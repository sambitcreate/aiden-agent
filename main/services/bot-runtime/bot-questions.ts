// Bot `ask_user_question` prompts, keyed by `waitId`.
//
// A Bot question is the same A–E quick-reply card the legacy chats show. The
// durable tool persists its `waitId` in the tool task's memo, so a question
// re-asked after a restart keeps its id, and an answer arrives by `waitId`
// from any desktop window or paired device. The first answer wins.
//
// Stopping the turn (Dismiss, delete, quit) withdraws the prompt and rejects
// the wait with the abort reason, so the tool records no answer and Resume
// asks again under the same `waitId`.

import {
  ASK_USER_QUESTION_VERSION,
  parseAskUserQuestionResponse,
  type AskUserQuestionResponseV1,
  type AskUserQuestionV1,
} from "../../../renderer/shared/ask-user-question.js";

export interface BotQuestionPrompt {
  botId: string;
  waitId: string;
  toolCallId: string;
  questions: AskUserQuestionV1[];
}

export interface BotQuestionRequest {
  botId: string;
  waitId: string;
  toolCallId: string;
  questions: AskUserQuestionV1[];
  signal: AbortSignal | undefined;
}

export interface BotQuestions {
  /** Ask the person. Resolves with their answer; rejects when `signal` aborts. */
  request(request: BotQuestionRequest): Promise<AskUserQuestionResponseV1>;
  /**
   * Settle a waiting question with the answer in `value` (the composer's
   * response shape, `promptId` = `waitId`). `rejected` when nothing waits under
   * `waitId` or `value` is not a valid answer to it.
   */
  answer(waitId: string, value: unknown): "answered" | "rejected";
  /** Questions waiting for an answer, oldest first; for one Bot when `botId` is given. */
  pending(botId?: string): BotQuestionPrompt[];
  /** Called with the Bot id whenever its pending questions change. */
  onChange(listener: (botId: string) => void): () => void;
}

export interface BotQuestionsOptions {
  /** Pending set changed by a publish or a withdrawal, after the listeners ran. */
  publish?(prompt: BotQuestionPrompt): void;
}

interface Waiting {
  prompt: BotQuestionPrompt;
  settle(response: AskUserQuestionResponseV1 | null, reason?: unknown): void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The question was withdrawn.", "AbortError");
}

export function createBotQuestions(options: BotQuestionsOptions = {}): BotQuestions {
  const waiting = new Map<string, Waiting>();
  const listeners = new Set<(botId: string) => void>();

  const notify = (botId: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(botId);
      } catch {
        // A listener failure must not change how the question settles.
      }
    }
  };

  return {
    request(request) {
      if (request.signal?.aborted) return Promise.reject(abortReason(request.signal));
      const prompt: BotQuestionPrompt = {
        botId: request.botId,
        waitId: request.waitId,
        toolCallId: request.toolCallId,
        questions: request.questions,
      };
      return new Promise<AskUserQuestionResponseV1>((resolve, reject) => {
        const onAbort = () => settle(null, abortReason(request.signal!));
        const settle = (response: AskUserQuestionResponseV1 | null, reason?: unknown) => {
          if (waiting.get(request.waitId)?.prompt !== prompt) return;
          waiting.delete(request.waitId);
          request.signal?.removeEventListener("abort", onAbort);
          notify(prompt.botId);
          if (response) resolve(response);
          else reject(reason);
        };
        waiting.set(request.waitId, { prompt, settle });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          options.publish?.(prompt);
        } catch (error) {
          settle(null, error);
          return;
        }
        notify(prompt.botId);
      });
    },

    answer(waitId, value) {
      const entry = waiting.get(waitId);
      if (!entry) return "rejected";
      const response = parseAskUserQuestionResponse(value, {
        version: ASK_USER_QUESTION_VERSION,
        promptId: waitId,
        streamId: "s-bot",
        toolCallId: entry.prompt.toolCallId,
        questions: entry.prompt.questions,
      });
      if (!response) return "rejected";
      entry.settle(response);
      return "answered";
    },

    pending(botId) {
      const all = [...waiting.values()].map((entry) => entry.prompt);
      return botId === undefined ? all : all.filter((prompt) => prompt.botId === botId);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
