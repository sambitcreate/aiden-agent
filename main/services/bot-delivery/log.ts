// The per-Bot delivery log: one durable row for every Bot message the person
// can hear about (routine results today; issues, proposals and digests next).
// The phone feed reads this log instead of projecting `schedule-runs.json`, so
// what the Mac and Telegram got is what the phones see.
//
// Rows live beside the Bot's session in `<profile>/bots/<dir>/deliveries.json`,
// newest first, at most 200 per Bot. Writes are atomic and serialized per Bot,
// the same way the routine notes are kept. Each channel is stamped as it
// succeeds, so a retry sends only what the row still owes; a suppressed row
// stays for the record but never reaches a person.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { botIdFromDirectoryName } from "../bot-runtime/harness-host.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_DELIVERIES_FILE = "deliveries.json";
/** Newest rows kept per Bot; older rows fall off as new ones arrive. */
export const BOT_DELIVERIES_MAX = 200;
/** The phone feed serves at most this many due rows, newest first. */
export const BOT_DELIVERIES_DUE_MAX = 100;

export type BotDeliveryClass = "routine_result" | "issue" | "proposal" | "digest";

export interface BotDeliveryRow {
  id: string;
  botId: string;
  class: BotDeliveryClass;
  /** Stable key one Bot delivers by; a repeat is the same message. */
  dedupeKey: string;
  title: string;
  body: string;
  routineId?: string;
  requestId?: string;
  /** What the phone feed shows. */
  status: "succeeded" | "failed" | "info";
  createdAt: number;
  /** The row may reach the person (and their phones) from this time on. */
  deliverAfter: number;
  /** Kept for the record only: a suppressed row never reaches a person. */
  suppressed?: boolean;
  /** When the Mac banner went out; unset while it is still owed. */
  macSentAt?: number;
  /** When Telegram accepted the message; unset while it is still owed. */
  telegramSentAt?: number;
  /** When every channel had gone out; unset until the row is fully delivered. */
  sentAt?: number;
}

/** The two live channels a row has to clear; phones read the log itself. */
export type BotDeliveryChannel = "mac" | "telegram";

export interface BotDeliveryLog {
  /** Dedupes by `(botId, dedupeKey)`; a repeat returns the stored row. */
  append(row: Omit<BotDeliveryRow, "id">): Promise<{ row: BotDeliveryRow; created: boolean }>;
  /** The row already stored under this key, if any. */
  find(botId: string, dedupeKey: string): Promise<BotDeliveryRow | undefined>;
  /** Rows due at `now`, newest first, at most 100. `since` is exclusive. */
  due(since: number | undefined, now: number): Promise<BotDeliveryRow[]>;
  /** Records one channel's success; the first time sticks. */
  markChannel(botId: string, id: string, channel: BotDeliveryChannel, at: number): Promise<void>;
  /** Records that every channel went out; keeps the first time. */
  markSent(botId: string, id: string, at: number): Promise<void>;
  forgetBot(botId: string): Promise<void>;
  /** Every row this Bot kept, newest first. */
  list(botId: string): Promise<BotDeliveryRow[]>;
  /** Bots that have a delivery log. */
  botIds(): Promise<string[]>;
}

const CLASSES: ReadonlySet<string> = new Set<BotDeliveryClass>([
  "routine_result",
  "issue",
  "proposal",
  "digest",
]);
const STATUSES: ReadonlySet<string> = new Set<BotDeliveryRow["status"]>([
  "succeeded",
  "failed",
  "info",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

/** An absent optional timestamp, or null when one is present but unusable. */
function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return timestamp(value) ?? null;
}

/** One stored row, or undefined when it is not the current shape. */
function parseRow(value: unknown, botId: string): BotDeliveryRow | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalText(value.id, 160);
  const dedupeKey = optionalText(value.dedupeKey, 400);
  const title = optionalText(value.title, 200);
  const createdAt = timestamp(value.createdAt);
  const deliverAfter = timestamp(value.deliverAfter);
  if (value.botId !== botId || id === undefined || dedupeKey === undefined || title === undefined) return undefined;
  if (typeof value.class !== "string" || !CLASSES.has(value.class)) return undefined;
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return undefined;
  if (typeof value.body !== "string" || createdAt === undefined || deliverAfter === undefined) return undefined;
  const routineId = optionalText(value.routineId, 160);
  const requestId = optionalText(value.requestId, 160);
  const suppressed = value.suppressed === true;
  const macSentAt = optionalTimestamp(value.macSentAt);
  const telegramSentAt = optionalTimestamp(value.telegramSentAt);
  const sentAt = optionalTimestamp(value.sentAt);
  if (macSentAt === null || telegramSentAt === null || sentAt === null) return undefined;
  return {
    id,
    botId,
    class: value.class as BotDeliveryClass,
    dedupeKey,
    title,
    body: value.body,
    ...(routineId !== undefined ? { routineId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    status: value.status as BotDeliveryRow["status"],
    createdAt,
    deliverAfter,
    ...(suppressed ? { suppressed: true } : {}),
    ...(macSentAt !== undefined ? { macSentAt } : {}),
    ...(telegramSentAt !== undefined ? { telegramSentAt } : {}),
    ...(sentAt !== undefined ? { sentAt } : {}),
  };
}

/** Every row this Bot kept; unreadable or malformed content reads as no rows. */
function parseFile(text: string, botId: string): BotDeliveryRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => parseRow(row, botId))
    .filter((row): row is BotDeliveryRow => row !== undefined)
    .slice(0, BOT_DELIVERIES_MAX);
}

export function createBotDeliveryLog(options: { profileDir(): string; now?(): number }): BotDeliveryLog {
  const now = options.now ?? Date.now;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_DELIVERIES_FILE);

  async function load(botId: string): Promise<BotDeliveryRow[]> {
    try {
      return parseFile(await fs.readFile(fileOf(botId), "utf8"), botId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function save(botId: string, rows: BotDeliveryRow[]): Promise<void> {
    await writeJsonAtomic(fileOf(botId), rows, { mode: 0o600, mkdirMode: 0o700 });
  }

  return {
    append(input) {
      return serial(input.botId, async () => {
        const rows = await load(input.botId);
        const existing = rows.find((row) => row.dedupeKey === input.dedupeKey);
        if (existing) return { row: existing, created: false };
        const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : now();
        const row: BotDeliveryRow = {
          id: randomUUID(),
          ...input,
          createdAt,
          deliverAfter: Number.isFinite(input.deliverAfter) ? input.deliverAfter : createdAt,
        };
        await save(input.botId, [row, ...rows].slice(0, BOT_DELIVERIES_MAX));
        return { row, created: true };
      });
    },

    async find(botId, dedupeKey) {
      return (await load(botId)).find((row) => row.dedupeKey === dedupeKey);
    },

    async due(since, at) {
      const due: BotDeliveryRow[] = [];
      for (const botId of await botIds()) {
        for (const row of await load(botId)) {
          // A suppressed row is kept for the record, never for a person.
          if (row.suppressed === true) continue;
          if (row.deliverAfter > at) continue;
          if (since !== undefined && row.deliverAfter <= since) continue;
          due.push(row);
        }
      }
      due.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return due.slice(0, BOT_DELIVERIES_DUE_MAX);
    },

    markChannel(botId, id, channel, at) {
      return serial(botId, async () => {
        const rows = await load(botId);
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) return;
        const row = rows[index]!;
        if ((channel === "mac" ? row.macSentAt : row.telegramSentAt) !== undefined) return;
        const next = [...rows];
        next[index] = channel === "mac" ? { ...row, macSentAt: at } : { ...row, telegramSentAt: at };
        await save(botId, next);
      });
    },

    markSent(botId, id, at) {
      return serial(botId, async () => {
        const rows = await load(botId);
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) return;
        const row = rows[index]!;
        // "Sent" means every channel went out; one channel alone leaves it owed.
        if (row.sentAt !== undefined || row.macSentAt === undefined || row.telegramSentAt === undefined) return;
        const next = [...rows];
        next[index] = { ...row, sentAt: at };
        await save(botId, next);
      });
    },

    forgetBot(botId) {
      return serial(botId, async () => {
        await fs.rm(fileOf(botId), { force: true });
      });
    },

    list: (botId) => load(botId),
    botIds,
  };

  async function botIds(): Promise<string[]> {
    const root = path.join(options.profileDir(), "bots");
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ids: string[] = [];
    for (const name of names) {
      // Locks and staging names contain a dot; only Bot directories count.
      if (name.startsWith(".")) continue;
      const stat = await fs.lstat(path.join(root, name)).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const botId = botIdFromDirectoryName(name);
      if (botId !== null) ids.push(botId);
    }
    return ids;
  }
}
