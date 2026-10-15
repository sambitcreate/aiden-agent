// One process must own every Bot session database in a profile. The permanent
// OS flock guard is authoritative; runtime.lock is diagnostic legacy metadata.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { desktopLeaseHelperPath, tryAcquireProcessLifetimeLock } from "../process-lifetime-lock.js";
import { syncDirectory, writeFileAtomic } from "../durable-fs.js";

export const BOT_PROFILE_LOCK_FILE = "runtime.lock";
export const BOT_PROFILE_GUARD_FILE = "runtime.lease.lock";

export type ProfileLockResult =
  | { ok: true; release(): Promise<void> }
  | { ok: false; reason: "held_by_live_process"; pid: number };

interface LockRecord {
  pid: number;
  startedAt: number;
  token: string;
  protocol?: "flock-v1";
}

const reservedProfiles = new Set<string>();

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        typeof value.startedAt === "number" && typeof value.token === "string") {
      return { pid: value.pid, startedAt: value.startedAt, token: value.token,
        ...(value.protocol === "flock-v1" ? { protocol: "flock-v1" as const } : {}) };
    }
  } catch { /* malformed legacy metadata */ }
  return null;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readRecord(file: string): Promise<LockRecord | null> {
  try { return parseLockRecord(await fs.readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Acquire before any Bot session database is opened. */
export async function acquireBotProfileLock(dir: string): Promise<ProfileLockResult> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(dir);
  const file = path.join(canonical, BOT_PROFILE_LOCK_FILE);
  if (reservedProfiles.has(canonical)) return { ok: false, reason: "held_by_live_process", pid: process.pid };
  reservedProfiles.add(canonical);
  let releaseGuard: (() => void) | null = null;
  let published = false;
  let replacedLegacy = false;
  try {
    releaseGuard = tryAcquireProcessLifetimeLock(path.join(canonical, BOT_PROFILE_GUARD_FILE), desktopLeaseHelperPath());
    if (!releaseGuard) {
      const owner = await readRecord(file);
      return { ok: false, reason: "held_by_live_process", pid: owner?.pid ?? 0 };
    }
    const legacy = await readRecord(file);
    // An old binary does not honor the guard. A live legacy record must not
    // be displaced during an upgrade, even though mixed-version use is unsafe.
    if (legacy && legacy.protocol !== "flock-v1" && processIsAlive(legacy.pid)) {
      return { ok: false, reason: "held_by_live_process", pid: legacy.pid };
    }
    await fs.rm(file, { force: true });
    replacedLegacy = true;
    const record: LockRecord = { protocol: "flock-v1", pid: process.pid, startedAt: Date.now(), token: randomUUID() };
    await writeFileAtomic(file, `${JSON.stringify(record)}\n`, { exclusive: true, mode: 0o600 });
    published = true;
    let released: Promise<void> | null = null;
    const heldGuard = releaseGuard;
    return {
      ok: true,
      release: () => {
        released ??= (async () => {
          try {
            await fs.rm(file, { force: true });
            await syncDirectory(canonical).catch(() => undefined);
          } finally {
            heldGuard();
            reservedProfiles.delete(canonical);
          }
        })();
        return released;
      },
    };
  } finally {
    if (!published) {
      try { if (replacedLegacy) await fs.rm(file, { force: true }); }
      finally {
        releaseGuard?.();
        reservedProfiles.delete(canonical);
      }
    }
  }
}
