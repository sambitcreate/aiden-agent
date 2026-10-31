// A chat whose last reply was still running when Aiden quit or crashed. The
// runtime records every foreground run as an operation: a crash leaves it
// running and the next launch marks it interrupted, and a quit finishes it as
// interrupted. Stop, a finished reply or a new message records a later
// operation, so the chat stops offering Resume. Aiden never resumes on its own.

import type { DurablePiRuntimeOperation } from "./pi-runtime-effect-core.js";
import { parseAskUserQuestions } from "../../renderer/shared/ask-user-question.js";
import {
  INTERRUPTED_WAIT_MAX_AGE_MS,
  INTERRUPTED_WAIT_MAX_SUMMARY_LENGTH,
  type InterruptedWaitV1,
} from "../../renderer/shared/interrupted-reply.js";

type OperationReader = { listOperationsByChat(chatId: string): Promise<DurablePiRuntimeOperation[]> };

/** The chat's latest foreground run when a quit or crash cut it short. */
export async function latestInterruptedRun(
  store: OperationReader,
  chatId: string,
): Promise<DurablePiRuntimeOperation | undefined> {
  let latest: DurablePiRuntimeOperation | undefined;
  for (const operation of await store.listOperationsByChat(chatId)) {
    // Subagent runs record their own operations under the parent chat.
    if (operation.lane !== "foreground") continue;
    if (!latest || operation.startedAt >= latest.startedAt) latest = operation;
  }
  return latest?.state === "interrupted" ? latest : undefined;
}

export async function chatReplyInterrupted(store: OperationReader, chatId: string): Promise<boolean> {
  return (await latestInterruptedRun(store, chatId)) !== undefined;
}

// What a reply was waiting on is saved when the card is shown and removed when
// it settles, except when the host withdraws it while Aiden quits. A crash never settles it. On the
// next launch it counts only if it was asked during the chat's interrupted run.

export type InterruptedWaitRecord = InterruptedWaitV1 & { chatId: string };

export interface InterruptedWaitDatabase {
  version: 1;
  waits: InterruptedWaitRecord[];
}

/** Waits kept across every chat, and per chat; the oldest go first. */
const MAX_INTERRUPTED_WAITS = 100;
const MAX_INTERRUPTED_WAITS_PER_CHAT = 10;

export function emptyInterruptedWaits(): InterruptedWaitDatabase {
  return { version: 1, waits: [] };
}

function shortText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() && Array.from(value).length <= maximum ? value : undefined;
}

function parseInterruptedWait(value: unknown): InterruptedWaitRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const chatId = shortText(input.chatId, 200);
  const waitId = shortText(input.waitId, 200);
  const askedAt = input.askedAt;
  if (!chatId || !waitId || typeof askedAt !== "number" || !Number.isFinite(askedAt)) return undefined;
  if (input.kind === "question") {
    const questions = parseAskUserQuestions(input.questions);
    return questions ? { kind: "question", chatId, waitId, askedAt, questions } : undefined;
  }
  if (input.kind === "approval") {
    const summary = shortText(input.summary, INTERRUPTED_WAIT_MAX_SUMMARY_LENGTH);
    return summary ? { kind: "approval", chatId, waitId, askedAt, summary } : undefined;
  }
  return undefined;
}

/** A hand-edited or older file keeps only the waits that still parse. */
export function normalizeInterruptedWaits(value: unknown): InterruptedWaitDatabase {
  const waits = (value as { waits?: unknown } | null)?.waits;
  if (!Array.isArray(waits)) return emptyInterruptedWaits();
  return {
    version: 1,
    waits: waits.flatMap((wait) => {
      const parsed = parseInterruptedWait(wait);
      return parsed ? [parsed] : [];
    }),
  };
}

export function clipInterruptedWaitSummary(summary: string): string {
  const characters = Array.from(summary.replace(/\s+/gu, " ").trim());
  return characters.length <= INTERRUPTED_WAIT_MAX_SUMMARY_LENGTH
    ? characters.join("")
    : `${characters.slice(0, INTERRUPTED_WAIT_MAX_SUMMARY_LENGTH - 1).join("")}…`;
}

export interface InterruptedWaitPersistence {
  load(): Promise<InterruptedWaitDatabase>;
  update<R>(mutation: (draft: InterruptedWaitDatabase) => R): Promise<R>;
}

/** Fresh saved waits, read once: which chats hold any, and each run's waits. */
export interface InterruptedWaitSnapshot {
  chatIds: ReadonlySet<string>;
  forRun(chatId: string, runStartedAt: number): InterruptedWaitV1[];
}

/** The chat's waits asked during the run that began at `runStartedAt`, questions first. */
function waitsForRun(
  waits: readonly InterruptedWaitRecord[],
  chatId: string,
  runStartedAt: number,
): InterruptedWaitV1[] {
  return waits
    .filter((item) => item.chatId === chatId && item.askedAt >= runStartedAt)
    .sort((left, right) => (left.kind === right.kind ? left.askedAt - right.askedAt : left.kind === "question" ? -1 : 1))
    .map(({ chatId: _chatId, ...view }) => view);
}

export function createInterruptedWaitStore(
  persistence: InterruptedWaitPersistence,
  now: () => number = Date.now,
) {
  const fresh = (wait: InterruptedWaitRecord) => now() - wait.askedAt <= INTERRUPTED_WAIT_MAX_AGE_MS;
  return {
    /** Save a card a chat's reply is waiting on; a reply can wait on a question and an approval at once. */
    remember(chatId: string, wait: InterruptedWaitV1): Promise<void> {
      const record = parseInterruptedWait({ ...wait, chatId });
      if (!record) return Promise.resolve();
      return persistence.update((draft) => {
        const kept = draft.waits.filter((item) => item.waitId !== record.waitId && fresh(item));
        const sameChat = kept.filter((item) => item.chatId === chatId);
        const dropped = new Set(sameChat.slice(0, Math.max(0, sameChat.length - MAX_INTERRUPTED_WAITS_PER_CHAT + 1)));
        draft.waits = [...kept.filter((item) => !dropped.has(item)), record].slice(-MAX_INTERRUPTED_WAITS);
      });
    },
    /** The card was answered, dismissed or withdrawn: nothing to offer again. */
    forget(waitId: string, chatId?: string): Promise<void> {
      return persistence.update((draft) => {
        draft.waits = draft.waits.filter((item) => item.waitId !== waitId || (chatId !== undefined && item.chatId !== chatId));
      });
    },
    /** The chat was deleted. */
    forgetChat(chatId: string): Promise<void> {
      return persistence.update((draft) => {
        draft.waits = draft.waits.filter((item) => item.chatId !== chatId);
      });
    },
    /** One read of the saved waits, for asking about many chats at once. */
    async snapshot(): Promise<InterruptedWaitSnapshot> {
      const waits = (await persistence.load()).waits.filter(fresh);
      return {
        chatIds: new Set(waits.map((item) => item.chatId)),
        forRun: (chatId, runStartedAt) => waitsForRun(waits, chatId, runStartedAt),
      };
    },
    /** Drop waits too old to offer, so their text does not stay on disk. */
    prune(): Promise<void> {
      return persistence.update((draft) => {
        draft.waits = draft.waits.filter(fresh);
      });
    },
    /** The chat's saved waits asked during the run that was cut short, questions first. */
    async forRun(chatId: string, runStartedAt: number): Promise<InterruptedWaitV1[]> {
      return waitsForRun((await persistence.load()).waits.filter(fresh), chatId, runStartedAt);
    },
  };
}

export type InterruptedWaitStore = ReturnType<typeof createInterruptedWaitStore>;
