// Bot memory contracts shared by main, the renderer and Remote (spec 2026-10-09 §5–§8).
// MEMORY.md holds the Bot's own notes; USER.md holds what it knows about the person.

export type BotMemoryTarget = "memory" | "user";
/**
 * `maxEntries` is per store and matches the Remote/native contract
 * (`AIDEN_REMOTE_BOT_MEMORY_STORE_MAX_ENTRIES`), so every view a host can
 * load is one a phone can show.
 */
export const BOT_MEMORY_LIMITS = { memoryChars: 2_200, userChars: 1_375, entryChars: 500, maxEntries: 64 } as const;
export const BOT_MEMORY_ENTRY_DELIMITER = "\n§\n";
/** Conversation entry written by background review / compaction flush. */
export const BOT_MEMORY_REVIEW_ENTRY_KIND = "aiden.memory-review";
export type BotMemorySource = "turn" | "review" | "compaction";
export interface BotMemoryReviewEntryData {
  source: Exclude<BotMemorySource, "turn">;
  added: number;
  targets: BotMemoryTarget[];
  failed?: true;
}
/** `id` = first 16 hex of sha256(target + "\0" + text); content-addressed. */
export interface BotMemoryEntry { id: string; text: string }
export interface BotMemoryStoreView {
  entries: BotMemoryEntry[];
  usedChars: number;
  limitChars: number;
  overBudget: boolean;
}
export interface BotMemoryView {
  botId: string;
  /** First 16 hex of sha256 over both files. */
  revision: string;
  /** False when a file could not be read/decoded; only "clear" is offered. */
  readable: boolean;
  memory: BotMemoryStoreView;
  user: BotMemoryStoreView;
  /** Epoch ms of the newest write, or null when nothing was ever saved. */
  updatedAt: number | null;
}
export type BotMemoryEdit =
  | { kind: "replace"; target: BotMemoryTarget; entryId: string; text: string }
  | { kind: "remove"; target: BotMemoryTarget; entryId: string }
  | { kind: "clear" };
export interface BotMemoryEditInput { botId: string; edit: BotMemoryEdit }
export type BotMemoryEditErrorCode = "entry_not_found" | "over_budget" | "blocked" | "invalid";
export type BotMemoryEditResult =
  | { ok: true; view: BotMemoryView }
  | { ok: false; code: BotMemoryEditErrorCode; message: string; view: BotMemoryView };
export interface BotMemoryChangedEvent { botId: string; revision: string }
export const BOT_MEMORY_CHANNELS = {
  get: "bots:memory:get",       // invoke(botId) → BotMemoryView
  edit: "bots:memory:edit",     // invoke(BotMemoryEditInput) → BotMemoryEditResult
  changed: "bots:memory:changed", // push BotMemoryChangedEvent
} as const;
