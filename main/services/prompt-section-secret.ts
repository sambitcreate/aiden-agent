// Per-chat secrets for prompt sections that need an unguessable but stable
// marker, such as the nonce framing AGENTS.md instructions.
//
// A chat's secret is derived from a random per-device key and the chat id, so
// nothing secret is stored in chat records (which reach the renderer, paired
// phones, exports and forks) and every run of one chat on this device agrees.
// The key is never sent anywhere; only values derived from it reach a prompt.

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const PROMPT_SECTION_KEY_FILE = "prompt-section-key";
const KEY = /^[0-9a-f]{64}$/u;
const POSIX = process.platform !== "win32";

const cached = new Map<string, Buffer>();
let fallbackLogged = false;

/**
 * The stored key, or undefined when the file is missing, is not a plain file
 * (a symlink is never followed) or does not hold a key. A key others could
 * read is tightened to 0600 first; if that fails it is not trusted.
 */
function readKey(file: string): Buffer | undefined {
  try {
    const info = lstatSync(file);
    if (!info.isFile()) return undefined;
    if (POSIX && (info.mode & 0o077) !== 0) chmodSync(file, 0o600);
    const stored = readFileSync(file, "utf8").trim();
    return KEY.test(stored) ? Buffer.from(stored, "hex") : undefined;
  } catch {
    return undefined;
  }
}

/** A fresh key in a private temp file beside `file`, never at `file` itself. */
function writeTemp(file: string, key: Buffer): string {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  return temp;
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** How long a key writer may hold the lock before others treat it as abandoned. */
const LOCK_STALE_MS = 10_000;
/** How long a process waits for another's lock before using a key for this run only. */
const LOCK_WAIT_MS = 2_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `replace` while holding `<file>.lock`, created exclusively, so only one
 * process at a time can replace the key file; each replacement reads the file
 * again first. A lock left behind by a process that died is broken once it is
 * older than LOCK_STALE_MS. Undefined when the lock stays held past
 * LOCK_WAIT_MS.
 */
function withKeyLock(file: string, replace: () => Buffer | undefined): Buffer | undefined {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) removeQuietly(lock);
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) return undefined;
      pause(20);
      continue;
    }
    try {
      return replace();
    } finally {
      removeQuietly(lock);
    }
  }
}

/**
 * Publishes `key` at `file` only if no key is there yet. The file appears
 * whole (a hard link to, or a rename of, a finished temp file), so a
 * concurrent reader never sees it empty. Returns the key that ends up stored:
 * ours, or the one a concurrent creator published first.
 */
function publishKey(file: string, key: Buffer): Buffer | undefined {
  const temp = writeTemp(file, key);
  try {
    linkSync(temp, file);
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
    // A key is already there, or this volume has no hard links. Unless a
    // valid key is stored, move the finished file into place in one step
    // under the lock, so two processes never each publish their own: the
    // second reads the first one's key. rename replaces a damaged file or a
    // symlink itself rather than writing through it.
    return readKey(file) ?? withKeyLock(file, () => {
      const stored = readKey(file);
      if (stored) return stored;
      renameSync(temp, file);
      return readKey(file);
    });
  } finally {
    removeQuietly(temp);
  }
}

/**
 * This device's key, kept in `dir` (the app's data folder). The first caller
 * creates it and a concurrent creator's key wins and is read back, so two
 * processes sharing the folder agree. When the folder cannot be written the
 * key is random for this process: markers stay stable within a run but change
 * after a restart (an ACP chat with AGENTS.md then replaces its native session
 * once per launch), and that is logged once.
 */
export function promptSectionDeviceKey(dir: string): Buffer {
  const hit = cached.get(dir);
  if (hit) return hit;
  const file = path.join(dir, PROMPT_SECTION_KEY_FILE);
  let key = readKey(file);
  if (!key) {
    const fresh = randomBytes(32);
    try {
      key = publishKey(file, fresh);
    } catch {
      key = undefined;
    }
    if (!key) {
      if (!fallbackLogged) {
        fallbackLogged = true;
        // This module stays Electron-free (the CLI and the harness use it), so it
        // reports through Node's warning channel rather than the app logger.
        process.emitWarning("The app data folder could not store the prompt section key; using a key for this run only.", "PromptSectionKeyWarning");
      }
      key = fresh;
    }
  }
  cached.set(dir, key);
  return key;
}

/** The secret for one chat on this device. */
export function chatPromptSecret(deviceKey: Uint8Array, chatId: string): Buffer {
  return createHmac("sha256", deviceKey).update(`chat-prompt-secret\u0000${chatId}`).digest();
}

/** Forget cached keys (tests). */
export function forgetPromptSectionDeviceKeys(): void {
  cached.clear();
}
