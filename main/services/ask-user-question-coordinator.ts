import { randomUUID } from "node:crypto";
import {
  ASK_USER_QUESTION_VERSION,
  parseAskUserQuestionResponse,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
  type AskUserQuestionV1,
} from "../../renderer/shared/ask-user-question.js";

interface PendingQuestionnaire {
  prompt: AskUserQuestionPromptV1;
  ownerDocumentId: string;
  settle(response: AskUserQuestionResponseV1): void;
}

export class AskUserQuestionCoordinator {
  private readonly pending = new Map<string, PendingQuestionnaire>();
  private readonly detachedStreams = new Set<string>();

  constructor(private readonly publish: (prompt: AskUserQuestionPromptV1) => void) {}

  request(
    descriptor: {
      streamId: string;
      toolCallId: string;
      kind?: AskUserQuestionPromptV1["kind"];
      questions: AskUserQuestionV1[];
    },
    ownerDocumentId: string,
    signal?: AbortSignal,
  ): Promise<AskUserQuestionResponseV1> {
    const prompt: AskUserQuestionPromptV1 = {
      version: ASK_USER_QUESTION_VERSION,
      promptId: `q-${randomUUID()}`,
      ...descriptor,
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
      const aborted = () => finish(cancelled());
      const finish = (response: AskUserQuestionResponseV1) => {
        if (settled) return;
        settled = true;
        this.pending.delete(prompt.promptId);
        signal?.removeEventListener("abort", aborted);
        resolve(response);
      };
      this.pending.set(prompt.promptId, {
        prompt,
        ownerDocumentId,
        settle: finish,
      });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted || this.detachedStreams.has(prompt.streamId)) {
        aborted();
        return;
      }
      try {
        this.publish(prompt);
      } catch {
        finish(cancelled());
      }
    });
  }

  respond(promptId: string, value: unknown, ownerDocumentId: string): boolean {
    const entry = this.pending.get(promptId);
    if (!entry || entry.ownerDocumentId !== ownerDocumentId) return false;
    const response = parseAskUserQuestionResponse(value, entry.prompt);
    if (!response) return false;
    entry.settle(response);
    return true;
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
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
