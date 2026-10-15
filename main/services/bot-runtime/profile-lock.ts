// Exclusive per-profile lock for the durable Bot runtime.
//
// Pi Durable storage has no cross-process locking: one process must own a
// Bot's `session.sqlite` at a time. Every Bot harness in a profile is opened
// only while this process holds `<profile>/bots/runtime.lock`. A second Aiden
// process (or anything else that tries to host Bots) is refused instead of
// opening the same databases concurrently.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncDirectory, writeFileAtomic } from "../durable-fs.js";

export const BOT_PROFILE_LOCK_FILE = "runtime.lock";

export type ProfileLockResult =
  | { ok: true; release(): Promise<void> }
  | { ok: false; reason: "held_by_live_process"; pid: number };

interface LockRecord {
  pid: number;
  startedAt: number;
  token: string;
}

/** Tokens of locks this process currently holds, so a same-process reacquire is refused too. */
const heldTokens = new Set<string>();
const MAX_ATTEMPTS = 4;

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.startedAt === "number" &&
      typeof value.token === "string"
    ) {
      return { pid: value.pid, startedAt: value.startedAt, token: value.token };
    }
  } catch {
    // A torn or foreign file is treated as stale below.
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock whose holder is still alive. Our own pid counts only for a lock this process took. */
function isLiveHolder(record: LockRecord): boolean {
  if (record.pid === process.pid) return heldTokens.has(record.token);
  return processIsAlive(record.pid);
}

async function readLock(file: string): Promise<{ raw: string; record: LockRecord | null } | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return { raw, record: parseLockRecord(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Remove a stale lock without deleting a fresh one another process published
 * meanwhile: move it aside under a unique name, and only discard it when the
 * moved bytes are the stale bytes we judged.
 */
async function reclaimStaleLock(dir: string, file: string, staleRaw: string): Promise<void> {
  const aside = path.join(dir, `.${BOT_PROFILE_LOCK_FILE}.stale-${randomUUID()}`);
  try {
    await fs.rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await fs.readFile(aside, "utf8").catch(() => null);
  if (moved === staleRaw || moved === null) {
    await fs.rm(aside, { force: true });
    return;
  }
  // We moved a lock that someone else just published; put it back if the
  // name is still free. Losing that race means the other process's lock was
  // already replaced by a third one, which then owns the profile.
  try {
    await fs.link(aside, file);
  } catch {
    // EEXIST: a newer lock is in place.
  }
  await fs.rm(aside, { force: true });
}

/**
 * Acquire the exclusive Bot runtime lock in `dir` (the profile's `bots/`
 * directory). A lock held by a live process is refused; a lock left by a dead
 * process is reclaimed.
 */
export async function acquireBotProfileLock(dir: string): Promise<ProfileLockResult> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, BOT_PROFILE_LOCK_FILE);
  const record: LockRecord = { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
  const raw = `${JSON.stringify(record)}\n`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await writeFileAtomic(file, raw, { exclusive: true, mode: 0o600 });
      heldTokens.add(record.token);
      return { ok: true, release: createRelease(dir, file, record) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readLock(file);
    if (existing === null) continue;
    if (existing.record !== null && isLiveHolder(existing.record)) {
      return { ok: false, reason: "held_by_live_process", pid: existing.record.pid };
    }
    await reclaimStaleLock(dir, file, existing.raw);
  }
  const holder = await readLock(file);
  return { ok: false, reason: "held_by_live_process", pid: holder?.record?.pid ?? 0 };
}

function createRelease(dir: string, file: string, record: LockRecord): () => Promise<void> {
  let released: Promise<void> | null = null;
  return () => {
    released ??= (async () => {
      heldTokens.delete(record.token);
      const current = await readLock(file);
      // Never delete a lock another process reclaimed after ours went stale.
      if (current?.record?.token !== record.token) return;
      await fs.rm(file, { force: true });
      await syncDirectory(dir).catch(() => undefined);
    })();
    return released;
  };
}
