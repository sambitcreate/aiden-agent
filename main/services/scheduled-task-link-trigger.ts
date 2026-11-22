// Link triggers for chat tasks: `POST /hooks/tasks/<token>` on Aiden On The
// Go's listener (docs/scheduled-task-triggers.md). The router asks `admit`
// before it reads a body (unknown or disabled link 404, 60 calls a minute
// 429, wrong content type 415), reads at most 256 KB (413), then `deliver`
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
 * The held payload once another call arrives inside the gap: up to 20 calls,
 * the oldest dropped beyond that, the whole batch kept under `maxChars` by
 * shortening the longest calls.
 */
export function mergeLinkBatch(held: string, incoming: string, maxChars: number): string {
  const batch = readBatch(held);
  const calls = [...batch.calls, incoming];
  const over = Math.max(0, calls.length - SCHEDULED_TASK_LINK_LIMITS.batch);
  const kept = calls.slice(over);
  const encode = () => `${BATCH_MARK}${JSON.stringify({ calls: kept, dropped: batch.dropped + over })}`;
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

/** What the run sees for an event: one call as it is, or a batch spelled out. */
export function linkEventText(payload: string): string {
  if (!payload.startsWith(BATCH_MARK)) return payload;
  const { calls, dropped } = readBatch(payload);
  const head = `${calls.length} calls arrived while the task waited.${dropped ? ` ${dropped} more ${dropped === 1 ? "call was" : "calls were"} dropped.` : ""}`;
  return [head, ...calls.map((call, index) => `Call ${index + 1}:\n${call}`)].join("\n\n");
}

const SECRET_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api[-_]?key|x-api-key|private[-_]?key|signature)$/iu;

/** Values under credential-looking keys are withheld, at any depth. */
function withholdSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[withheld]";
  if (Array.isArray(value)) return value.map((item) => withholdSecrets(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      [key, SECRET_KEY.test(key) ? "[withheld]" : withholdSecrets(item, depth + 1)]));
  }
  return typeof value === "string" ? redactCredentialText(value) : value;
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
  findByToken(token: string): Promise<TaskTriggerRoutine | undefined>;
  /** The link's signing secret (`aiden-internal:task-hook:<taskId>`). */
  secret(taskId: string): Promise<string | null>;
  emit(taskId: string, event: { eventId: string; payload: string }): Promise<BotRoutineEventOutcome>;
  log(taskId: string, entry: TaskLinkLogEntry): Promise<void>;
  now(): number;
}

export function createTaskLinkWebhook(deps: TaskLinkWebhookDependencies) {
  /** Recent call times per task, for 60 a minute. */
  const recent = new Map<string, number[]>();

  async function open(token: string): Promise<(TaskTriggerRoutine & { task: { trigger: ScheduledTaskLinkTrigger } }) | undefined> {
    if (!deps.active()) return undefined;
    const routine = await deps.findByToken(token);
    if (!routine || !routine.enabled || routine.task.trigger.kind !== "webhook") return undefined;
    return routine as TaskTriggerRoutine & { task: { trigger: ScheduledTaskLinkTrigger } };
  }

  const mediaType = (contentType: string | undefined) => (contentType ?? "text/plain").split(";")[0]!.trim().toLowerCase();

  return {
    /** Before the body is read: 404, 429 or 415, or the header the signature comes in. */
    async admit(request: { token: string; contentType?: string }): Promise<{ status: 404 | 415 | 429 } | { accept: true; signatureHeader?: string }> {
      const routine = await open(request.token);
      if (!routine) return { status: 404 };
      const now = deps.now();
      const calls = (recent.get(routine.id) ?? []).filter((at) => at > now - 60_000);
      if (calls.length >= SCHEDULED_TASK_LINK_LIMITS.callsPerMinute) {
        recent.set(routine.id, calls);
        return { status: 429 };
      }
      calls.push(now);
      recent.set(routine.id, calls);
      const type = mediaType(request.contentType);
      if (type !== "application/json" && type !== "text/plain") return { status: 415 };
      const header = routine.task.trigger.signatureHeader;
      return { accept: true, ...(header ? { signatureHeader: header } : {}) };
    },

    /** The call itself: signature, filters, repeats, then the event core. */
    async deliver(request: { token: string; contentType?: string; signature?: string; body: Uint8Array }): Promise<{ status: 202 | 400 | 401 | 404 | 413 | 415 }> {
      const routine = await open(request.token);
      if (!routine) return { status: 404 };
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
          await log("bad_signature", cut(redactCredentialText(text), 2_048));
          return { status: 401 };
        }
      }
      let json: unknown;
      if (type === "application/json") {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          await log("invalid", cut(redactCredentialText(text), 2_048));
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
