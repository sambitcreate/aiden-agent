import { createHash } from "node:crypto";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { Chat, ChatMeta } from "./types.js";

export class EmptyChatMigrationSnapshotError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("The empty-chat migration snapshot could not be saved safely.");
    this.cause = cause;
    this.name = "EmptyChatMigrationSnapshotError";
  }
}

export interface EmptyChatCandidate { id: string; fingerprint: string }
const fingerprint = (chat: Chat) => createHash("sha256").update(JSON.stringify(chat)).digest("hex");

export interface EmptyChatMigrationState {
  version: 1;
  /** null means the legacy snapshot has not been taken yet. */
  pending: EmptyChatCandidate[] | null;
  complete: boolean;
}

export function isEmptyChatMigrationState(value: unknown): value is EmptyChatMigrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<EmptyChatMigrationState>;
  return state.version === 1 && typeof state.complete === "boolean" &&
    (state.pending === null || (Array.isArray(state.pending) &&
      state.pending.every((candidate) => candidate && typeof candidate === "object" &&
        typeof candidate.id === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(candidate.id) &&
        typeof candidate.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(candidate.fingerprint)) &&
      new Set(state.pending.map((candidate) => candidate.id)).size === state.pending.length)) &&
    (!state.complete || (Array.isArray(state.pending) && state.pending.length === 0));
}

export function isLegacyEmptyWorkspaceChat(
  chat: Chat,
  workspaceIds: ReadonlySet<string>,
  reservedChatIds: ReadonlySet<string>,
): boolean {
  const workspaceId = persistedChatWorkspaceId(chat.workspaceId);
  return chat.messages.length === 0 && chat.botId === undefined &&
    workspaceId !== ASSISTANT_WORKSPACE_ID && workspaceIds.has(workspaceId) &&
    !chat.id.startsWith("telegram-") && !chat.id.startsWith("assistant-") &&
    !reservedChatIds.has(chat.id);
}

/**
 * Startup-only, before any renderer or remote writer starts. Persist the exact
 * legacy candidates before deleting anything: retries must never sweep chats
 * created by newer clients after the first migration attempt.
 */
export async function migrateEmptyWorkspaceChats(deps: {
  load(): Promise<EmptyChatMigrationState>;
  save(state: EmptyChatMigrationState): Promise<void>;
  list(): Promise<ChatMeta[]>;
  get(id: string): Promise<Chat | null>;
  eligible(chat: Chat): Promise<boolean>;
  remove(id: string, assertCurrent: (chat: Chat) => Promise<void>): Promise<void>;
  onPreserved?(error: unknown): void;
}): Promise<number> {
  let state = await deps.load();
  if (!isEmptyChatMigrationState(state)) throw new Error("Invalid empty-chat migration state.");
  if (state.complete) return 0;
  const readCandidate = async (id: string) => {
    try { return await deps.get(id); }
    catch (error) { deps.onPreserved?.(error); return null; }
  };
  if (state.pending === null) {
    try {
      const candidates: EmptyChatCandidate[] = [];
      const seen = new Set<string>();
      for (const meta of await deps.list()) {
        if (seen.has(meta.id)) continue;
        seen.add(meta.id);
        const chat = await readCandidate(meta.id);
        // Snapshot before consulting any external eligibility store. Unknown
        // payloads survive; any stored message is already outside cleanup scope.
        if (chat?.messages.length === 0) candidates.push({ id: chat.id, fingerprint: fingerprint(chat) });
      }
      state = { version: 1, pending: candidates, complete: false };
      await deps.save(state);
    } catch (error) {
      throw new EmptyChatMigrationSnapshotError(error);
    }
  }
  let removed = 0;
  for (const candidate of [...state.pending!]) {
    const { id } = candidate;
    const chat = await readCandidate(id);
    let eligible = false;
    if (chat && fingerprint(chat) === candidate.fingerprint) {
      try { eligible = await deps.eligible(chat); }
      catch (error) { deps.onPreserved?.(error); }
    }
    if (eligible) {
      await deps.remove(id, async (current) => {
        // Cross-store removal calls this again after deleting private stores;
        // do not reopen those stores or re-evaluate eligibility at that point.
        if (current.messages.length !== 0 || fingerprint(current) !== candidate.fingerprint) throw new Error("The empty chat changed during migration.");
      });
      removed++;
    }
    // Eligibility uncertainty preserves this candidate permanently. It cannot
    // keep a pre-snapshot retry window open or sweep newer chats on restart.
    state = { version: 1, pending: state.pending!.filter((entry) => entry.id !== id), complete: false };
    await deps.save(state);
  }
  await deps.save({ version: 1, pending: [], complete: true });
  return removed;
}
