import { createHash } from "node:crypto";

/** The shared base every Bot's computer is cloned from. */
export const BOT_COMPUTER_BASE_VM = "aiden-base";

/** The canonical shared Linux computer VM name. */
export const BOT_COMPUTER_SHARED_VM = "aiden-vm-shared";

const BOT_VM_PREFIX = "aiden-bot-";
const DEDICATED_VM_PREFIX = "aiden-vm-";

/**
 * Legacy per-Bot VM name: `aiden-bot-` plus the first 16 hex digits of the
 * SHA-256 of its id (G17). Bot ids can hold characters Lume treats specially
 * (a `:` makes `lume run` try a registry pull), so the id itself never reaches argv.
 */
export function botComputerVmName(botId: string): string {
  if (typeof botId !== "string" || botId.length === 0) throw new Error("A Bot id is required.");
  return `${BOT_VM_PREFIX}${createHash("sha256").update(botId, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * First-class Linux computer VM name: `aiden-vm-shared` for `"shared"`, or
 * `aiden-vm-<16hex>` derived from `computerId` for dedicated computers (G17).
 */
export function botComputerPoolVmName(computerId: string): string {
  if (typeof computerId !== "string" || computerId.length === 0) throw new Error("A computer id is required.");
  if (computerId === "shared") return BOT_COMPUTER_SHARED_VM;
  return `${DEDICATED_VM_PREFIX}${createHash("sha256").update(computerId, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Safe single-segment directory name for a Bot's per-Bot workspace folder
 * (`~/Bots/<dir>` / `/home/aiden-bot/bots/<dir>`), free of path traversal or
 * shell metacharacters.
 */
export function botComputerWorkspaceDirName(botId: string): string {
  if (typeof botId !== "string" || botId.length === 0) throw new Error("A Bot id is required.");
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(botId) && !botId.includes("..")) {
    return botId;
  }
  const prefix = botId
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24);
  const hash = createHash("sha256").update(botId, "utf8").digest("hex").slice(0, 12);
  return prefix ? `${prefix}-${hash}` : `bot-${hash}`;
}

/** Every VM name Aiden creates. Anything else in its storage is not Aiden's. */
export function isAidenVmName(name: string): boolean {
  return (
    name === BOT_COMPUTER_BASE_VM ||
    name === BOT_COMPUTER_SHARED_VM ||
    /^aiden-vm-[0-9a-f]{16}$/u.test(name) ||
    /^aiden-bot-[0-9a-f]{16}$/u.test(name)
  );
}

/** A staging name for building a new base beside the current one. */
export const BOT_COMPUTER_STAGING_BASE_VM = "aiden-base-next";

export function isLumeVmNameSafe(name: string): boolean {
  return isAidenVmName(name) || name === BOT_COMPUTER_STAGING_BASE_VM;
}
