import { createHash, randomUUID } from "node:crypto";
import {
  botAccessAuthorizationOf,
  botPendingAccessRequestOf,
  type BotAccessAuthorization,
  type BotAccessChoice,
  type BotPendingAccessRequest,
} from "../../../renderer/shared/bot-access-requests.js";
export type { BotAccessAuthorization } from "../../../renderer/shared/bot-access-requests.js";
/** Definite refusal before any authority was published. Never use for transient I/O. */
export class BotAccessRequestStaleError extends Error {}
export interface BotAccessRequestPrompt extends BotPendingAccessRequest {
  logicalRequestId: string;
  /** Private identity of the immutable host attempt, never projected. */
  authorizationFingerprint?: string;
  authorization: BotAccessAuthorization;
  grant?: { folderPath: string; rootId?: string };
  /** Main-only live owner. Never persisted, projected or restored from a memo. */
  owner?: { signal: AbortSignal; deadline: number; validate(): Promise<void> };
}
export type BotAccessAnswerOutcome = "answered" | "saved_for_future" | "not_waiting" | "invalid";
export interface BotAccessTallyProof { authorizationFingerprint: string; offered: boolean; decidedAt: number }
export interface BotAccessAuthorizationReceipt {
  savedForFuture?: true;
  hint?: string;
  effectiveChoice?: BotAccessChoice;
  tally?: BotAccessTallyProof;
}
export type BotAccessSettle = (prompt: BotAccessRequestPrompt, choice: BotAccessChoice, receipt: BotAccessAuthorizationReceipt | undefined) => Promise<BotAccessAuthorizationReceipt | undefined>;
export interface BotAccessDecision extends BotAccessAuthorizationReceipt { choice: BotAccessChoice; waitId: string }
export interface BotAccessRequests {
  request(
    prompt: Omit<BotAccessRequestPrompt, "waitId" | "authorizationFingerprint"> & { signal: AbortSignal | undefined },
  ): Promise<BotAccessDecision>;
  answer(
    botId: string,
    waitId: string,
    choice: BotAccessChoice,
    authorize: (prompt: BotAccessRequestPrompt, choice: BotAccessChoice) => Promise<void | BotAccessAuthorizationReceipt>,
    settle?: BotAccessSettle,
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
    ...(prompt.approvalCount === undefined ? {} : { approvalCount: prompt.approvalCount }),
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
  promise: Promise<BotAccessDecision>;
  authorized?: { choice: BotAccessChoice; receipt?: BotAccessAuthorizationReceipt };
  settle(choice?: BotAccessChoice, reason?: unknown, receipt?: BotAccessAuthorizationReceipt): void;
}
export function createBotAccessRequests(): BotAccessRequests {
  const waiting = new Map<string, Waiting>(),
    logical = new Map<string, string>();
  const listeners = new Set<(botId: string) => void>();
  // Acknowledges publication only, never replays authority. Durable restart
  // acknowledgement is backed by the application's journal in main wiring.
  const saved = new Map<string, string>();
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
        authorizationFingerprint: createHash("sha256").update(JSON.stringify({ version: 1, waitId, botId: data.botId, authorization: data.authorization, ownerDeadline: owner?.deadline })).digest("hex"),
      });
      if (
        !botPendingAccessRequestOf(publicPrompt(prompt)) ||
        !botAccessAuthorizationOf(prompt.authorization) ||
        JSON.stringify(prompt.choices) !== JSON.stringify(prompt.authorization.choices)
      )
        return Promise.reject(new Error("Invalid Bot access request."));
      let resolve!: (answer: BotAccessDecision) => void,
        reject!: (reason: unknown) => void;
      const promise = new Promise<BotAccessDecision>((yes, no) => {
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
        settle(choice, reason, receipt) {
          if (waiting.get(waitId) !== entry) return;
          waiting.delete(waitId);
          if (logical.get(key) === waitId) logical.delete(key);
          signal?.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
          notify(prompt.botId);
          if (choice) resolve({ choice, waitId, ...receipt });
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
    async answer(botId, waitId, choice, authorize, settle) {
      if (choice === "always" && saved.get(waitId) === botId) return "saved_for_future";
      const entry = waiting.get(waitId);
      if (!entry || entry.prompt.botId !== botId || entry.claimed) return "not_waiting";
      if (!entry.prompt.choices.includes(choice)) return "invalid";
      entry.claimed = true;
      try {
        if (!entry.authorized) {
          const authorized = await authorize(entry.prompt, choice);
          entry.authorized = { choice: authorized?.savedForFuture ? "always" : authorized?.effectiveChoice ?? choice,
            ...(authorized ? { receipt: structuredClone(authorized) } : {}) };
        }
        const effectiveChoice = entry.authorized.choice;
        const receipt = settle ? await settle(entry.prompt, effectiveChoice, entry.authorized.receipt) : entry.authorized.receipt;
        if (receipt?.savedForFuture) {
          saved.set(waitId, botId);
          if (saved.size > 4096) saved.delete(saved.keys().next().value!);
          // A different tap can recover an earlier Always whose receipt read
          // failed. Settle the actual published decision, never a new decline.
          entry.settle("always", undefined, receipt);
          return "saved_for_future";
        }
        if (effectiveChoice === "always") {
          saved.set(waitId, botId);
          if (saved.size > 4096) saved.delete(saved.keys().next().value!);
        }
        if (waiting.get(waitId) !== entry) return effectiveChoice === "always" ? "saved_for_future" : "not_waiting";
        entry.settle(effectiveChoice, undefined, receipt);
        return "answered";
      } catch (error) {
        if (entry.authorized?.choice === "always") entry.authorized.receipt = { ...entry.authorized.receipt, savedForFuture: true };
        entry.claimed = false;
        if (error instanceof BotAccessRequestStaleError) entry.settle(undefined, error);
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
