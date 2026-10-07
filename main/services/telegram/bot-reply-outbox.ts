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

import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../durable-fs.js";
import type {
  BotInputAttachment,
  BotReplyOutcome,
  BotSendInput,
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
  /** Delivery failed even after the one duplicate-labelled retry. */
  | "failed";

export interface BotReplyRow {
  requestId: string;
  botId: string;
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

export interface TelegramBotIngressDeps {
  /** The outbox file, under the Telegram profile's directory. */
  file: string;
  session: {
    send(botId: string, input: BotSendInput): Promise<{ submissionId: string; deduped: boolean }>;
    awaitReply(botId: string, submissionId: string, signal: AbortSignal): Promise<BotReplyOutcome>;
  };
  deliver(reply: TelegramBotReply): Promise<void>;
  now?: () => number;
  onError?(message: string, cause: unknown): void;
}

export interface TelegramBotIngress {
  /** Durably admit one message. Resolves only after the session accepted it. */
  admit(message: TelegramBotMessage): Promise<{ requestId: string; deduped: boolean }>;
  /** Startup: resume waiting, deliver saved replies, redeliver ambiguous sends once. */
  recover(): Promise<void>;
  rows(): Promise<BotReplyRow[]>;
  /** Resolves when no background wait or delivery is running (tests and shutdown). */
  idle(): Promise<void>;
  stop(): void;
}

export function telegramBotRequestId(message: Pick<TelegramBotMessage, "botId" | "chatId" | "threadId" | "messageId">): string {
  return `tg:${message.botId}:${message.chatId}:${message.threadId ?? 0}:${message.messageId}`;
}

function parseFile(raw: string): OutboxFile {
  const value = JSON.parse(raw) as Partial<OutboxFile>;
  if (value.version !== 1 || !Array.isArray(value.rows)) throw new Error("Unreadable Telegram Bot outbox.");
  return { version: 1, rows: value.rows };
}

export function createTelegramBotIngress(deps: TelegramBotIngressDeps): TelegramBotIngress {
  const now = deps.now ?? Date.now;
  const stopper = new AbortController();
  const background = new Set<Promise<void>>();
  let state: OutboxFile | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  /** Serialize every read-modify-write of the outbox file. */
  function locked<T>(action: (file: OutboxFile) => Promise<T> | T): Promise<T> {
    const next = tail.then(async () => {
      state ??= await readFile(deps.file, "utf8").then(parseFile, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { version: 1 as const, rows: [] };
        throw error;
      });
      return action(state);
    });
    tail = next.catch(() => undefined);
    return next;
  }

  async function persist(file: OutboxFile): Promise<void> {
    const settled = file.rows.filter((row) => row.state === "sent" || row.state === "failed");
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

  function inBackground(work: () => Promise<void>): void {
    const promise = work().catch((cause) => deps.onError?.("Telegram Bot reply delivery failed.", cause));
    background.add(promise);
    void promise.finally(() => background.delete(promise));
  }

  async function deliverRow(requestId: string, duplicate: boolean): Promise<void> {
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

  async function track(row: BotReplyRow): Promise<void> {
    let outcome: BotReplyOutcome;
    try {
      outcome = await deps.session.awaitReply(row.botId, row.submissionId, stopper.signal);
    } catch (cause) {
      if (stopper.signal.aborted) return;
      throw cause;
    }
    if (outcome.kind === "interrupted") {
      await update(row.requestId, (current) => void (current.state = "interrupted"));
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
      if (known !== undefined) return { requestId, deduped: true };
      const { submissionId, deduped } = await deps.session.send(message.botId, {
        text: message.text,
        requestId,
        ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      });
      const row = await locked(async (file) => {
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
      if (row !== undefined) inBackground(() => track(row));
      return { requestId, deduped: deduped || row === undefined };
    },

    async recover() {
      const rows = await locked((file) => file.rows.map((row) => ({ ...row })));
      for (const row of rows) {
        if (row.state === "awaiting") inBackground(() => track(row));
        else if (row.state === "pending") inBackground(() => deliverRow(row.requestId, false));
        else if (row.state === "sending") {
          if (row.redelivered) await update(row.requestId, (current) => void (current.state = "failed"));
          else inBackground(() => deliverRow(row.requestId, true));
        }
      }
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
