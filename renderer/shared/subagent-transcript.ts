import {
  GENERATION_TIMELINE_VERSION,
  MAX_GENERATION_TIMELINE_STEPS,
  parseGenerationTimeline,
  type AgentStep,
} from "./generation-timeline.js";
import {
  isSafeSubagentIdentifier,
  parseSubagentHistoryDetailV1,
  type SubagentHistoryDetailV1,
} from "./subagent-runs.js";

/**
 * One helper's conversation, saved beside its run record: the task it was
 * given, then each message it wrote with that message's steps. Steps use the
 * main chat's `GenerationTimeline` step format so they can render the same
 * rows. Text has already been through the parent/helper credential filter
 * (the one Phase 1 applies to a stopped helper's partial work).
 */
export const SUBAGENT_TRANSCRIPT_VERSION = 1 as const;
/** Saved size cap per helper, measured as UTF-8 JSON. */
export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** The task plus one entry per helper message; a helper has at most 512 lifecycle events. */
export const MAX_SUBAGENT_TRANSCRIPT_ENTRIES = 600;
export const MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS = 200_000;
/** Bounded so a corrupt or hostile counter cannot overflow while it grows. */
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

export interface SubagentTranscriptTaskEntry {
  kind: "task";
  text: string;
}

export interface SubagentTranscriptMessageEntry {
  kind: "message";
  text: string;
  steps: AgentStep[];
  startedAt: number;
  finishedAt?: number;
}

export type SubagentTranscriptEntry = SubagentTranscriptTaskEntry | SubagentTranscriptMessageEntry;

export interface SubagentTranscriptV1 {
  version: typeof SUBAGENT_TRANSCRIPT_VERSION;
  runId: string;
  /** Grows by one with every saved or streamed change. */
  revision: number;
  /** Older steps or text were dropped to stay under the size cap. */
  trimmed: boolean;
  /** The first entry is always the task. */
  entries: SubagentTranscriptEntry[];
}

export interface SubagentTranscriptChange {
  index: number;
  entry: SubagentTranscriptEntry;
}

/**
 * A live change from `baseRevision` to `revision`: the entries that changed,
 * in full, and the new entry count. Applying it to a transcript at exactly
 * `baseRevision` gives the transcript at `revision`.
 */
export interface SubagentTranscriptUpdateV1 {
  version: typeof SUBAGENT_TRANSCRIPT_VERSION;
  runId: string;
  baseRevision: number;
  revision: number;
  trimmed: boolean;
  entryCount: number;
  changes: SubagentTranscriptChange[];
}

/** The `chat:subagent-transcript` stream payload. */
export interface SubagentTranscriptNotification {
  streamId: string;
  update: SubagentTranscriptUpdateV1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    Reflect.ownKeys(value).length === keys.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function revisionNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REVISION;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS;
}

/** Steps must pass the main chat's own timeline parser and carry no extra fields. */
function parseSteps(value: unknown, textLength: number): AgentStep[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_GENERATION_TIMELINE_STEPS) return undefined;
  const parsed = parseGenerationTimeline(
    {
      version: GENERATION_TIMELINE_VERSION,
      generationId: "subagent-transcript",
      status: "completed",
      startedAt: 0,
      steps: value,
    },
    textLength,
  );
  if (!parsed || parsed.steps.length !== value.length) return undefined;
  for (const [index, step] of parsed.steps.entries()) {
    const raw = value[index];
    if (!isPlainRecord(raw) || Object.keys(raw).length !== Object.keys(step).length)
      return undefined;
  }
  return parsed.steps;
}

function parseEntry(value: unknown, index: number): SubagentTranscriptEntry | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (index === 0) {
    if (
      !hasOnlyKeys(value, ["kind", "text"]) ||
      value.kind !== "task" ||
      !boundedText(value.text)
    ) {
      return undefined;
    }
    return { kind: "task", text: value.text };
  }
  if (
    !hasOnlyKeys(value, ["kind", "text", "steps", "startedAt"], ["finishedAt"]) ||
    value.kind !== "message" ||
    !boundedText(value.text) ||
    !finiteTimestamp(value.startedAt) ||
    (value.finishedAt !== undefined &&
      (!finiteTimestamp(value.finishedAt) || value.finishedAt < value.startedAt))
  ) {
    return undefined;
  }
  const steps = parseSteps(value.steps, value.text.length);
  if (!steps) return undefined;
  return {
    kind: "message",
    text: value.text,
    steps,
    startedAt: value.startedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
  };
}

export function parseSubagentTranscript(value: unknown): SubagentTranscriptV1 | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["version", "runId", "revision", "trimmed", "entries"]) ||
    value.version !== SUBAGENT_TRANSCRIPT_VERSION ||
    !isSafeSubagentIdentifier(value.runId) ||
    !revisionNumber(value.revision) ||
    value.revision < 1 ||
    typeof value.trimmed !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > MAX_SUBAGENT_TRANSCRIPT_ENTRIES
  ) {
    return undefined;
  }
  const entries: SubagentTranscriptEntry[] = [];
  for (const [index, raw] of value.entries.entries()) {
    const entry = parseEntry(raw, index);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return {
    version: SUBAGENT_TRANSCRIPT_VERSION,
    runId: value.runId,
    revision: value.revision,
    trimmed: value.trimmed,
    entries,
  };
}

export function parseSubagentTranscriptUpdate(
  value: unknown,
): SubagentTranscriptUpdateV1 | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "runId",
      "baseRevision",
      "revision",
      "trimmed",
      "entryCount",
      "changes",
    ]) ||
    value.version !== SUBAGENT_TRANSCRIPT_VERSION ||
    !isSafeSubagentIdentifier(value.runId) ||
    !revisionNumber(value.baseRevision) ||
    !revisionNumber(value.revision) ||
    value.revision <= value.baseRevision ||
    typeof value.trimmed !== "boolean" ||
    !Number.isSafeInteger(value.entryCount) ||
    (value.entryCount as number) < 1 ||
    (value.entryCount as number) > MAX_SUBAGENT_TRANSCRIPT_ENTRIES ||
    !Array.isArray(value.changes) ||
    value.changes.length > (value.entryCount as number)
  ) {
    return undefined;
  }
  const changes: SubagentTranscriptChange[] = [];
  let previousIndex = -1;
  for (const raw of value.changes) {
    if (
      !isPlainRecord(raw) ||
      !hasOnlyKeys(raw, ["index", "entry"]) ||
      !Number.isSafeInteger(raw.index) ||
      (raw.index as number) <= previousIndex ||
      (raw.index as number) >= (value.entryCount as number)
    ) {
      return undefined;
    }
    const index = raw.index as number;
    const entry = parseEntry(raw.entry, index);
    if (!entry) return undefined;
    changes.push({ index, entry });
    previousIndex = index;
  }
  return {
    version: SUBAGENT_TRANSCRIPT_VERSION,
    runId: value.runId,
    baseRevision: value.baseRevision,
    revision: value.revision,
    trimmed: value.trimmed,
    entryCount: value.entryCount as number,
    changes,
  };
}

export function parseSubagentTranscriptNotification(
  value: unknown,
): SubagentTranscriptNotification | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["streamId", "update"])) return undefined;
  if (
    typeof value.streamId !== "string" ||
    value.streamId.length === 0 ||
    value.streamId.length > 256
  ) {
    return undefined;
  }
  const update = parseSubagentTranscriptUpdate(value.update);
  return update ? { streamId: value.streamId, update } : undefined;
}

/**
 * Fold a newer live update into what a reader already holds for one run. A
 * stale or repeated update is ignored. An update that does not follow on
 * starts a fresh accumulation, because the reader missed something and must
 * rely on the saved copy for the gap.
 */
export function accumulateSubagentTranscriptUpdate(
  live: SubagentTranscriptUpdateV1 | null | undefined,
  update: SubagentTranscriptUpdateV1,
): SubagentTranscriptUpdateV1 {
  if (!live || live.runId !== update.runId) return update;
  if (update.revision <= live.revision) return live;
  if (update.baseRevision > live.revision) return update;
  const byIndex = new Map<number, SubagentTranscriptEntry>();
  for (const change of live.changes) {
    if (change.index < update.entryCount) byIndex.set(change.index, change.entry);
  }
  for (const change of update.changes) byIndex.set(change.index, change.entry);
  return {
    version: SUBAGENT_TRANSCRIPT_VERSION,
    runId: update.runId,
    baseRevision: live.baseRevision,
    revision: update.revision,
    trimmed: live.trimmed || update.trimmed,
    entryCount: update.entryCount,
    changes: [...byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, entry]) => ({ index, entry })),
  };
}

/** `subagents:get`: the run's history, plus its saved conversation when there is one. */
export interface SubagentHistoryDetailWithTranscriptV1 extends SubagentHistoryDetailV1 {
  transcript?: SubagentTranscriptV1;
}

/**
 * Strict parser for a `subagents:get` reply. A transcript must belong to the
 * same run as the snapshot; anything else rejects the whole reply.
 */
export function parseSubagentHistoryDetailWithTranscript(
  value: unknown,
): SubagentHistoryDetailWithTranscriptV1 | undefined {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== Object.keys(value).length)
    return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, "transcript"))
    return parseSubagentHistoryDetailV1(value);
  const { transcript: rawTranscript, ...rest } = value;
  const detail = parseSubagentHistoryDetailV1(rest);
  const transcript = parseSubagentTranscript(rawTranscript);
  if (!detail || !transcript || transcript.runId !== detail.snapshot.runId) return undefined;
  return { ...detail, transcript };
}

/** A window keeps live updates for at most this many helpers per stream. */
export const MAX_LIVE_SUBAGENT_TRANSCRIPTS = 16;

/** Live updates a window has folded so far, by run id, oldest first. */
export type LiveSubagentTranscripts = ReadonlyMap<string, SubagentTranscriptUpdateV1>;

/**
 * Fold one streamed update into a window's per-run live state. The newest
 * helpers are kept when there are too many; a dropped one falls back to its
 * saved copy.
 */
export function foldLiveSubagentTranscript(
  live: LiveSubagentTranscripts | undefined,
  update: SubagentTranscriptUpdateV1,
): LiveSubagentTranscripts {
  const next = new Map(live ?? []);
  const folded = accumulateSubagentTranscriptUpdate(next.get(update.runId), update);
  if (folded === next.get(update.runId)) return live ?? next;
  next.delete(update.runId);
  next.set(update.runId, folded);
  while (next.size > MAX_LIVE_SUBAGENT_TRANSCRIPTS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export interface MergedSubagentTranscript {
  transcript: SubagentTranscriptV1 | null;
  /**
   * False when the live updates start after the saved copy, so something in
   * between is missing. The reader should read the saved copy again.
   */
  complete: boolean;
}

/**
 * The late-joiner merge: start from the saved copy, then apply live updates
 * newer than it. Readers subscribe to the live stream before reading the
 * saved copy, and the recorder saves each revision before streaming it, so
 * the two always meet.
 */
export function mergeSubagentTranscript(
  saved: SubagentTranscriptV1 | null | undefined,
  live: SubagentTranscriptUpdateV1 | null | undefined,
): MergedSubagentTranscript {
  const base = saved ?? null;
  if (!live || (base && live.runId !== base.runId)) return { transcript: base, complete: true };
  if (base && base.revision >= live.revision) return { transcript: base, complete: true };
  const baseRevision = base?.revision ?? 0;
  if (live.baseRevision > baseRevision) return { transcript: base, complete: false };
  const entries = (base?.entries ?? []).slice(0, live.entryCount);
  for (const change of live.changes) entries[change.index] = change.entry;
  if (entries.length !== live.entryCount || entries.some((entry) => entry === undefined)) {
    return { transcript: base, complete: false };
  }
  const transcript = parseSubagentTranscript({
    version: SUBAGENT_TRANSCRIPT_VERSION,
    runId: live.runId,
    revision: live.revision,
    trimmed: (base?.trimmed ?? false) || live.trimmed,
    entries,
  });
  return transcript ? { transcript, complete: true } : { transcript: base, complete: false };
}

export function subagentTranscriptBytes(transcript: SubagentTranscriptV1): number {
  return new TextEncoder().encode(JSON.stringify(transcript)).length;
}

export const SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_MARKER = "[Earlier text removed to save space.]";
const TRIMMED_TEXT_MARKER = SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_MARKER;
/** What starts a message whose front was cut to fit. */
export const SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_PREFIX = `${TRIMMED_TEXT_MARKER}\n`;
const TRIMMED_TEXT_PREFIX = SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_PREFIX;

/** A message's text without the marker of an earlier front cut. */
export function trimmedTextBody(text: string): string {
  return text.startsWith(TRIMMED_TEXT_PREFIX) ? text.slice(TRIMMED_TEXT_PREFIX.length) : text;
}

/**
 * Where a step lands once `removed` characters are cut from the front of the
 * text it sat in (`offset` is its place in the uncut text). A step from the
 * removed part moves to the start; any other keeps its place after the marker.
 */
export function trimmedStepOffset(offset: number, removed: number): number {
  const kept = offset - removed;
  return kept <= 0 ? 0 : TRIMMED_TEXT_PREFIX.length + kept;
}

/** UTF-8 size of one entry's JSON, as it appears inside `entries`. */
export function subagentTranscriptEntryBytes(entry: SubagentTranscriptEntry): number {
  return utf8Bytes(JSON.stringify(entry));
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Keep a transcript under `maxBytes`. The oldest steps go first, from the
 * earliest message onward. If that is still too big, the oldest message text
 * is replaced by a short marker. The task and the newest message stay.
 *
 * Sizes are kept per entry, so each drop re-measures only the entry it
 * changed. `entryBytes`, when given, holds each entry's
 * `subagentTranscriptEntryBytes` so the caller's cached sizes are reused.
 */
export function trimSubagentTranscriptToBytes(
  transcript: SubagentTranscriptV1,
  maxBytes: number = MAX_SUBAGENT_TRANSCRIPT_BYTES,
  entryBytes?: readonly number[],
): SubagentTranscriptV1 {
  const sizes =
    entryBytes && entryBytes.length === transcript.entries.length
      ? [...entryBytes]
      : transcript.entries.map(subagentTranscriptEntryBytes);
  const commas = Math.max(0, transcript.entries.length - 1);
  const envelope = (trimmed: boolean) =>
    utf8Bytes(JSON.stringify({ ...transcript, trimmed, entries: [] }));
  let entriesSize = sizes.reduce((sum, size) => sum + size, 0) + commas;
  if (envelope(transcript.trimmed) + entriesSize <= maxBytes) return transcript;
  // Unchanged entries keep their identity, so a caller can reuse what it
  // cached for them.
  const entries = [...transcript.entries];
  const fixed = envelope(true);
  const replace = (index: number, entry: SubagentTranscriptEntry) => {
    entries[index] = entry;
    const size = subagentTranscriptEntryBytes(entry);
    entriesSize += size - sizes[index]!;
    sizes[index] = size;
  };
  const over = () => fixed + entriesSize - maxBytes;
  for (let index = 1; index < entries.length && over() > 0; index += 1) {
    let entry = entries[index]!;
    if (entry.kind !== "message") continue;
    while (entry.kind === "message" && entry.steps.length > 0 && over() > 0) {
      // Drop in chunks sized from the average step, so a large message is
      // re-measured a few times rather than once per step.
      const average = Math.max(1, Math.ceil(sizes[index]! / (entry.steps.length + 1)));
      const count = Math.min(entry.steps.length, Math.max(1, Math.ceil(over() / average)));
      replace(index, {
        ...entry,
        steps: entry.steps.slice(count).map((step, order) => ({ ...step, order }) as AgentStep),
      });
      entry = entries[index]!;
    }
  }
  for (let index = 1; index < entries.length - 1 && over() > 0; index += 1) {
    const entry = entries[index]!;
    if (entry.kind !== "message" || entry.text === TRIMMED_TEXT_MARKER) continue;
    replace(index, { ...entry, text: TRIMMED_TEXT_MARKER, steps: [] });
  }
  const lastIndex = entries.length - 1;
  const last = entries[lastIndex]!;
  if (over() > 0 && lastIndex > 0 && last.kind === "message") {
    // Only the task and the newest message remain: shorten the newest text
    // from the front, keeping its latest words. Text is measured in bytes,
    // so cut again if multi-byte characters left it over.
    const original = trimmedTextBody(last.text);
    let body = original;
    for (let attempt = 0; attempt < 8 && over() > 0; attempt += 1) {
      const keep = Math.max(0, body.length - over() - TRIMMED_TEXT_PREFIX.length);
      body = body.slice(body.length - keep);
      const removed = original.length - body.length;
      replace(lastIndex, {
        ...last,
        text: `${TRIMMED_TEXT_PREFIX}${body}`,
        steps: last.steps.map(
          (step) =>
            ({
              ...step,
              contentOffset: trimmedStepOffset(
                (step.contentOffset ?? 0) - (last.text.length - original.length),
                removed,
              ),
            }) as AgentStep,
        ),
      });
      if (keep === 0) break;
    }
  }
  return { ...transcript, trimmed: true, entries };
}
