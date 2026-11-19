// Per-chat secrets for prompt sections that need an unguessable but stable
// marker, such as the nonce framing AGENTS.md instructions.
//
// A chat's secret is derived from a random per-device key and the chat id, so
// nothing secret is stored in chat records (which reach the renderer, paired
// phones, exports and forks) and every run of one chat on this device agrees.
// The key is never sent anywhere; only values derived from it reach a prompt.

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const PROMPT_SECTION_KEY_FILE = "prompt-section-key";
const KEY = /^[0-9a-f]{64}$/u;

const cached = new Map<string, Buffer>();

function readKey(file: string): Buffer | undefined {
  try {
    const stored = readFileSync(file, "utf8").trim();
    return KEY.test(stored) ? Buffer.from(stored, "hex") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This device's key, kept in `dir` (the app's data folder). The first caller
 * creates it; a concurrent creator's key wins and is read back. When the folder
 * cannot be written the key is random for this process, so markers stay stable
 * within a run and change after a restart.
 */
export function promptSectionDeviceKey(dir: string): Buffer {
  const hit = cached.get(dir);
  if (hit) return hit;
  const file = path.join(dir, PROMPT_SECTION_KEY_FILE);
  let key = readKey(file);
  if (!key) {
    const fresh = randomBytes(32);
    try {
      writeFileSync(file, `${fresh.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      key = fresh;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") key = readKey(file);
      if (!key) {
        // Present but unreadable or malformed: replace it once; otherwise
        // fall back to the process-local key.
        try {
          writeFileSync(file, `${fresh.toString("hex")}\n`, { mode: 0o600 });
        } catch {
          // Unwritable folder.
        }
        key = fresh;
      }
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
