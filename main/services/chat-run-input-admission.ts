import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
  appendChatMessageWithReconciliation,
  isAppendReconciliationRequiredError,
} from "./chat-append-commit.js";
import { holdHookBlockedPrompt } from "./hook-blocked-prompt.js";
import { AidenOperationUnknownOutcomeError } from "./aiden-remote-operation-contract.js";
import type { PiRuntimeQueueOptions, PiRuntimeQueueReceipt } from "./pi-agent-runtime-harness.js";
import type { Chat, ChatMessage } from "./types.js";
import type { AgentNoticeV1 } from "../../renderer/shared/agent-notices.js";
import type {
  ChatRunInputAdmissionResult,
  ChatRunInputMode,
  ChatRunInputRejectionReason,
} from "../../renderer/shared/chat-run-input.js";

export type {
  ChatRunInputAdmissionResult,
  ChatRunInputMode,
  ChatRunInputRejectionReason,
};

export interface ChatRunInputGenerationRef {
  chatId: string;
  owner: { documentId: string };
  cancelRequested: boolean;
  /** Runs that take no mid-flight input (Design Studio). */
  inputClosed?: boolean;
  /**
   * Stop the run's still-running subagents once steering is accepted. Pi
   * delivers steering only after the current tool call returns, so without
   * this a steer would wait for every child to finish.
   */
  stopSubagentsForGuidance?(): void;
  /**
   * The person's UserPromptSubmit hooks, for a chat that runs them. Mid-flight
   * input is the person's prompt too, so it is screened before it is saved
   * or queued, the same as the prompt that started the run.
   */
  inputHooks?: ChatRunInputHooks;
  agent: {
    queueAdmissionBlocked(): "not-active" | "cancelled" | "capacity" | undefined;
    queueSteer(message: AgentMessage, options?: PiRuntimeQueueOptions): PiRuntimeQueueReceipt;
    queueFollowUp(message: AgentMessage, options?: PiRuntimeQueueOptions): PiRuntimeQueueReceipt;
  };
}

/** What the person's UserPromptSubmit hooks made of one mid-flight input. */
export type ChatRunInputScreening = { blocked: string } | { context?: string };

export interface ChatRunInputHooks {
  /** Runs the hooks for this input; never throws (a failed dispatch is no outcome). */
  screen(input: { text: string; messageId: string }): Promise<ChatRunInputScreening>;
  /** Hook context for the queued message with this timestamp only, never saved as the person's words. */
  attachContext(timestamp: number, context: string): void;
  /** Write the saved input's blocked mark; a failed write is reported, and the input stays held in this process. */
  markBlocked(messageId: string, reason: string): Promise<void>;
}

export interface ChatRunInputAdmissionDeps {
  /** Live foreground generations keyed by stream id. */
  active: ReadonlyMap<string, ChatRunInputGenerationRef>;
  isChatDeleting(chatId: string): boolean;
  appendMessage(
    chatId: string,
    message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
    meta?: { isCurrent?: () => boolean },
  ): Promise<Chat>;
  readChat(chatId: string): Promise<Chat | null>;
  now?(): number;
  newMessageId?(): string;
}

export interface ChatRunInputAdmissionRequest {
  streamId: string;
  /** Host-derived integrity cross-check; the generation remains the chat authority. */
  chatId?: string;
  mode: ChatRunInputMode;
  text: string;
  ownerDocumentId?: string;
  /** Main-owned follow-up notice: stored with the message so clients draw it as a card. */
  notice?: AgentNoticeV1;
}

function rejectionReason(
  blocked: "not-active" | "cancelled" | "capacity" | "invalid-message",
): ChatRunInputRejectionReason {
  if (blocked === "cancelled") return "cancelled";
  if (blocked === "capacity") return "capacity";
  if (blocked === "invalid-message") return "invalid";
  return "run_not_active";
}

/**
 * Shared foreground admission boundary for mid-flight user input (Remote Slice
 * 2). Both the Remote `POST /streams/{id}/inputs` route and the desktop IPC
 * surface reach the Pi runtime queues only through here so transcript
 * persistence, owner binding, and cancel/terminal races stay Mac-owned.
 *
 * Ordering: probe the runtime queue first so common rejections leave the
 * client draft unconsumed, then persist the user message, then admit. The
 * only residual race is the run closing between persistence and the
 * synchronous admission call; in that case the committed message stays as
 * conversation history and the client is told it was committed.
 *
 * In a chat that runs hooks, UserPromptSubmit screens the input after the
 * probe and before it is saved. A refused input is saved with its blocked
 * mark and never queued (`invalid`, committed); accepted input carries its
 * hook context to the model on that message only.
 */
export function createChatRunInputAdmission(deps: ChatRunInputAdmissionDeps) {
  const now = deps.now ?? Date.now;
  const newMessageId = deps.newMessageId ?? (() => `message_${randomUUID()}`);

  async function admit(
    input: ChatRunInputAdmissionRequest,
  ): Promise<ChatRunInputAdmissionResult> {
    const generation = deps.active.get(input.streamId);
    if (
      !generation ||
      (input.chatId !== undefined && generation.chatId !== input.chatId) ||
      (input.ownerDocumentId !== undefined &&
        generation.owner.documentId !== input.ownerDocumentId)
    ) {
      return { admitted: false, reason: "run_not_active", committed: false };
    }
    if (generation.inputClosed) {
      return { admitted: false, reason: "run_not_active", committed: false };
    }
    if (generation.cancelRequested || deps.isChatDeleting(generation.chatId)) {
      return { admitted: false, reason: "cancelled", committed: false };
    }
    const blocked = generation.agent.queueAdmissionBlocked();
    if (blocked) {
      return { admitted: false, reason: rejectionReason(blocked), committed: false };
    }
    const messageId = newMessageId();
    // A notice is Aiden's own message, not the person's prompt, so hooks
    // never screen it.
    const screening =
      generation.inputHooks && !input.notice
        ? await generation.inputHooks.screen({ text: input.text, messageId })
        : undefined;
    const hookBlocked = screening && "blocked" in screening ? screening.blocked : undefined;
    if (screening) {
      // The hooks took time; the run may have ended or filled meanwhile.
      if (deps.active.get(input.streamId) !== generation) {
        return { admitted: false, reason: "run_not_active", committed: false };
      }
      if (generation.cancelRequested || deps.isChatDeleting(generation.chatId)) {
        return { admitted: false, reason: "cancelled", committed: false };
      }
      const blockedNow = hookBlocked ? undefined : generation.agent.queueAdmissionBlocked();
      if (blockedNow) {
        return { admitted: false, reason: rejectionReason(blockedNow), committed: false };
      }
    }
    // A refused input stays visible but marked, so no model ever sees it
    // (the same as a refused prompt that starts a run). It is held out of
    // every projection before it is saved, then the mark is written.
    if (hookBlocked) holdHookBlockedPrompt(messageId);
    try {
      await appendChatMessageWithReconciliation({
        messageId,
        append: () =>
          deps.appendMessage(
            generation.chatId,
            {
              id: messageId,
              role: "user",
              content: input.text,
              ...(input.notice ? { notice: input.notice } : {}),
            },
            {
              isCurrent: () =>
                deps.active.get(input.streamId) === generation &&
                !generation.cancelRequested,
            },
          ),
        recover: () => deps.readChat(generation.chatId),
      });
    } catch (error) {
      if (isAppendReconciliationRequiredError(error)) {
        throw new AidenOperationUnknownOutcomeError();
      }
      // The reconciliation helper only rethrows uncommitted appends, so the
      // client draft is genuinely unconsumed here.
      return {
        admitted: false,
        reason: generation.cancelRequested ? "cancelled" : "run_not_active",
        committed: false,
      };
    }
    if (hookBlocked) {
      await generation.inputHooks?.markBlocked(messageId, hookBlocked);
      return { admitted: false, reason: "invalid", committed: true, messageId };
    }
    if (deps.active.get(input.streamId) !== generation) {
      return { admitted: false, reason: "run_not_active", committed: true, messageId };
    }
    if (generation.cancelRequested) {
      return { admitted: false, reason: "cancelled", committed: true, messageId };
    }
    const message: AgentMessage = { role: "user", content: input.text, timestamp: now() };
    if (screening && "context" in screening && screening.context) {
      generation.inputHooks?.attachContext(message.timestamp, screening.context);
    }
    // The transcript already holds this input; Pi must reuse that visible
    // message on emission instead of projecting a second copy.
    const committed = { visibleChatMessageId: messageId };
    let receipt: PiRuntimeQueueReceipt;
    try {
      receipt =
        input.mode === "steer"
          ? generation.agent.queueSteer(message, committed)
          : generation.agent.queueFollowUp(message, committed);
    } catch {
      // The harness pushes onto the accepted queue before invoking Pi; a throw
      // here leaves both delivery and transcript state ambiguous. Keep the
      // idempotency entry in flight rather than recording a false-clean failure.
      throw new AidenOperationUnknownOutcomeError();
    }
    if (!receipt.accepted) {
      return {
        admitted: false,
        reason: rejectionReason(receipt.reason),
        committed: true,
        messageId,
      };
    }
    if (input.mode === "steer") {
      try {
        generation.stopSubagentsForGuidance?.();
      } catch {
        // The guidance is already queued; it still lands when the children end.
      }
    }
    return { admitted: true, queue: receipt.queue, committed: true, messageId };
  }

  return { admit };
}
