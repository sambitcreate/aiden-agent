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
}): Promise<number> {
  let state = await deps.load();
  if (!isEmptyChatMigrationState(state)) throw new Error("Invalid empty-chat migration state.");
  if (state.complete) return 0;
  if (state.pending === null) {
    const candidates: EmptyChatCandidate[] = [];
    for (const meta of await deps.list()) {
      const chat = await deps.get(meta.id);
      // An unreadable/corrupt record is not proof of an empty conversation.
      if (chat && await deps.eligible(chat)) candidates.push({ id: chat.id, fingerprint: fingerprint(chat) });
    }
    state = { version: 1, pending: candidates, complete: false };
    try { await deps.save(state); }
    catch (error) { throw new EmptyChatMigrationSnapshotError(error); }
  }
  let removed = 0;
  for (const candidate of [...state.pending!]) {
    const { id } = candidate;
    const chat = await deps.get(id);
    if (chat && fingerprint(chat) === candidate.fingerprint && await deps.eligible(chat)) {
      await deps.remove(id, async (current) => {
        if (fingerprint(current) !== candidate.fingerprint || !await deps.eligible(current)) throw new Error("The empty chat changed during migration.");
      });
      removed++;
    }
    state = { version: 1, pending: state.pending!.filter((entry) => entry.id !== id), complete: false };
    await deps.save(state);
  }
  await deps.save({ version: 1, pending: [], complete: true });
  return removed;
}
