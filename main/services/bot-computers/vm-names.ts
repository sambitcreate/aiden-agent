import { createHash } from "node:crypto";

/** The shared base every Bot's computer is cloned from. */
export const BOT_COMPUTER_BASE_VM = "aiden-base";

const BOT_VM_PREFIX = "aiden-bot-";

/**
 * A Bot's VM name: `aiden-bot-` plus the first 16 hex digits of the SHA-256 of
 * its id (G17). Bot ids can hold characters Lume treats specially (a `:`
 * makes `lume run` try a registry pull), so the id itself never reaches argv.
 */
export function botComputerVmName(botId: string): string {
  if (typeof botId !== "string" || botId.length === 0) throw new Error("A Bot id is required.");
  return `${BOT_VM_PREFIX}${createHash("sha256").update(botId, "utf8").digest("hex").slice(0, 16)}`;
}

/** Every VM name Aiden creates. Anything else in its storage is not Aiden's. */
export function isAidenVmName(name: string): boolean {
  return name === BOT_COMPUTER_BASE_VM || /^aiden-bot-[0-9a-f]{16}$/u.test(name);
}

/** A staging name for building a new base beside the current one. */
export const BOT_COMPUTER_STAGING_BASE_VM = "aiden-base-next";

export function isLumeVmNameSafe(name: string): boolean {
  return isAidenVmName(name) || name === BOT_COMPUTER_STAGING_BASE_VM;
}
