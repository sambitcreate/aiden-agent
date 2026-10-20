// Telegram ingress and reply delivery for durable Bot sessions.
//
// Admission: a Bot-bound Telegram message is submitted to the Bot's durable
// conversation with the stable request id `tg:<bot>:<chat>:<thread>:<message>`
// before the caller advances the Telegram offset, so a crash before admission
// redelivers the update and a crash after it is deduped by the session.
//
// Delivery: every admitted message gets an outbox row. The reply is persisted
// (`pending`) before it is sent, so a crash after generation redelivers the
// saved reply instead of generating it again. A send that started but whose
// outcome is unknown (`sending` at restart, or a failed send) is redelivered
// once, prefixed "(may be a duplicate)".
//
// Interruption: a turn paused by a quit leaves its row `interrupted`, still
// tied to the original submission. When the person resumes the Bot (any
// client, this run or a later one) `botStateChanged` re-attaches the row and
// the answer is delivered once; startup recovery re-checks too, without ever
// starting the paused turn. A turn dismissed or stopped for good is
// `dismissed` and never delivered.
//
// Pause: a message to a Bot the person paused is not admitted. The chat gets
// one fixed line ("Ada is paused. Resume it in Aiden to continue.") per
// message, and no row: nothing waits for an answer. A turn that was running
// when the Bot paused keeps its `interrupted` row and is delivered once the
// person unpauses and resumes it.
//
// Routines: a finished routine's visible reply (or its failure) is a
// `routine` row keyed by the run's request id. It starts `pending` and uses
// the same `pending → sending → sent` path and duplicate-labelled redelivery,
// and its binding is checked again right before each send.

import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../durable-fs.js";
import type {
  BotInputAttachment,
  BotReplyOutcome,
  BotSendInput,
  BotSessionState,
} from "../bot-runtime/bot-session-service.js";

export const MAY_BE_DUPLICATE_PREFIX = "(may be a duplicate)";
const MAX_SETTLED_ROWS = 500;

export type BotReplyRowState =
  /** Admitted; waiting for the Bot's answer. */
  | "awaiting"
  /** Answer saved; not sent yet. */
  | "pending"
  /** A send started; its outcome is unknown until it is marked `sent`. */
  | "sending"
  | "sent"
  /** The turn was interrupted; nothing to deliver until the person resumes it. */
  | "interrupted"
  /** The person dismissed or stopped the turn: it will never have an answer. */
  | "dismissed"
  /** Delivery failed even after the one duplicate-labelled retry. */
  | "failed";

export interface BotReplyRow {
  requestId: string;
  botId: string;
  /** `reply` (absent): an answer to a Telegram message. `routine`: a routine's result. */
  kind?: "routine";
  /** The answered submission; empty for a routine row, which never waits on one. */
  submissionId: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  state: BotReplyRowState;
  text?: string;
  /** True once the duplicate-labelled redelivery was attempted. */
  redelivered?: boolean;
  updatedAt: number;
}

interface OutboxFile {
  version: 1;
  rows: BotReplyRow[];
}

export interface TelegramBotMessage {
  botId: string;
  chatId: number;
  threadId?: number;
  messageId: number;
  ownerUserId: number;
  text: string;
  attachments?: readonly BotInputAttachment[];
}

export interface TelegramBotReply {
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  text: string;
}

/** A routine result for the Bot's bound Telegram chat. */
export interface TelegramBotRoutineDelivery {
  botId: string;
  /** The routine run's session request id: one row per firing. */
  requestId: string;
  routineName: string;
  text: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
}

export interface TelegramBotIngressDeps {
  /** The outbox file, under the Telegram profile's directory. */
  file: string;
  session: {
    send(botId: string, input: BotSendInput): Promise<{ submissionId: string; deduped: boolean }>;
    awaitReply(botId: string, submissionId: string, signal: AbortSignal): Promise<BotReplyOutcome>;
  };
  deliver(reply: TelegramBotReply): Promise<void>;
  /**
   * Whether a routine row may still go to its chat: the Bot's binding is
   * enabled and still targets that chat. Checked right before each send.
   */
  routineTargetEnabled?(row: Pick<BotReplyRow, "botId" | "chatId" | "threadId">): Promise<boolean>;
  /** The Bot's display name, for the paused line. */
  botName?(botId: string): Promise<string | undefined>;
  now?: () => number;
  onError?(message: string, cause: unknown): void;
}

/** A routine row's text: the routine name in bold, then its reply (Markdown). */
export function telegramRoutineText(routineName: string, text: string): string {
  const name = routineName.trim().replace(/[\\*_`[\]~|]/gu, (character) => `\\${character}`);
  return `**${name}**\n\n${text}`;
}

export interface TelegramBotIngress {
  /**
   * Durably admit one message. Resolves only after the session accepted it,
   * or, for a paused Bot (`paused: true`), after the paused line was sent.
   */
  admit(message: TelegramBotMessage): Promise<{ requestId: string; deduped: boolean; paused?: true }>;
  /**
   * Durably queue a routine's result for the bound chat and send it in the
   * background. A request id that already has a row is ignored.
   */
  enqueueRoutineDelivery(delivery: TelegramBotRoutineDelivery): Promise<{ queued: boolean }>;
  /** Startup: resume waiting, deliver saved replies, redeliver ambiguous sends once. */
  recover(): Promise<void>;
  /**
   * The Bot's session state changed. Once it is no longer paused (Resume, or
   * Dismiss), its interrupted rows are re-attached to their submissions.
   */
  botStateChanged(botId: string, state: Pick<BotSessionState, "kind">): void;
  rows(): Promise<BotReplyRow[]>;
  /** Resolves when no background wait or delivery is running (tests and shutdown). */
  idle(): Promise<void>;
  stop(): void;
}

/** What the chat hears instead of an answer while its Bot is paused. */
export function telegramBotPausedLine(name: string | undefined): string {
  const display = name?.trim();
  return `${display ? display : "This Bot"} is paused. Resume it in Aiden to continue.`;
}

/** Duck-typed: this module only imports the session's types (the CLI bundles it without the runtime). */
function isPausedByPerson(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.name === "BotSessionError" &&
    (cause as { reason?: unknown }).reason === "paused_by_person"
  );
}

export function telegramBotRequestId(message: Pick<TelegramBotMessage, "botId" | "chatId" | "threadId" | "messageId">): string {
  return `tg:${message.botId}:${message.chatId}:${message.threadId ?? 0}:${message.messageId}`;
}

function parseFile(raw: string): OutboxFile {
  const value = JSON.parse(raw) as Partial<OutboxFile>;
  if (value.version !== 1 || !Array.isArray(value.rows)) throw new Error("Unreadable Telegram Bot outbox.");
  return { version: 1, rows: value.rows };
}

/**
 * The Bot session accepted a turn but its reply row could not be written. The update must be
 * redelivered until the row exists, however many attempts that takes: skipping it loses the answer.
 */
export class BotReplyAdmittedUnrecordedError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BotReplyAdmittedUnrecordedError";
  }
}

export function createTelegramBotIngress(deps: TelegramBotIngressDeps): TelegramBotIngress {
  const now = deps.now ?? Date.now;
  const stopper = new AbortController();
  const background = new Set<Promise<void>>();
  let state: OutboxFile | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  /** Rows with a wait running, so one row is never tracked (or delivered) twice. */
  const tracking = new Set<string>();
  /**
   * Tracked rows whose Bot left the paused state while their wait was still
   * settling. The wait may have observed the pause before Resume (or Dismiss),
   * so the row is checked again once that wait lets go of it.
   */
  const recheck = new Set<string>();

  /** Serialize every read-modify-write of the outbox file. */
  function locked<T>(action: (file: OutboxFile) => Promise<T> | T): Promise<T> {
    const next = tail.then(async () => {
      state ??= await readFile(deps.file, "utf8").then(parseFile, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { version: 1 as const, rows: [] };
        throw error;
      });
      try {
        return await action(state);
      } catch (error) {
        // The action may have changed the cached rows before its write failed.
        // Forget the cache so the next access starts from what is on disk;
        // otherwise a lost write would still dedupe or deliver from memory.
        state = undefined;
        throw error;
      }
    });
    tail = next.catch(() => undefined);
    return next;
  }

  async function persist(file: OutboxFile): Promise<void> {
    const settled = file.rows.filter((row) => row.state === "sent" || row.state === "failed" || row.state === "dismissed");
    if (settled.length > MAX_SETTLED_ROWS) {
      const drop = new Set(settled.slice(0, settled.length - MAX_SETTLED_ROWS));
      file.rows = file.rows.filter((row) => !drop.has(row));
    }
    await writeJsonAtomic(deps.file, file, { mode: 0o600, mkdirMode: 0o700 });
  }

  function update(requestId: string, change: (row: BotReplyRow) => void): Promise<BotReplyRow | undefined> {
    return locked(async (file) => {
      const row = file.rows.find((candidate) => candidate.requestId === requestId);
      if (row === undefined) return undefined;
      change(row);
      row.updatedAt = now();
      await persist(file);
      return { ...row };
    });
  }

  async function routineTargetEnabled(row: BotReplyRow): Promise<boolean> {
    if (deps.routineTargetEnabled === undefined) return false;
    try {
      return await deps.routineTargetEnabled(row);
    } catch {
      return false;
    }
  }

  function inBackground(work: () => Promise<void>): void {
    const promise = work().catch((cause) => deps.onError?.("Telegram Bot reply delivery failed.", cause));
    background.add(promise);
    void promise.finally(() => background.delete(promise));
  }

  async function deliverRow(requestId: string, duplicate: boolean): Promise<void> {
    const queued = await locked((file) => file.rows.find((candidate) => candidate.requestId === requestId));
    if (queued?.kind === "routine" && !(await routineTargetEnabled(queued))) {
      // Unbound or switched off since the routine ran: drop it unsent.
      await update(requestId, (current) => void (current.state = "failed"));
      return;
    }
    const row = await update(requestId, (current) => {
      current.state = "sending";
      if (duplicate) current.redelivered = true;
    });
    if (row === undefined || row.text === undefined) return;
    const text = duplicate ? `${MAY_BE_DUPLICATE_PREFIX} ${row.text}` : row.text;
    try {
      await deps.deliver({
        chatId: row.chatId,
        ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
        ownerUserId: row.ownerUserId,
        text,
      });
    } catch (cause) {
      // Part of the reply may have reached Telegram: retry once, labelled.
      if (!duplicate) return deliverRow(requestId, true);
      await update(requestId, (current) => void (current.state = "failed"));
      throw cause;
    }
    await update(requestId, (current) => void (current.state = "sent"));
  }

  /** Wait for the row's answer in the background, unless a wait for it is already running. */
  function trackOnce(row: BotReplyRow): void {
    if (tracking.has(row.requestId)) return;
    tracking.add(row.requestId);
    inBackground(async () => {
      try {
        await track(row);
      } finally {
        tracking.delete(row.requestId);
      }
      if (recheck.delete(row.requestId) && !stopper.signal.aborted) {
        const current = await locked((file) => file.rows.find((candidate) => candidate.requestId === row.requestId));
        if (current?.state === "interrupted") trackOnce({ ...current });
      }
    });
  }

  async function track(row: BotReplyRow): Promise<void> {
    let outcome: BotReplyOutcome;
    try {
      outcome = await deps.session.awaitReply(row.botId, row.submissionId, stopper.signal);
    } catch (cause) {
      if (stopper.signal.aborted) return;
      throw cause;
    }
    if (outcome.kind === "interrupted") {
      const next = outcome.settled ? "dismissed" : "interrupted";
      await update(row.requestId, (current) => void (current.state = next));
      return;
    }
    const text = outcome.kind === "completed" ? outcome.text : `⚠️ Error: ${outcome.error}`;
    await update(row.requestId, (current) => {
      current.state = "pending";
      current.text = text;
    });
    await deliverRow(row.requestId, false);
  }

  return {
    async admit(message) {
      const requestId = telegramBotRequestId(message);
      const known = await locked((file) => file.rows.find((row) => row.requestId === requestId));
      if (known !== undefined) {
        // A durable row whose wait was lost (a write published but reported as
        // failed, for example) is picked up here instead of waiting for a restart.
        if (known.state === "awaiting") trackOnce({ ...known });
        return { requestId, deduped: true };
      }
      let admitted: { submissionId: string; deduped: boolean };
      try {
        admitted = await deps.session.send(message.botId, {
          text: message.text,
          requestId,
          ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        });
      } catch (cause) {
        if (!isPausedByPerson(cause)) throw cause;
        // Not admitted and no row: the update is consumed with one fixed line.
        const name = await deps.botName?.(message.botId).catch(() => undefined);
        try {
          await deps.deliver({
            chatId: message.chatId,
            ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
            ownerUserId: message.ownerUserId,
            text: telegramBotPausedLine(name),
          });
        } catch (deliveryError) {
          deps.onError?.("Telegram could not tell a chat its Bot is paused.", deliveryError);
        }
        return { requestId, deduped: false, paused: true };
      }
      const { submissionId, deduped } = admitted;
      const recordRow = () => locked(async (file) => {
        const existing = file.rows.find((candidate) => candidate.requestId === requestId);
        if (existing !== undefined) return undefined;
        const created: BotReplyRow = {
          requestId,
          botId: message.botId,
          submissionId,
          chatId: message.chatId,
          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
          ownerUserId: message.ownerUserId,
          state: "awaiting",
          updatedAt: now(),
        };
        file.rows.push(created);
        await persist(file);
        return { ...created };
      });
      let row: BotReplyRow | undefined;
      try {
        row = await recordRow();
      } catch (cause) {
        // The session holds the turn; only this row can deliver its answer, so redelivery must retry it.
        throw new BotReplyAdmittedUnrecordedError(cause);
      }
      if (row !== undefined) trackOnce(row);
      return { requestId, deduped: deduped || row === undefined };
    },

    async enqueueRoutineDelivery(delivery) {
      if (stopper.signal.aborted) return { queued: false };
      const queued = await locked(async (file) => {
        if (file.rows.some((row) => row.requestId === delivery.requestId)) return false;
        file.rows.push({
          requestId: delivery.requestId,
          botId: delivery.botId,
          kind: "routine",
          submissionId: "",
          chatId: delivery.chatId,
          ...(delivery.threadId === undefined ? {} : { threadId: delivery.threadId }),
          ownerUserId: delivery.ownerUserId,
          state: "pending",
          text: telegramRoutineText(delivery.routineName, delivery.text),
          updatedAt: now(),
        });
        await persist(file);
        return true;
      });
      if (queued) inBackground(() => deliverRow(delivery.requestId, false));
      return { queued };
    },

    async recover() {
      const rows = await locked((file) => file.rows.map((row) => ({ ...row })));
      for (const row of rows) {
        // An interrupted row is re-checked: it may have been resumed while
        // Telegram was not running. A paused turn is never started here.
        if (row.state === "awaiting" || row.state === "interrupted") trackOnce(row);
        else if (row.state === "pending") inBackground(() => deliverRow(row.requestId, false));
        else if (row.state === "sending") {
          if (row.redelivered) await update(row.requestId, (current) => void (current.state = "failed"));
          else inBackground(() => deliverRow(row.requestId, true));
        }
      }
    },

    botStateChanged(botId, state) {
      // Still held: an interrupted turn waits for Resume, a paused Bot for unpause.
      if (state.kind === "interrupted" || state.kind === "paused" || stopper.signal.aborted) return;
      inBackground(async () => {
        const rows = await locked((file) =>
          file.rows
            .filter((row) => row.botId === botId && (row.state === "interrupted" || row.state === "awaiting"))
            .map((row) => ({ ...row })),
        );
        for (const row of rows) {
          // A wait still running may have seen the pause before this change:
          // re-check the row once it finishes instead of dropping the wakeup.
          if (tracking.has(row.requestId)) recheck.add(row.requestId);
          else if (row.state === "interrupted") trackOnce(row);
        }
      });
    },

    rows() {
      return locked((file) => file.rows.map((row) => ({ ...row })));
    },

    async idle() {
      while (background.size > 0) await Promise.allSettled([...background]);
      await tail;
    },

    stop() {
      stopper.abort(new Error("Telegram stopped"));
    },
  };
}
