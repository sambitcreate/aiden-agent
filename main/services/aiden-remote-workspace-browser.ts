import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenOpaqueHandleError,
  AidenOpaqueHandleStore,
  inspectAidenFilesystemIdentity,
  type AidenOpaqueHandleClaims,
} from "./aiden-remote-opaque-handles.js";
import type {
  AidenRemoteApprovedRoot,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";

const LOCATION_TTL_MS = 10 * 60_000;
const CURSOR_TTL_MS = 2 * 60_000;
const SELECTION_TTL_MS = 2 * 60_000;
const PAGE_SIZE = 200;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_DEPTH = 20;
const SYSTEM_DIRECTORY_NAMES = new Set([
  ".DocumentRevisions-V100",
  ".Spotlight-V100",
  ".TemporaryItems",
  ".Trashes",
  "Library",
  "System",
]);

export interface AidenRemoteBrowserRootProjection {
  id: string;
  label: string;
  location: string;
  policyRevision: string;
}

export interface AidenRemoteBrowserPage {
  rootId: string;
  label: string;
  breadcrumbs: Array<{ label: string; location: string }>;
  entries: Array<{ id: string; name: string; location: string }>;
  nextCursor?: string;
}

export interface AidenRemoteWorkspaceSelection {
  selection: string;
  displayName: string;
  expiresAt: string;
}

interface DirectoryEntryIdentity {
  name: string;
  canonicalPath: string;
  filesystemDevice: string;
  filesystemInode: string;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function opaqueEntryId(rootId: string, entry: DirectoryEntryIdentity): string {
  return createHash("sha256")
    .update(`${rootId}\0${entry.filesystemDevice}\0${entry.filesystemInode}`)
    .digest("base64url");
}

function compareNames(left: DirectoryEntryIdentity, right: DirectoryEntryIdentity): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function safeLabel(value: string, fallback: string): string {
  const candidate = [...(value || fallback)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? "�" : character;
    })
    .join("");
  return [...candidate].slice(0, 255).join("") || fallback;
}

function mapHandleError(error: unknown): never {
  if (!(error instanceof AidenOpaqueHandleError)) throw error;
  const status = error.code === "handle_wrong_device"
    ? 403
    : error.code === "handle_expired"
      ? 410
      : error.code === "handle_capacity"
        ? 429
        : error.code === "root_policy_changed" ||
            error.code === "filesystem_identity_changed" ||
            error.code === "path_outside_root"
          ? 409
          : 400;
  throw new AidenRemoteServiceError(
    error.code,
    error.code === "handle_expired"
      ? "This folder-browser link expired. Refresh the approved roots and try again."
      : error.code === "handle_capacity"
        ? "Aiden's folder-browser handle capacity is temporarily full."
        : "This folder-browser link is no longer valid.",
    status,
    error.code === "handle_capacity",
  );
}

export class AidenRemoteWorkspaceBrowserService {
  constructor(
    private readonly options: {
      instanceId: string;
      state: Pick<AidenRemoteStateRegistry, "snapshot">;
      handles?: AidenOpaqueHandleStore;
      now?: () => number;
    },
  ) {}

  private get handles(): AidenOpaqueHandleStore {
    this.handleStore ??= this.options.handles ?? new AidenOpaqueHandleStore({ now: this.now });
    return this.handleStore;
  }

  private handleStore: AidenOpaqueHandleStore | undefined;
  private readonly now = (): number => this.options.now?.() ?? Date.now();

  private async approvedRoot(rootId: string): Promise<AidenRemoteApprovedRoot> {
    const root = (await this.options.state.snapshot()).approvedRoots.find(
      (candidate) => candidate.id === rootId,
    );
    if (!root) {
      throw new AidenRemoteServiceError(
        "root_policy_changed",
        "This approved folder is no longer available for remote browsing.",
        409,
      );
    }
    return root;
  }

  private async claimsForPath(
    deviceId: string,
    root: AidenRemoteApprovedRoot,
    candidatePath: string,
    extra: Pick<
      AidenOpaqueHandleClaims,
      "expiresAt" | "depth" | "snapshotId" | "cursorOffset" | "parentHandleDigest"
    >,
  ): Promise<AidenOpaqueHandleClaims> {
    try {
      const rootIdentity = await fs.stat(root.folderPath, { bigint: true });
      const canonicalRoot = await fs.realpath(root.folderPath);
      if (
        !rootIdentity.isDirectory() ||
        canonicalRoot !== root.folderPath ||
        rootIdentity.dev.toString() !== root.device ||
        rootIdentity.ino.toString() !== root.inode
      ) {
        throw new AidenOpaqueHandleError("filesystem_identity_changed");
      }
      const identity = await inspectAidenFilesystemIdentity(root.folderPath, candidatePath);
      if (identity.kind !== "directory") {
        throw new AidenOpaqueHandleError("handle_invalid");
      }
      return {
        instanceId: this.options.instanceId,
        deviceId,
        rootId: root.id,
        policyRevision: root.policyRevision,
        ...identity,
        ...extra,
      };
    } catch (error) {
      if (error instanceof AidenRemoteServiceError) throw error;
      if (error instanceof AidenOpaqueHandleError) mapHandleError(error);
      throw new AidenRemoteServiceError(
        "workspace_unavailable",
        "This approved folder is not currently available on the Mac.",
        409,
      );
    }
  }

  private async resolveLocation(
    deviceId: string,
    token: string,
  ): Promise<{ claims: AidenOpaqueHandleClaims; root: AidenRemoteApprovedRoot }> {
    try {
      const stored = this.handles.claimsFor(token, "loc");
      const root = await this.approvedRoot(stored.rootId);
      const current = await this.claimsForPath(deviceId, root, stored.canonicalPath, {
        expiresAt: stored.expiresAt,
        depth: stored.depth,
        snapshotId: stored.snapshotId,
        cursorOffset: stored.cursorOffset,
        parentHandleDigest: stored.parentHandleDigest,
      });
      return { claims: this.handles.resolve(token, "loc", current), root };
    } catch (error) {
      mapHandleError(error);
    }
  }

  async listRoots(deviceId: string): Promise<{ roots: AidenRemoteBrowserRootProjection[] }> {
    const state = await this.options.state.snapshot();
    const roots: AidenRemoteBrowserRootProjection[] = [];
    for (const root of state.approvedRoots) {
      const claims = await this.claimsForPath(deviceId, root, root.folderPath, {
        expiresAt: this.now() + LOCATION_TTL_MS,
        depth: 0,
        snapshotId: undefined,
        cursorOffset: undefined,
        parentHandleDigest: undefined,
      });
      roots.push({
        id: root.id,
        label: safeLabel(root.label, "Approved folder"),
        location: this.handles.issue("loc", claims),
        policyRevision: root.policyRevision,
      });
    }
    return { roots };
  }

  private async directoryEntries(
    root: AidenRemoteApprovedRoot,
    directoryPath: string,
  ): Promise<DirectoryEntryIdentity[]> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new AidenRemoteServiceError(
        "workspace_unavailable",
        "This folder contains too many entries to browse remotely.",
        409,
        false,
        { limit: MAX_DIRECTORY_ENTRIES },
      );
    }
    const directories: DirectoryEntryIdentity[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        SYSTEM_DIRECTORY_NAMES.has(entry.name)
      ) {
        continue;
      }
      try {
        const identity = await inspectAidenFilesystemIdentity(
          root.folderPath,
          path.join(directoryPath, entry.name),
        );
        if (identity.kind !== "directory") continue;
        directories.push({
          name: safeLabel(entry.name, "Folder"),
          canonicalPath: identity.canonicalPath,
          filesystemDevice: identity.filesystemDevice,
          filesystemInode: identity.filesystemInode,
        });
      } catch {
        // A raced, unreadable, or redirected entry is omitted. The parent
        // location remains usable and no local path crosses the wire.
      }
    }
    return directories.sort(compareNames);
  }

  private async breadcrumbs(
    deviceId: string,
    root: AidenRemoteApprovedRoot,
    currentPath: string,
  ): Promise<Array<{ label: string; location: string }>> {
    const relative = path.relative(root.folderPath, currentPath);
    const segments = relative ? relative.split(path.sep) : [];
    const result: Array<{ label: string; location: string }> = [];
    let candidate = root.folderPath;
    for (let index = 0; index <= segments.length; index += 1) {
      if (index > 0) candidate = path.join(candidate, segments[index - 1]!);
      const claims = await this.claimsForPath(deviceId, root, candidate, {
        expiresAt: this.now() + LOCATION_TTL_MS,
        depth: index,
        snapshotId: undefined,
        cursorOffset: undefined,
        parentHandleDigest: undefined,
      });
      result.push({
        label: index === 0 ? safeLabel(root.label, "Approved folder") : safeLabel(segments[index - 1]!, "Folder"),
        location: this.handles.issue("loc", claims),
      });
    }
    return result;
  }

  async listChildren(
    deviceId: string,
    location: string,
    cursor?: string,
  ): Promise<AidenRemoteBrowserPage> {
    const { claims, root } = await this.resolveLocation(deviceId, location);
    const depth = claims.depth ?? 0;
    if (depth > MAX_DEPTH) {
      throw new AidenRemoteServiceError(
        "handle_invalid",
        "This folder is deeper than Aiden's remote browser limit.",
        400,
        false,
        { limit: MAX_DEPTH },
      );
    }
    const entries = await this.directoryEntries(root, claims.canonicalPath);
    const snapshotId = createHash("sha256")
      .update(entries.map((entry) => `${entry.name}\0${entry.filesystemDevice}\0${entry.filesystemInode}`).join("\n"))
      .digest("base64url");
    let offset = 0;
    if (cursor) {
      try {
        const storedCursor = this.handles.claimsFor(cursor, "cur");
        const currentCursor = await this.claimsForPath(deviceId, root, claims.canonicalPath, {
          expiresAt: storedCursor.expiresAt,
          depth,
          snapshotId,
          cursorOffset: storedCursor.cursorOffset,
          parentHandleDigest: tokenDigest(location),
        });
        const resolved = this.handles.resolve(cursor, "cur", currentCursor);
        offset = resolved.cursorOffset ?? -1;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entries.length) {
          throw new AidenOpaqueHandleError("handle_invalid");
        }
      } catch (error) {
        mapHandleError(error);
      }
    }
    const pageEntries = entries.slice(offset, offset + PAGE_SIZE);
    const projectedEntries = await Promise.all(
      pageEntries.map(async (entry) => ({
        id: opaqueEntryId(root.id, entry),
        name: entry.name,
        location: this.handles.issue(
          "loc",
          await this.claimsForPath(deviceId, root, entry.canonicalPath, {
            expiresAt: this.now() + LOCATION_TTL_MS,
            depth: depth + 1,
            snapshotId: undefined,
            cursorOffset: undefined,
            parentHandleDigest: undefined,
          }),
        ),
      })),
    );
    const nextOffset = offset + pageEntries.length;
    const nextCursor = nextOffset < entries.length
      ? this.handles.issue("cur", {
          ...claims,
          expiresAt: this.now() + CURSOR_TTL_MS,
          snapshotId,
          cursorOffset: nextOffset,
          parentHandleDigest: tokenDigest(location),
        })
      : undefined;
    return {
      rootId: root.id,
      label: safeLabel(path.basename(claims.canonicalPath), root.label),
      breadcrumbs: await this.breadcrumbs(deviceId, root, claims.canonicalPath),
      entries: projectedEntries,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async createSelection(
    deviceId: string,
    location: string,
  ): Promise<AidenRemoteWorkspaceSelection> {
    const { claims, root } = await this.resolveLocation(deviceId, location);
    const expiresAt = this.now() + SELECTION_TTL_MS;
    const fresh = await this.claimsForPath(deviceId, root, claims.canonicalPath, {
      expiresAt,
      depth: claims.depth,
      snapshotId: undefined,
      cursorOffset: undefined,
      parentHandleDigest: undefined,
    });
    return {
      selection: this.handles.issue("sel", fresh),
      displayName: safeLabel(path.basename(fresh.canonicalPath), root.label),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async consumeSelection(deviceId: string, selection: string): Promise<AidenOpaqueHandleClaims> {
    try {
      const stored = this.handles.claimsFor(selection, "sel");
      const root = await this.approvedRoot(stored.rootId);
      const current = await this.claimsForPath(deviceId, root, stored.canonicalPath, {
        expiresAt: stored.expiresAt,
        depth: stored.depth,
        snapshotId: stored.snapshotId,
        cursorOffset: stored.cursorOffset,
        parentHandleDigest: stored.parentHandleDigest,
      });
      return this.handles.consumeSelection(
        selection,
        current,
        (claims) => ({ ...claims }),
        this.now(),
      );
    } catch (error) {
      mapHandleError(error);
    }
  }

  async revalidateConsumedSelection(
    deviceId: string,
    claims: AidenOpaqueHandleClaims,
  ): Promise<AidenOpaqueHandleClaims> {
    if (this.now() >= claims.expiresAt) {
      mapHandleError(new AidenOpaqueHandleError("handle_expired"));
    }
    if (claims.deviceId !== deviceId || claims.instanceId !== this.options.instanceId) {
      mapHandleError(new AidenOpaqueHandleError("handle_wrong_device"));
    }
    const root = await this.approvedRoot(claims.rootId);
    const current = await this.claimsForPath(deviceId, root, claims.canonicalPath, {
      expiresAt: claims.expiresAt,
      depth: claims.depth,
      snapshotId: claims.snapshotId,
      cursorOffset: claims.cursorOffset,
      parentHandleDigest: claims.parentHandleDigest,
    });
    if (
      current.policyRevision !== claims.policyRevision ||
      current.canonicalRootPath !== claims.canonicalRootPath ||
      current.canonicalPath !== claims.canonicalPath ||
      current.filesystemDevice !== claims.filesystemDevice ||
      current.filesystemInode !== claims.filesystemInode
    ) {
      mapHandleError(new AidenOpaqueHandleError("filesystem_identity_changed"));
    }
    return current;
  }
}
