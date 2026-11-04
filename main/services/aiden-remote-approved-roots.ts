import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "../shared/path-containment.js";
import type {
  AidenRemoteApprovedRoot,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";

export const AIDEN_REMOTE_ROOT_POLICY_REVISION = "remote-browser-v1:no-hidden-system";

export interface AidenRemoteApprovedRootDependencies {
  now(): number;
  randomBytes(size: number): Buffer;
  homeDirectory(): string;
}

export interface AidenRemoteApprovedRootLiveIdentity {
  root: string;
  /** The live device, which can differ from the persisted one after a remount. */
  device: string;
  inode: string;
}

interface ApprovedRootFilesystem {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<{ dev: bigint; ino: bigint; isDirectory(): boolean }>;
}

const liveFilesystem: ApprovedRootFilesystem = {
  realpath: (target) => fs.realpath(target),
  stat: (target) => fs.stat(target, { bigint: true }),
};

/**
 * Prove a persisted approved root still names the folder the user approved,
 * returning its live identity, or `null` when it must be reviewed again.
 *
 * macOS assigns APFS `st_dev` numbers when a volume mounts, so a reboot can
 * renumber the device under an unchanged folder. A device change is accepted
 * only when the canonical path and inode still match and the root now lives
 * on the same volume as `approvalStore`, the directory holding the persisted
 * approval records. Substituting that volume already means controlling every
 * record that approved the folder, the boundary `sameHomeByInode` in
 * bot-managed-workspace.ts accepts for Bot homes. Any other volume (an
 * external or network drive, a disk image) could be replaced by one that
 * presents the same path and inode, so its roots keep the exact device check.
 */
export async function verifyApprovedRootIdentity(
  root: Pick<AidenRemoteApprovedRoot, "folderPath" | "device" | "inode">,
  approvalStore: string,
  filesystem: ApprovedRootFilesystem = liveFilesystem,
): Promise<AidenRemoteApprovedRootLiveIdentity | null> {
  try {
    const [canonical, metadata] = await Promise.all([
      filesystem.realpath(root.folderPath),
      filesystem.stat(root.folderPath),
    ]);
    if (canonical !== root.folderPath || !metadata.isDirectory() || metadata.ino.toString() !== root.inode) {
      return null;
    }
    if (metadata.dev.toString() !== root.device) {
      const store = await filesystem.stat(approvalStore);
      if (store.dev !== metadata.dev) return null;
    }
    return { root: canonical, device: metadata.dev.toString(), inode: root.inode };
  } catch {
    return null;
  }
}

function displayLabel(folderPath: string): string {
  return path.basename(folderPath) || folderPath;
}

export class AidenRemoteApprovedRootService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly inventoryOwner = new AsyncLocalStorage<boolean>();

  /** Root creation, compensation, phone approval and Bot policy saves share this lock. */
  withInventoryLock<T>(action: () => Promise<T>): Promise<T> {
    if (this.inventoryOwner.getStore()) return action();
    const result = this.tail.then(() => this.inventoryOwner.run(true, action), () => this.inventoryOwner.run(true, action));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  constructor(
    private readonly state: Pick<AidenRemoteStateRegistry, "snapshot" | "addApprovedRoot" | "removeApprovedRoot"> & Partial<Pick<AidenRemoteStateRegistry, "approveRootForPhones">>,
    private readonly dependencies: AidenRemoteApprovedRootDependencies = {
      now: Date.now,
      randomBytes,
      homeDirectory: os.homedir,
    },
  ) {}

  async addLocalFolder(
    selectedPath: string,
    options: { confirmHomeDirectory?: boolean; botsOnly?: true; operationId?: string; rootId?: string; expectedIdentity?: { device: string; inode: string }; assertCurrent?: () => void } = {},
  ): Promise<AidenRemoteApprovedRoot> {
    return this.withInventoryLock(() => this.addFolderUnlocked(selectedPath, options));
  }

  private async addFolderUnlocked(selectedPath: string, options: { confirmHomeDirectory?: boolean; botsOnly?: true; operationId?: string; rootId?: string; expectedIdentity?: { device: string; inode: string }; assertCurrent?: () => void }): Promise<AidenRemoteApprovedRoot> {
    if (!path.isAbsolute(selectedPath) || Buffer.byteLength(selectedPath, "utf8") > 4_096) {
      throw new Error("Select an absolute local folder.");
    }
    const canonicalPath = await fs.realpath(selectedPath);
    const metadata = await fs.stat(canonicalPath, { bigint: true });
    if (!metadata.isDirectory()) throw new Error("The approved root must be a directory.");
    if (options.expectedIdentity && (canonicalPath !== selectedPath || options.expectedIdentity.device !== String(metadata.dev) || options.expectedIdentity.inode !== String(metadata.ino))) throw new Error("That folder changed. Ask for access again.");
    if (canonicalPath === path.parse(canonicalPath).root) {
      throw new Error("The filesystem root cannot be approved for remote browsing.");
    }
    const canonicalHome = await fs.realpath(this.dependencies.homeDirectory());
    if (canonicalPath === canonicalHome && options.confirmHomeDirectory !== true) {
      throw new Error("Approving the entire home directory requires local confirmation.");
    }

    const existing = (await this.state.snapshot()).approvedRoots;
    const exact = existing.find((root) => root.folderPath === canonicalPath);
    if (exact) {
      if (exact.device !== String(metadata.dev) || exact.inode !== String(metadata.ino)) throw new Error("That folder changed. Approve it again in Settings.");
      options.assertCurrent?.();
      if (!options.botsOnly && exact.botsOnly) {
        if (!this.state.approveRootForPhones) throw new Error("Folder approval is unavailable.");
        return this.state.approveRootForPhones(exact.id);
      }
      return exact;
    }
    const overlapping = existing.filter((root) => options.botsOnly || !root.botsOnly);
    if (overlapping.some((root) => isPathInside(root.folderPath, canonicalPath))) {
      throw new Error("This folder is already covered by an approved root.");
    }
    if (overlapping.some((root) => isPathInside(canonicalPath, root.folderPath))) {
      throw new Error("This folder would overlap an existing approved root.");
    }

    const root: AidenRemoteApprovedRoot = {
      id: options.rootId ?? `root_${this.dependencies.randomBytes(24).toString("base64url")}`,
      label: displayLabel(canonicalPath),
      folderPath: canonicalPath,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      policyRevision: AIDEN_REMOTE_ROOT_POLICY_REVISION,
      createdAt: this.dependencies.now(),
      ...(options.botsOnly ? { botsOnly: true as const } : {}),
      ...(options.botsOnly && options.operationId ? { botGrantOperationId: options.operationId } : {}),
    };
    options.assertCurrent?.();
    await this.state.addApprovedRoot(root, options.assertCurrent);
    return root;
  }

  async removeLocalRoot(rootId: string, ownedBy?: string): Promise<boolean> {
    return this.withInventoryLock(() => this.state.removeApprovedRoot(rootId, ownedBy));
  }
}
