/** Host-owned Open work records. Public mutations cannot author provenance or execution links. */
export type BotOpenWorkState = "open" | "waiting" | "done" | "dismissed";
export type BotOpenWorkSource =
  | { kind: "person"; submissionId?: string; entryId?: string }
  | { kind: "routine"; submissionId: string; entryId: string; routineId: string; runId: string }
  | { kind: "peer"; exchangeId: string; role: "incoming" | "outgoing"; peerBotId: string; submissionId?: string; entryId?: string };
export type BotOpenWorkLink =
  | { kind: "source" | "result"; submissionId: string; entryId: string }
  | { kind: "routine"; routineId: string; runId: string }
  | { kind: "issue"; issueId: string }
  | { kind: "peer"; exchangeId: string; peerBotId: string };
export interface BotOpenWorkExecution {
  state: "idle" | "queued" | "running" | "interrupted" | "stopping";
  canStop: boolean;
  blockedReason?: "mixed_inputs" | "not_linked" | "host_unavailable";
}
export interface BotOpenWorkStopReceipt {
  mutationId: string;
  state: "requested" | "stopped" | "already_finished" | "not_running" | "uncertain" | "blocked";
  requestedAt: number;
  finishedAt?: number;
  reason?: "mixed_inputs" | "host_unavailable" | "deadline" | "source_missing";
}
export interface BotOpenWorkItem {
  id: string; revision: string; title: string; note: string; state: BotOpenWorkState; waitingReason?: string;
  createdAt: number; updatedAt: number; source: BotOpenWorkSource; links: BotOpenWorkLink[];
  completion?: { by: "person" | "bot"; at: number; result?: { submissionId: string; entryId: string } };
  execution: BotOpenWorkExecution;
  lastStop?: BotOpenWorkStopReceipt;
}
export interface BotOpenWorkUndoOption { mutationId: string; itemId: string; expectedRevision: string; expiresAt: number }
export interface BotOpenWorkSnapshot { botId: string; revision: string; items: BotOpenWorkItem[]; undo: BotOpenWorkUndoOption[] }
export interface BotOpenWorkEvidence { itemId: string; kind: "source" | "result"; submissionId: string; entryId: string; title: string; text: string; truncated: boolean; createdAt?: number }
export type BotOpenWorkMutation = { mutationId: string } & (
  | { action: "add"; expectedRevision: string; title: string; note?: string }
  | { action: "edit"; id: string; expectedRevision: string; patch: { title?: string; note?: string; state?: BotOpenWorkState; waitingReason?: string } }
  | { action: "dismiss" | "stop" | "stop_and_dismiss"; id: string; expectedRevision: string }
  | { action: "undo"; undoOf: string; expectedRevision: string }
);
export const BOT_OPEN_WORK_ERROR_CODES = ["invalid", "not_found", "stale", "active_full", "history_full", "receipts_full", "mutation_conflict", "undo_conflict", "undo_expired", "mixed_inputs", "unavailable", "deleted"] as const;
export type BotOpenWorkErrorCode = typeof BOT_OPEN_WORK_ERROR_CODES[number];
export type BotOpenWorkResult =
  | { ok: true; mutationId: string; replayed: boolean; itemId?: string; snapshot: BotOpenWorkSnapshot; undo?: BotOpenWorkUndoOption; stop?: BotOpenWorkStopReceipt }
  | { ok: false; code: BotOpenWorkErrorCode; error: string; snapshot?: BotOpenWorkSnapshot };
export const BOT_OPEN_WORK_CHANNELS = { snapshot: "bots:openWork:snapshot", mutate: "bots:openWork:mutate", evidence: "bots:openWork:evidence", changed: "bots:openWork:changed" } as const;
export const BOT_OPEN_WORK_LIMITS = {
  active: 64, terminal: 128, receipts: 512, links: 4, idChars: 160, revisionChars: 160,
  titleScalars: 160, titleBytes: 640, noteScalars: 1000, noteBytes: 2048,
  waitingReasonScalars: 160, waitingReasonBytes: 640, errorScalars: 280, errorBytes: 1120,
  mutationBytes: 16 * 1024, storedBytes: 768 * 1024, publicBytes: 900 * 1024, undoMs: 24 * 60 * 60 * 1000,
  evidenceTextBytes: 32 * 1024, evidenceBytes: 256 * 1024,
} as const;
const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const DECIMAL = /^[1-9][0-9]{0,31}$/u;
const STATES = new Set(["open", "waiting", "done", "dismissed"]);
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
function invalid(): never { throw new Error("Invalid Open work data."); }
function text(value: unknown, scalars: number, bytes: number, empty = false): string {
  if (typeof value !== "string" || value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) || [...value].length > scalars || utf8(value) > bytes || !empty && !value.trim()) return invalid();
  return value;
}
export function parseBotOpenWorkId(value: unknown): string { if (typeof value !== "string" || !ID.test(value)) return invalid(); return value; }
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) return invalid(); return value.toLowerCase(); }
function decimal(value: unknown): string { if (typeof value !== "string" || !DECIMAL.test(value)) return invalid(); return value; }
function at(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid(); return value; }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
/** Bounded plain JSON copy: accessors, cycles and sparse arrays never reach the parsers. */
function json(value: unknown, maximum: number): unknown {
  let nodes = 0; const seen = new Set<object>();
  const copy = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 12) return invalid();
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (!entry || typeof entry !== "object" || seen.has(entry) || !Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) return invalid();
    seen.add(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.values(descriptors).some((descriptor) => !Object.prototype.hasOwnProperty.call(descriptor, "value"))) return invalid();
    let result: unknown;
    if (Array.isArray(entry)) {
      if (entry.length > 1024 || Object.keys(entry).length !== entry.length) return invalid();
      result = Array.from({ length: entry.length }, (_, index) => copy(descriptors[String(index)]!.value, depth + 1));
    } else result = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, copy(descriptor.value, depth + 1)]));
    seen.delete(entry); return result;
  };
  const result = copy(value, 0); if (utf8(JSON.stringify(result)) > maximum) return invalid(); return result;
}

export function parseBotOpenWorkMutation(value: unknown): BotOpenWorkMutation {
  const data = fields(json(value, BOT_OPEN_WORK_LIMITS.mutationBytes), ["mutationId", "action", "expectedRevision", "title", "note", "id", "patch", "undoOf"]);
  const mutationId = uuid(data.mutationId); const expectedRevision = parseBotOpenWorkId(data.expectedRevision);
  if (data.action === "add") {
    fields(data, ["mutationId", "action", "expectedRevision", "title", "note"]);
    return { action: "add", mutationId, expectedRevision, title: text(data.title, 160, 640).trim(), ...(data.note !== undefined ? { note: text(data.note, 1000, 2048, true) } : {}) };
  }
  if (data.action === "undo") { fields(data, ["mutationId", "action", "expectedRevision", "undoOf"]); return { action: "undo", mutationId, expectedRevision, undoOf: uuid(data.undoOf) }; }
  const id = parseBotOpenWorkId(data.id);
  if (["dismiss", "stop", "stop_and_dismiss"].includes(data.action as string)) {
    fields(data, ["mutationId", "action", "expectedRevision", "id"]);
    return { action: data.action as "dismiss" | "stop" | "stop_and_dismiss", mutationId, expectedRevision, id };
  }
  if (data.action !== "edit") return invalid();
  fields(data, ["mutationId", "action", "expectedRevision", "id", "patch"]);
  const raw = fields(data.patch, ["title", "note", "state", "waitingReason"]);
  if (!Object.keys(raw).length || raw.state !== undefined && !STATES.has(raw.state as string) || raw.state === "waiting" && raw.waitingReason === undefined || raw.state !== undefined && raw.state !== "waiting" && raw.waitingReason !== undefined) return invalid();
  return { action: "edit", mutationId, expectedRevision, id, patch: {
    ...(raw.title !== undefined ? { title: text(raw.title, 160, 640).trim() } : {}), ...(raw.note !== undefined ? { note: text(raw.note, 1000, 2048, true) } : {}),
    ...(raw.state !== undefined ? { state: raw.state as BotOpenWorkState } : {}), ...(raw.waitingReason !== undefined ? { waitingReason: text(raw.waitingReason, 160, 640).trim() } : {}),
  } };
}

function submission(value: unknown): { submissionId: string; entryId: string } {
  const data = fields(value, ["submissionId", "entryId"]);
  return { submissionId: decimal(data.submissionId), entryId: decimal(data.entryId) };
}
function source(value: unknown): BotOpenWorkSource {
  const data = fields(value, ["kind", "submissionId", "entryId", "routineId", "runId", "exchangeId", "role", "peerBotId"]);
  if (data.kind === "peer") { fields(data, ["kind", "exchangeId", "role", "peerBotId", "submissionId", "entryId"]); if (data.role !== "incoming" && data.role !== "outgoing") return invalid(); return { kind: "peer", exchangeId: parseBotOpenWorkId(data.exchangeId), role: data.role, peerBotId: parseBotOpenWorkId(data.peerBotId), ...(data.submissionId === undefined && data.entryId === undefined ? {} : { submissionId: decimal(data.submissionId), entryId: decimal(data.entryId) }) }; }
  if (data.kind === "person") {
    fields(data, ["kind", "submissionId", "entryId"]);
    if (data.submissionId === undefined && data.entryId === undefined) return { kind: "person" };
    return { kind: "person", submissionId: decimal(data.submissionId), entryId: decimal(data.entryId) };
  }
  if (data.kind !== "routine") return invalid();
  return { kind: "routine", submissionId: decimal(data.submissionId), entryId: decimal(data.entryId), routineId: parseBotOpenWorkId(data.routineId), runId: parseBotOpenWorkId(data.runId) };
}
function link(value: unknown): BotOpenWorkLink {
  const data = fields(value, ["kind", "submissionId", "entryId", "routineId", "runId", "issueId", "exchangeId", "peerBotId"]);
  if (data.kind === "peer") { fields(data, ["kind", "exchangeId", "peerBotId"]); return { kind: "peer", exchangeId: parseBotOpenWorkId(data.exchangeId), peerBotId: parseBotOpenWorkId(data.peerBotId) }; }
  if (data.kind === "source" || data.kind === "result") { fields(data, ["kind", "submissionId", "entryId"]); return { kind: data.kind, submissionId: decimal(data.submissionId), entryId: decimal(data.entryId) }; }
  if (data.kind === "routine") { fields(data, ["kind", "routineId", "runId"]); return { kind: "routine", routineId: parseBotOpenWorkId(data.routineId), runId: parseBotOpenWorkId(data.runId) }; }
  if (data.kind !== "issue") return invalid();
  fields(data, ["kind", "issueId"]); return { kind: "issue", issueId: parseBotOpenWorkId(data.issueId) };
}
function stop(value: unknown): BotOpenWorkStopReceipt {
  const data = fields(value, ["mutationId", "state", "requestedAt", "finishedAt", "reason"]);
  if (!["requested", "stopped", "already_finished", "not_running", "uncertain", "blocked"].includes(data.state as string)
    || data.reason !== undefined && !["mixed_inputs", "host_unavailable", "deadline", "source_missing"].includes(data.reason as string)) return invalid();
  return { mutationId: uuid(data.mutationId), state: data.state as BotOpenWorkStopReceipt["state"], requestedAt: at(data.requestedAt),
    ...(data.finishedAt !== undefined ? { finishedAt: at(data.finishedAt) } : {}), ...(data.reason !== undefined ? { reason: data.reason as BotOpenWorkStopReceipt["reason"] } : {}) };
}
function undo(value: unknown): BotOpenWorkUndoOption {
  const data = fields(value, ["mutationId", "itemId", "expectedRevision", "expiresAt"]);
  return { mutationId: uuid(data.mutationId), itemId: parseBotOpenWorkId(data.itemId), expectedRevision: parseBotOpenWorkId(data.expectedRevision), expiresAt: at(data.expiresAt) };
}
function item(value: unknown): BotOpenWorkItem {
  const data = fields(value, ["id", "revision", "title", "note", "state", "waitingReason", "createdAt", "updatedAt", "source", "links", "completion", "execution", "lastStop"]);
  if (!STATES.has(data.state as string) || !Array.isArray(data.links) || data.links.length > 4 || data.state === "waiting" && data.waitingReason === undefined || data.state !== "waiting" && data.waitingReason !== undefined) return invalid();
  const execution = fields(data.execution, ["state", "canStop", "blockedReason"]);
  if (!["idle", "queued", "running", "interrupted", "stopping"].includes(execution.state as string) || typeof execution.canStop !== "boolean"
    || execution.blockedReason !== undefined && !["mixed_inputs", "not_linked", "host_unavailable"].includes(execution.blockedReason as string)
    || execution.canStop && (execution.blockedReason !== undefined || execution.state === "idle" || execution.state === "stopping")) return invalid();
  let completion: BotOpenWorkItem["completion"];
  if (data.completion !== undefined) {
    const raw = fields(data.completion, ["by", "at", "result"]);
    if (data.state !== "done" || raw.by !== "person" && raw.by !== "bot") return invalid();
    completion = { by: raw.by, at: at(raw.at), ...(raw.result !== undefined ? { result: submission(raw.result) } : {}) };
  }
  const links = data.links.map(link);
  if (new Set(links.map((entry) => JSON.stringify(entry))).size !== links.length) return invalid();
  return { id: parseBotOpenWorkId(data.id), revision: parseBotOpenWorkId(data.revision), title: text(data.title, 160, 640), note: text(data.note, 1000, 2048, true), state: data.state as BotOpenWorkState,
    createdAt: at(data.createdAt), updatedAt: at(data.updatedAt), source: source(data.source), links,
    ...(data.waitingReason !== undefined ? { waitingReason: text(data.waitingReason, 160, 640) } : {}), ...(completion ? { completion } : {}),
    execution: execution as unknown as BotOpenWorkExecution, ...(data.lastStop !== undefined ? { lastStop: stop(data.lastStop) } : {}) };
}
export function parseBotOpenWorkItem(value: unknown): BotOpenWorkItem { return item(json(value, BOT_OPEN_WORK_LIMITS.publicBytes)); }
export function parseBotOpenWorkSnapshot(value: unknown): BotOpenWorkSnapshot {
  const data = fields(json(value, BOT_OPEN_WORK_LIMITS.publicBytes), ["botId", "revision", "items", "undo"]);
  if (!Array.isArray(data.items) || data.items.length > 192 || !Array.isArray(data.undo) || data.undo.length > 192) return invalid();
  const items = data.items.map(item); const options = data.undo.map(undo);
  if (new Set(items.map((entry) => entry.id)).size !== items.length || items.filter((entry) => entry.state === "open" || entry.state === "waiting").length > 64
    || items.filter((entry) => entry.state === "done" || entry.state === "dismissed").length > 128 || new Set(options.map((entry) => entry.itemId)).size !== options.length
    || options.some((option) => !items.some((entry) => entry.id === option.itemId && entry.revision === option.expectedRevision))) return invalid();
  return { botId: parseBotOpenWorkId(data.botId), revision: parseBotOpenWorkId(data.revision), items, undo: options };
}
export function parseBotOpenWorkResult(value: unknown): BotOpenWorkResult {
  const data = fields(json(value, BOT_OPEN_WORK_LIMITS.publicBytes), ["ok", "mutationId", "replayed", "itemId", "snapshot", "undo", "stop", "code", "error"]);
  if (data.ok === false) {
    fields(data, ["ok", "code", "error", "snapshot"]);
    if (!BOT_OPEN_WORK_ERROR_CODES.includes(data.code as BotOpenWorkErrorCode)) return invalid();
    return { ok: false, code: data.code as BotOpenWorkErrorCode, error: text(data.error, 280, 1120), ...(data.snapshot !== undefined ? { snapshot: parseBotOpenWorkSnapshot(data.snapshot) } : {}) };
  }
  if (data.ok !== true || typeof data.replayed !== "boolean") return invalid();
  fields(data, ["ok", "mutationId", "replayed", "itemId", "snapshot", "undo", "stop"]);
  return { ok: true, mutationId: uuid(data.mutationId), replayed: data.replayed, snapshot: parseBotOpenWorkSnapshot(data.snapshot),
    ...(data.itemId !== undefined ? { itemId: parseBotOpenWorkId(data.itemId) } : {}), ...(data.undo !== undefined ? { undo: undo(data.undo) } : {}), ...(data.stop !== undefined ? { stop: stop(data.stop) } : {}) };
}
export function parseBotOpenWorkEvidence(value: unknown): BotOpenWorkEvidence {
  const data = fields(json(value, BOT_OPEN_WORK_LIMITS.evidenceBytes), ["itemId", "kind", "submissionId", "entryId", "title", "text", "truncated", "createdAt"]);
  if (data.kind !== "source" && data.kind !== "result" || typeof data.truncated !== "boolean") return invalid();
  return { itemId: parseBotOpenWorkId(data.itemId), kind: data.kind, submissionId: decimal(data.submissionId), entryId: decimal(data.entryId), title: text(data.title, 160, 640),
    text: text(data.text, 32768, 32768, true), truncated: data.truncated, ...(data.createdAt !== undefined ? { createdAt: at(data.createdAt) } : {}) };
}
