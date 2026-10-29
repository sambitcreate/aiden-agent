// Dated promises a Bot made to the person (spec §6 P2), noted by the memory
// review, and turned into one-time routine proposals the person approves.
// Kept per Bot in `<profile>/bots/<dir>/commitments.json`.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseBotRoutineDate } from "../../../renderer/shared/bot-routine-schedule.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_COMMITMENTS_FILE = "commitments.json";
export const BOT_COMMITMENT_LIMITS = { waiting: 32, textChars: 200, maxDaysAhead: 60, kept: 100 } as const;

export type BotCommitmentStatus = "waiting" | "proposed" | "accepted" | "dismissed" | "expired";

export interface BotCommitment {
  id: string;
  botId: string;
  text: string;
  /** YYYY-MM-DD in the Mac's time zone. */
  dueDate: string;
  /** HH:MM, when the promise named a time. */
  dueTime?: string;
  createdAt: number;
  status: BotCommitmentStatus;
  proposalId?: string;
  /** Its card was revised into a repeating schedule or a trigger: no date expires it. */
  openEnded?: true;
}

export type BotCommitmentAddResult =
  | { ok: true; commitment: BotCommitment }
  | { ok: false; code: "invalid" | "full" | "duplicate"; error: string };

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const STATUSES = new Set<BotCommitmentStatus>(["waiting", "proposed", "accepted", "dismissed", "expired"]);

/** Days from `today` (YYYY-MM-DD) to `date`, counting calendar days. */
export function daysBetween(today: string, date: string): number {
  const a = parseBotRoutineDate(today);
  const b = parseBotRoutineDate(date);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** Today's date in `timeZone`, YYYY-MM-DD. */
export function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function normalizedText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

function parseRecord(value: unknown, botId: string): BotCommitment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.botId !== botId || typeof record.id !== "string" || typeof record.text !== "string") return undefined;
  if (typeof record.dueDate !== "string" || typeof record.createdAt !== "number") return undefined;
  if (typeof record.status !== "string" || !STATUSES.has(record.status as BotCommitmentStatus)) return undefined;
  if (record.dueTime !== undefined && (typeof record.dueTime !== "string" || !CLOCK.test(record.dueTime))) return undefined;
  try {
    parseBotRoutineDate(record.dueDate);
  } catch {
    return undefined;
  }
  return {
    id: record.id,
    botId,
    text: record.text.slice(0, BOT_COMMITMENT_LIMITS.textChars),
    dueDate: record.dueDate,
    ...(typeof record.dueTime === "string" ? { dueTime: record.dueTime } : {}),
    createdAt: record.createdAt,
    status: record.status as BotCommitmentStatus,
    ...(typeof record.proposalId === "string" ? { proposalId: record.proposalId } : {}),
    ...(record.openEnded === true ? { openEnded: true as const } : {}),
  };
}

export function createBotCommitmentStore(options: { profileDir(): string; now?(): number; timeZone?(): string }) {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_COMMITMENTS_FILE);

  async function load(botId: string): Promise<BotCommitment[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      return Array.isArray(parsed)
        ? parsed.map((item) => parseRecord(item, botId)).filter((item): item is BotCommitment => item !== undefined)
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  }

  async function save(botId: string, records: BotCommitment[]): Promise<void> {
    const open = records.filter((record) => record.status === "waiting" || record.status === "proposed");
    const closed = records.filter((record) => !open.includes(record)).slice(-BOT_COMMITMENT_LIMITS.kept);
    await writeJsonAtomic(fileOf(botId), [...records.filter((record) => open.includes(record) || closed.includes(record))], {
      mode: 0o600,
      mkdirMode: 0o700,
    });
  }

  return {
    add(botId: string, input: { text: string; dueDate: string; dueTime?: string }): Promise<BotCommitmentAddResult> {
      return serial(botId, async () => {
        const text = input.text.trim();
        if (!text || [...text].length > BOT_COMMITMENT_LIMITS.textChars) {
          return { ok: false, code: "invalid", error: `Say the promise in at most ${BOT_COMMITMENT_LIMITS.textChars} characters.` };
        }
        let ahead: number;
        try {
          ahead = daysBetween(localDate(now(), timeZone()), input.dueDate);
        } catch {
          return { ok: false, code: "invalid", error: "due_date must be YYYY-MM-DD." };
        }
        if (ahead < 1 || ahead > BOT_COMMITMENT_LIMITS.maxDaysAhead) {
          return { ok: false, code: "invalid", error: `The follow-up must be between tomorrow and ${BOT_COMMITMENT_LIMITS.maxDaysAhead} days from now.` };
        }
        if (input.dueTime !== undefined && !CLOCK.test(input.dueTime)) {
          return { ok: false, code: "invalid", error: "due_time must be HH:MM." };
        }
        const records = await load(botId);
        const open = records.filter((record) => record.status === "waiting" || record.status === "proposed");
        if (open.some((record) => normalizedText(record.text) === normalizedText(text) && record.dueDate === input.dueDate)) {
          return { ok: false, code: "duplicate", error: "That follow-up is already noted." };
        }
        if (records.filter((record) => record.status === "waiting").length >= BOT_COMMITMENT_LIMITS.waiting) {
          return { ok: false, code: "full", error: "Too many follow-ups are waiting." };
        }
        const commitment: BotCommitment = {
          id: randomUUID(),
          botId,
          text,
          dueDate: input.dueDate,
          ...(input.dueTime !== undefined ? { dueTime: input.dueTime } : {}),
          createdAt: now(),
          status: "waiting",
        };
        await save(botId, [...records, commitment]);
        return { ok: true, commitment };
      });
    },

    list: (botId: string) => load(botId),

    update(
      botId: string,
      id: string,
      patch: Partial<Pick<BotCommitment, "status" | "proposalId" | "dueDate" | "dueTime" | "openEnded">>,
    ): Promise<void> {
      return serial(botId, async () => {
        const records = await load(botId);
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) return;
        const next = { ...records[index]!, ...patch };
        if (next.openEnded === undefined) delete next.openEnded;
        records[index] = next;
        await save(botId, records);
      });
    },

    forgetBot(botId: string): Promise<void> {
      return serial(botId, async () => {
        await fs.rm(fileOf(botId), { force: true });
      });
    },
  };
}

export type BotCommitmentStore = ReturnType<typeof createBotCommitmentStore>;
