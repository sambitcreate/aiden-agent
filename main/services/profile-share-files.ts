import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROFILE_SHARE_DIRECTORY_PREFIX = "aiden-profile-share-";
export const PROFILE_SHARE_FILE_NAME = "Aiden-usage-profile.png";
export const PROFILE_SHARE_STALE_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ProfileShareFile {
  directory: string;
  filePath: string;
}

export async function createProfileShareFile(
  image: Buffer,
  temporaryRoot = os.tmpdir(),
): Promise<ProfileShareFile> {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, PROFILE_SHARE_DIRECTORY_PREFIX));
  const filePath = path.join(directory, PROFILE_SHARE_FILE_NAME);
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(filePath, image, { flag: "wx", mode: 0o600 });
    return { directory, filePath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeProfileShareDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

export async function writeProfileShareExport(filePath: string, image: Buffer): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    // Opening an existing path does not apply the mode argument. Normalize it
    // before writing so a user-selected export never inherits public bits.
    await handle.chmod(0o600);
    await handle.writeFile(image);
  } finally {
    await handle.close();
  }
}

export async function cleanupStaleProfileShareDirectories(options?: {
  temporaryRoot?: string;
  activeDirectories?: ReadonlySet<string>;
  now?: number;
}): Promise<number> {
  const temporaryRoot = options?.temporaryRoot ?? os.tmpdir();
  const activeDirectories = options?.activeDirectories ?? new Set<string>();
  const now = options?.now ?? Date.now();
  const entries = await fs.readdir(temporaryRoot, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROFILE_SHARE_DIRECTORY_PREFIX)) continue;
    const directory = path.join(temporaryRoot, entry.name);
    if (activeDirectories.has(directory)) continue;
    try {
      const stats = await fs.stat(directory);
      if (now - stats.mtimeMs < PROFILE_SHARE_STALE_AGE_MS) continue;
      await removeProfileShareDirectory(directory);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return removed;
}
