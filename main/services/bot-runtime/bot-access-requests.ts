import { randomUUID } from "node:crypto";
import {
  botAccessAuthorizationOf,
  botPendingAccessRequestOf,
  type BotAccessAuthorization,
  type BotAccessChoice,
  type BotPendingAccessRequest,
} from "../../../renderer/shared/bot-access-requests.js";
export type { BotAccessAuthorization } from "../../../renderer/shared/bot-access-requests.js";
export interface BotAccessRequestPrompt extends BotPendingAccessRequest {
  logicalRequestId: string;
  authorization: BotAccessAuthorization;
  grant?: { folderPath: string; rootId?: string };
  /** Main-only live owner. Never persisted, projected or restored from a memo. */
  owner?: { signal: AbortSignal; deadline: number; validate(): Promise<void> };
}
export type BotAccessAnswerOutcome = "answered" | "not_waiting" | "invalid";
export interface BotAccessRequests {
  request(
    prompt: Omit<BotAccessRequestPrompt, "waitId"> & { signal: AbortSignal | undefined },
  ): Promise<{ choice: BotAccessChoice; waitId: string }>;
  answer(
    botId: string,
    waitId: string,
    choice: BotAccessChoice,
    authorize: (prompt: BotAccessRequestPrompt, choice: BotAccessChoice) => Promise<void>,
  ): Promise<BotAccessAnswerOutcome>;
  pending(botId?: string): BotPendingAccessRequest[];
  get(botId: string, waitId: string): BotPendingAccessRequest | undefined;
  onChange(listener: (botId: string) => void): () => void;
}
function publicPrompt(prompt: BotAccessRequestPrompt): BotPendingAccessRequest {
  return {
    botId: prompt.botId,
    waitId: prompt.waitId,
    toolCallId: prompt.toolCallId,
    target: prompt.target,
    label: prompt.label,
    ...(prompt.place === undefined ? {} : { place: prompt.place }),
    why: prompt.why,
    choices: [...prompt.choices],
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
interface Waiting {
  prompt: BotAccessRequestPrompt;
  fingerprint: string;
  claimed: boolean;
  promise: Promise<{ choice: BotAccessChoice; waitId: string }>;
  settle(choice?: BotAccessChoice, reason?: unknown): void;
}
export function createBotAccessRequests(): BotAccessRequests {
  const waiting = new Map<string, Waiting>(),
    logical = new Map<string, string>();
  const listeners = new Set<(botId: string) => void>();
  const notify = (botId: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(botId);
      } catch {
        /* Observers cannot affect a decision. */
      }
    }
  };
  return {
    request(request) {
      if (request.signal?.aborted) return Promise.reject(request.signal.reason);
      const { signal, owner, ...data } = request;
      const fingerprint = JSON.stringify(data),
        key = JSON.stringify([request.botId, request.logicalRequestId]);
      const previous = waiting.get(logical.get(key) ?? "");
      if (previous?.fingerprint === fingerprint) return previous.promise;
      previous?.settle(
        undefined,
        new Error("The authorization changed. This request was asked again."),
      );
      const waitId = randomUUID();
      const prompt = Object.freeze({
        ...freeze(structuredClone(data)),
        ...(owner ? { owner: Object.freeze({ ...owner }) } : {}),
        waitId,
      });
      if (
        !botPendingAccessRequestOf(publicPrompt(prompt)) ||
        !botAccessAuthorizationOf(prompt.authorization) ||
        JSON.stringify(prompt.choices) !== JSON.stringify(prompt.authorization.choices)
      )
        return Promise.reject(new Error("Invalid Bot access request."));
      let resolve!: (answer: { choice: BotAccessChoice; waitId: string }) => void,
        reject!: (reason: unknown) => void;
      const promise = new Promise<{ choice: BotAccessChoice; waitId: string }>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => entry.settle(undefined, signal?.reason);
      const entry: Waiting = {
        prompt,
        fingerprint,
        claimed: false,
        promise,
        settle(choice, reason) {
          if (waiting.get(waitId) !== entry) return;
          waiting.delete(waitId);
          if (logical.get(key) === waitId) logical.delete(key);
          signal?.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
          notify(prompt.botId);
          if (choice) resolve({ choice, waitId });
          else reject(reason);
        },
      };
      waiting.set(waitId, entry);
      logical.set(key, waitId);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (owner) {
        timer = setTimeout(
          () => entry.settle(undefined, new Error("This access request expired.")),
          Math.max(0, owner.deadline - Date.now()),
        );
        timer.unref();
      }
      notify(prompt.botId);
      return promise;
    },
    async answer(botId, waitId, choice, authorize) {
      const entry = waiting.get(waitId);
      if (!entry || entry.prompt.botId !== botId || entry.claimed) return "not_waiting";
      if (!entry.prompt.choices.includes(choice)) return "invalid";
      entry.claimed = true;
      try {
        await authorize(entry.prompt, choice);
        if (waiting.get(waitId) !== entry) return "not_waiting";
        entry.settle(choice);
        return "answered";
      } catch (error) {
        entry.claimed = false;
        throw error;
      }
    },
    pending: (botId) =>
      [...waiting.values()]
        .filter((entry) => botId === undefined || entry.prompt.botId === botId)
        .map((entry) => publicPrompt(entry.prompt)),
    get(botId, waitId) {
      const entry = waiting.get(waitId);
      return entry?.prompt.botId === botId ? publicPrompt(entry.prompt) : undefined;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
