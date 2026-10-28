// Event routines per Bot, in `<profile>/bots/<dir>/event-routines.json`: what
// to do, when (the trigger), and the bookkeeping the dispatcher's limits need
// (seen event ids, the last run, today's count, one held event).

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BOT_ROUTINE_EVENT_LIMITS,
  parseBotRoutineTrigger,
  type BotRoutineTrigger,
} from "../../../renderer/shared/bot-routine-trigger.js";
import { botIdFromDirectoryName } from "../bot-runtime/harness-host.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_EVENT_ROUTINES_FILE = "event-routines.json";
export const BOT_EVENT_ROUTINES_MAX = 16;
export const BOT_WEBHOOK_LIMITS = { tokenBytes: 32, bodyBytes: 16_384 } as const;

export interface BotEventRoutine {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  trigger: BotRoutineTrigger;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** sha256 hex of the webhook token; only for webhook routines. Never shown again. */
  tokenHash?: string;
  /** Dispatcher bookkeeping. */
  seenEventIds: string[];
  lastRunAt?: number;
  day?: { key: string; count: number };
  held?: { eventId: string; payload: string; at: number };
}

export type { BotEventRoutineView } from "../../../renderer/shared/bot-event-routines.js";
import type { BotEventRoutineView } from "../../../renderer/shared/bot-event-routines.js";

export function viewOf(routine: BotEventRoutine): BotEventRoutineView {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    prompt: routine.prompt,
    trigger: routine.trigger,
    enabled: routine.enabled,
    ...(routine.lastRunAt !== undefined ? { lastRunAt: routine.lastRunAt } : {}),
  };
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh token (base64url, 32 bytes) and the hash stored in its place. */
export function mintBotWebhookToken(): { token: string; tokenHash: string } {
  const token = randomBytes(BOT_WEBHOOK_LIMITS.tokenBytes).toString("base64url");
  return { token, tokenHash: hashWebhookToken(token) };
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function parseRoutine(value: unknown, botId: string): BotEventRoutine | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.botId !== botId || typeof record.id !== "string" || typeof record.name !== "string") return undefined;
  if (typeof record.prompt !== "string" || typeof record.enabled !== "boolean") return undefined;
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined;
  let trigger: BotRoutineTrigger;
  try {
    trigger = parseBotRoutineTrigger(record.trigger);
  } catch {
    return undefined;
  }
  if (trigger.kind === "webhook" && (typeof record.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.tokenHash))) return undefined;
  const seen = Array.isArray(record.seenEventIds)
    ? record.seenEventIds.filter((id): id is string => typeof id === "string").slice(-BOT_ROUTINE_EVENT_LIMITS.seenIds)
    : [];
  const day = record.day && typeof record.day === "object" ? record.day as { key?: unknown; count?: unknown } : undefined;
  const held = record.held && typeof record.held === "object" ? record.held as { eventId?: unknown; payload?: unknown; at?: unknown } : undefined;
  return {
    id: record.id,
    botId,
    name: record.name,
    prompt: record.prompt,
    trigger,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(trigger.kind === "webhook" ? { tokenHash: record.tokenHash as string } : {}),
    seenEventIds: seen,
    ...(typeof record.lastRunAt === "number" ? { lastRunAt: record.lastRunAt } : {}),
    ...(day && typeof day.key === "string" && typeof day.count === "number" ? { day: { key: day.key, count: day.count } } : {}),
    ...(held && typeof held.eventId === "string" && typeof held.payload === "string" && typeof held.at === "number"
      ? { held: { eventId: held.eventId, payload: held.payload, at: held.at } }
      : {}),
  };
}

export interface BotEventRoutineInput {
  name: string;
  prompt: string;
  trigger: unknown;
  enabled?: boolean;
}

function cleanInput(input: BotEventRoutineInput): { name: string; prompt: string; trigger: BotRoutineTrigger } {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name || [...name].length > 120) throw new Error("Give the routine a name of at most 120 characters.");
  if (!prompt || prompt.length > 32 * 1024) throw new Error("Say what the routine should do.");
  return { name, prompt, trigger: parseBotRoutineTrigger(input.trigger) };
}

export function createBotEventRoutineStore(options: { profileDir(): string; now?(): number }) {
  const now = options.now ?? Date.now;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_EVENT_ROUTINES_FILE);

  async function load(botId: string): Promise<BotEventRoutine[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      return Array.isArray(parsed)
        ? parsed.map((item) => parseRoutine(item, botId)).filter((item): item is BotEventRoutine => item !== undefined)
        : [];
    } catch {
      return [];
    }
  }

  async function save(botId: string, routines: BotEventRoutine[]): Promise<void> {
    await writeJsonAtomic(fileOf(botId), routines, { mode: 0o600, mkdirMode: 0o700 });
  }

  async function botIds(): Promise<string[]> {
    const root = path.join(options.profileDir(), "bots");
    const names = await fs.readdir(root).catch(() => [] as string[]);
    const ids: string[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const botId = botIdFromDirectoryName(name);
      if (botId !== null) ids.push(botId);
    }
    return ids;
  }

  return {
    list: load,

    /** Every Bot's event routines, for the sources that watch for events. */
    async all(): Promise<BotEventRoutine[]> {
      const routines: BotEventRoutine[] = [];
      for (const botId of await botIds()) routines.push(...(await load(botId)));
      return routines;
    },

    /** Creates a routine. A webhook routine's token is returned once and only its hash is stored. */
    create(botId: string, input: BotEventRoutineInput): Promise<{ routine: BotEventRoutine; token?: string }> {
      return serial(botId, async () => {
        const clean = cleanInput(input);
        const routines = await load(botId);
        if (routines.length >= BOT_EVENT_ROUTINES_MAX) throw new Error("This Bot has as many event routines as it can keep.");
        const at = now();
        const minted = clean.trigger.kind === "webhook" ? mintBotWebhookToken() : undefined;
        const routine: BotEventRoutine = {
          id: randomUUID(),
          botId,
          ...clean,
          enabled: input.enabled ?? true,
          createdAt: at,
          updatedAt: at,
          ...(minted ? { tokenHash: minted.tokenHash } : {}),
          seenEventIds: [],
        };
        await save(botId, [...routines, routine]);
        return { routine, ...(minted ? { token: minted.token } : {}) };
      });
    },

    update(botId: string, id: string, input: Partial<BotEventRoutineInput>): Promise<BotEventRoutine> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const index = routines.findIndex((routine) => routine.id === id);
        if (index < 0) throw new Error("This routine no longer exists.");
        const current = routines[index]!;
        const clean = cleanInput({
          name: input.name ?? current.name,
          prompt: input.prompt ?? current.prompt,
          trigger: input.trigger ?? current.trigger,
        });
        if (clean.trigger.kind !== current.trigger.kind) throw new Error("Make a new routine to change what starts it.");
        const next: BotEventRoutine = { ...current, ...clean, enabled: input.enabled ?? current.enabled, updatedAt: now() };
        routines[index] = next;
        await save(botId, routines);
        return next;
      });
    },

    /** A new link for a webhook routine; the old one stops working. */
    rotateToken(botId: string, id: string): Promise<string> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const index = routines.findIndex((routine) => routine.id === id);
        if (index < 0 || routines[index]!.trigger.kind !== "webhook") throw new Error("This routine has no link.");
        const minted = mintBotWebhookToken();
        routines[index] = { ...routines[index]!, tokenHash: minted.tokenHash, updatedAt: now() };
        await save(botId, routines);
        return minted.token;
      });
    },

    remove(botId: string, id: string): Promise<boolean> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const kept = routines.filter((routine) => routine.id !== id);
        if (kept.length === routines.length) return false;
        await save(botId, kept);
        return true;
      });
    },

    /** The webhook routine a token opens, compared by hash in constant time. */
    async findByToken(token: string): Promise<BotEventRoutine | undefined> {
      if (!/^[A-Za-z0-9_-]{20,100}$/u.test(token)) return undefined;
      const hash = hashWebhookToken(token);
      return (await this.all()).find((routine) =>
        routine.trigger.kind === "webhook" && routine.tokenHash !== undefined && sameHash(routine.tokenHash, hash));
    },

    /** Read-modify-write one routine's bookkeeping under the Bot's lock. */
    mutate<T>(botId: string, id: string, change: (routine: BotEventRoutine) => { next?: BotEventRoutine; result: T }): Promise<T | undefined> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const index = routines.findIndex((routine) => routine.id === id);
        if (index < 0) return undefined;
        const { next, result } = change(structuredClone(routines[index]!));
        if (next) {
          routines[index] = next;
          await save(botId, routines);
        }
        return result;
      });
    },
  };
}

export type BotEventRoutineStore = ReturnType<typeof createBotEventRoutineStore>;
