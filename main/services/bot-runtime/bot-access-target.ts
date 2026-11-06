import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isPathInside } from "../../shared/path-containment.js";
import type { AidenRemoteApprovedRoot } from "../aiden-remote-state.js";
import type { BotFileToolLocation } from "../bot-file-tool-router.js";
import {
  BOT_ACCESS_PATH_MAX_BYTES,
  BOT_ACCESS_LABEL_MAX_CHARS,
  BOT_ACCESS_PLACE_MAX_CHARS,
  BOT_WHOLE_MAC_REQUEST,
} from "../../../renderer/shared/bot-access-requests.js";
import { withoutBotHandoffControls } from "../../../renderer/shared/bot-handoffs.js";

/** Whole app-owned directories, shared by target validation and temporary file access. */
export function botAccessPrivateRoots(userData: string, configDirectory: string): readonly string[] {
  return [path.resolve(userData), path.resolve(configDirectory)];
}

export type BotAccessAlways =
  | { kind: "existing"; rootId: string }
  | { kind: "new" }
  | { kind: "none"; reason: "covered" | "overlaps" | "home" };
export type BotAccessResolution =
  | {
      kind: "folder";
      root: string;
      label: string;
      place: string;
      device: string;
      inode: string;
      always: BotAccessAlways;
      inventoryRevision?: string;
    }
  | { kind: "whole_mac" }
  | {
      kind: "refused";
      reason: "not_absolute" | "too_long" | "not_found" | "private" | "filesystem_root";
    };
export interface BotAccessTargetDeps {
  homeDirectory(): string;
  privateRoots(): readonly string[];
  approvedRoots(): Promise<readonly Pick<AidenRemoteApprovedRoot, "id" | "folderPath">[]>;
  filesystem?: {
    realpath(p: string): Promise<string>;
    stat(p: string): Promise<{ dev: bigint; ino: bigint; isDirectory(): boolean }>;
  };
}
type AccessInventoryRoot = Pick<AidenRemoteApprovedRoot, "id" | "folderPath"> & Partial<Pick<AidenRemoteApprovedRoot, "device" | "inode">>;
export function botAccessRootInventoryRevision(
  roots: readonly AccessInventoryRoot[],
  targetRoot: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [targetRoot, roots
          .filter(({ folderPath }) => isPathInside(folderPath, targetRoot) || isPathInside(targetRoot, folderPath))
          .map(({ id, folderPath, device, inode }) => [id, folderPath, device, inode])
          .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))],
      ),
    )
    .digest("hex");
}
export async function resolveBotAccessTarget(
  requested: string,
  deps: BotAccessTargetDeps,
): Promise<BotAccessResolution> {
  if (requested === BOT_WHOLE_MAC_REQUEST) return { kind: "whole_mac" };
  if (Buffer.byteLength(requested, "utf8") > BOT_ACCESS_PATH_MAX_BYTES)
    return { kind: "refused", reason: "too_long" };
  const home = deps.homeDirectory();
  const expanded =
    requested === "~"
      ? home
      : requested.startsWith("~/")
        ? path.join(home, requested.slice(2))
        : requested;
  if (!path.isAbsolute(expanded)) return { kind: "refused", reason: "not_absolute" };
  const filesystem = deps.filesystem ?? {
    realpath: fs.realpath,
    stat: (p: string) => fs.stat(p, { bigint: true }),
  };
  let root: string, identity: Awaited<ReturnType<typeof filesystem.stat>>;
  try {
    root = await filesystem.realpath(expanded);
    identity = await filesystem.stat(root);
    if (!identity.isDirectory()) {
      root = path.dirname(root);
      identity = await filesystem.stat(root);
    }
    if (!identity.isDirectory()) return { kind: "refused", reason: "not_found" };
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return { kind: "refused", reason: "not_found" };
  }
  if (root === path.parse(root).root) return { kind: "refused", reason: "filesystem_root" };
  const realHome = await filesystem.realpath(home).catch(() => path.resolve(home));
  for (const privateRoot of deps.privateRoots()) {
    // Keep the lexical guard even when a private directory has not been provisioned yet.
    const canonical = await filesystem.realpath(privateRoot).catch(() => path.resolve(privateRoot));
    if (isPathInside(canonical, root) || (root !== realHome && isPathInside(root, canonical))) return { kind: "refused", reason: "private" };
  }
  const roots = await deps.approvedRoots();
  let always: BotAccessAlways = { kind: "new" };
  if (root === realHome) always = { kind: "none", reason: "home" };
  else {
    for (const approved of roots) {
      const canonical = await filesystem
        .realpath(approved.folderPath)
        .catch(() => path.resolve(approved.folderPath));
      if (canonical === root) {
        always = { kind: "existing", rootId: approved.id };
        break;
      }
      if (isPathInside(canonical, root)) always = { kind: "none", reason: "covered" };
      else if (isPathInside(root, canonical)) always = { kind: "none", reason: "overlaps" };
    }
  }
  const displayPath = isPathInside(realHome, root)
    ? "~" + (root === realHome ? "" : "/" + path.relative(realHome, root))
    : root;
  return {
    kind: "folder",
    root,
    label: Array.from(withoutBotHandoffControls(path.basename(root)).trim() || "folder")
      .slice(0, BOT_ACCESS_LABEL_MAX_CHARS)
      .join(""),
    place: Array.from(withoutBotHandoffControls(displayPath))
      .slice(0, BOT_ACCESS_PLACE_MAX_CHARS)
      .join(""),
    device: String(identity.dev),
    inode: String(identity.ino),
    always,
    inventoryRevision: botAccessRootInventoryRevision(roots, root),
  };
}
export function coveredByBotLocations(
  root: string,
  locations: readonly Pick<BotFileToolLocation, "root" | "access">[],
  requiredAccess: "read" | "write" = "read",
): boolean {
  return locations.some(
    (location) =>
      (requiredAccess === "read" || location.access !== "read") &&
      isPathInside(location.root, root),
  );
}
