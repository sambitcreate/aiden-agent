// Link triggers for chat tasks: `POST /hooks/tasks/<token>` on Aiden On The
// Go's listener (docs/scheduled-task-triggers.md). The router asks `admit`
// before it reads a body (unknown or disabled link 404, 60 calls a minute
// 429, wrong content type 415; nothing on that path writes), reads at most 256 KB (413), then `deliver`
// checks the optional signature, the filters and repeats and hands the call
// to the shared event core. Accepted calls answer 202 with no body, whatever
// happened to them, so a caller learns nothing about the task.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { redactCredentialText } from "./diagnostics-contract.js";
import { SCHEDULED_TASK_LINK_LIMITS, type ScheduledTaskLinkTrigger } from "../../renderer/shared/scheduled-task-trigger.js";
import type { BotRoutineEventOutcome } from "./bot-routine-events/dispatcher.js";
import type { TaskLinkLogEntry, TaskTriggerRoutine } from "./scheduled-task-triggers-store.js";

const BATCH_MARK = "\u0000aiden-link-batch:";

/** A held batch of calls: the newest 20, and how many older ones were dropped. */
interface LinkBatch { calls: string[]; dropped: number }

function readBatch(payload: string): LinkBatch {
  if (payload.startsWith(BATCH_MARK)) {
    try {
      const parsed = JSON.parse(payload.slice(BATCH_MARK.length)) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const calls = Array.isArray(record.calls) ? record.calls.filter((call): call is string => typeof call === "string") : [];
        const dropped = typeof record.dropped === "number" && Number.isSafeInteger(record.dropped) && record.dropped >= 0 ? record.dropped : 0;
        return { calls, dropped };
      }
    } catch {
      // Fall through: treat it as one call.
    }
  }
  return { calls: [payload], dropped: 0 };
}

/**
 * Two held payloads as one batch, older calls first: up to 20 calls, the
 * oldest dropped beyond that, the whole batch kept under `maxChars` by
 * shortening the longest calls. A call arriving inside the gap merges this
 * way, and so does a batch whose run was skipped (a busy chat) with what
 * arrived since.
 */
export function mergeLinkBatches(older: string, newer: string, maxChars: number): string {
  const first = readBatch(older);
  const second = readBatch(newer);
  const calls = [...first.calls, ...second.calls];
  const over = Math.max(0, calls.length - SCHEDULED_TASK_LINK_LIMITS.batch);
  const kept = calls.slice(over);
  const dropped = first.dropped + second.dropped + over;
  const encode = () => `${BATCH_MARK}${JSON.stringify({ calls: kept, dropped })}`;
  let encoded = encode();
  while (encoded.length > maxChars) {
    let longest = 0;
    for (let index = 1; index < kept.length; index += 1) if (kept[index]!.length > kept[longest]!.length) longest = index;
    const call = kept[longest]!;
    kept[longest] = `${call.slice(0, Math.max(0, Math.floor(call.length * 0.8) - 1))}…`;
    encoded = encode();
  }
  return encoded;
}

/**
 * What the run sees for an event: one call as it is, or a batch spelled out
 * under a line saying how many calls arrived and how many were dropped. The
 * whole text fits `maxChars`: the longest calls are shortened, never the
 * heading or the earliest calls.
 */
export function linkEventText(payload: string, maxChars: number): string {
  if (!payload.startsWith(BATCH_MARK)) return cut(payload, maxChars);
  const { calls, dropped } = readBatch(payload);
  const head = `${calls.length} calls arrived while the task waited.${dropped ? ` ${dropped} more ${dropped === 1 ? "call was" : "calls were"} dropped.` : ""}`;
  const kept = [...calls];
  const spell = () => [head, ...kept.map((call, index) => `Call ${index + 1}:\n${call}`)].join("\n\n");
  let text = spell();
  while (text.length > maxChars) {
    let longest = 0;
    for (let index = 1; index < kept.length; index += 1) if (kept[index]!.length > kept[longest]!.length) longest = index;
    const call = kept[longest]!;
    if (call.length <= 1) return cut(text, maxChars);
    kept[longest] = `${call.slice(0, Math.max(0, Math.floor(call.length * 0.8) - 1))}…`;
    text = spell();
  }
  return text;
}

const SECRET_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api[-_]?key|x-api-key|private[-_]?key|signature)$/iu;

/** Values under credential-looking keys are withheld, at any depth. */
function withholdSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return "[withheld]";
  if (Array.isArray(value)) return value.map((item) => withholdSecrets(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      [key, SECRET_KEY.test(key) ? "[withheld]" : withholdSecrets(item, depth + 1)]));
  }
  return typeof value === "string" ? redactCredentialText(value) : value;
}

/** JSON nested deeper than this is refused: turning it back into text would overflow the stack. */
const MAX_JSON_DEPTH = 32;

/** Whether parsed JSON nests deeper than `limit`, checked without recursion. */
function nestsDeeper(value: unknown, limit: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: current, depth } = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current as Record<string, unknown>)) {
      if (child !== null && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

function valueAt(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value) ?? "");

function cut(text: string, chars: number): string {
  const shown = [...text.slice(0, chars * 2)];
  return shown.length > chars ? `${shown.slice(0, chars - 1).join("")}…` : shown.join("");
}

function previewOf(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= SCHEDULED_TASK_LINK_LIMITS.previewBytes) return text;
  return `${bytes.subarray(0, SCHEDULED_TASK_LINK_LIMITS.previewBytes - 3).toString("utf8").replace(/�+$/u, "")}…`;
}

/** The body as the model and the log see it: credentials withheld, NULs removed. */
export function linkCallText(trigger: ScheduledTaskLinkTrigger, json: unknown | undefined, text: string): string {
  if (json === undefined) return cut(redactCredentialText(text).split("\u0000").join(""), SCHEDULED_TASK_LINK_LIMITS.payloadChars);
  const safe = withholdSecrets(json);
  const shown = trigger.includeFields?.length
    ? Object.fromEntries(trigger.includeFields.map((path) => [path, valueAt(safe, path) ?? null]))
    : safe;
  return cut(JSON.stringify(shown, null, 2).split("\u0000").join(""), SCHEDULED_TASK_LINK_LIMITS.payloadChars);
}

function signatureMatches(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/iu, "");
  if (!/^[a-f0-9]{64}$/iu.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(given, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const LOG_OF: Record<BotRoutineEventOutcome, TaskLinkLogEntry["outcome"]> = {
  queued: "ran", held: "batched", duplicate: "duplicate", daily_limit: "daily_limit", disabled: "off", unknown: "off",
};

export interface TaskLinkWebhookDependencies {
  /** Only while trigger tasks are running (Aiden open, scheduled tasks on). */
  active(): boolean;
  /** The task id a token belongs to, from memory only: no task read, no write. */
  tokenTask(token: string): Promise<string | undefined>;
  /** The task a token opens, read-only (disabled tasks too). */
  findByToken(token: string): Promise<TaskTriggerRoutine | undefined>;
  /** The link's signing secret (`aiden-internal:task-hook:<taskId>`). */
  secret(taskId: string): Promise<string | null>;
  emit(taskId: string, event: { eventId: string; payload: string }): Promise<BotRoutineEventOutcome>;
  log(taskId: string, entry: TaskLinkLogEntry, options?: { coalesce?: boolean }): Promise<void>;
  now(): number;
}

/** Calls with a token no task has, across every link, before further unknown tokens get 429. */
export const UNKNOWN_LINK_CALLS_PER_MINUTE = 120;
/**
 * Calls one link refuses (bad signature, not JSON) that are logged in a
 * minute; later refusals are answered without a log entry. They never use the
 * link's 60, so a properly signed sender keeps getting through.
 */
export const REFUSED_LINK_CALLS_PER_MINUTE = 30;

type LinkRoutine = TaskTriggerRoutine & { task: { trigger: ScheduledTaskLinkTrigger } };

export function createTaskLinkWebhook(deps: TaskLinkWebhookDependencies) {
  /** Recent call times per task, for 60 a minute. */
  const recent = new Map<string, number[]>();
  /** Recent logged refusals per task, kept apart so they can't use up real calls. */
  const refused = new Map<string, number[]>();
  /** Recent calls with an unknown token, across every link. */
  let unknown: number[] = [];

  const within = (times: number[] | undefined, now: number) => (times ?? []).filter((at) => at > now - 60_000);

  /** The task behind a link, read-only, if it is on and still a link task. */
  async function open(token: string): Promise<LinkRoutine | undefined> {
    const routine = await deps.findByToken(token);
    if (!routine || !routine.enabled || routine.task.trigger.kind !== "webhook") return undefined;
    return routine as LinkRoutine;
  }

  /**
   * A refused call gives back its place in the 60 a minute. Whether it is
   * logged: only the first 30 refusals a minute are, so a flood of bad calls
   * neither blocks the real sender nor keeps writing the log.
   */
  function refuse(taskId: string, admittedAt: number | undefined): boolean {
    const now = deps.now();
    if (admittedAt !== undefined) {
      const calls = recent.get(taskId) ?? [];
      const index = calls.lastIndexOf(admittedAt);
      if (index >= 0) calls.splice(index, 1);
    }
    const lately = within(refused.get(taskId), now);
    if (lately.length >= REFUSED_LINK_CALLS_PER_MINUTE) {
      refused.set(taskId, lately);
      return false;
    }
    refused.set(taskId, [...lately, now]);
    return true;
  }

  const mediaType = (contentType: string | undefined) => (contentType ?? "text/plain").split(";")[0]!.trim().toLowerCase();

  return {
    /** Before the body is read: 404, 429 or 415, or the header the signature comes in. */
    async admit(request: { token: string; contentType?: string }): Promise<{ status: 404 | 415 | 429 } | { accept: true; signatureHeader?: string }> {
      if (!deps.active()) return { status: 404 };
      const now = deps.now();
      // The in-memory index first: only a miss counts as an unknown token, so
      // a flood of made-up tokens never puts a real link on 429.
      const taskId = await deps.tokenTask(request.token);
      if (taskId === undefined) {
        unknown = within(unknown, now);
        if (unknown.length >= UNKNOWN_LINK_CALLS_PER_MINUTE) return { status: 429 };
        unknown.push(now);
        return { status: 404 };
      }
      // A known token, even one whose task is off, uses its link's 60 a minute
      // before anything else is read.
      const calls = within(recent.get(taskId), now);
      if (calls.length >= SCHEDULED_TASK_LINK_LIMITS.callsPerMinute) {
        recent.set(taskId, calls);
        return { status: 429 };
      }
      calls.push(now);
      recent.set(taskId, calls);
      const routine = await open(request.token);
      if (!routine) return { status: 404 };
      const type = mediaType(request.contentType);
      if (type !== "application/json" && type !== "text/plain") return { status: 415 };
      const header = routine.task.trigger.signatureHeader;
      return { accept: true, ...(header ? { signatureHeader: header } : {}) };
    },

    /** The call itself: signature, filters, repeats, then the event core. */
    async deliver(request: { token: string; contentType?: string; signature?: string; body: Uint8Array }): Promise<{ status: 202 | 400 | 401 | 404 | 413 | 415 }> {
      if (!deps.active()) return { status: 404 };
      const routine = await open(request.token);
      if (!routine) return { status: 404 };
      const admitted = recent.get(routine.id);
      const admittedAt = admitted?.length ? admitted[admitted.length - 1] : undefined;
      if (request.body.byteLength > SCHEDULED_TASK_LINK_LIMITS.bodyBytes) return { status: 413 };
      const type = mediaType(request.contentType);
      if (type !== "application/json" && type !== "text/plain") return { status: 415 };
      const trigger = routine.task.trigger;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(request.body);
      const log = (outcome: TaskLinkLogEntry["outcome"], shown: string) =>
        deps.log(routine.id, { at: deps.now(), outcome, preview: previewOf(shown) });
      if (trigger.signatureHeader) {
        const secret = await deps.secret(routine.id);
        if (!secret || !signatureMatches(secret, request.body, request.signature)) {
          if (refuse(routine.id, admittedAt)) {
            await deps.log(routine.id, { at: deps.now(), outcome: "bad_signature", preview: previewOf(cut(redactCredentialText(text), 2_048)) }, { coalesce: true });
          }
          return { status: 401 };
        }
      }
      let json: unknown;
      if (type === "application/json") {
        try {
          json = JSON.parse(text) as unknown;
          if (nestsDeeper(json, MAX_JSON_DEPTH)) throw new Error("Nested too deeply.");
        } catch {
          if (refuse(routine.id, admittedAt)) {
            await deps.log(routine.id, { at: deps.now(), outcome: "invalid", preview: previewOf(cut(redactCredentialText(text), 2_048)) }, { coalesce: true });
          }
          return { status: 400 };
        }
      }
      const payload = linkCallText(trigger, json, text);
      const matches = (trigger.filters ?? []).every((filter) => json !== undefined && asText(valueAt(json, filter.path)) === filter.equals);
      if (!matches) {
        await log("filtered", payload);
        return { status: 202 };
      }
      // The same repeat value is one event; without one, identical bodies within a minute are.
      const repeat = trigger.dedupePath && json !== undefined ? valueAt(json, trigger.dedupePath) : undefined;
      const eventId = repeat !== undefined
        ? createHash("sha256").update(`d\0${asText(repeat)}`).digest("hex").slice(0, 32)
        : createHash("sha256").update(`${Math.floor(deps.now() / 60_000)}\0`).update(request.body).digest("hex").slice(0, 32);
      const outcome = await deps.emit(routine.id, { eventId, payload });
      await log(LOG_OF[outcome], payload);
      return { status: 202 };
    },
  };
}

export type TaskLinkWebhook = ReturnType<typeof createTaskLinkWebhook>;
