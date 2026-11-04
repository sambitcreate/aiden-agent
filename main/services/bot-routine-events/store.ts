// Event routines per Bot, in `<profile>/bots/<dir>/event-routines.json`: what
// to do, when (the trigger), and the bookkeeping the dispatcher's limits need
// (seen event ids, the last run, today's count, one held event). A watch
// routine also keeps its check state: the output's hash, a bounded copy of
// the output for the next diff, and when it was checked and is next due.

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
import { writeJsonAtomic, type DurableFsIo } from "../durable-fs.js";
import { parseConnectorPrivate, parseConnectorBaseline, ConnectorWatchStorageError, type BotConnectorWatchPrivate, type BotConnectorWatchBinding, type BotConnectorWatchBaseline } from "./connector-types.js";


export const BOT_EVENT_ROUTINES_FILE = "event-routines.json";
export const BOT_EVENT_ROUTINES_MAX = 16;
export const BOT_WEBHOOK_LIMITS = { tokenBytes: 32, bodyBytes: 16_384 } as const;

export interface BotEventReceipt {
  eventId: string;
  payload: string;
  at: number;
  watchRevision?: number;
}

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
  /** The Bot's suggestion the person accepted to add this routine. */
  sourceProposalId?: string;
  /** Dispatcher bookkeeping. */
  seenEventIds: string[];
  lastRunAt?: number;
  day?: { key: string; count: number };
  held?: BotEventReceipt;
  /** Accepted events whose run isn't recorded yet; replayed after a restart. */
  running?: BotEventReceipt[];
  /** Private connector binding/receipts, never part of event-routine views. */
  connector?: BotConnectorWatchPrivate;
  /** Watch routines only: what the last checks found. */
  watch?: BotWatchState;
}

export interface BotWatchState {
  connectorBaseline?: BotConnectorWatchBaseline;
  connectorItemCount?: number;
  /** A detected change owed to the dispatcher; saved atomically with its baseline. */
  pending?: { eventId: string; payload: string; revision: number; nextAttemptAt: number };
  /** sha256 hex of the last good output's exact bytes; absent until the baseline. */
  hash?: string;
  /** The last good output, cut to {@link BOT_WATCH_SNAPSHOT_CHARS}, for the next diff. */
  snapshot?: string;
  sameSince?: number;
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastResult?: BotWatchResult;
  failures: number;
  lastError?: string;
  /**
   * A failure (and maybe its "Needs you" card) that no success has settled yet.
   * Survives a source edit, which otherwise starts over, so the first good
   * check of the fixed source still settles the card.
   */
  unsettledFailure?: true;
}

export const BOT_WATCH_SNAPSHOT_CHARS = 16_000;
const WATCH_RESULTS: ReadonlySet<string> = new Set<BotWatchResult>(["baseline", "no_change", "changed", "error"]);

function watchPending(value: unknown): BotWatchState["pending"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { eventId, payload, revision, nextAttemptAt } = value as Record<string, unknown>;
  if (typeof eventId !== "string" || !/^[a-f0-9]{24}-[a-z0-9]+$/u.test(eventId)) return undefined;
  if (typeof payload !== "string" || payload.length > BOT_ROUTINE_EVENT_LIMITS.payloadChars * 2 ||
    [...payload].length > BOT_ROUTINE_EVENT_LIMITS.payloadChars) return undefined;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
    typeof nextAttemptAt !== "number" || !Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) return undefined;
  return { eventId, payload, revision, nextAttemptAt };
}

function parseWatchState(value: unknown,binding?:BotConnectorWatchBinding): BotWatchState {
  if (!value || typeof value !== "object" || Array.isArray(value)) { if(binding && value !== undefined)throw new ConnectorWatchStorageError(); return { failures: 0 }; }
  const record = value as Record<string, unknown>;
  const pending = watchPending(record.pending);
  const connectorBaseline = parseConnectorBaseline(record.connectorBaseline,binding);
  if(binding){
    const known=["pending","connectorBaseline","connectorItemCount","hash","snapshot","sameSince","lastCheckAt","nextCheckAt","lastResult","failures","lastError","unsettledFailure"];
    if(Object.keys(record).some(key=>!known.includes(key)) || record.pending!==undefined&&!pending || record.hash!==undefined&&(typeof record.hash!=="string"||!/^[a-f0-9]{64}$/u.test(record.hash)||!connectorBaseline)
      || record.connectorItemCount!==undefined&&(!Number.isSafeInteger(record.connectorItemCount)||(record.connectorItemCount as number)<0)
      || ["sameSince","lastCheckAt","nextCheckAt"].some(key=>record[key]!==undefined&&(!Number.isSafeInteger(record[key])||(record[key] as number)<0))
      || record.failures!==undefined&&(!Number.isSafeInteger(record.failures)||(record.failures as number)<0)
      || record.lastResult!==undefined&&!WATCH_RESULTS.has(record.lastResult as BotWatchResult))throw new ConnectorWatchStorageError();
  }

  const time = (key: string) => typeof record[key] === "number" && Number.isFinite(record[key]) ? { [key]: record[key] as number } : {};
  return {
    ...(pending ? { pending } : {}),
    ...(connectorBaseline ? { connectorBaseline } : {}),
    ...(Number.isSafeInteger(record.connectorItemCount) && (record.connectorItemCount as number) >= 0 ? { connectorItemCount: record.connectorItemCount as number } : {}),
    ...(typeof record.hash === "string" && /^[a-f0-9]{64}$/u.test(record.hash) ? { hash: record.hash } : {}),
    ...(typeof record.snapshot === "string" ? { snapshot: record.snapshot.slice(0, BOT_WATCH_SNAPSHOT_CHARS) } : {}),
    ...time("sameSince"),
    ...time("lastCheckAt"),
    ...time("nextCheckAt"),
    ...(typeof record.lastResult === "string" && WATCH_RESULTS.has(record.lastResult) ? { lastResult: record.lastResult as BotWatchResult } : {}),
    failures: typeof record.failures === "number" && Number.isInteger(record.failures) && record.failures >= 0 ? record.failures : 0,
    ...(typeof record.lastError === "string" ? { lastError: record.lastError.slice(0, 200) } : {}),
    ...(record.unsettledFailure === true ? { unsettledFailure: true as const } : {}),
  };
}

/** Where a watch's check state starts over: a new source (or a new watch) is checked right away. */
function freshWatch(at: number): BotWatchState {
  return { failures: 0, nextCheckAt: at };
}

export const BOT_EVENT_RUNNING_MAX = 4;

export type { BotEventRoutineView } from "../../../renderer/shared/bot-event-routines.js";
import type { BotEventRoutineView, BotWatchResult } from "../../../renderer/shared/bot-event-routines.js";

export function viewOf(routine: BotEventRoutine): BotEventRoutineView {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    prompt: routine.prompt,
    trigger: routine.trigger,
    enabled: routine.enabled,
    ...(routine.lastRunAt !== undefined ? { lastRunAt: routine.lastRunAt } : {}),
    ...(routine.trigger.kind === "watch" && routine.watch ? { watch: watchView(routine.watch) } : {}),
  };
}

function watchView(state: BotWatchState): NonNullable<BotEventRoutineView["watch"]> {
  const { hash: _hash, snapshot: _snapshot, unsettledFailure: _unsettled, pending: _pending, connectorBaseline: _baseline, connectorItemCount: _count, ...shown } = state;
  return shown;
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
  const connector = parseConnectorPrivate(record.connector);
  if (trigger.kind === "watch" && trigger.source.type === "connector" && (!connector || trigger.source.watchId !== record.id)) throw new ConnectorWatchStorageError();
  if (trigger.kind === "webhook" && (typeof record.tokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.tokenHash))) return undefined;
  const seen = Array.isArray(record.seenEventIds)
    ? record.seenEventIds.filter((id): id is string => typeof id === "string").slice(-BOT_ROUTINE_EVENT_LIMITS.seenIds)
    : [];
  const day = record.day && typeof record.day === "object" ? record.day as { key?: unknown; count?: unknown } : undefined;
  const held = record.held && typeof record.held === "object" ? record.held as { eventId?: unknown; payload?: unknown; at?: unknown; watchRevision?: unknown } : undefined;
  const running = Array.isArray(record.running)
    ? (record.running as Array<{ eventId?: unknown; payload?: unknown; at?: unknown; watchRevision?: unknown } | null>)
      .filter((entry): entry is { eventId: string; payload: string; at: number; watchRevision?: unknown } =>
        !!entry && typeof entry.eventId === "string" && typeof entry.payload === "string" && typeof entry.at === "number")
      .slice(-BOT_EVENT_RUNNING_MAX)
      .map(({ eventId, payload, at, watchRevision }) => ({ eventId, payload, at,
        ...(typeof watchRevision === "number" && Number.isSafeInteger(watchRevision) ? { watchRevision } : {}) }))
    : [];
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
    ...(typeof record.sourceProposalId === "string" ? { sourceProposalId: record.sourceProposalId } : {}),
    ...(connector ? { connector } : {}),
    seenEventIds: seen,
    ...(typeof record.lastRunAt === "number" ? { lastRunAt: record.lastRunAt } : {}),
    ...(day && typeof day.key === "string" && typeof day.count === "number" ? { day: { key: day.key, count: day.count } } : {}),
    ...(held && typeof held.eventId === "string" && typeof held.payload === "string" && typeof held.at === "number"
      ? { held: { eventId: held.eventId, payload: held.payload, at: held.at,
        ...(typeof held.watchRevision === "number" && Number.isSafeInteger(held.watchRevision) ? { watchRevision: held.watchRevision } : {}) } }
      : {}),
    ...(running.length ? { running } : {}),
    ...(trigger.kind === "watch" ? { watch: parseWatchState(record.watch,connector?.binding) } : {}),
  };
}

export interface BotEventRoutineInput {
  name: string;
  prompt: string;
  trigger: unknown;
  enabled?: boolean;
}

/** Only the Bot's accepted suggestion sets where a routine came from; the profile never does. */
export interface BotEventRoutineCreateInput extends BotEventRoutineInput {
  /** Host-only stable connector creation identity and private approved binding. */
  id?: string;
  connector?: BotConnectorWatchPrivate;
  sourceProposalId?: string;
}

function cleanInput(input: BotEventRoutineInput): { name: string; prompt: string; trigger: BotRoutineTrigger } {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name || [...name].length > 120) throw new Error("Give the routine a name of at most 120 characters.");
  if (!prompt || prompt.length > 32 * 1024) throw new Error("Say what the routine should do.");
  return { name, prompt, trigger: parseBotRoutineTrigger(input.trigger) };
}

type WatchTrigger = Extract<BotRoutineTrigger, { kind: "watch" }>;

/**
 * A person's edit of a watch: a new source starts over with a fresh baseline;
 * a new interval moves the next check; turning it back on clears the failure
 * count and checks soon.
 */
function nextWatchState(state: BotWatchState, before: WatchTrigger, after: WatchTrigger, reenabled: boolean, at: number): BotWatchState {
  if (JSON.stringify(before.source) !== JSON.stringify(after.source)) {
    const unsettled = state.unsettledFailure || state.failures > 0 || state.lastResult === "error";
    return { ...freshWatch(at), ...(unsettled ? { unsettledFailure: true as const } : {}) };
  }
  let next = state;
  if (before.everyMinutes !== after.everyMinutes) {
    next = { ...next, nextCheckAt: (next.lastCheckAt ?? at) + after.everyMinutes * 60_000 };
  }
  if (reenabled) next = { ...next, failures: 0, nextCheckAt: at };
  return next;
}

export interface BotEventPublicationGuard { beforePublish?():Promise<void>; assertCurrent():void }
export function createBotEventRoutineStore(options: { profileDir(): string; now?(): number; /** Test-only durable I/O seams. */ io?:Partial<DurableFsIo> }) {
  const now = options.now ?? Date.now;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_EVENT_ROUTINES_FILE);

  async function load(botId: string): Promise<BotEventRoutine[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      if(!Array.isArray(parsed))throw new ConnectorWatchStorageError();
      return parsed.map((item)=>parseRoutine(item,botId)).filter((item):item is BotEventRoutine=>item!==undefined);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==="ENOENT")return [];
      throw error instanceof ConnectorWatchStorageError?error:new ConnectorWatchStorageError();
    }
  }

  async function save(botId: string, routines: BotEventRoutine[], guard?:BotEventPublicationGuard): Promise<void> {
    guard?.assertCurrent();
    await writeJsonAtomic(fileOf(botId), routines, { mode: 0o600, mkdirMode: 0o700, ...guard, io:options.io });
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

    /**
     * Creates a routine. A webhook routine's token is returned once and only
     * its hash is stored. Creating from a suggestion that already made one
     * returns that routine, with no new token.
     */
    create(botId: string, input: BotEventRoutineCreateInput, validate?: (routines: readonly BotEventRoutine[]) => void, guard?:BotEventPublicationGuard): Promise<{ routine: BotEventRoutine; token?: string }> {
      return serial(botId, async () => {
        const clean = cleanInput(input);
        if (clean.trigger.kind === "watch" && clean.trigger.source.type === "connector" && (!input.connector || input.id !== clean.trigger.source.watchId)) throw new Error("A connector watch requires an approved host binding.");
        const routines = (await load(botId)).filter((routine) => routine.connector?.deletedAt === undefined || routine.connector.deletedAt >= now() - 86_400_000);
        if (routines.filter((routine) => routine.connector?.deletedAt !== undefined).length >= 128) throw new Error("Too many recent deleted connector watches. Try again tomorrow.");
        const identified = input.id ? routines.find((routine) => routine.id === input.id) : undefined;
        if (identified) return { routine: identified };
        const existing = input.sourceProposalId !== undefined
          ? routines.find((routine) => routine.sourceProposalId === input.sourceProposalId)
          : undefined;
        if (existing) return { routine: existing };
        if (routines.filter((routine) => routine.connector?.deletedAt === undefined).length >= BOT_EVENT_ROUTINES_MAX) throw new Error("This Bot has as many event routines as it can keep.");
        const at = now();
        const minted = clean.trigger.kind === "webhook" ? mintBotWebhookToken() : undefined;
        const routine: BotEventRoutine = {
          id: input.id ?? randomUUID(),
          ...(input.connector ? { connector: input.connector } : {}),
          botId,
          ...clean,
          enabled: input.enabled ?? true,
          createdAt: at,
          updatedAt: at,
          ...(minted ? { tokenHash: minted.tokenHash } : {}),
          ...(input.sourceProposalId !== undefined ? { sourceProposalId: input.sourceProposalId } : {}),
          seenEventIds: [],
          // The first check takes the baseline soon after the person adds it.
          ...(clean.trigger.kind === "watch" ? { watch: freshWatch(at) } : {}),
        };
        const next = [...routines, routine];
        guard?.assertCurrent();validate?.(next);
        await save(botId, next, guard);
        return { routine, ...(minted ? { token: minted.token } : {}) };
      });
    },

    /** The routine an accepted suggestion added, if any. */
    async findBySourceProposal(botId: string, proposalId: string): Promise<BotEventRoutine | undefined> {
      return (await load(botId)).find((routine) => routine.sourceProposalId === proposalId);
    },

    update(botId: string, id: string, input: Partial<BotEventRoutineInput>): Promise<BotEventRoutine> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const index = routines.findIndex((routine) => routine.id === id);
        if (index < 0) throw new Error("This routine no longer exists.");
        const current = routines[index]!;
        if (current.connector) throw new Error("Use the connector watch controls to edit this watch.");
        const clean = cleanInput({
          name: input.name ?? current.name,
          prompt: input.prompt ?? current.prompt,
          trigger: input.trigger ?? current.trigger,
        });
        if (clean.trigger.kind !== current.trigger.kind) throw new Error("Make a new routine to change what starts it.");
        const at = now();
        const revision = Math.max(at, current.updatedAt + 1);
        const enabled = input.enabled ?? current.enabled;
        const next: BotEventRoutine = { ...current, ...clean, enabled, updatedAt: revision };
        if (clean.trigger.kind === "watch" && current.trigger.kind === "watch") {
          next.watch = nextWatchState(current.watch ?? { failures: 0 }, current.trigger, clean.trigger, !current.enabled && enabled, at);
          if (next.watch.pending) {
            if (clean.prompt !== current.prompt) delete next.watch.pending;
            else next.watch = { ...next.watch, pending: { ...next.watch.pending, revision } };
          }
          if (clean.prompt === current.prompt && JSON.stringify(clean.trigger.source) === JSON.stringify(current.trigger.source)) {
            if (next.held?.watchRevision === current.updatedAt) next.held = { ...next.held, watchRevision: revision };
            if (next.running) next.running = next.running.map((event) => event.watchRevision === current.updatedAt ? { ...event, watchRevision: revision } : event);
          } else {
            // Retire queued output of the old source/task, including legacy
            // receipts with no revision. A later harmless edit cannot revive it.
            delete next.held;
            delete next.running;
          }
        }
        routines[index] = next;
        await save(botId, routines);
        return next;
      });
    },

    /** Internal activity reduction only; legacy external CRUD cannot edit connector watches. */
    pause(botId: string, id: string): Promise<BotEventRoutine> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const index = routines.findIndex((routine) => routine.id === id && routine.connector?.deletedAt === undefined);
        if (index < 0) throw new Error("This routine no longer exists.");
        const current = routines[index]!;
        if (!current.enabled) return current;
        const revision = Math.max(now(), current.updatedAt + 1);
        const next: BotEventRoutine = { ...current, enabled: false, updatedAt: revision };
        if (current.watch) {
          next.watch = { ...current.watch, ...(current.watch.pending ? { pending: { ...current.watch.pending, revision } } : {}) };
          if (current.held?.watchRevision === current.updatedAt) next.held = { ...current.held, watchRevision: revision };
          next.running = current.running?.filter((event) => event.watchRevision === current.updatedAt).map((event) => ({ ...event, watchRevision: revision }));
        }
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
        if (routines.some((routine) => routine.id === id && routine.connector)) throw new Error("Use the connector watch controls to delete this watch.");
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
    mutate<T>(botId: string, id: string, change: (routine: BotEventRoutine, routines: readonly BotEventRoutine[]) => { next?: BotEventRoutine; result: T } | Promise<{ next?: BotEventRoutine; result: T }>, guard?:BotEventPublicationGuard): Promise<T | undefined> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const index = routines.findIndex((routine) => routine.id === id);
        if (index < 0) return undefined;
        guard?.assertCurrent();
        const { next, result } = await change(structuredClone(routines[index]!), structuredClone(routines));
        if (next) {
          routines[index] = next;
          await save(botId, routines, guard);
        }
        return result;
      });
    },
  };
}

export type BotEventRoutineStore = ReturnType<typeof createBotEventRoutineStore>;
