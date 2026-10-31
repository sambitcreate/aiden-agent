import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { formatHarnessBytes } from "../../../renderer/shared/acp-harness.js";
import { statfsAvailableBytes } from "../managed-worktree-capacity.js";
import { runBoundedProcess } from "./bounded-process.js";
import { BotComputerError } from "./types.js";

export interface VmStatPages {
  pageSize: number;
  free: number;
  inactive: number;
  purgeable: number;
}

/**
 * Parse `/usr/bin/vm_stat`:
 *
 *   Mach Virtual Memory Statistics: (page size of 16384 bytes)
 *   Pages free:                               12345.
 *   Pages inactive:                          123456.
 *   Pages purgeable:                           4321.
 */
export function parseVmStat(stdout: string): VmStatPages {
  const pageSize = /page size of (\d+) bytes/u.exec(stdout)?.[1];
  const pages = (label: string): number => {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, "mu").exec(stdout);
    if (!match) throw new Error(`vm_stat did not report ${label} pages.`);
    return Number(match[1]);
  };
  if (!pageSize) throw new Error("vm_stat did not report its page size.");
  const result = { pageSize: Number(pageSize), free: pages("free"), inactive: pages("inactive"), purgeable: pages("purgeable") };
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("vm_stat reported an unreadable number.");
  }
  if (result.pageSize === 0) throw new Error("vm_stat reported a zero page size.");
  return result;
}

/** Memory a new VM can take without pushing the Mac into swap: free plus inactive plus purgeable pages. */
export function availableMemoryBytes(pages: VmStatPages): number {
  return (pages.free + pages.inactive + pages.purgeable) * pages.pageSize;
}

export async function readAvailableMemoryBytes(signal?: AbortSignal): Promise<number> {
  const result = await runBoundedProcess("/usr/bin/vm_stat", [], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    signal,
    timeoutMs: 5_000,
    maxStdoutBytes: 16 * 1024,
    overflow: "fail",
  });
  if (result.timedOut || result.exitCode !== 0) throw new Error("vm_stat did not answer.");
  return availableMemoryBytes(parseVmStat(result.stdout));
}

/**
 * Bytes a directory tree really occupies (allocated blocks, so sparse VM disks
 * count what they use, not their nominal 100 GB). Symlinks are not followed.
 */
export async function allocatedBytes(root: string, limitEntries = 20_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > limitEntries) return;
      const full = path.join(dir, entry.name);
      try {
        const info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        total += typeof info.blocks === "number" && info.blocks > 0 ? info.blocks * 512 : info.size;
        if (info.isDirectory()) await walk(full);
      } catch {
        // A file removed mid-walk counts as gone.
      }
    }
  };
  await walk(root);
  return total;
}

export interface BotComputerResourceProbe {
  freeDiskBytes(dir: string): Promise<number>;
  availableMemoryBytes(signal?: AbortSignal): Promise<number>;
}

export const systemResourceProbe: BotComputerResourceProbe = {
  freeDiskBytes: statfsAvailableBytes,
  availableMemoryBytes: readAvailableMemoryBytes,
};

/**
 * Refuse with a message the person can act on when the Mac lacks the disk or
 * memory a step needs. Checked before Set up and before every start.
 */
export async function requireResources(
  probe: BotComputerResourceProbe,
  needs: { dir: string; diskBytes?: number; memoryBytes?: number; signal?: AbortSignal },
): Promise<void> {
  if (needs.diskBytes !== undefined && needs.diskBytes > 0) {
    const free = await probe.freeDiskBytes(needs.dir);
    if (free < needs.diskBytes) {
      throw new BotComputerError(
        "low_disk",
        `Bot computers need about ${formatHarnessBytes(needs.diskBytes)} of free disk space; this Mac has ${formatHarnessBytes(free)}. Free up space and try again.`,
      );
    }
  }
  if (needs.memoryBytes !== undefined && needs.memoryBytes > 0) {
    let available: number;
    try {
      available = await probe.availableMemoryBytes(needs.signal);
    } catch (error) {
      if (error instanceof BotComputerError) throw error;
      throw new BotComputerError("low_memory", "Aiden couldn't check this Mac's free memory, so it didn't start the computer.");
    }
    if (available < needs.memoryBytes) {
      throw new BotComputerError(
        "low_memory",
        `A Bot computer needs about ${formatHarnessBytes(needs.memoryBytes)} of free memory; this Mac has ${formatHarnessBytes(available)} free. Quit some apps or stop another Bot's computer.`,
      );
    }
  }
}
