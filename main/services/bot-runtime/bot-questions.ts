// Bot `ask_user_question` prompts, keyed by `waitId`.
//
// A Bot question is the same A–E quick-reply card the legacy chats show. The
// durable tool persists its `waitId` in the tool task's memo, so a question
// re-asked after a restart keeps its id, and an answer arrives by `waitId`
// from any desktop window or paired device. The first valid answer wins.
//
// Stopping the turn (Stop, Dismiss, delete, quit) withdraws the prompt and
// rejects the wait with the abort reason, so the tool records no answer. After
// a quit or crash, Resume asks again under the same `waitId`.

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

export interface BotQuestionRequest extends BotQuestionPrompt {
  signal: AbortSignal | undefined;
}

/**
 * - `answered`: the answer settled the question.
 * - `not_waiting`: nothing waits under that `waitId` for that Bot (answered
 *   elsewhere, withdrawn, or never asked).
 * - `invalid`: the question waits, but the value is not a valid answer to it
 *   (an option it does not have, a question index out of range, ...). The
 *   question keeps waiting.
 */
export type BotQuestionAnswerOutcome = "answered" | "not_waiting" | "invalid";

export interface BotQuestions {
  /** Ask the person. Resolves with their answer; rejects when `signal` aborts. */
  request(request: BotQuestionRequest): Promise<AskUserQuestionResponseV1>;
  /**
   * Settle the question `waitId` of `botId` with `value`, the composer's
   * response shape (`promptId` = `waitId`).
   */
  answer(botId: string, waitId: string, value: unknown): BotQuestionAnswerOutcome;
  /** Questions waiting for an answer, oldest first; for one Bot when `botId` is given. */
  pending(botId?: string): BotQuestionPrompt[];
  /** Called with the Bot id whenever its waiting questions change. */
  onChange(listener: (botId: string) => void): () => void;
}

interface Waiting {
  prompt: BotQuestionPrompt;
  settle(response: AskUserQuestionResponseV1 | null, reason?: unknown): void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The question was withdrawn.", "AbortError");
}

/** The prompt shape the shared response parser validates against. */
function parserPrompt(prompt: BotQuestionPrompt) {
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId: prompt.waitId,
    streamId: "s-bot",
    toolCallId: prompt.toolCallId,
    questions: prompt.questions,
  };
}

export function createBotQuestions(): BotQuestions {
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
      // A wait under the same id can only be a stale invocation of the same
      // call that nobody can answer any more: withdraw it before asking again.
      waiting.get(request.waitId)?.settle(null, new DOMException("The question was asked again.", "AbortError"));
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
        notify(prompt.botId);
      });
    },

    answer(botId, waitId, value) {
      const entry = waiting.get(waitId);
      if (!entry || entry.prompt.botId !== botId) return "not_waiting";
      const response = parseAskUserQuestionResponse(value, parserPrompt(entry.prompt));
      if (!response) return "invalid";
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
