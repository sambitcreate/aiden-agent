// Linux base disk preparation helper for Debian 13 Bot computers.
// Places the verified Debian 13 raw disk image into the VM's disk.img and grows
// it sparsely to 24 GB (using APFS copy-on-write when available).

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm, truncate } from "node:fs/promises";
import path from "node:path";
import { buildCloudInitSeedIso } from "./cloud-init-iso.js";
import { BOT_COMPUTER_LINUX_DISK_BYTES } from "./release.js";
import { BotComputerError } from "./types.js";

export interface PrepareLinuxDiskOptions {
  /** Verified Debian 13 arm64 raw disk image on disk. */
  sourceImagePath: string;
  /** Destination raw disk path (typically `<storage>/<vmName>/disk.img`). */
  targetDiskPath: string;
  /** Target sparse logical disk size in bytes (defaults to 24 GiB). */
  targetBytes?: number;
}

/**
 * Copy a verified Debian raw disk into place atomically (using clonefile/reflink
 * when the filesystem supports it) and grow its logical size sparsely to
 * `targetBytes`. `cloud-initramfs-growroot` inside Debian expands the GPT
 * partition and ext4 root filesystem on first boot.
 */
export async function prepareLinuxBaseDisk(options: PrepareLinuxDiskOptions): Promise<{ bytes: number }> {
  const targetBytes = options.targetBytes ?? BOT_COMPUTER_LINUX_DISK_BYTES;
  if (!path.isAbsolute(options.sourceImagePath) || !path.isAbsolute(options.targetDiskPath)) {
    throw new BotComputerError("invalid", "Linux disk paths must be absolute.");
  }
  const sourceInfo = await lstat(options.sourceImagePath).catch(() => null);
  if (!sourceInfo || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new BotComputerError("invalid", "The verified Debian disk image is missing.");
  }
  if (!Number.isSafeInteger(targetBytes) || targetBytes < sourceInfo.size) {
    throw new BotComputerError("invalid", "Target Linux disk size must be at least as large as the source image.");
  }

  const targetDir = path.dirname(options.targetDiskPath);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const staging = `${options.targetDiskPath}.aiden-tmp-${process.pid}-${Date.now()}`;
  try {
    // COPYFILE_FICLONE uses APFS copy-on-write on macOS when on the same volume,
    // transparently falling back to a byte copy otherwise.
    await copyFile(options.sourceImagePath, staging, constants.COPYFILE_FICLONE);
    if (targetBytes > sourceInfo.size) {
      await truncate(staging, targetBytes);
    }
    await rename(staging, options.targetDiskPath);
    return { bytes: targetBytes };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

export { buildCloudInitSeedIso };
