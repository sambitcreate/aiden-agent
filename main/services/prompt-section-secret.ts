// Per-chat secrets for prompt sections that need an unguessable but stable
// marker, such as the nonce framing AGENTS.md instructions.
//
// A chat's secret is derived from a random per-device key and the chat id, so
// nothing secret is stored in chat records (which reach the renderer, paired
// phones, exports and forks) and every run of one chat on this device agrees.
// The key is never sent anywhere; only values derived from it reach a prompt.

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How many places a key may be stored: the key file, then numbered spares
 * beside it for when the ones before are damaged.
 */
const KEY_SLOTS = 8;

function keySlot(dir: string, index: number): string {
  return path.join(
    dir,
    index === 0 ? PROMPT_SECTION_KEY_FILE : `${PROMPT_SECTION_KEY_FILE}.${index}`,
  );
}

/** How long a slot still being written by its creator is waited for. */
const SLOT_WRITE_WAIT_MS = 1_000;
/**
 * An unfinished slot older than this was left by a creator that died between
 * creating and writing it, and is skipped like a damaged one.
 */
const SLOT_ABANDONED_MS = 60_000;
/** The start of a key, as a slot holds it while its creator is writing it. */
const KEY_PREFIX = /^[0-9a-f]{0,64}$/u;

type SlotState = Buffer | "damaged" | "being-written";

/**
 * What `slot` holds. Only on a volume without hard links can a slot be seen
 * unfinished: it is created empty and then written in one small write. Such a
 * slot is waited for briefly and never skipped while its creator may still
 * finish it; a slot that is not a key or the start of one is damaged.
 */
function slotState(slot: string): SlotState {
  const deadline = Date.now() + SLOT_WRITE_WAIT_MS;
  for (;;) {
    const key = readKey(slot);
    if (key) return key;
    let unfinished: boolean;
    try {
      const info = lstatSync(slot);
      unfinished =
        info.isFile() &&
        Date.now() - info.mtimeMs < SLOT_ABANDONED_MS &&
        KEY_PREFIX.test(readFileSync(slot, "utf8"));
    } catch {
      return "damaged";
    }
    if (!unfinished) return "damaged";
    if (Date.now() > deadline) return "being-written";
    pause(20);
  }
}

/**
 * Creates `slot` holding `key` only if nothing is there yet. Undefined when
 * something already is; the caller then reads it.
 */
function createSlot(slot: string, key: Buffer): Buffer | undefined {
  const temp = writeTemp(slot, key);
  try {
    linkSync(temp, slot);
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return undefined;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
  } finally {
    removeQuietly(temp);
  }
  // No hard links on this volume: create the slot exclusively and write it.
  try {
    writeFileSync(slot, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return undefined;
    throw error;
  }
}

/**
 * The device key in `dir`. Every slot is created exclusively and never
 * replaced, so processes racing to create one all read the winner's key, and
 * a damaged slot (or a symlink, which is never followed or written through)
 * is skipped, the same way by every process, for the next one. A damaged key
 * file is left in place rather than replaced: replacing it is what let two
 * processes each publish their own. Nothing waits on another process's lock.
 *
 * Undefined when the folder cannot store a key, or when a slot's creator has
 * not finished writing it (a volume without hard links, and a creator paused
 * between creating and writing it): this run then uses a key of its own and
 * claims no spare, so the slot it finishes is still the key every later
 * launch reads. Only a creator paused longer than SLOT_ABANDONED_MS loses its
 * slot to a spare, and even then later launches read the lowest valid slot.
 */
function storedOrCreatedKey(dir: string, fresh: Buffer): Buffer | undefined {
  for (let index = 0; index < KEY_SLOTS; index += 1) {
    const slot = keySlot(dir, index);
    const stored = readKey(slot);
    if (stored) return stored;
    let exists = true;
    try {
      lstatSync(slot);
    } catch {
      exists = false;
    }
    if (!exists && createSlot(slot, fresh)) return fresh;
    // Damaged, or another process created it first: read what it holds.
    const state = slotState(slot);
    if (state === "being-written") return undefined;
    if (state !== "damaged") return state;
  }
  return undefined;
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
  const fresh = randomBytes(32);
  let key: Buffer | undefined;
  try {
    key = storedOrCreatedKey(dir, fresh);
  } catch {
    key = undefined;
  }
  if (!key) {
    if (!fallbackLogged) {
      fallbackLogged = true;
      // This module stays Electron-free (the CLI and the harness use it), so it
      // reports through Node's warning channel rather than the app logger.
      process.emitWarning(
        "The app data folder did not provide a stored prompt section key; using a key for this run only.",
        "PromptSectionKeyWarning",
      );
    }
    key = fresh;
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
