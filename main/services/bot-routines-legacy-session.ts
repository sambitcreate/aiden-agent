/**
 * TEMPORARY adapter: Bot routine ports over the pre-durable Bot chat send path.
 *
 * Remove this file when the per-Bot `BotSessionService` (Bots rework plan,
 * Task 1.3) lands, and point `botRoutinePorts()` in
 * `scheduled-bot-routines-main.ts` at that service instead.
 *
 * It submits a routine as a user turn in the Bot's canonical chat through
 * `llmClient.start`, which still enforces the Bot's own runtime authority,
 * model, managed home and tool policy. Known gaps the real service closes:
 * - there is no "interrupted" state here, so `state` reports only
 *   idle / needs_model;
 * - request-id dedupe is in memory only (lost on restart);
 * - `markSilent` cannot hide the reply: the legacy chat store derives preview
 *   and unread from stored messages. Notifications are still suppressed by
 *   the routine executor.
 */
import { randomUUID } from "node:crypto";
import { APPROVAL_TOOL_NAMES } from "./coding-tools.js";
import { botApplicationService } from "./bot-application-service-main.js";
import { chatStore } from "./chat-store.js";
import { llmClient } from "./llm-client.js";
import { SCHEDULE_TOOL_NAME } from "./schedule-tool.js";
import { ipcMain } from "../platform.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import type { BotRoutinePorts, BotRoutineSubmissionOutcome } from "./bot-routines-port.js";
import type { ChatDone, ChatError } from "./types.js";

const DEDUPE_LIMIT = 512;
// Nobody can answer an approval or question prompt for an unattended turn,
// and a routine run must never create routines.
const UNATTENDED_EXCLUDED_TOOLS = new Set<string>([
  SCHEDULE_TOOL_NAME,
  "ask_user_question",
  ...APPROVAL_TOOL_NAMES,
]);

function backgroundOwner(streamId: string) {
  let destroyed = false;
  let settle: ((payload: ChatDone | ChatError) => void) | undefined;
  const terminal = new Promise<ChatDone | ChatError>((resolve) => {
    settle = resolve;
  });
  const owner: ChatGenerationOwner = {
    id: 0,
    documentId: `bot-routine:${streamId}`,
    isDestroyed: () => destroyed,
    send: (channel: NotificationChannel, payload: unknown) => {
      if (destroyed) throw new Error("The routine turn is no longer active.");
      if (channel === "chat:done" || channel === "chat:error") {
        settle?.(payload as ChatDone | ChatError);
      }
    },
    onInvalidated: () => () => undefined,
  };
  return { owner, terminal, destroy: () => void (destroyed = true) };
}

export function createLegacyBotRoutineSession(): BotRoutinePorts {
  const submissionsByRequest = new Map<string, string>();
  const outcomes = new Map<string, Promise<BotRoutineSubmissionOutcome>>();
  const streams = new Map<string, string>();

  const canonicalChat = async (botId: string) => {
    const chat = await botApplicationService.getCanonicalChat(botId);
    if (!chat) throw new Error("This Bot's chat is not ready yet.");
    return chat;
  };

  const remember = (requestId: string, submissionId: string) => {
    submissionsByRequest.set(requestId, submissionId);
    while (submissionsByRequest.size > DEDUPE_LIMIT) {
      const oldest = submissionsByRequest.keys().next().value;
      if (oldest === undefined) break;
      const submissionId = submissionsByRequest.get(oldest);
      submissionsByRequest.delete(oldest);
      if (submissionId) {
        outcomes.delete(submissionId);
        streams.delete(submissionId);
      }
    }
  };

  return {
    async state(botId) {
      const chat = await canonicalChat(botId);
      if (!chat.providerId || !chat.model) return { kind: "needs_model" };
      return { kind: "idle" };
    },

    async send(botId, input) {
      const existing = submissionsByRequest.get(input.requestId);
      if (existing) return { submissionId: existing, deduped: true };
      const chat = await canonicalChat(botId);
      if (!chat.providerId || !chat.model) {
        throw new Error("This Bot needs an AI model before its routines can run.");
      }
      const submissionId = `routine_${randomUUID()}`;
      const streamId = `stream_${randomUUID()}`;
      const turn = llmClient.beginChatTurn(chat.id, submissionId, `bot-routine:${submissionId}`);
      if (!turn) throw new Error("This Bot is busy with another reply. The routine will try next time.");
      const background = backgroundOwner(streamId);
      let started = false;
      try {
        try {
          await chatStore.appendMessage(
            chat.id,
            { role: "user", content: input.text },
            { providerId: chat.providerId, model: chat.model },
          );
        } finally {
          turn.settleAsyncWork();
        }
        ipcMain.broadcast("chats:metadata-updated", {
          chatId: chat.id,
          workspaceId: chat.workspaceId,
          title: chat.title,
          updatedAt: Date.now(),
        });
        started = await llmClient.start(
          streamId,
          {
            chatId: chat.id,
            workspaceId: chat.workspaceId,
            providerId: chat.providerId,
            model: chat.model,
            messages: [],
          },
          background.owner,
          {
            allowSubagents: false,
            allowComputerUse: false,
            usageSource: "scheduled",
            turnId: submissionId,
            excludeToolNames: UNATTENDED_EXCLUDED_TOOLS,
          },
        );
        if (!started) throw new Error("The routine reply stopped before it began.");
      } catch (error) {
        turn.release();
        background.destroy();
        throw error;
      }
      remember(input.requestId, submissionId);
      streams.set(submissionId, streamId);
      outcomes.set(
        submissionId,
        background.terminal
          .then((terminal): BotRoutineSubmissionOutcome =>
            "message" in terminal
              ? { kind: "failed", error: terminal.message }
              : { kind: "completed", text: terminal.content },
          )
          .finally(() => {
            turn.release();
            background.destroy();
          }),
      );
      return { submissionId, deduped: false };
    },

    async awaitReply(_botId, submissionId, signal) {
      const outcome = outcomes.get(submissionId);
      if (!outcome) return { kind: "failed", error: "This routine reply is no longer tracked." };
      const cancel = () => {
        const streamId = streams.get(submissionId);
        if (streamId) llmClient.cancel(streamId, "scheduled_task_cancel");
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
      return outcome.finally(() => signal.removeEventListener("abort", cancel));
    },

    async markSilent() {
      // See the file header: the legacy chat store cannot hide a stored reply.
    },
  };
}
