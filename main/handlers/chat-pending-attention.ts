import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import {
  CHAT_PENDING_ATTENTION_MAX_IDS,
  type ChatPendingAttention,
} from "../../renderer/shared/chat-pending-attention.js";
import {
  pendingAttentionForChat,
  type DetachedPromptLog,
  type InterruptedRunWaits,
  type PendingAttentionRuns,
} from "../services/chat-pending-attention.js";

export interface ChatPendingAttentionHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  runs: PendingAttentionRuns;
  detached: DetachedPromptLog;
  /** Which of these ids are chats this host has. */
  knownChatIds(ids: readonly string[]): Promise<ReadonlySet<string>>;
  /** Saved waits from each chat's interrupted run; chats with none are absent. Never throws. */
  interruptedWaits(chatIds: readonly string[]): Promise<ReadonlyMap<string, InterruptedRunWaits>>;
  /**
   * A dismissal removed a wait. Nothing else reports it, so this tells the
   * Dock badge and the renderer's Inbox to recount.
   */
  onChange?: () => void;
}

function chatIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid chat identifiers.");
  if (value.length > CHAT_PENDING_ATTENTION_MAX_IDS) throw new Error("Too many chat identifiers.");
  for (const id of value) {
    if (!isSafeSubagentIdentifier(id)) throw new Error("Invalid chat identifier.");
  }
  return [...new Set(value as string[])];
}

/**
 * `chats:pendingAttention(ids)`: what each listed local chat is waiting on.
 * Chats this host does not have, and chats waiting on nothing, are left out.
 * `chats:dismissDetachedAttention(id)`: the person dismissed the chat's
 * Unavailable prompts; when any were dropped, `onChange` reports it.
 */
export function registerChatPendingAttentionHandlers<Event>(
  dependencies: ChatPendingAttentionHandlerDependencies<Event>,
): void {
  const { handle } = dependencies;

  handle("chats:pendingAttention", async (_event, ids): Promise<ChatPendingAttention[]> => {
    const requested = chatIds(ids);
    if (requested.length === 0) return [];
    const known = await dependencies.knownChatIds(requested);
    const chats = requested.filter((id) => known.has(id));
    const interrupted = await dependencies.interruptedWaits(chats);
    return chats.flatMap((chatId) => {
      const attention = pendingAttentionForChat(chatId, {
        runs: dependencies.runs,
        detached: dependencies.detached,
        interrupted: interrupted.get(chatId),
      });
      return attention ? [attention] : [];
    });
  });

  handle("chats:dismissDetachedAttention", (_event, id) => {
    if (!isSafeSubagentIdentifier(id)) throw new Error("Invalid chat identifier.");
    if (dependencies.detached.clearChat(id)) dependencies.onChange?.();
  });
}
