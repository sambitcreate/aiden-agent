import { randomUUID } from "node:crypto";
import {
  ASK_USER_QUESTION_VERSION,
  parseAskUserQuestionResponse,
  type AskUserQuestionAnswerStatus,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
  type AskUserQuestionV1,
} from "../../renderer/shared/ask-user-question.js";

interface PendingQuestionnaire {
  prompt: AskUserQuestionPromptV1;
  ownerDocumentId: string;
  deadline?: number;
  settle(response: AskUserQuestionResponseV1): void;
}

/**
 * Prompts that stopped waiting at their deadline. Kept briefly so an owner's
 * late answer is reported as expired (and can become a follow-up message)
 * instead of looking like an ownership failure.
 */
const MAX_EXPIRED_PROMPTS = 64;

export type AskUserQuestionRespondOutcome = AskUserQuestionAnswerStatus | "rejected";

export class AskUserQuestionCoordinator {
  private readonly pending = new Map<string, PendingQuestionnaire>();
  private readonly expired = new Map<string, string>();
  private readonly detachedStreams = new Set<string>();

  constructor(private readonly publish: (prompt: AskUserQuestionPromptV1) => void) {}

  request(
    descriptor: {
      streamId: string;
      toolCallId: string;
      questions: AskUserQuestionV1[];
      /** Stop waiting after this long and tell the agent no answer arrived. */
      timeoutMs?: number;
    },
    ownerDocumentId: string,
    signal?: AbortSignal,
  ): Promise<AskUserQuestionResponseV1> {
    const { timeoutMs, ...fields } = descriptor;
    const deadline =
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Date.now() + timeoutMs
        : undefined;
    const prompt: AskUserQuestionPromptV1 = {
      version: ASK_USER_QUESTION_VERSION,
      promptId: `q-${randomUUID()}`,
      ...fields,
      ...(deadline !== undefined ? { expiresAt: new Date(deadline).toISOString() } : {}),
    };
    const cancelled = (): AskUserQuestionResponseV1 => ({
      version: ASK_USER_QUESTION_VERSION,
      promptId: prompt.promptId,
      cancelled: true,
      answers: [],
    });
    if (signal?.aborted || this.detachedStreams.has(prompt.streamId)) {
      return Promise.resolve(cancelled());
    }
    return new Promise<AskUserQuestionResponseV1>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = () => finish(cancelled());
      const finish = (response: AskUserQuestionResponseV1) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pending.delete(prompt.promptId);
        signal?.removeEventListener("abort", aborted);
        if (response.timedOut) this.rememberExpired(prompt.promptId, ownerDocumentId);
        resolve(response);
      };
      this.pending.set(prompt.promptId, {
        prompt,
        ownerDocumentId,
        ...(deadline !== undefined ? { deadline } : {}),
        settle: finish,
      });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted || this.detachedStreams.has(prompt.streamId)) {
        aborted();
        return;
      }
      if (deadline !== undefined) {
        timer = setTimeout(() => finish(timedOut(prompt.promptId)), deadline - Date.now());
        timer.unref?.();
      }
      try {
        this.publish(prompt);
      } catch {
        finish(cancelled());
      }
    });
  }

  /**
   * Settle a prompt from its owner. A prompt whose deadline has passed is
   * settled as timed out even if its timer has not fired yet, so the agent
   * never receives an answer the owner saw as expired.
   */
  respondWithOutcome(
    promptId: string,
    value: unknown,
    ownerDocumentId: string,
  ): AskUserQuestionRespondOutcome {
    const entry = this.pending.get(promptId);
    if (!entry) {
      return this.expired.get(promptId) === ownerDocumentId ? "expired" : "rejected";
    }
    if (entry.ownerDocumentId !== ownerDocumentId) return "rejected";
    if (entry.deadline !== undefined && Date.now() >= entry.deadline) {
      entry.settle(timedOut(promptId));
      return "expired";
    }
    const response = parseAskUserQuestionResponse(value, entry.prompt);
    if (!response) return "rejected";
    entry.settle(response);
    return "answered";
  }

  /** True when the prompt is no longer waiting because of this owner's call. */
  respond(promptId: string, value: unknown, ownerDocumentId: string): boolean {
    return this.respondWithOutcome(promptId, value, ownerDocumentId) !== "rejected";
  }

  cancelStream(streamId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.prompt.streamId !== streamId) continue;
      entry.settle({
        version: ASK_USER_QUESTION_VERSION,
        promptId: entry.prompt.promptId,
        cancelled: true,
        answers: [],
      });
    }
  }

  detachStream(streamId: string): void {
    this.detachedStreams.add(streamId);
    this.cancelStream(streamId);
  }

  releaseStream(streamId: string): void {
    this.cancelStream(streamId);
    this.detachedStreams.delete(streamId);
  }

  shutdown(): void {
    for (const entry of [...this.pending.values()]) this.cancelStream(entry.prompt.streamId);
    this.detachedStreams.clear();
    this.expired.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private rememberExpired(promptId: string, ownerDocumentId: string): void {
    this.expired.set(promptId, ownerDocumentId);
    while (this.expired.size > MAX_EXPIRED_PROMPTS) {
      const oldest = this.expired.keys().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }
}

function timedOut(promptId: string): AskUserQuestionResponseV1 {
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId,
    cancelled: true,
    answers: [],
    timedOut: true,
  };
}
