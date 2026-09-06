import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AidenRemoteApprovedRoot,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";

export const AIDEN_REMOTE_ROOT_POLICY_REVISION = "remote-browser-v1:no-hidden-system";

export class AidenRemoteHomeDirectoryConfirmationRequiredError extends Error {
  constructor() {
    super("Approving the entire home directory requires local confirmation.");
    this.name = "AidenRemoteHomeDirectoryConfirmationRequiredError";
  }
}

export interface AidenRemoteApprovedRootDependencies {
  now(): number;
  randomBytes(size: number): Buffer;
  homeDirectory(): string;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
      throw new AidenRemoteHomeDirectoryConfirmationRequiredError();
    }

    const existing = (await this.state.snapshot()).approvedRoots;
    if (existing.some((root) => isWithin(root.folderPath, canonicalPath))) {
      throw new Error("This folder is already covered by an approved root.");
    }
    if (existing.some((root) => isWithin(canonicalPath, root.folderPath))) {
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
