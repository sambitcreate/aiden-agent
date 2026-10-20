// Bot hand-off cards waiting on the person, keyed by `waitId` (plan §4.3).
//
// Built like `bot-questions.ts`. The asking side (the `hand_off` tool, a rule
// in `beforeTool`, `sign_in`) persists its `waitId` in a tool-task memo, so a
// card re-asked after a restart keeps its id, and an answer arrives by
// `waitId` from any desktop window or paired device. The first valid answer
// wins and is applied once.
//
// Stopping the turn (Stop, Dismiss, delete, quit) withdraws the card and
// rejects the wait with the abort reason, so nothing is recorded. After a quit
// or crash, Resume asks again under the same `waitId`.

import {
  botHandoffAnswerOf,
  type BotHandoffAnswer,
  type BotPendingHandoff,
} from "../../../renderer/shared/bot-handoffs.js";
import type { BotRuleHandoffRequest } from "./bot-extension.js";

export interface BotHandoffRequest extends BotPendingHandoff {
  signal: AbortSignal | undefined;
}

/** The card a rule opens instead of running a call (plan §4.4): an action card naming its rule. */
export function ruleHandoffRequest(request: BotRuleHandoffRequest): BotHandoffRequest {
  return {
    botId: request.botId,
    waitId: request.waitId,
    toolCallId: request.toolCallId,
    kind: "action",
    action: request.action,
    why: request.why,
    source: "rule",
    rule: { id: request.rule.id, label: request.rule.label },
    signal: request.signal,
  };
}

/**
 * - `answered`: the answer settled the card.
 * - `not_waiting`: nothing waits under that `waitId` for that Bot (answered
 *   elsewhere, withdrawn, or never asked).
 * - `invalid`: the card waits, but the value is not exactly
 *   `{ outcome: "done" | "skipped", note? }`. The card keeps waiting.
 */
export type BotHandoffAnswerOutcome = "answered" | "not_waiting" | "invalid";

export interface BotHandoffs {
  /** Show the card. Resolves with the answer; rejects with the abort reason when `signal` aborts. */
  request(request: BotHandoffRequest): Promise<BotHandoffAnswer>;
  /** Settle the card `waitId` of `botId`; the first valid answer wins. */
  answer(botId: string, waitId: string, value: unknown): BotHandoffAnswerOutcome;
  /** Cards waiting on the person, oldest first; for one Bot when `botId` is given. */
  pending(botId?: string): BotPendingHandoff[];
  get(botId: string, waitId: string): BotPendingHandoff | undefined;
  /** Called with the Bot id whenever its waiting cards change (opened, answered, withdrawn). */
  onChange(listener: (botId: string) => void): () => void;
  /** Called once per settled card: with the answer, or `null` when it was withdrawn (abort, asked again). */
  onSettled(listener: (prompt: BotPendingHandoff, answer: BotHandoffAnswer | null) => void): () => void;
}

interface Waiting {
  prompt: BotPendingHandoff;
  settle(answer: BotHandoffAnswer | null, reason?: unknown): void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The hand-off was withdrawn.", "AbortError");
}

/** The card as every surface sees it: the request without its signal, and no empty optional fields. */
function promptOf(request: BotHandoffRequest): BotPendingHandoff {
  return {
    botId: request.botId,
    waitId: request.waitId,
    toolCallId: request.toolCallId,
    kind: request.kind,
    action: request.action,
    ...(request.why === undefined ? {} : { why: request.why }),
    ...(request.open === undefined ? {} : { open: { url: request.open.url } }),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    ...(request.target === undefined ? {} : { target: request.target }),
    source: request.source,
    ...(request.rule === undefined ? {} : { rule: { id: request.rule.id, label: request.rule.label } }),
  };
}

function each<T extends unknown[]>(listeners: ReadonlySet<(...args: T) => void>, ...args: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch {
      // A listener failure must not change how the card settles.
    }
  }
}

export function createBotHandoffs(): BotHandoffs {
  const waiting = new Map<string, Waiting>();
  const changeListeners = new Set<(botId: string) => void>();
  const settledListeners = new Set<(prompt: BotPendingHandoff, answer: BotHandoffAnswer | null) => void>();

  return {
    request(request) {
      if (request.signal?.aborted) return Promise.reject(abortReason(request.signal));
      const prompt = promptOf(request);
      // A wait under the same id can only be a stale invocation of the same
      // call that nobody can answer any more: withdraw it before asking again.
      waiting.get(request.waitId)?.settle(null, new DOMException("The hand-off was asked again.", "AbortError"));
      return new Promise<BotHandoffAnswer>((resolve, reject) => {
        const onAbort = () => settle(null, abortReason(request.signal!));
        const settle = (answer: BotHandoffAnswer | null, reason?: unknown) => {
          if (waiting.get(request.waitId)?.prompt !== prompt) return;
          waiting.delete(request.waitId);
          request.signal?.removeEventListener("abort", onAbort);
          each(changeListeners, prompt.botId);
          each(settledListeners, prompt, answer);
          if (answer) resolve(answer);
          else reject(reason);
        };
        waiting.set(request.waitId, { prompt, settle });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        each(changeListeners, prompt.botId);
      });
    },

    answer(botId, waitId, value) {
      const entry = waiting.get(waitId);
      if (!entry || entry.prompt.botId !== botId) return "not_waiting";
      const answer = botHandoffAnswerOf(value);
      if (!answer) return "invalid";
      entry.settle(answer);
      return "answered";
    },

    pending(botId) {
      const all = [...waiting.values()].map((entry) => entry.prompt);
      return botId === undefined ? all : all.filter((prompt) => prompt.botId === botId);
    },

    get(botId, waitId) {
      const prompt = waiting.get(waitId)?.prompt;
      return prompt?.botId === botId ? prompt : undefined;
    },

    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    onSettled(listener) {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
  };
}
