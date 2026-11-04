import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../durable-fs.js";
import {
  BOT_MESSAGE_LIMITS as L,
  type BotMessageStatusEntryData,
  type BotMessageStatusOutcome,
} from "../../../renderer/shared/bot-messages.js";
export type BotMessageDeliveryStatus = "delivered" | "answered" | "failed" | "expired";
export interface BotMessageEffect {
  id: string;
  kind: "target" | "reply" | "notice" | "notification";
  botId: string;
  requestId?: string;
  text?: string;
  data?: BotMessageStatusEntryData;
  submissionId?: string;
  acknowledgedAt?: number;
}
export interface BotMessageDelivery {
  id: string;
  fromBotId: string;
  toBotId: string;
  hop: 1 | 2;
  parentDeliveryId?: string;
  childDeliveryId?: string;
  targetRequestId: string;
  submissionId?: string;
  createdAt: number;
  deadline: number;
  settledAt?: number;
  status: BotMessageDeliveryStatus;
  outcome?: BotMessageStatusOutcome | "replied";
  message: string;
  fromName: string;
  toName: string;
  initialAnswer?: string;
  childOutcome?: BotMessageStatusOutcome;
  childReserved?: boolean;
  replayTarget?: string;
  taskId?: string;
  waiting: Array<{
    waitId: string;
    summary: string;
    at: number;
  }>;
  effects: BotMessageEffect[];
}
export type BotMessageLimitHit = {
  reason: "in_flight" | "burst" | "pair_daily" | "once_per_turn" | "capacity";
  retryAfter?: number;
};
export interface BotMessageReceipt {
  id: string;
  fromBotId: string;
  toBotId: string;
  toName: string;
  inputHash: string;
  taskId?: string;
}
export function botMessageReplayHash(input: {
  fromBotId: string;
  target: string;
  message: string;
  hop: 1 | 2;
  parentDeliveryId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.fromBotId,
        input.target.trim().toLocaleLowerCase(),
        input.message.trim(),
        input.hop,
        input.parentDeliveryId ?? null,
      ]),
    )
    .digest("hex");
}
function receiptOf(row: BotMessageDelivery): BotMessageReceipt {
  return {
    id: row.id,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    toName: row.toName,
    inputHash: botMessageReplayHash({
      ...row,
      target: row.replayTarget ?? row.toBotId,
    }),
    ...(row.taskId ? { taskId: row.taskId } : {}),
  };
}
export interface BotMessageLedger {
  receipt(id: string): Promise<BotMessageReceipt | undefined>;
  receipts(): Promise<BotMessageReceipt[]>;
  collectReceipt(id: string, taskId: string): Promise<void>;
  get(id: string): Promise<BotMessageDelivery | undefined>;
  reserve(row: BotMessageDelivery): Promise<
    | {
        row: BotMessageDelivery;
        created: boolean;
      }
    | {
        refused: BotMessageLimitHit;
      }
  >;
  update(id: string, change: (row: BotMessageDelivery) => BotMessageDelivery): Promise<BotMessageDelivery | undefined>;
  open(): Promise<BotMessageDelivery[]>;
  forgetBot(botId: string): Promise<BotMessageDelivery[]>;
}
interface Book {
  version: 1;
  rows: BotMessageDelivery[];
  counters: {
    pairs: Array<{
      key: string;
      day: string;
      count: number;
    }>;
    senders: Array<{
      id: string;
      times: number[];
      cooldownUntil: number;
    }>;
  };
  receipts: BotMessageReceipt[];
  tombstones: string[];
}
export class BotMessageLedgerUnavailable extends Error {
  constructor(
    message = "Bot message bookkeeping is unavailable. Restore or repair bots/bot-messages.json before sending again.",
  ) {
    super(message);
    this.name = "BotMessageLedgerUnavailable";
  }
}
// Several adapters in a profile still share one transaction serial.
const serials = new Map<string, Promise<unknown>>();
function serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const result = (serials.get(file) ?? Promise.resolve()).catch(() => undefined).then(fn);
  serials.set(file, result);
  void result
    .finally(() => {
      if (serials.get(file) === result) serials.delete(file);
    })
    .catch(() => undefined);
  return result;
}
const copy = <T>(v: T): T => structuredClone(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const outcomes = new Set([
  "waiting_approval",
  "silent",
  "expired",
  "gave_up",
  "failed",
  "replied_while_paused",
  "replied",
]);
const statusOutcomes = new Set([...outcomes].filter((value) => value !== "replied"));
function validEffect(e: BotMessageEffect): boolean {
  if (
    !e ||
    !str(e.id) ||
    !str(e.botId) ||
    !["target", "reply", "notice", "notification"].includes(e.kind) ||
    (e.requestId !== undefined && !str(e.requestId)) ||
    (e.submissionId !== undefined && !str(e.submissionId)) ||
    (e.acknowledgedAt !== undefined && !finite(e.acknowledgedAt)) ||
    (e.text !== undefined && (!str(e.text) || e.text.length > L.replyChars))
  )
    return false;
  if (e.kind === "target" || e.kind === "reply") return str(e.requestId) && str(e.text);
  const d = e.data;
  if (!d) return e.kind === "notification" && str(e.text);
  return (
    str(d.deliveryId) &&
    str(d.botId) &&
    str(d.botName) &&
    statusOutcomes.has(d.outcome) &&
    (d.summary === undefined || (str(d.summary) && d.summary.length <= 160)) &&
    (d.text === undefined || (str(d.text) && d.text.length <= L.replyChars)) &&
    (d.waitId === undefined || str(d.waitId))
  );
}
function validRow(row: BotMessageDelivery): boolean {
  return (
    !!row &&
    str(row.id) &&
    str(row.fromBotId) &&
    str(row.toBotId) &&
    (row.hop === 1 || row.hop === 2) &&
    str(row.targetRequestId) &&
    finite(row.createdAt) &&
    finite(row.deadline) &&
    str(row.message) &&
    row.message.length <= L.messageChars &&
    (row.outcome === undefined || outcomes.has(row.outcome)) &&
    (row.childOutcome === undefined || statusOutcomes.has(row.childOutcome)) &&
    (row.childReserved === undefined || typeof row.childReserved === "boolean") &&
    (row.replayTarget === undefined || str(row.replayTarget)) &&
    (row.taskId === undefined || str(row.taskId)) &&
    (row.parentDeliveryId === undefined || str(row.parentDeliveryId)) &&
    (row.childDeliveryId === undefined || str(row.childDeliveryId)) &&
    (row.submissionId === undefined || str(row.submissionId)) &&
    str(row.fromName) &&
    str(row.toName) &&
    ["delivered", "answered", "failed", "expired"].includes(row.status) &&
    (row.settledAt === undefined || finite(row.settledAt)) &&
    (row.initialAnswer === undefined || (str(row.initialAnswer) && row.initialAnswer.length <= L.replyChars)) &&
    Array.isArray(row.waiting) &&
    row.waiting.every((w) => w && str(w.waitId) && str(w.summary) && finite(w.at)) &&
    Array.isArray(row.effects) &&
    row.effects.every(validEffect) &&
    new Set(row.effects.map((e) => e.id)).size === row.effects.length
  );
}
function recoverable(row: BotMessageDelivery): boolean {
  return (
    row.effects.some(
      (e) =>
        e.kind === "target" && e.botId === row.toBotId && e.requestId === row.targetRequestId && e.text === row.message,
    ) ||
    (row.id.startsWith("deleted:") && row.fromBotId === row.toBotId && row.status === "failed" && row.message === "")
  );
}
function validate(book: Book): void {
  if (
    !book ||
    book.version !== 1 ||
    !Array.isArray(book.rows) ||
    !book.rows.every((r) => validRow(r) && recoverable(r)) ||
    !Array.isArray(book.receipts) ||
    !book.receipts.every(
      (r) =>
        str(r.id) &&
        str(r.fromBotId) &&
        str(r.toBotId) &&
        str(r.toName) &&
        /^[a-f0-9]{64}$/u.test(r.inputHash) &&
        (r.taskId === undefined || str(r.taskId)),
    ) ||
    !Array.isArray(book.tombstones) ||
    !book.tombstones.every(str) ||
    !Array.isArray(book.counters?.pairs) ||
    !book.counters.pairs.every((p) => str(p.key) && str(p.day) && Number.isSafeInteger(p.count) && p.count >= 0) ||
    !Array.isArray(book.counters?.senders) ||
    !book.counters.senders.every(
      (s) => str(s.id) && finite(s.cooldownUntil) && Array.isArray(s.times) && s.times.every(finite),
    ) ||
    new Set(book.counters.pairs.map((p) => JSON.stringify([p.key, p.day]))).size !== book.counters.pairs.length ||
    new Set(book.counters.senders.map((s) => s.id)).size !== book.counters.senders.length ||
    new Set(book.rows.map((r) => r.id)).size !== book.rows.length ||
    new Set(book.receipts.map((r) => r.id)).size !== book.receipts.length
  )
    throw new BotMessageLedgerUnavailable();
}
const terminal = (r: BotMessageDelivery) => r.status !== "delivered";
const pending = (r: BotMessageDelivery) => !terminal(r) || r.effects.some((e) => e.acknowledgedAt === undefined);
const dayOf = (n: number) => {
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const tombstones = new Map<string, Set<string>>();
export function createBotMessageLedger(options: { file(): string; now(): number }): BotMessageLedger {
  async function read(file: string): Promise<Book> {
    try {
      const book = JSON.parse(await readFile(file, "utf8")) as Book;
      validate(book);
      return book;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 1,
          rows: [],
          counters: { pairs: [], senders: [] },
          receipts: [],
          tombstones: [],
        };
      throw e instanceof BotMessageLedgerUnavailable ? e : new BotMessageLedgerUnavailable();
    }
  }
  function tx<T>(
    fn: (book: Book) => {
      value: T;
      write?: boolean;
    },
  ): Promise<T> {
    const file = options.file();
    return serial(file, async () => {
      const book = await read(file);
      let purged = false;
      for (const botId of await deferred(file)) {
        if (!book.tombstones.includes(botId)) {
          purge(book, botId);
          purged = true;
        }
      }
      const result = fn(book);
      if (result.write || purged) {
        validate(book);
        await writeFileAtomic(file, JSON.stringify(book), {
          mode: 0o600,
          mkdirMode: 0o700,
        });
      }
      return copy(result.value);
    });
  }
  return {
    receipt: (id) => tx((b) => ({ value: b.receipts.find((r) => r.id === id) })),
    receipts: () => tx((b) => ({ value: b.receipts })),
    collectReceipt: (id, taskId) =>
      tx((b) => {
        const index = b.receipts.findIndex((r) => r.id === id && r.taskId === taskId);
        if (index < 0) return { value: undefined };
        b.receipts.splice(index, 1);
        return { value: undefined, write: true };
      }),
    get: (id) => tx((b) => ({ value: b.rows.find((r) => r.id === id) })),
    open: () => tx((b) => ({ value: b.rows.filter(pending) })),
    reserve(row) {
      return tx<Awaited<ReturnType<BotMessageLedger["reserve"]>>>((b) => {
        if (
          !validRow(row) ||
          [row.fromBotId, row.toBotId].some(
            (id) => b.tombstones.includes(id) || tombstones.get(options.file())?.has(id),
          )
        )
          throw new BotMessageLedgerUnavailable("This Bot no longer exists.");
        const receipt = b.receipts.find((r) => r.id === row.id);
        if (receipt) {
          if (
            receipt.inputHash !== receiptOf(row).inputHash ||
            receipt.toBotId !== row.toBotId ||
            receipt.taskId !== row.taskId
          )
            throw new BotMessageLedgerUnavailable("The saved Bot message does not match this replay.");
          // The receipt is immutable; the envelope belongs only to the bounded display/outbox row.
          return {
            value: {
              row: b.rows.find((r) => r.id === row.id) ?? row,
              created: false,
            },
          };
        }
        if (!recoverable(row) || row.status !== "delivered")
          throw new BotMessageLedgerUnavailable("The Bot message intent is missing its recovery payload.");
        const now = options.now(),
          day = dayOf(now),
          pair = JSON.stringify([row.fromBotId, row.toBotId].sort());
        const sender = b.counters.senders.find((s) => s.id === row.fromBotId) ?? {
          id: row.fromBotId,
          times: [],
          cooldownUntil: 0,
        };
        const refuse = (reason: BotMessageLimitHit["reason"], retryAfter?: number) => ({
          value: {
            refused: {
              reason,
              ...(retryAfter === undefined ? {} : { retryAfter }),
            },
          },
        });
        if (sender.cooldownUntil > now) return refuse("burst", sender.cooldownUntil - now);
        if (b.rows.filter((r) => r.fromBotId === row.fromBotId && pending(r)).length >= L.inFlightPerSender)
          return refuse("in_flight");
        const parent = row.parentDeliveryId ? b.rows.find((r) => r.id === row.parentDeliveryId) : undefined;
        if (
          row.hop === 2 &&
          (!parent ||
            terminal(parent) ||
            parent.toBotId !== row.fromBotId ||
            parent.hop !== 1 ||
            parent.deadline <= now)
        )
          throw new BotMessageLedgerUnavailable("The parent message is no longer available.");
        if (parent?.childReserved || parent?.childDeliveryId) return refuse("once_per_turn");
        const count = b.counters.pairs.find((p) => p.key === pair && p.day === day);
        if ((count?.count ?? 0) >= L.dailyPerPair) return refuse("pair_daily");
        // Display retention never removes receipts or quotas. Parents with live children remain.
        while (b.rows.length >= 500) {
          const index = b.rows.findIndex(
            (r) =>
              terminal(r) &&
              !pending(r) &&
              !b.rows.some((c) => !terminal(c) && (c.parentDeliveryId === r.id || c.id === r.parentDeliveryId)),
          );
          if (index < 0) return refuse("capacity");
          b.rows.splice(index, 1);
        }
        // Previous local days are no longer admission windows. Preserve a future day
        // across clock rollback; never discard a still-active cooldown.
        b.counters.pairs = b.counters.pairs.filter((p) => p.day >= day);
        b.counters.senders = b.counters.senders.filter(
          (s) => s.id === row.fromBotId || s.cooldownUntil > now || s.times.some((t) => t > now - L.burstWindowMs),
        );
        sender.times = sender.times.filter((t) => t > now - L.burstWindowMs);
        sender.times.push(now);
        if (sender.times.length >= L.burstCount) sender.cooldownUntil = now + L.cooldownMs;
        if (!b.counters.senders.includes(sender)) b.counters.senders.push(sender);
        if (count) count.count++;
        else b.counters.pairs.push({ key: pair, day, count: 1 });
        if (parent) {
          parent.childDeliveryId = row.id;
          parent.childReserved = true;
          row.deadline = Math.min(row.deadline, parent.deadline);
        }
        b.rows.push(copy(row));
        b.receipts.push(receiptOf(row));
        return { value: { row, created: true }, write: true };
      });
    },
    update(id, change) {
      return tx((b) => {
        const index = b.rows.findIndex((r) => r.id === id);
        if (index < 0) return { value: undefined };
        const old = b.rows[index]!,
          next = change(copy(old));
        if (next.id !== old.id || next.fromBotId !== old.fromBotId || next.toBotId !== old.toBotId)
          throw new BotMessageLedgerUnavailable("Cannot change delivery identity.");
        if (terminal(old) && (next.status !== old.status || next.outcome !== old.outcome)) return { value: old };
        if (JSON.stringify(old) === JSON.stringify(next)) return { value: old };
        b.rows[index] = next;
        return { value: next, write: true };
      });
    },
    async forgetBot(botId) {
      const file = options.file();
      const known = tombstones.get(file) ?? new Set<string>();
      tombstones.set(file, known);
      known.add(botId); // Fence concurrent writers even if the main file is corrupt.
      return serial(file, async () => {
        const ids = await deferred(file);
        ids.add(botId);
        await writeFileAtomic(`${file}.pending-purges.json`, JSON.stringify([...ids]), {
          mode: 0o600,
          mkdirMode: 0o700,
        });
        let book: Book;
        try {
          book = await read(file);
        } catch (error) {
          if (error instanceof BotMessageLedgerUnavailable) return [];
          throw error;
        }
        const removed: BotMessageDelivery[] = [];
        for (const id of ids) removed.push(...purge(book, id));
        validate(book);
        await writeFileAtomic(file, JSON.stringify(book), {
          mode: 0o600,
          mkdirMode: 0o700,
        });
        return copy(removed);
      });
    },
  };
  async function deferred(file: string): Promise<Set<string>> {
    const ids = tombstones.get(file) ?? new Set<string>();
    tombstones.set(file, ids);
    try {
      const saved: unknown = JSON.parse(await readFile(`${file}.pending-purges.json`, "utf8"));
      if (!Array.isArray(saved) || !saved.every(str))
        throw new BotMessageLedgerUnavailable("Bot message deletion bookkeeping needs repair.");
      for (const id of saved) ids.add(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return ids;
  }
  function purge(b: Book, botId: string): BotMessageDelivery[] {
    if (!b.tombstones.includes(botId)) b.tombstones.push(botId);
    const removed = b.rows.filter((r) => r.fromBotId === botId || r.toBotId === botId);
    b.rows = b.rows.filter((r) => !removed.includes(r));
    b.receipts = b.receipts.filter((r) => r.fromBotId !== botId && r.toBotId !== botId);
    b.counters.senders = b.counters.senders.filter((s) => s.id !== botId);
    for (const row of removed) {
      const parent = b.rows.find((r) => r.id === row.parentDeliveryId);
      if (parent && !terminal(parent)) {
        parent.childOutcome = "failed";
        parent.childReserved = true;
        delete parent.childDeliveryId;
      }
      if (row.fromBotId === botId || b.tombstones.includes(row.fromBotId)) continue;
      // A terminal answer with an undelivered reply is still owed to the peer.
      const owed =
        !terminal(row) || row.effects.some((e) => e.acknowledgedAt === undefined && e.botId === row.fromBotId);
      if (!owed || parent) continue; // The surviving parent owns the single origin outcome.
      const id = `deleted:${row.id}`;
      if (b.rows.some((r) => r.id === id)) continue;
      b.rows.push({
        id,
        fromBotId: row.fromBotId,
        toBotId: row.fromBotId,
        fromName: "",
        toName: row.toName,
        message: "",
        targetRequestId: "",
        hop: 1,
        createdAt: options.now(),
        deadline: row.deadline,
        status: "failed",
        outcome: "failed",
        settledAt: options.now(),
        waiting: [],
        effects: [
          {
            id: `${id}:notice`,
            kind: "notice",
            botId: row.fromBotId,
            data: {
              deliveryId: row.id,
              botId: row.toBotId,
              botName: row.toName,
              outcome: "failed",
            },
          },
        ],
      });
    }
    return removed;
  }
}
