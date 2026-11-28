// Bookkeeping for chat tasks that run when something happens, in
// `<userData>/scheduled-task-triggers.json`: seen event ids, the last run and
// today's count, one held event, receipts of accepted events not yet recorded
// (replayed after a restart) and a watch's check state. The task itself (its
// trigger, prompt and on/off state) lives in the schedule store; this file
// only keeps what the shared event core needs to apply its limits.
//
// Each trigger task is one routine for the shared event core
// (bot-routine-events/dispatcher.ts, watch.ts), keyed by the task's id. Its
// revision (`updatedAt` for the core) moves only when the trigger, the prompt
// or the on/off state changes, so a run being recorded never retires a
// change a watch already saw.

import { createHash, timingSafeEqual } from "node:crypto";
import type { BotRoutineTrigger } from "../../renderer/shared/bot-routine-trigger.js";
import {
  BOT_ROUTINE_EVENT_LIMITS,
  BOT_WATCH_LIMITS,
} from "../../renderer/shared/bot-routine-trigger.js";
import {
  SCHEDULED_TASK_LINK_LIMITS,
  SCHEDULED_TASK_TRIGGER_LIMITS,
  type ScheduledTaskTrigger,
} from "../../renderer/shared/scheduled-task-trigger.js";
import type { EventRoutine, EventRoutineStore } from "./bot-routine-events/dispatcher.js";
import {
  BOT_EVENT_RUNNING_MAX,
  BOT_WATCH_SNAPSHOT_CHARS,
  type BotEventDropNotice,
  type BotEventDropPart,
  type BotEventPublicationGuard,
  type BotEventReceipt,
  type BotWatchState,
} from "./bot-routine-events/store.js";
import {
  parseConnectorBaseline,
  parseConnectorPrivate,
} from "./bot-routine-events/connector-types.js";
import type { TaskConnectorSource } from "./scheduled-task-connector-trigger.js";
import type { ScheduledTask } from "./types.js";

export const SCHEDULED_TASK_TRIGGERS_FILE = "scheduled-task-triggers.json";

/** One event's payload bound: a link batch holds up to 20 calls. */
export const TASK_TRIGGER_PAYLOAD_CHARS = SCHEDULED_TASK_TRIGGER_LIMITS.eventTextChars;

/** What happened to one call of a task's link (newest last, 50 kept). */
export interface TaskLinkLogEntry {
  at: number;
  outcome:
    | "ran"
    | "batched"
    | "duplicate"
    | "daily_limit"
    | "dropped"
    | "filtered"
    | "bad_signature"
    | "invalid"
    | "off";
  /** The body, credentials withheld, cut to 2 KB. */
  preview: string;
  /** Refused calls within a minute share one entry: how many more came after the first. */
  repeats?: number;
}

/** Drop cards waiting to be shown, per task. */
const DROP_NOTICES_MAX = 8;
/** Keyed log lines remembered per task (`appliedLogKeys`). */
export const APPLIED_LOG_KEYS_MAX = 32;

function appliedLogKeysOf(value: unknown): Pick<TaskTriggerBook, "appliedLogKeys"> {
  const keys = Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (key): key is string => typeof key === "string" && key.length > 0 && key.length <= 300,
          ),
        ),
      ].slice(-APPLIED_LOG_KEYS_MAX)
    : [];
  return keys.length ? { appliedLogKeys: keys } : {};
}

/** A drop notice's log line is keyed `<notice id>:log`; its key is kept while the notice is. */
const logKeyOf = (notice: BotEventDropNotice) => `${notice.id}:log`;
const LOG_OUTCOMES = new Set<TaskLinkLogEntry["outcome"]>([
  "ran",
  "batched",
  "duplicate",
  "daily_limit",
  "dropped",
  "filtered",
  "bad_signature",
  "invalid",
  "off",
]);

export function hashTaskLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** A trigger task as the shared event core sees it. */
export interface TaskTriggerRoutine extends EventRoutine {
  /** The saved task this routine stands for. */
  task: ScheduledTask & { trigger: ScheduledTaskTrigger };
  /** Script checks that finished so far (`AIDEN_CHECK_RUNS`). */
  checkRuns: number;
  /** A connected-app task's exact source; until one is bound the routine stays off. */
  connectorSource?: TaskConnectorSource;
}

interface TaskTriggerBook {
  /** What the revision was taken for: the trigger, prompt and on/off state. */
  fingerprint: string;
  revision: number;
  seenEventIds: string[];
  lastRunAt?: number;
  day?: { key: string; count: number };
  held?: BotEventReceipt;
  running?: BotEventReceipt[];
  /** Retry drops whose card isn't shown yet (`requeue`). */
  dropNotices?: BotEventDropNotice[];
  watch?: BotWatchState;
  checkRuns: number;
  /** A link task's token, by hash; the token itself is never stored. */
  tokenHash?: string;
  log?: TaskLinkLogEntry[];
  /** A connected-app task's exact source, set only by a save after Find sources. */
  connector?: TaskConnectorSource;
  /** A save added or changed the link's signature header: the link needs rotating to get a secret. */
  needsNewLink?: true;
  /**
   * Keys of log lines already written by a write that may be retried (a drop
   * notice's line), kept apart from the visible log so new calls can't push
   * one out. A key goes in the write that clears its notice. Never shown.
   */
  appliedLogKeys?: string[];
}

interface Persistence<T> {
  load(): Promise<T>;
  update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R>;
}

export interface ScheduledTaskTriggerStoreDependencies {
  persistence: Persistence<unknown>;
  /** Every saved task; trigger tasks of the person's own (no Bot) become routines. */
  tasks(): Promise<ScheduledTask[]>;
  /**
   * The event core turned a routine off: the task pauses. `afterFailures` is
   * false when one check paused it at once (a connected app that was removed).
   */
  pauseTask(taskId: string, reason: string, afterFailures: boolean): Promise<void>;
  /**
   * A task stopped being a link or script task, or lost its trigger: its
   * link secret and script state file can go. Called once, after the change is saved.
   */
  released?(taskId: string): void;
  now(): number;
}

type TriggerTask = ScheduledTask & { trigger: ScheduledTaskTrigger };

function isTriggerTask(task: ScheduledTask): task is TriggerTask {
  return task.trigger !== undefined && task.botId === undefined && task.mode === "llm";
}

function fingerprintOf(task: TriggerTask): string {
  return JSON.stringify({
    trigger: task.trigger,
    prompt: task.prompt ?? "",
    enabled: task.enabled,
  });
}

function parseFingerprint(value: string): {
  trigger?: ScheduledTaskTrigger;
  prompt?: string;
  enabled?: boolean;
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as { trigger?: ScheduledTaskTrigger; prompt?: string; enabled?: boolean })
      : {};
  } catch {
    return {};
  }
}

const sourceKey = (trigger: ScheduledTaskTrigger | undefined) =>
  JSON.stringify(
    trigger
      ? trigger.kind === "watch"
        ? [trigger.kind, trigger.source]
        : trigger.kind === "connector"
          ? [trigger.kind, trigger.condition, trigger.source]
          : [trigger.kind]
      : null,
  );

/** The shared core's trigger shape: a task's watch has the same fields as a Bot watch. */
function coreTrigger(trigger: ScheduledTaskTrigger, taskId: string): BotRoutineTrigger {
  if (trigger.kind === "webhook") return { kind: "webhook" } as BotRoutineTrigger;
  if (trigger.kind === "connector")
    return {
      kind: "watch",
      source: { type: "connector", watchId: taskId },
      everyMinutes: trigger.everyMinutes,
    };
  return {
    kind: "watch",
    source: { ...trigger.source },
    everyMinutes: trigger.everyMinutes,
  } as BotRoutineTrigger;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A held or pending payload within the event bound, counted in code points as the dispatcher cuts it. */
const payloadFits = (text: string) =>
  text.length <= TASK_TRIGGER_PAYLOAD_CHARS * 2 && [...text].length <= TASK_TRIGGER_PAYLOAD_CHARS;

function parseReceipt(value: unknown): BotEventReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.eventId !== "string" ||
    row.eventId.length > 200 ||
    typeof row.payload !== "string" ||
    !finite(row.at)
  )
    return undefined;
  if (!payloadFits(row.payload)) return undefined;
  return {
    eventId: row.eventId,
    payload: row.payload,
    at: row.at,
    ...(finite(row.watchRevision) ? { watchRevision: row.watchRevision } : {}),
    ...(finite(row.retries) && row.retries > 0 && row.retries <= 100
      ? { retries: row.retries }
      : {}),
  };
}

function parseWatch(value: unknown): BotWatchState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const pending =
    row.pending && typeof row.pending === "object"
      ? (row.pending as Record<string, unknown>)
      : undefined;
  const results = new Set(["baseline", "no_change", "changed", "error"]);
  return {
    failures: finite(row.failures) ? row.failures : 0,
    ...(pending &&
    typeof pending.eventId === "string" &&
    typeof pending.payload === "string" &&
    payloadFits(pending.payload) &&
    finite(pending.revision) &&
    finite(pending.nextAttemptAt)
      ? {
          pending: {
            eventId: pending.eventId,
            payload: pending.payload,
            revision: pending.revision,
            nextAttemptAt: pending.nextAttemptAt,
          },
        }
      : {}),
    ...(typeof row.hash === "string" && /^[a-f0-9]{64}$/u.test(row.hash) ? { hash: row.hash } : {}),
    ...(typeof row.snapshot === "string"
      ? { snapshot: row.snapshot.slice(0, BOT_WATCH_SNAPSHOT_CHARS) }
      : {}),
    ...(finite(row.sameSince) ? { sameSince: row.sameSince } : {}),
    ...(finite(row.lastCheckAt) ? { lastCheckAt: row.lastCheckAt } : {}),
    ...(finite(row.nextCheckAt) ? { nextCheckAt: row.nextCheckAt } : {}),
    ...(typeof row.lastResult === "string" && results.has(row.lastResult)
      ? { lastResult: row.lastResult as BotWatchState["lastResult"] }
      : {}),
    ...(typeof row.lastError === "string" ? { lastError: row.lastError.slice(0, 200) } : {}),
    ...(row.unsettledFailure === true ? { unsettledFailure: true as const } : {}),
    ...connectorWatchFields(row),
  };
}

/** A connected-app check's saved comparison state; anything unreadable starts a new baseline. */
function connectorWatchFields(
  row: Record<string, unknown>,
): Pick<BotWatchState, "connectorBaseline" | "connectorItemCount"> {
  let baseline: BotWatchState["connectorBaseline"];
  try {
    baseline =
      row.connectorBaseline === undefined
        ? undefined
        : parseConnectorBaseline(row.connectorBaseline);
  } catch {
    baseline = undefined;
  }
  return {
    ...(baseline ? { connectorBaseline: baseline } : {}),
    ...(finite(row.connectorItemCount) ? { connectorItemCount: row.connectorItemCount } : {}),
  };
}

function parseConnectorSource(value: unknown): TaskConnectorSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.serverFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.serverFingerprint))
    return undefined;
  const binding = row.binding as TaskConnectorSource["binding"] | undefined;
  if (!binding || typeof binding !== "object") return undefined;
  // The Bot watch validator checks the binding with a matching condition.
  const condition =
    binding.adapter === "imcp-mail-v1"
      ? { kind: "email" as const, unreadOnly: false }
      : { kind: "calendar" as const, lookAheadMinutes: 60, timezone: "UTC" };
  const parsed = parseConnectorPrivate({ binding, condition, createDigest: "task", mutations: [] });
  return parsed ? { binding: parsed.binding, serverFingerprint: row.serverFingerprint } : undefined;
}

function parseBook(value: unknown): TaskTriggerBook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.fingerprint !== "string" || !finite(row.revision)) return undefined;
  const day =
    row.day && typeof row.day === "object" ? (row.day as Record<string, unknown>) : undefined;
  const held = parseReceipt(row.held);
  const running = Array.isArray(row.running)
    ? row.running
        .map(parseReceipt)
        .filter((receipt): receipt is BotEventReceipt => receipt !== undefined)
        .slice(-BOT_EVENT_RUNNING_MAX)
    : [];
  const watch = parseWatch(row.watch);
  const dropNotices = Array.isArray(row.dropNotices)
    ? row.dropNotices
        .flatMap((entry): BotEventDropNotice[] => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          const held = parseReceipt(item.held);
          if (
            typeof item.id !== "string" ||
            item.id.length > 300 ||
            item.reason !== "retries" ||
            !held
          )
            return [];
          const done = Array.isArray(item.done)
            ? [
                ...new Set(
                  item.done.filter(
                    (part): part is BotEventDropPart => part === "card" || part === "log",
                  ),
                ),
              ]
            : [];
          return [
            {
              id: item.id,
              reason: "retries",
              held,
              ...(done.length ? { done } : {}),
              ...(finite(item.failures) && item.failures > 0 && item.failures <= 100
                ? { failures: item.failures }
                : {}),
            },
          ];
        })
        .slice(-DROP_NOTICES_MAX)
    : [];
  const log = Array.isArray(row.log)
    ? row.log
        .flatMap((entry): TaskLinkLogEntry[] => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          return finite(item.at) &&
            typeof item.outcome === "string" &&
            LOG_OUTCOMES.has(item.outcome as TaskLinkLogEntry["outcome"]) &&
            typeof item.preview === "string"
            ? [
                {
                  at: item.at,
                  outcome: item.outcome as TaskLinkLogEntry["outcome"],
                  preview: item.preview.slice(0, SCHEDULED_TASK_LINK_LIMITS.previewBytes),
                  ...(finite(item.repeats) && item.repeats > 0 ? { repeats: item.repeats } : {}),
                },
              ]
            : [];
        })
        .slice(-SCHEDULED_TASK_LINK_LIMITS.log)
    : [];
  return {
    fingerprint: row.fingerprint,
    revision: row.revision,
    seenEventIds: Array.isArray(row.seenEventIds)
      ? row.seenEventIds
          .filter((id): id is string => typeof id === "string")
          .slice(-BOT_ROUTINE_EVENT_LIMITS.seenIds)
      : [],
    ...(finite(row.lastRunAt) ? { lastRunAt: row.lastRunAt } : {}),
    ...(day && typeof day.key === "string" && finite(day.count)
      ? { day: { key: day.key, count: day.count } }
      : {}),
    ...(held ? { held } : {}),
    ...(running.length ? { running } : {}),
    ...(dropNotices.length ? { dropNotices } : {}),
    ...(watch ? { watch } : {}),
    checkRuns: finite(row.checkRuns) ? row.checkRuns : 0,
    ...(typeof row.tokenHash === "string" && /^[a-f0-9]{64}$/u.test(row.tokenHash)
      ? { tokenHash: row.tokenHash }
      : {}),
    ...(log.length ? { log } : {}),
    ...(parseConnectorSource(row.connector)
      ? { connector: parseConnectorSource(row.connector)! }
      : {}),
    ...(row.needsNewLink === true && typeof row.tokenHash === "string"
      ? { needsNewLink: true as const }
      : {}),
    ...appliedLogKeysOf(row.appliedLogKeys),
  };
}

function books(draft: unknown): Record<string, unknown> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return {};
  const tasks = (draft as Record<string, unknown>).tasks;
  return tasks && typeof tasks === "object" && !Array.isArray(tasks)
    ? (tasks as Record<string, unknown>)
    : {};
}

/**
 * The bookkeeping for a task as saved now. A new trigger task starts with a
 * check due right away. A changed source starts over with a fresh baseline; a
 * changed prompt retires what was queued for the old one; turning the task
 * back on clears the failure count and checks soon; any other change keeps
 * queued work, re-stamped with the new revision.
 */
export function reconcileTaskTriggerBook(
  book: TaskTriggerBook | undefined,
  task: TriggerTask,
  now: number,
): TaskTriggerBook {
  const fingerprint = fingerprintOf(task);
  if (!book) {
    return {
      fingerprint,
      revision: now,
      seenEventIds: [],
      watch: { failures: 0, nextCheckAt: now },
      checkRuns: 0,
    };
  }
  if (book.fingerprint === fingerprint) return book;
  const before = parseFingerprint(book.fingerprint);
  const revision = Math.max(now, book.revision + 1);
  const next: TaskTriggerBook = { ...book, fingerprint, revision };
  let watch: BotWatchState = book.watch ?? { failures: 0 };
  if (
    before.trigger?.kind === "webhook" &&
    task.trigger.kind === "webhook" &&
    book.tokenHash !== undefined &&
    task.trigger.signatureHeader !== undefined &&
    task.trigger.signatureHeader !== before.trigger.signatureHeader
  ) {
    next.needsNewLink = true;
  }
  if (sourceKey(before.trigger) !== sourceKey(task.trigger)) {
    const unsettled = watch.unsettledFailure || watch.failures > 0 || watch.lastResult === "error";
    next.watch = {
      failures: 0,
      nextCheckAt: now,
      ...(unsettled ? { unsettledFailure: true as const } : {}),
    };
    next.checkRuns = 0;
    delete next.held;
    delete next.running;
    if (task.trigger.kind !== "webhook") {
      delete next.tokenHash;
      delete next.log;
      delete next.appliedLogKeys;
      delete next.needsNewLink;
    }
    // A connected-app source stays bound through filter edits; switching
    // between Mail and Calendar needs a new one from Find sources.
    if (
      task.trigger.kind !== "connector" ||
      before.trigger?.kind !== "connector" ||
      before.trigger.condition.kind !== task.trigger.condition.kind
    )
      delete next.connector;
    return next;
  }
  if (
    (before.trigger?.kind === "watch" || before.trigger?.kind === "connector") &&
    (task.trigger.kind === "watch" || task.trigger.kind === "connector") &&
    before.trigger.everyMinutes !== task.trigger.everyMinutes
  ) {
    watch = {
      ...watch,
      nextCheckAt: (watch.lastCheckAt ?? now) + task.trigger.everyMinutes * 60_000,
    };
  }
  if (before.enabled === false && task.enabled) watch = { ...watch, failures: 0, nextCheckAt: now };
  if ((before.prompt ?? "") !== (task.prompt ?? "")) {
    const { pending: _retired, ...kept } = watch;
    watch = kept;
    delete next.held;
    delete next.running;
  } else {
    if (watch.pending?.revision === book.revision)
      watch = { ...watch, pending: { ...watch.pending, revision } };
    if (next.held?.watchRevision === book.revision)
      next.held = { ...next.held, watchRevision: revision };
    if (next.running) {
      next.running = next.running.map((receipt) =>
        receipt.watchRevision === book.revision ? { ...receipt, watchRevision: revision } : receipt,
      );
    }
  }
  next.watch = watch;
  return next;
}

function routineOf(task: TriggerTask, book: TaskTriggerBook): TaskTriggerRoutine {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt ?? "",
    trigger: coreTrigger(task.trigger, task.id),
    // A connected-app task does nothing until a save binds its source.
    enabled: task.enabled && (task.trigger.kind !== "connector" || book.connector !== undefined),
    createdAt: task.createdAt,
    updatedAt: book.revision,
    seenEventIds: [...book.seenEventIds],
    ...(book.lastRunAt !== undefined ? { lastRunAt: book.lastRunAt } : {}),
    ...(book.day ? { day: { ...book.day } } : {}),
    ...(book.held ? { held: structuredClone(book.held) } : {}),
    ...(book.running ? { running: structuredClone(book.running) } : {}),
    ...(book.dropNotices ? { dropNotices: structuredClone(book.dropNotices) } : {}),
    ...(book.watch ? { watch: structuredClone(book.watch) } : {}),
    ...(book.tokenHash ? { tokenHash: book.tokenHash } : {}),
    task,
    checkRuns: book.checkRuns,
    ...(book.connector ? { connectorSource: structuredClone(book.connector) } : {}),
  };
}

function bookOf(routine: TaskTriggerRoutine, base: TaskTriggerBook): TaskTriggerBook {
  return {
    fingerprint: base.fingerprint,
    revision: base.revision,
    seenEventIds: routine.seenEventIds.slice(-BOT_ROUTINE_EVENT_LIMITS.seenIds),
    ...(routine.lastRunAt !== undefined ? { lastRunAt: routine.lastRunAt } : {}),
    ...(routine.day ? { day: routine.day } : {}),
    ...(routine.held ? { held: routine.held } : {}),
    ...(routine.running?.length ? { running: routine.running.slice(-BOT_EVENT_RUNNING_MAX) } : {}),
    ...(routine.dropNotices?.length
      ? { dropNotices: routine.dropNotices.slice(-DROP_NOTICES_MAX) }
      : {}),
    ...(routine.watch ? { watch: routine.watch } : {}),
    checkRuns: routine.checkRuns,
    // The token and the call log change only through their own methods.
    ...(base.tokenHash ? { tokenHash: base.tokenHash } : {}),
    ...(base.log ? { log: base.log } : {}),
    ...(base.connector ? { connector: base.connector } : {}),
    ...(base.needsNewLink ? { needsNewLink: true as const } : {}),
    // A key leaves with its notice: once the notice is cleared, nothing retries its line.
    ...appliedLogKeysOf(
      base.appliedLogKeys?.filter((key) =>
        routine.dropNotices?.some((notice) => logKeyOf(notice) === key),
      ),
    ),
  };
}

export function createScheduledTaskTriggerStore(
  dependencies: ScheduledTaskTriggerStoreDependencies,
) {
  let tail: Promise<unknown> = Promise.resolve();
  /** One change at a time across the file; every routine shares it. */
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const run = tail.then(action, action);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Link token hashes to task ids, kept from the saved bookkeeping so an
   * unknown token is answered without reading the tasks or writing the file.
   * Stale entries are harmless: a hit is checked again under `load()`.
   */
  let tokenIndex: Map<string, string> | undefined;
  const indexFrom = (stored: Record<string, unknown>) => {
    const index = new Map<string, string>();
    for (const [id, value] of Object.entries(stored)) {
      const book = parseBook(value);
      if (book?.tokenHash) index.set(book.tokenHash, id);
    }
    return index;
  };

  async function tokenTask(token: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{20,100}$/u.test(token)) return undefined;
    const hash = hashTaskLinkToken(token);
    tokenIndex ??= indexFrom(books(await dependencies.persistence.load()));
    let id: string | undefined;
    for (const [known, taskId] of tokenIndex) if (sameHash(known, hash)) id = taskId;
    return id;
  }

  /** Whether a saved trigger kept something that outlives it: a link secret or a script state file. */
  const leavesSomething = (trigger: ScheduledTaskTrigger | undefined) =>
    trigger?.kind === "webhook" || (trigger?.kind === "watch" && trigger.source.type === "script");

  /** Reconcile every trigger task's bookkeeping with the saved tasks; drop what belongs to no task. */
  async function load(): Promise<Map<string, TaskTriggerRoutine>> {
    const tasks = (await dependencies.tasks()).filter(isTriggerTask);
    const released: string[] = [];
    const routines = await dependencies.persistence.update((draft) => {
      const record =
        draft && typeof draft === "object" && !Array.isArray(draft)
          ? (draft as Record<string, unknown>)
          : {};
      const stored = books(record);
      const now = dependencies.now();
      const next: Record<string, TaskTriggerBook> = {};
      const routines = new Map<string, TaskTriggerRoutine>();
      for (const task of tasks) {
        const previous = parseBook(stored[task.id]);
        const book = reconcileTaskTriggerBook(previous, task, now);
        if (previous && previous.fingerprint !== book.fingerprint) {
          const before = parseFingerprint(previous.fingerprint).trigger;
          const linkGone = before?.kind === "webhook" && task.trigger.kind !== "webhook";
          const scriptGone =
            before?.kind === "watch" &&
            before.source.type === "script" &&
            !(task.trigger.kind === "watch" && task.trigger.source.type === "script");
          if (linkGone || scriptGone) released.push(task.id);
        }
        next[task.id] = book;
        routines.set(task.id, routineOf(task, book));
      }
      for (const [id, value] of Object.entries(stored)) {
        const book = parseBook(value);
        if (!next[id] && book && leavesSomething(parseFingerprint(book.fingerprint).trigger))
          released.push(id);
      }
      record.version = 1;
      record.tasks = next;
      tokenIndex = indexFrom(next);
      return routines;
    });
    for (const id of released) dependencies.released?.(id);
    return routines;
  }

  return {
    /** The routine for one task (the owner key is the task id). */
    list(ownerKey: string): Promise<TaskTriggerRoutine[]> {
      return serial(async () => {
        const routine = (await load()).get(ownerKey);
        return routine ? [routine] : [];
      });
    },

    /** Every trigger task, for the watches and replay. */
    all(): Promise<TaskTriggerRoutine[]> {
      return serial(async () => [...(await load()).values()]);
    },

    /**
     * Read-modify-write one task's bookkeeping. A change that turns the
     * routine off (three failed checks) pauses the task itself, since its
     * trigger is the only thing that runs it.
     */
    mutate<T>(
      _ownerKey: string,
      id: string,
      change: (
        routine: TaskTriggerRoutine,
        routines: readonly TaskTriggerRoutine[],
      ) =>
        | { next?: TaskTriggerRoutine; result: T }
        | Promise<{ next?: TaskTriggerRoutine; result: T }>,
      guard?: BotEventPublicationGuard,
    ): Promise<T | undefined> {
      return serial(async () => {
        const routines = await load();
        const current = routines.get(id);
        if (!current) return undefined;
        guard?.assertCurrent();
        const { next, result } = await change(
          structuredClone(current),
          structuredClone([...routines.values()]),
        );
        if (!next) return result;
        await guard?.beforePublish?.();
        guard?.assertCurrent();
        let fingerprint: string | undefined;
        if (!next.enabled && current.enabled) {
          await dependencies.pauseTask(
            id,
            next.watch?.lastError ?? "",
            (next.watch?.failures ?? 0) >= BOT_WATCH_LIMITS.failuresBeforePause,
          );
          // The pause is part of this change: same revision, so the work it
          // held stays tied to it until the person turns the task back on.
          fingerprint = fingerprintOf({ ...current.task, enabled: false });
        }
        await dependencies.persistence.update((draft) => {
          const record =
            draft && typeof draft === "object" && !Array.isArray(draft)
              ? (draft as Record<string, unknown>)
              : {};
          const stored = books(record);
          const base = parseBook(stored[id]);
          if (!base) return;
          stored[id] = bookOf(next, fingerprint ? { ...base, fingerprint } : base);
          record.version = 1;
          record.tasks = stored;
        });
        return result;
      });
    },

    /**
     * The task id a link token belongs to, from the in-memory index only (the
     * file is read once, read-only, to build it); compared by hash in constant
     * time. Never reads the tasks, never writes. Stale entries are possible
     * until the next `load()`, so a hit is checked again by `findByToken`.
     */
    tokenTask,

    /**
     * The link task a token opens, disabled tasks too. Read-only: the routine
     * is built from the saved task and its book as `load()` would reconcile
     * it, without writing, so calls to a known link (even a leaked token of a
     * task that is off) never write the file before the link's own limits.
     */
    async findByToken(token: string): Promise<TaskTriggerRoutine | undefined> {
      const id = await tokenTask(token);
      if (id === undefined) return undefined;
      const hash = hashTaskLinkToken(token);
      const task = (await dependencies.tasks()).find((candidate) => candidate.id === id);
      if (!task || !isTriggerTask(task) || task.trigger.kind !== "webhook") return undefined;
      const book = reconcileTaskTriggerBook(
        parseBook(books(await dependencies.persistence.load())[id]),
        task,
        dependencies.now(),
      );
      return book.tokenHash !== undefined && sameHash(book.tokenHash, hash)
        ? routineOf(task, book)
        : undefined;
    },

    /** A new link replaces the old one at once; undefined leaves the task with no link. */
    setTokenHash(id: string, tokenHash: string | undefined): Promise<boolean> {
      return serial(async () => {
        const routine = (await load()).get(id);
        if (!routine || routine.task.trigger.kind !== "webhook") return false;
        await dependencies.persistence.update((draft) => {
          const stored = books(draft);
          const base = parseBook(stored[id]);
          if (!base) return;
          const { tokenHash: _old, needsNewLink: _rotated, ...rest } = base;
          stored[id] = tokenHash ? { ...rest, tokenHash } : rest;
          tokenIndex = indexFrom(stored);
        });
        return true;
      });
    },

    /**
     * One call in the link's log. With `coalesce`, a call refused the same way
     * as the newest entry within a minute only counts on that entry, so a
     * flood of bad calls can't push real ones out.
     */
    /**
     * Adds a line to the link's recent calls. With `key`, a line already
     * written under that key (a retry after a write that landed and then
     * reported failure) adds nothing; the keys are kept apart from the
     * visible log (`appliedLogKeys`), so new calls never push one out. With
     * every key slot held by a pending notice, it refuses (throws) rather
     * than forget one, and the caller tries again later.
     */
    appendLog(
      id: string,
      entry: TaskLinkLogEntry,
      options: { coalesce?: boolean; key?: string } = {},
    ): Promise<void> {
      return serial(async () => {
        await dependencies.persistence.update((draft) => {
          const stored = books(draft);
          const base = parseBook(stored[id]);
          if (!base) return;
          const keys = base.appliedLogKeys ?? [];
          if (options.key !== undefined && keys.includes(options.key)) return;
          if (options.key !== undefined && keys.length >= APPLIED_LOG_KEYS_MAX) {
            throw new Error(
              "Too many log lines are waiting to be confirmed; this one is tried again later.",
            );
          }
          const log = [...(base.log ?? [])];
          const last = log.length ? log[log.length - 1] : undefined;
          if (
            options.coalesce &&
            last &&
            last.outcome === entry.outcome &&
            entry.at - last.at < 60_000
          ) {
            log[log.length - 1] = { ...last, repeats: (last.repeats ?? 0) + 1 };
          } else {
            log.push(entry);
          }
          stored[id] = {
            ...base,
            log: log.slice(-SCHEDULED_TASK_LINK_LIMITS.log),
            ...(options.key !== undefined ? { appliedLogKeys: [...keys, options.key] } : {}),
          };
        });
      });
    },

    /**
     * The link's recent calls, newest first, whether it has a link at all and
     * whether it needs a new one. Read-only: an open task panel polls it.
     */
    async linkState(
      id: string,
    ): Promise<{ hasLink: boolean; needsNewLink: boolean; log: TaskLinkLogEntry[] } | undefined> {
      const task = (await dependencies.tasks()).find((candidate) => candidate.id === id);
      if (!task || !isTriggerTask(task)) return undefined;
      const book = parseBook(books(await dependencies.persistence.load())[id]);
      const link = task.trigger.kind === "webhook" && book?.tokenHash !== undefined;
      return {
        hasLink: link,
        needsNewLink: link && book?.needsNewLink === true,
        log: [...(book?.log ?? [])].reverse(),
      };
    },

    /**
     * A save after Find sources binds the task's exact source. A new source
     * starts over: a fresh baseline, checked right away.
     */
    setConnectorSource(id: string, source: TaskConnectorSource): Promise<boolean> {
      return serial(async () => {
        const routine = (await load()).get(id);
        if (!routine || routine.task.trigger.kind !== "connector") return false;
        await dependencies.persistence.update((draft) => {
          const stored = books(draft);
          const base = parseBook(stored[id]);
          if (!base) return;
          const { held: _held, running: _running, ...rest } = base;
          stored[id] = {
            ...rest,
            connector: structuredClone(source),
            watch: { failures: 0, nextCheckAt: dependencies.now() },
          };
        });
        return true;
      });
    },

    /** One more finished script check, for `AIDEN_CHECK_RUNS`. */
    countCheckRun(id: string): Promise<void> {
      return serial(async () => {
        await dependencies.persistence.update((draft) => {
          const stored = books(draft);
          const base = parseBook(stored[id]);
          if (base) stored[id] = { ...base, checkRuns: base.checkRuns + 1 };
        });
      });
    },
  } satisfies EventRoutineStore<TaskTriggerRoutine> & Record<string, unknown>;
}

export type ScheduledTaskTriggerStore = ReturnType<typeof createScheduledTaskTriggerStore>;
