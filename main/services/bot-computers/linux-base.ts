// Hidden Linux base VM builder for PR 4 (F1), gated behind
// `AIDEN_BOT_COMPUTERS_LINUX`. Creates the Linux VM in Aiden's Lume storage,
// places the verified Debian 13 raw disk image and grows it sparsely to 24 GB,
// writes the cloud-init NoCloud `CIDATA` seed ISO, and boots it once with
// `--mount` (and optional `--disk-path`) so an Apple-silicon Mac check can
// verify XFCE desktop display and SSH readiness before F2 wires Settings.

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm, truncate } from "node:fs/promises";
import path from "node:path";
import { buildCloudInitSeedIso, type CloudInitAptSnapshot, writeCloudInitSeedIso } from "./cloud-init-iso.js";
import { runLume, type LumeCommand, type LumeInvocation, type LumeRunResult } from "./lume-cli.js";
import { classifyLumeError, isLoopbackHost, parseLumeVmInfo, type LumeVmInfo } from "./lume-output.js";
import {
  BOT_COMPUTER_LINUX_CPU_COUNT,
  BOT_COMPUTER_LINUX_DISK_BYTES,
  BOT_COMPUTER_LINUX_DISK_GB,
  BOT_COMPUTER_LINUX_DISPLAY,
  BOT_COMPUTER_LINUX_MEMORY_GB,
} from "./release.js";
import { BotComputerError } from "./types.js";
import { isLumeVmNameSafe } from "./vm-names.js";

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

export interface HiddenLinuxBaseOptions {
  /** Aiden VM name (e.g. `aiden-base`). */
  vmName: string;
  /** Verified vendored Lume invocation (or fake Lume in tests). */
  invocation: LumeInvocation;
  /** Aiden's isolated Lume VM storage directory (`<root>/vms`). */
  storage: string;
  /** Allowlisted Lume environment (`lumeEnvironment(...)`). */
  lumeEnv: Record<string, string>;
  /** Shared folder mounted read-write (`<root>/base-shared`). */
  sharedDir: string;
  /** Log file path for detached `lume run`. */
  logFile: string;
  /** Verified Debian 13 raw disk image path. */
  sourceImagePath: string;
  /** Where to write the cloud-init `cidata` seed ISO. */
  seedIsoPath: string;
  /** Optional explicit `--disk-path` override instead of `<storage>/<vmName>/disk.img`. */
  diskPathOverride?: string;
  /** Aiden's `ssh-ed25519 …` public key for the guest user. */
  sshAuthorizedKey: string;
  /** Pre-hashed or plaintext guest password (hashed to SHA-512 crypt before writing the ISO). */
  passwordHash?: string;
  password?: string;
  /** Random VNC password for this boot. */
  vncPassword: string;
  /** Optional APT snapshot override (defaults to `BOT_COMPUTER_LINUX_APT_SNAPSHOT`). */
  snapshot?: CloudInitAptSnapshot;
  /** Optional package list override. */
  packages?: readonly string[];
  /** Override hardware config (defaults to 4 CPU, 4 GB RAM, 24 GB disk, 1280x800). */
  cpu?: number;
  memoryGb?: number;
  diskSizeGb?: number;
  display?: string;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface HiddenLinuxBaseResult {
  vmName: string;
  ip: string;
  vnc: { host: string; port: number };
  diskPath: string;
  seedIsoPath: string;
  seedIsoBytes: number;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BotComputerError("cancelled", "Starting the Linux base computer was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BotComputerError("cancelled", "Starting the Linux base computer was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create and boot a hidden Linux base VM behind `AIDEN_BOT_COMPUTERS_LINUX`:
 * 1. `lume create <vmName> --os linux --cpu 4 --memory 4GB --disk-size 24GB --display 1280x800 --storage <storage>`
 * 2. Place the verified Debian raw image into the VM's disk and grow it sparsely to 24 GB
 * 3. Write the NoCloud `CIDATA` seed ISO (`meta-data` + `user-data`)
 * 4. `lume run <vmName> --detach --display none --no-audio-device --no-clipboard-device --mount <seedIso> [--disk-path <override>] ...`
 * 5. Poll `lume get` until the VM is running with an IP, loopback VNC endpoint, and SSH ready.
 */
export async function createAndBootHiddenLinuxBase(options: HiddenLinuxBaseOptions): Promise<HiddenLinuxBaseResult> {
  if (!isLumeVmNameSafe(options.vmName)) {
    throw new BotComputerError("invalid", "That is not one of Aiden's computers.");
  }

  const cpu = options.cpu ?? BOT_COMPUTER_LINUX_CPU_COUNT;
  const memoryGb = options.memoryGb ?? BOT_COMPUTER_LINUX_MEMORY_GB;
  const diskSizeGb = options.diskSizeGb ?? BOT_COMPUTER_LINUX_DISK_GB;
  const display = options.display ?? BOT_COMPUTER_LINUX_DISPLAY;
  const targetDiskPath = options.diskPathOverride ?? path.join(options.storage, options.vmName, "disk.img");
  const pollMs = options.pollIntervalMs ?? 500;
  const startTimeoutMs = options.startTimeoutMs ?? 240_000;

  const execLume = (command: LumeCommand, timeoutMs: number, onSpawn?: () => void): Promise<LumeRunResult> =>
    runLume(options.invocation, command, {
      storage: options.storage,
      env: options.lumeEnv,
      timeoutMs,
      signal: options.signal,
      onSpawn,
    });

  await mkdir(options.storage, { recursive: true, mode: 0o700 });
  await mkdir(options.sharedDir, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(options.logFile), { recursive: true, mode: 0o700 });

  const created = await execLume(
    { op: "create", os: "linux", name: options.vmName, cpu, memoryGb, diskSizeGb, display },
    120_000,
  );
  if (created.exitCode !== 0) {
    const kind = classifyLumeError(`${created.stderr}\n${created.stdout}`, created.exitCode);
    if (kind === "low_disk") {
      throw new BotComputerError(
        "low_disk",
        "The Linux base computer couldn't be created because this Mac doesn't have enough free disk space. Free up space and try again.",
      );
    }
    throw new BotComputerError("lume_failed", "Creating the Linux base computer failed.");
  }

  let launched = false;
  try {
    await prepareLinuxBaseDisk({
      sourceImagePath: options.sourceImagePath,
      targetDiskPath,
      targetBytes: diskSizeGb * 1024 ** 3,
    });

    const isoBytes = await writeCloudInitSeedIso(options.seedIsoPath, {
      instanceId: options.vmName,
      hostname: options.vmName,
      sshAuthorizedKey: options.sshAuthorizedKey,
      passwordHash: options.passwordHash,
      password: options.password,
      snapshot: options.snapshot,
      packages: options.packages,
    });

    const started = await execLume(
      {
        op: "run",
        name: options.vmName,
        vncPassword: options.vncPassword,
        sharedDir: options.sharedDir,
        mount: options.seedIsoPath,
        ...(options.diskPathOverride ? { diskPath: options.diskPathOverride } : {}),
        logFile: options.logFile,
      },
      60_000,
      () => {
        launched = true;
      },
    );
    if (started.exitCode !== 0) {
      const kind = classifyLumeError(`${started.stderr}\n${started.stdout}`, started.exitCode);
      if (kind === "low_disk") {
        throw new BotComputerError(
          "low_disk",
          "The Linux base computer didn't start because this Mac doesn't have enough free disk space. Free up space and try again.",
        );
      }
      throw new BotComputerError("start_failed", "The Linux base computer didn't start.");
    }

    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const result = await execLume({ op: "get", name: options.vmName }, 30_000);
      if (result.exitCode === 0) {
        const info: LumeVmInfo = parseLumeVmInfo(result.stdout);
        if (info.state === "running" && info.ip && info.vnc && info.sshAvailable === true) {
          if (!isLoopbackHost(info.vnc.host)) {
            throw new BotComputerError(
              "vnc_not_loopback",
              "The Linux base computer offered its screen beyond this Mac, so Aiden stopped it.",
            );
          }
          return {
            vmName: options.vmName,
            ip: info.ip,
            vnc: info.vnc,
            diskPath: targetDiskPath,
            seedIsoPath: options.seedIsoPath,
            seedIsoBytes: isoBytes.length,
          };
        }
      }
      if (Date.now() > deadline) {
        throw new BotComputerError("start_failed", "The Linux base computer didn't start in time.");
      }
      await sleep(pollMs, options.signal);
    }
  } catch (error) {
    if (launched) {
      await runLume(
        options.invocation,
        { op: "stop", name: options.vmName, force: true, timeoutSeconds: 0 },
        { storage: options.storage, env: options.lumeEnv, timeoutMs: 30_000 },
      ).catch(() => undefined);
    }
    throw error;
  }
}

export { buildCloudInitSeedIso };
