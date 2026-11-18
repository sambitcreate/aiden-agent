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
import type { ChatInputSourceV1 } from "../../renderer/shared/chat-input-source.js";
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
  /**
   * The chat's owed next turn, for a run that offers one. Input this run's
   * queue can no longer take, because Pi already ended it, is registered here
   * and becomes the chat's next turn once the run settles.
   */
  owedTurn?: { hold(): ChatOwedInputHold | undefined };
  agent: {
    queueAdmissionBlocked(): "not-active" | "cancelled" | "capacity" | undefined;
    queueSteer(message: AgentMessage, options?: PiRuntimeQueueOptions): PiRuntimeQueueReceipt;
    queueFollowUp(message: AgentMessage, options?: PiRuntimeQueueOptions): PiRuntimeQueueReceipt;
  };
}

/**
 * Keeps a settling run's owed turn open while one input is being saved, so
 * the run cannot finish settling before that input is registered.
 */
export interface ChatOwedInputHold {
  /**
   * Registers saved input as the chat's next turn. False when main can no
   * longer run it (the chat is being deleted, the app is quitting, the run was
   * stopped, or its owed turn already started or closed).
   */
  register(input: OwedChatInput): boolean;
  /** Idempotent; the owed turn starts once the run settled and every hold is released. */
  release(): void;
}

/** One saved input an owed turn answers, with the hook context it was screened with. */
export interface OwedChatInput {
  messageId: string;
  hookContext?: string;
}

/** What the person's UserPromptSubmit hooks made of one mid-flight input. */
export type ChatRunInputScreening = { blocked: string } | { context?: string };

export interface ChatRunInputHooks {
  /** Runs the hooks for this input; never throws (a failed dispatch is no outcome). */
  screen(input: { text: string; messageId: string }): Promise<ChatRunInputScreening>;
  /**
   * Hook context for this one queued input, never saved as the person's
   * words. Called only once the queue has accepted the input; the timestamp
   * is unique among this run's queued inputs and the text pins it further.
   * The saved message id lets the run hand the context to an owed turn if
   * it ends before Pi reads the input.
   */
  attachContext(input: { timestamp: number; text: string; messageId: string }, context: string): void;
}

export interface ChatRunInputAdmissionDeps {
  /** Live foreground generations keyed by stream id. */
  active: ReadonlyMap<string, ChatRunInputGenerationRef>;
  isChatDeleting(chatId: string): boolean;
  appendMessage(
    chatId: string,
    message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
    meta?: {
      isCurrent?: () => boolean;
      /** Host-only: save the input already marked as refused by a hook, in the same write. */
      hookBlockedReason?: string;
    },
  ): Promise<Chat>;
  readChat(chatId: string): Promise<Chat | null>;
  /**
   * The person's steer or follow-up is in the transcript (not a main-owned
   * notice). The Inbox ends the chat's snooze here, as it does for a message
   * the person sends. Not awaited; a throw is the caller's to log.
   */
  onPersonWrote?(chatId: string): void;
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
  /** Aiden Live sent this for the person; the message shows "By voice". */
  inputSource?: ChatInputSourceV1;
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
 * residual race is the run closing between persistence and the synchronous
 * admission call. A run that offers an owed turn is held open across the
 * save, so input its queue no longer takes is registered as the chat's next
 * turn in the same section that commits it, and only then reported as a
 * `follow-up`. Input main cannot register stays as conversation history and
 * the client is told it was committed, never that it was queued.
 *
 * In a chat that runs hooks, UserPromptSubmit screens the input after the
 * probe and before it is saved. A refused input is saved with its blocked
 * mark in the same write, so no saved copy ever lacks it, and is never queued
 * (`invalid`, committed); accepted input carries its hook context to the
 * model on that message only.
 */
export function createChatRunInputAdmission(deps: ChatRunInputAdmissionDeps) {
  const now = deps.now ?? Date.now;
  const newMessageId = deps.newMessageId ?? (() => `message_${randomUUID()}`);
  // The last timestamp each run's queued input used, so no two share one.
  const lastQueuedAt = new WeakMap<ChatRunInputGenerationRef, number>();

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
    const stopped = () => generation.cancelRequested || deps.isChatDeleting(generation.chatId);
    if (stopped()) {
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
      if (stopped()) {
        return { admitted: false, reason: "cancelled", committed: false };
      }
      const blockedNow = hookBlocked ? undefined : generation.agent.queueAdmissionBlocked();
      if (blockedNow) {
        return { admitted: false, reason: rejectionReason(blockedNow), committed: false };
      }
    }
    // A refused input stays visible but marked, so no model ever sees it
    // (the same as a refused prompt that starts a run). It is held out of
    // every projection in this process, and saved already marked.
    if (hookBlocked) holdHookBlockedPrompt(messageId, hookBlocked);
    // Refused input is never answered, so it never needs an owed turn.
    const owedHold = hookBlocked ? undefined : generation.owedTurn?.hold();
    try {
      return await commitAndQueue(input, generation, messageId, screening, stopped, owedHold);
    } finally {
      owedHold?.release();
    }
  }

  async function commitAndQueue(
    input: ChatRunInputAdmissionRequest,
    generation: ChatRunInputGenerationRef,
    messageId: string,
    screening: ChatRunInputScreening | undefined,
    stopped: () => boolean,
    owedHold: ChatOwedInputHold | undefined,
  ): Promise<ChatRunInputAdmissionResult> {
    const hookBlocked = screening && "blocked" in screening ? screening.blocked : undefined;
    const hookContext =
      screening && "context" in screening && screening.context ? screening.context : undefined;
    // Pi already ended the run, so the saved input becomes the chat's next
    // turn, if main can still run one. A stopped run owes nothing.
    const owe = (): ChatRunInputAdmissionResult => {
      if (owedHold && !stopped() && owedHold.register({ messageId, ...(hookContext ? { hookContext } : {}) })) {
        return { admitted: true, queue: "follow-up", committed: true, messageId };
      }
      return { admitted: false, reason: "run_not_active", committed: true, messageId };
    };
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
              ...(input.inputSource && !input.notice ? { inputSource: input.inputSource } : {}),
            },
            {
              isCurrent: () =>
                deps.active.get(input.streamId) === generation && !stopped(),
              ...(hookBlocked ? { hookBlockedReason: hookBlocked } : {}),
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
        reason: stopped() ? "cancelled" : "run_not_active",
        committed: false,
      };
    }
    if (hookBlocked) {
      return { admitted: false, reason: "invalid", committed: true, messageId };
    }
    if (!input.notice) {
      try {
        deps.onPersonWrote?.(generation.chatId);
      } catch {
        // The input is committed either way; the snooze ends with the next wake.
      }
    }
    if (deps.active.get(input.streamId) !== generation) {
      return owe();
    }
    if (stopped()) {
      return { admitted: false, reason: "cancelled", committed: true, messageId };
    }
    const timestamp = Math.max(now(), (lastQueuedAt.get(generation) ?? -Infinity) + 1);
    const message: AgentMessage = { role: "user", content: input.text, timestamp };
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
    if (!receipt.accepted && receipt.reason === "not-active") {
      return owe();
    }
    if (!receipt.accepted) {
      return {
        admitted: false,
        reason: rejectionReason(receipt.reason),
        committed: true,
        messageId,
      };
    }
    lastQueuedAt.set(generation, timestamp);
    // Pi takes queued input at its next turn boundary, never synchronously,
    // so the context is in place before the model can see the message.
    if (hookContext) {
      generation.inputHooks?.attachContext({ timestamp, text: input.text, messageId }, hookContext);
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
