import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
  appendChatMessageWithReconciliation,
  isAppendReconciliationRequiredError,
} from "./chat-append-commit.js";
import { AidenOperationUnknownOutcomeError } from "./aiden-remote-operation-contract.js";
import type { PiRuntimeQueueReceipt } from "./pi-agent-runtime-harness.js";
import type { Chat, ChatMessage } from "./types.js";
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
  agent: {
    queueAdmissionBlocked(): "not-active" | "cancelled" | "capacity" | undefined;
    queueSteer(message: AgentMessage): PiRuntimeQueueReceipt;
    queueFollowUp(message: AgentMessage): PiRuntimeQueueReceipt;
  };
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
    if (generation.cancelRequested || deps.isChatDeleting(generation.chatId)) {
      return { admitted: false, reason: "cancelled", committed: false };
    }
    const blocked = generation.agent.queueAdmissionBlocked();
    if (blocked) {
      return { admitted: false, reason: rejectionReason(blocked), committed: false };
    }
    const messageId = newMessageId();
    try {
      await appendChatMessageWithReconciliation({
        messageId,
        append: () =>
          deps.appendMessage(
            generation.chatId,
            { id: messageId, role: "user", content: input.text },
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
    if (deps.active.get(input.streamId) !== generation) {
      return { admitted: false, reason: "run_not_active", committed: true, messageId };
    }
    if (generation.cancelRequested) {
      return { admitted: false, reason: "cancelled", committed: true, messageId };
    }
    const message: AgentMessage = { role: "user", content: input.text, timestamp: now() };
    const receipt =
      input.mode === "steer"
        ? generation.agent.queueSteer(message)
        : generation.agent.queueFollowUp(message);
    if (!receipt.accepted) {
      return {
        admitted: false,
        reason: rejectionReason(receipt.reason),
        committed: true,
        messageId,
      };
    }
    return { admitted: true, queue: receipt.queue, committed: true, messageId };
  }

  return { admit };
}
