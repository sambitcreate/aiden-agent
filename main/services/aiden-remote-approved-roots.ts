import { randomBytes } from "node:crypto";
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
 * only when the canonical path and inode still match and the root shares a
 * device with its parent, i.e. it is not itself a mount point where another
 * volume could present the same root inode. This is the boundary
 * `sameHomeByInode` in bot-managed-workspace.ts accepts for Bot homes:
 * substituting the volume that holds the parent needs control of that mount.
 */
export async function verifyApprovedRootIdentity(
  root: Pick<AidenRemoteApprovedRoot, "folderPath" | "device" | "inode">,
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
      const parent = await filesystem.stat(path.dirname(canonical));
      if (parent.dev !== metadata.dev) return null;
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
  constructor(
    private readonly state: Pick<AidenRemoteStateRegistry, "snapshot" | "addApprovedRoot" | "removeApprovedRoot">,
    private readonly dependencies: AidenRemoteApprovedRootDependencies = {
      now: Date.now,
      randomBytes,
      homeDirectory: os.homedir,
    },
  ) {}

  async addLocalFolder(
    selectedPath: string,
    options: { confirmHomeDirectory?: boolean } = {},
  ): Promise<AidenRemoteApprovedRoot> {
    if (!path.isAbsolute(selectedPath) || Buffer.byteLength(selectedPath, "utf8") > 4_096) {
      throw new Error("Select an absolute local folder.");
    }
    const canonicalPath = await fs.realpath(selectedPath);
    const metadata = await fs.stat(canonicalPath, { bigint: true });
    if (!metadata.isDirectory()) throw new Error("The approved root must be a directory.");
    if (canonicalPath === path.parse(canonicalPath).root) {
      throw new Error("The filesystem root cannot be approved for remote browsing.");
    }
    const canonicalHome = await fs.realpath(this.dependencies.homeDirectory());
    if (canonicalPath === canonicalHome && options.confirmHomeDirectory !== true) {
      throw new Error("Approving the entire home directory requires local confirmation.");
    }

    const existing = (await this.state.snapshot()).approvedRoots;
    if (existing.some((root) => isPathInside(root.folderPath, canonicalPath))) {
      throw new Error("This folder is already covered by an approved root.");
    }
    if (existing.some((root) => isPathInside(canonicalPath, root.folderPath))) {
      throw new Error("This folder would overlap an existing approved root.");
    }

    const root: AidenRemoteApprovedRoot = {
      id: `root_${this.dependencies.randomBytes(24).toString("base64url")}`,
      label: displayLabel(canonicalPath),
      folderPath: canonicalPath,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      policyRevision: AIDEN_REMOTE_ROOT_POLICY_REVISION,
      createdAt: this.dependencies.now(),
    };
    await this.state.addApprovedRoot(root);
    return root;
  }

  async removeLocalRoot(rootId: string): Promise<boolean> {
    return this.state.removeApprovedRoot(rootId);
  }
}
