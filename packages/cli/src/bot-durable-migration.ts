import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { acquireLease, atomicJson, readJson } from "./state.ts";
import type { createDaemonChats } from "./daemon-chats.ts";
import type { LegacyBotChatFence } from "./legacy-bot-chat-fence.ts";

export const CLI_DURABLE_BOT_MARKER = "bot-durable-v1.json";
export interface CliDurableBotMarker { version: 1; state: "preparing" | "enabled"; backup: string; createdAt: number }
export function cliDurableBotMarker(agentDir: string): CliDurableBotMarker | null {
  const value = readJson<CliDurableBotMarker | null>(join(agentDir, CLI_DURABLE_BOT_MARKER), null);
  if (value !== null && (value.version !== 1 || !["preparing", "enabled"].includes(value.state) || typeof value.backup !== "string")) throw new Error("Invalid durable Bot migration marker. Recover the migration before continuing.");
  return value;
}

/** How long enabling waits for paired devices' in-flight Bot-chat writes before giving up. */
export const CLI_DURABLE_BOT_DRAIN_MS = 30_000;

/** Explicit foreground switch. Leaves all source chats, journals, homes and grants intact. */
export async function enableCliDurableBots(agentDir: string, daemon: ReturnType<typeof createDaemonChats>, fence?: LegacyBotChatFence, drainMs = CLI_DURABLE_BOT_DRAIN_MS) {
  const release = acquireLease(join(agentDir, "bot-durable-migration"));
  try {
  const previous = cliDurableBotMarker(agentDir);
  if (previous?.state === "enabled") return { enabled: true, backup: previous.backup, restartRequired: true };
  const backup = join(agentDir, "bot-migration-backups", randomUUID());
  // Fence new legacy generation before draining an already admitted turn. A
  // device write admitted earlier finishes first; later ones see the marker.
  const writeMarker = async () => atomicJson(join(agentDir, CLI_DURABLE_BOT_MARKER), { version: 1, state: "preparing", backup, createdAt: Date.now() });
  if (fence) await fence.exclusive(writeMarker, drainMs); else await writeMarker();
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const metadata = (await daemon.chatStore.list()).filter((chat) => chat.botId);
  for (const chat of metadata) await daemon.llmClient.cancelChat(chat.id);
  for (const chat of metadata) await daemon.llmClient.waitForChatIdle(chat.id);
  const chats = [];
  for (const chat of metadata) {
    const content = await daemon.chatStore.get(chat.id);
    let journal: string | null = null;
    try { journal = await readFile(daemon.sessionPath(chat.id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    chats.push({ chat: content, journal });
  }
  atomicJson(join(backup, "legacy-chats.json"), { version: 1, chats });
  atomicJson(join(backup, "recovery.json"), { version: 1, createdAt: Date.now(), mode: "preserve_legacy_start_empty", source: "daemon-chats", chatCount: chats.length });
  // Only a complete backup authorizes the new runtime on the next daemon start.
  atomicJson(join(agentDir, CLI_DURABLE_BOT_MARKER), { version: 1, state: "enabled", backup, createdAt: Date.now() });
  return { enabled: true, backup, legacyChatsPreserved: chats.length, restartRequired: true };
  } finally { release(); }
}
