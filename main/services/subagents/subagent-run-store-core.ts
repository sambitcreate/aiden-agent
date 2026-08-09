import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import {
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshotV1,
  SUBAGENT_ACTIVE_STATES,
  type SubagentRunSnapshotV1,
} from "../../../renderer/shared/subagent-runs.js";
import { sanitizeSubagentSnapshotText } from "../../../renderer/shared/subagent-safe-text.js";
import {
  createNativeSubagentRunStoreStorage,
  SubagentRunStoreStorageError,
  type SubagentRunStoreGeneration,
  type SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";

const STORE_FILE = "runs.json";
const STORE_VERSION = 1 as const;
export const MAX_STORED_SUBAGENT_RUNS = 512;
export const MAX_SUBAGENT_RUN_STORE_BYTES = 8 * 1024 * 1024;
export const MAX_SUBAGENT_CHAT_TOMBSTONES = 512;
const MAX_JSON_NESTING_DEPTH = 128;
const MAX_JSON_OBJECT_KEYS = MAX_STORED_SUBAGENT_RUNS * 128 + 16;
const MAX_NATIVE_GENERATION_CONFLICT_RETRIES = 1;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  // Match Buffer's prior BOM behavior so the only semantic change is that
  // malformed byte sequences can no longer be normalized to U+FFFD.
  ignoreBOM: true,
});

export interface SubagentRunDatabaseV1 {
  version: typeof STORE_VERSION;
  runs: SubagentRunSnapshotV1[];
  pendingChatDeletions: string[];
}

class SubagentRunStoreEvidenceError extends Error {
  readonly name = "SubagentRunStoreEvidenceError";

  constructor(detail?: string) {
    super(
      detail
        ? `Subagent run storage contains unreadable evidence and was preserved. ${detail}`
        : "Subagent run storage contains unreadable evidence and was preserved.",
    );
  }
}

class SubagentRunStoreJsonStructureError extends Error {
  readonly name = "SubagentRunStoreJsonStructureError";
}

class SubagentRunStoreGenerationConflictError extends Error {
  readonly name = "SubagentRunStoreGenerationConflictError";

  constructor() {
    super("Subagent run storage changed and requires a fresh merge.");
  }
}

export interface SubagentRunStoreOptions {
  now?: () => number;
  /** Test-only lower ceiling. Production can never exceed the exported cap. */
  maxRuns?: number;
  /** Test seams for asserting the crash-durability barriers. */
  syncFile?: (filePath: string) => Promise<void>;
  syncDirectory?: (directoryPath: string) => Promise<void>;
  afterRead?: (contents: string) => Promise<string>;
  storageFactory?: (directory: string) => SubagentRunStoreStorage;
}

function safeLookupId(value: string): boolean {
  return isSafeSubagentIdentifier(value);
}

function strictSnapshot(value: unknown): SubagentRunSnapshotV1 {
  const snapshot = parseSubagentRunSnapshotV1(value);
  if (!snapshot) throw new Error("Invalid subagent run snapshot.");

  // The shared parser is the primary trust boundary. Recheck each text field
  // independently here: sanitizing serialized JSON would incorrectly treat
  // quotes and separators from the container as part of a field's syntax.
  const textFields = [
    snapshot.label,
    snapshot.taskPreview,
    snapshot.modelId,
    snapshot.activity,
    snapshot.latestText,
    snapshot.terminalMarkdown,
    snapshot.error,
    ...snapshot.warnings,
  ].filter((field): field is string => field !== undefined);
  if (textFields.some((field) => sanitizeSubagentSnapshotText(field) !== field)) {
    throw new Error("Unsafe subagent run snapshot.");
  }
  return snapshot;
}

function databaseJson(database: SubagentRunDatabaseV1): string {
  return `${JSON.stringify(database, null, 2)}\n`;
}

function orderedNewestFirst(runs: readonly SubagentRunSnapshotV1[]): SubagentRunSnapshotV1[] {
  return [...runs].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.revision - left.revision ||
      left.runId.localeCompare(right.runId),
  );
}

function boundedRuns(
  runs: readonly SubagentRunSnapshotV1[],
  maxRuns: number,
  pendingChatDeletions: readonly string[],
  pinnedRunId?: string,
): SubagentRunSnapshotV1[] {
  const ordered = orderedNewestFirst(runs);
  let newest = ordered.slice(0, maxRuns);
  const pinned = pinnedRunId ? ordered.find((run) => run.runId === pinnedRunId) : undefined;
  if (pinned && !newest.some((run) => run.runId === pinned.runId)) {
    newest = orderedNewestFirst([...newest.slice(0, Math.max(0, maxRuns - 1)), pinned]);
  }
  while (
    newest.length > 1 &&
    Buffer.byteLength(
      databaseJson({
        version: STORE_VERSION,
        runs: newest,
        pendingChatDeletions: [...pendingChatDeletions],
      }),
      "utf-8",
    ) > MAX_SUBAGENT_RUN_STORE_BYTES
  ) {
    let removable = newest.length - 1;
    while (removable >= 0 && newest[removable]?.runId === pinnedRunId) removable -= 1;
    if (removable < 0) break;
    newest.splice(removable, 1);
  }
  if (
    Buffer.byteLength(
      databaseJson({
        version: STORE_VERSION,
        runs: newest,
        pendingChatDeletions: [...pendingChatDeletions],
      }),
      "utf-8",
    ) > MAX_SUBAGENT_RUN_STORE_BYTES
  ) {
    throw new Error("Subagent run snapshot exceeds the private store limit.");
  }
  return newest;
}

function retainedRuns(
  runs: readonly SubagentRunSnapshotV1[],
  maxRuns: number,
  pendingChatDeletions: readonly string[],
): SubagentRunSnapshotV1[] {
  const retained = orderedNewestFirst(runs);
  if (retained.length > maxRuns) {
    throw new Error(
      "Subagent run history is at capacity. Delete an older chat before starting more delegated work.",
    );
  }
  if (
    Buffer.byteLength(
      databaseJson({
        version: STORE_VERSION,
        runs: retained,
        pendingChatDeletions: [...pendingChatDeletions],
      }),
      "utf-8",
    ) > MAX_SUBAGENT_RUN_STORE_BYTES
  ) {
    throw new Error(
      "Subagent run history is at capacity. Delete an older chat before starting more delegated work.",
    );
  }
  return retained;
}

function normalizedPendingChatDeletions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid pending subagent chat deletion state.");
  }

  const normalized = new Set<string>();
  for (const chatId of value) {
    // Invalid identifiers cannot name a chat accepted by any store API. Filter
    // them before applying the cap so they cannot crowd out a later real
    // recovery marker.
    if (typeof chatId !== "string" || !safeLookupId(chatId)) continue;
    normalized.add(chatId);
    if (normalized.size > MAX_SUBAGENT_CHAT_TOMBSTONES) {
      // Dropping any valid marker could resurrect that chat's private runs.
      // Refuse the bounded 8 MiB store instead.
      throw new Error("Too many subagent chat deletions require recovery.");
    }
  }
  return [...normalized];
}

/**
 * JSON.parse intentionally keeps only the last occurrence of a duplicate
 * object key. Scan the bounded persisted document first so no duplicate can
 * hide recovery authority before normalization sees it.
 */
export function assertUniqueJsonObjectKeys(serialized: string): void {
  let offset = 0;
  let objectKeys = 0;

  function fail(): never {
    throw new SubagentRunStoreJsonStructureError();
  }

  function skipWhitespace(): void {
    while (
      serialized[offset] === " " ||
      serialized[offset] === "\t" ||
      serialized[offset] === "\n" ||
      serialized[offset] === "\r"
    ) {
      offset += 1;
    }
  }

  function readString(decode: boolean): string | undefined {
    if (serialized[offset] !== '"') fail();
    offset += 1;
    let segmentStart = offset;
    let decoded = "";
    while (offset < serialized.length) {
      const character = serialized[offset]!;
      if (character === '"') {
        if (decode) decoded += serialized.slice(segmentStart, offset);
        offset += 1;
        return decode ? decoded : undefined;
      }
      if (character === "\\") {
        if (decode) decoded += serialized.slice(segmentStart, offset);
        offset += 1;
        const escaped = serialized[offset];
        if (escaped === undefined) fail();
        if (escaped === "u") {
          const hexadecimal = serialized.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) fail();
          if (decode) decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
          offset += 5;
          segmentStart = offset;
          continue;
        }
        const replacement =
          escaped === '"'
            ? '"'
            : escaped === "\\"
              ? "\\"
              : escaped === "/"
                ? "/"
                : escaped === "b"
                  ? "\b"
                  : escaped === "f"
                    ? "\f"
                    : escaped === "n"
                      ? "\n"
                      : escaped === "r"
                        ? "\r"
                        : escaped === "t"
                          ? "\t"
                          : undefined;
        if (replacement === undefined) fail();
        if (decode) decoded += replacement;
        offset += 1;
        segmentStart = offset;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      offset += 1;
    }
    fail();
  }

  function readNumber(): void {
    if (serialized[offset] === "-") offset += 1;
    if (serialized[offset] === "0") {
      offset += 1;
    } else {
      const first = serialized.charCodeAt(offset);
      if (first < 0x31 || first > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === ".") {
      offset += 1;
      const firstFraction = serialized.charCodeAt(offset);
      if (firstFraction < 0x30 || firstFraction > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === "e" || serialized[offset] === "E") {
      offset += 1;
      if (serialized[offset] === "+" || serialized[offset] === "-") offset += 1;
      const firstExponent = serialized.charCodeAt(offset);
      if (firstExponent < 0x30 || firstExponent > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
  }

  function readValue(depth: number): void {
    if (depth > MAX_JSON_NESTING_DEPTH) fail();
    skipWhitespace();
    const character = serialized[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (serialized[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        const key = readString(true);
        objectKeys += 1;
        if (objectKeys > MAX_JSON_OBJECT_KEYS || key === undefined || keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (serialized[offset] !== ":") fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "}") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (serialized[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "]") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
      }
    }
    if (character === '"') {
      readString(false);
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      readNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (serialized.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    fail();
  }

  readValue(0);
  skipWhitespace();
  if (offset !== serialized.length) fail();
}

function parseDatabase(value: unknown, maxRuns: number): SubagentRunDatabaseV1 {
  if (value === undefined) {
    return { version: STORE_VERSION, runs: [], pendingChatDeletions: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid subagent run database.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const currentSchema =
    keys.length === 3 &&
    keys.includes("version") &&
    keys.includes("runs") &&
    keys.includes("pendingChatDeletions");
  const legacySchema = keys.length === 2 && keys.includes("version") && keys.includes("runs");
  if (
    (!currentSchema && !legacySchema) ||
    candidate.version !== STORE_VERSION ||
    !Array.isArray(candidate.runs)
  ) {
    throw new Error("Invalid subagent run database.");
  }
  const pendingChatDeletions = currentSchema
    ? normalizedPendingChatDeletions(candidate.pendingChatDeletions)
    : [];
  const pendingChatDeletionSet = new Set(pendingChatDeletions);

  const byRunId = new Map<string, SubagentRunSnapshotV1>();
  const conflictedRunIds = new Set<string>();
  for (const raw of candidate.runs.slice(0, MAX_STORED_SUBAGENT_RUNS * 2)) {
    try {
      const run = strictSnapshot(raw);
      // A valid deletion intent owns the durable state. Never replay or
      // preserve a run that would resurrect history for its pending chat.
      if (pendingChatDeletionSet.has(run.chatId)) continue;
      if (conflictedRunIds.has(run.runId)) continue;
      const existing = byRunId.get(run.runId);
      if (existing && !hasStableIdentity(existing, run)) {
        // A duplicate durable ID with a different immutable owner is
        // ambiguous untrusted state. Preserve neither claimant.
        byRunId.delete(run.runId);
        conflictedRunIds.add(run.runId);
        continue;
      }
      if (
        !existing ||
        run.revision > existing.revision ||
        (run.revision === existing.revision && run.updatedAt > existing.updatedAt)
      ) {
        byRunId.set(run.runId, run);
      }
    } catch {
      // Stored data is untrusted. Invalid or unsafe records are never replayed.
    }
  }
  return {
    version: STORE_VERSION,
    runs: boundedRuns([...byRunId.values()], maxRuns, pendingChatDeletions),
    pendingChatDeletions,
  };
}

/**
 * Strict, lossless V1 reader for parallel V2 migration. Unlike normal replay,
 * this never drops, deduplicates, reorders, reconciles, or normalizes evidence.
 */
export function parseSubagentRunDatabaseV1ForMigration(serialized: string): SubagentRunDatabaseV1 {
  if (Buffer.byteLength(serialized, "utf8") > MAX_SUBAGENT_RUN_STORE_BYTES) {
    throw new Error("Subagent V1 migration source is oversized.");
  }
  assertUniqueJsonObjectKeys(serialized);
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid subagent V1 migration source.");
  }
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const currentSchema =
    keys.length === 3 &&
    keys.includes("version") &&
    keys.includes("runs") &&
    keys.includes("pendingChatDeletions");
  const legacySchema = keys.length === 2 && keys.includes("version") && keys.includes("runs");
  if (
    (!currentSchema && !legacySchema) ||
    candidate.version !== STORE_VERSION ||
    !Array.isArray(candidate.runs) ||
    candidate.runs.length > MAX_STORED_SUBAGENT_RUNS
  ) {
    throw new Error("Invalid subagent V1 migration source schema.");
  }
  const runs = candidate.runs.map((raw) => {
    const snapshot = strictSnapshot(raw);
    if (!isDeepStrictEqual(raw, snapshot)) {
      throw new Error("Subagent V1 migration would normalize a run.");
    }
    return snapshot;
  });
  if (new Set(runs.map(({ runId }) => runId)).size !== runs.length) {
    throw new Error("Subagent V1 migration source has duplicate runs.");
  }
  const pendingChatDeletions = currentSchema ? candidate.pendingChatDeletions : [];
  if (
    !Array.isArray(pendingChatDeletions) ||
    pendingChatDeletions.length > MAX_SUBAGENT_CHAT_TOMBSTONES ||
    pendingChatDeletions.some((chatId) => !safeLookupId(chatId as string)) ||
    new Set(pendingChatDeletions).size !== pendingChatDeletions.length
  ) {
    throw new Error("Invalid subagent V1 migration deletion state.");
  }
  const deletedChats = new Set(pendingChatDeletions as string[]);
  if (runs.some(({ chatId }) => deletedChats.has(chatId))) {
    throw new Error("Subagent V1 migration source contains deletion-owned runs.");
  }
  return {
    version: STORE_VERSION,
    runs,
    pendingChatDeletions: [...(pendingChatDeletions as string[])],
  };
}

function interruptedSnapshot(
  snapshot: SubagentRunSnapshotV1,
  now: number,
): SubagentRunSnapshotV1 | undefined {
  if (snapshot.revision >= Number.MAX_SAFE_INTEGER) return undefined;
  try {
    return strictSnapshot({
      ...snapshot,
      state: "interrupted",
      revision: snapshot.revision + 1,
      updatedAt: Math.max(snapshot.updatedAt, now),
      finishedAt: Math.max(snapshot.updatedAt, now),
      activity: "Interrupted after Aiden restarted.",
    });
  } catch {
    // Persisted state is untrusted. If an otherwise active record cannot make
    // the one required restart transition, scrub that record rather than
    // preventing the application from opening.
    return undefined;
  }
}

function hasStableIdentity(existing: SubagentRunSnapshotV1, next: SubagentRunSnapshotV1): boolean {
  return (
    existing.runId === next.runId &&
    existing.groupId === next.groupId &&
    existing.generationId === next.generationId &&
    existing.childId === next.childId &&
    existing.chatId === next.chatId &&
    existing.workspaceId === next.workspaceId &&
    existing.role === next.role &&
    existing.label === next.label &&
    existing.taskPreview === next.taskPreview &&
    existing.startedAt === next.startedAt &&
    existing.modelId === next.modelId
  );
}

function isValidProgression(existing: SubagentRunSnapshotV1, next: SubagentRunSnapshotV1): boolean {
  const existingMilestones = existing.milestones ?? [];
  const nextMilestones = next.milestones ?? [];
  if (
    SUBAGENT_ACTIVE_STATES.has(existing.state) === false ||
    next.updatedAt < existing.updatedAt ||
    next.turns < existing.turns ||
    next.tools < existing.tools ||
    next.tokens < existing.tokens ||
    nextMilestones.length < existingMilestones.length ||
    existingMilestones.some((milestone, index) => nextMilestones[index] !== milestone)
  ) {
    return false;
  }
  if (existing.state === "queued") return true;
  if (existing.state === "starting") return next.state !== "queued";
  return next.state !== "queued" && next.state !== "starting";
}

/**
 * Private, renderer-safe child-run persistence. The resolver is injectable so
 * tests never import Electron and production can resolve `userData` lazily.
 */
export function createSubagentRunStore(
  resolveDirectory: () => Promise<string>,
  options: SubagentRunStoreOptions = {},
) {
  const now = options.now ?? Date.now;
  const requestedMax = options.maxRuns ?? MAX_STORED_SUBAGENT_RUNS;
  if (
    !Number.isInteger(requestedMax) ||
    requestedMax < 1 ||
    requestedMax > MAX_STORED_SUBAGENT_RUNS
  ) {
    throw new Error("Invalid subagent run history limit.");
  }
  const maxRuns = requestedMax;
  const syncFile = options.syncFile;
  const syncDirectory = options.syncDirectory;
  const afterRead = options.afterRead;
  const storageFactory = options.storageFactory ?? createNativeSubagentRunStoreStorage;
  let operationTail: Promise<void> = Promise.resolve();
  let directoryPromise: Promise<string> | undefined;
  let storagePromise: Promise<SubagentRunStoreStorage> | undefined;
  let generation: SubagentRunStoreGeneration = "missing";
  let cache: SubagentRunDatabaseV1 | undefined;
  const deletedChats = new Map<string, { attempts: Set<symbol>; committed: boolean }>();
  let directorySyncPending = false;
  let stagingCleanupSyncPending = false;
  let restartReconciliationComplete = false;

  function hydratePendingChatDeletions(database: SubagentRunDatabaseV1): void {
    for (const chatId of database.pendingChatDeletions) {
      const tombstone = deletedChats.get(chatId) ?? {
        attempts: new Set<symbol>(),
        committed: true,
      };
      tombstone.committed = true;
      deletedChats.set(chatId, tombstone);
    }
  }

  function reconcileTombstonesWithDurableSnapshot(database: SubagentRunDatabaseV1): void {
    hydratePendingChatDeletions(database);
    const durable = new Set(database.pendingChatDeletions);
    for (const [chatId, tombstone] of deletedChats) {
      if (!durable.has(chatId) && tombstone.attempts.size === 0) {
        // A fresh durable read has now proved either that a provisional delete
        // never installed or that completion did install. Match the IPC
        // handler's release decision so a surviving chat is not denied writes
        // forever after the same verification.
        deletedChats.delete(chatId);
      }
    }
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function directory(): Promise<string> {
    if (!directoryPromise) {
      directoryPromise = (async () => {
        const resolved = await resolveDirectory();
        if (!path.isAbsolute(resolved)) {
          throw new Error("Subagent run storage requires an absolute directory.");
        }
        return resolved;
      })();
    }
    return directoryPromise;
  }

  async function storage(): Promise<SubagentRunStoreStorage> {
    if (!storagePromise) {
      storagePromise = directory().then((resolved) => storageFactory(resolved));
    }
    return storagePromise;
  }

  async function removeCrashStagingFiles(): Promise<void> {
    const storageDirectory = await directory();
    if (stagingCleanupSyncPending) {
      await (await storage()).syncDirectory();
      await syncDirectory?.(storageDirectory);
      stagingCleanupSyncPending = false;
    }
    const removed = await (await storage()).cleanup();
    if (removed && syncDirectory) {
      stagingCleanupSyncPending = true;
      await syncDirectory(storageDirectory);
      stagingCleanupSyncPending = false;
    }
  }

  async function writeNow(database: SubagentRunDatabaseV1): Promise<void> {
    const storageDirectory = await directory();
    const staged = path.join(storageDirectory, `.${STORE_FILE}.${randomUUID()}.tmp`);
    const contents = databaseJson(database);
    if (Buffer.byteLength(contents, "utf-8") > MAX_SUBAGENT_RUN_STORE_BYTES) {
      throw new Error("Subagent run history exceeds the private store limit.");
    }
    if (syncFile) await syncFile(staged);
    // The helper retains the verified directory descriptor and performs the
    // staged fsync plus an expected-generation install entirely relative to it.
    cache = undefined;
    try {
      generation = await (await storage()).write(generation, contents);
    } catch (error) {
      // A native destination-changed result proves only that this cached
      // generation is stale. It does not authorize writing this database over
      // the newer durable state; the caller must reload, validate, merge, and
      // make one bounded retry.
      if (
        error instanceof SubagentRunStoreStorageError &&
        error.failure === "destination_changed"
      ) {
        throw new SubagentRunStoreGenerationConflictError();
      }
      throw error;
    }
    if (syncDirectory) {
      directorySyncPending = true;
      await syncDirectory(storageDirectory);
      directorySyncPending = false;
    }
    cache = database;
  }

  async function readNow(
    reconcileActive = false,
    forceDurableRead = false,
  ): Promise<SubagentRunDatabaseV1> {
    if (directorySyncPending) {
      await (await storage()).syncDirectory();
      await syncDirectory?.(await directory());
      directorySyncPending = false;
    }
    if (cache && !reconcileActive && !forceDurableRead) return cache;
    let parsed: unknown;
    let shouldRewrite = false;
    // Any durable read supersedes the cache as evidence. If the read or parse
    // fails, no later history path may fall back to snapshots that predate the
    // unreadable on-disk state.
    cache = undefined;
    const read = await (await storage()).read();
    generation = read.generation;
    if (read.status === "missing") {
      parsed = undefined;
    } else if (read.status === "oversized") {
      // The generation proves runs.json exists. Its bytes may contain a
      // recovery-authoritative deletion marker, so absence can never be
      // inferred and the existing inode must not be normalized away.
      throw new SubagentRunStoreEvidenceError();
    } else {
      let decoded: string;
      try {
        decoded = STRICT_UTF8_DECODER.decode(read.contents);
      } catch {
        // The native helper returns the exact persisted bytes. Replacement
        // decoding would make invalid evidence look like a different valid
        // JSON document and could erase a recovery-authoritative marker.
        throw new SubagentRunStoreEvidenceError();
      }
      const serialized = afterRead ? await afterRead(decoded) : decoded;
      try {
        assertUniqueJsonObjectKeys(serialized);
        parsed = JSON.parse(serialized) as unknown;
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof SubagentRunStoreJsonStructureError)
        ) {
          throw error;
        }
        // Syntactically malformed bytes are existing evidence, not an empty
        // store. Rewriting them could erase a pending cross-store chat deletion.
        throw new SubagentRunStoreEvidenceError();
      }
    }

    let database: SubagentRunDatabaseV1;
    try {
      database = parseDatabase(parsed, maxRuns);
    } catch (error) {
      // A schema-invalid existing document may have hidden or displaced
      // recovery authority. Preserve it byte-for-byte for external repair.
      throw new SubagentRunStoreEvidenceError(error instanceof Error ? error.message : undefined);
    }
    if (parsed !== undefined && JSON.stringify(parsed) !== JSON.stringify(database)) {
      shouldRewrite = true;
    }
    let reconciled = false;
    if (reconcileActive) {
      const restartTime = now();
      if (!Number.isFinite(restartTime) || restartTime < 0) {
        throw new Error("Invalid subagent run store clock.");
      }
      database.runs = database.runs.flatMap((run) => {
        if (!SUBAGENT_ACTIVE_STATES.has(run.state)) return [run];
        reconciled = true;
        const interrupted = interruptedSnapshot(run, restartTime);
        return interrupted ? [interrupted] : [];
      });
    }
    if (reconciled || shouldRewrite) {
      await writeNow(database);
      return database;
    }
    cache = database;
    return database;
  }

  return {
    /** Load, scrub, and reconcile persisted state during application startup. */
    async initialize(): Promise<void> {
      await serialized(async () => {
        if (restartReconciliationComplete) return;
        await removeCrashStagingFiles();
        const database = await readNow(true);
        hydratePendingChatDeletions(database);
        restartReconciliationComplete = true;
      });
    },

    async upsert(value: unknown): Promise<SubagentRunSnapshotV1> {
      const snapshot = strictSnapshot(value);
      return serialized(async () => {
        if (deletedChats.has(snapshot.chatId)) {
          throw new Error("Subagent history is no longer available for this chat.");
        }
        for (let attempt = 0; attempt <= MAX_NATIVE_GENERATION_CONFLICT_RETRIES; attempt += 1) {
          // The first pass may use this instance's cache. A rejected native
          // CAS is retried only from a fresh durable generation, so every
          // current tombstone, record identity, revision, and capacity limit
          // participates in the merge.
          const database = await readNow(false, attempt > 0);
          hydratePendingChatDeletions(database);
          if (deletedChats.has(snapshot.chatId)) {
            throw new Error("Subagent history is no longer available for this chat.");
          }
          const existing = database.runs.find((run) => run.runId === snapshot.runId);
          if (existing && !hasStableIdentity(existing, snapshot)) {
            throw new Error("Subagent run identity cannot change.");
          }
          if (existing && snapshot.revision <= existing.revision) {
            if (JSON.stringify(snapshot) === JSON.stringify(existing))
              return structuredClone(existing);
            throw new Error("Subagent run revisions must increase monotonically.");
          }
          if (existing && !isValidProgression(existing, snapshot)) {
            throw new Error("Subagent run lifecycle cannot move backward.");
          }
          const next = retainedRuns(
            [snapshot, ...database.runs.filter((run) => run.runId !== snapshot.runId)],
            maxRuns,
            database.pendingChatDeletions,
          );
          const nextDatabase: SubagentRunDatabaseV1 = {
            version: STORE_VERSION,
            runs: next,
            pendingChatDeletions: database.pendingChatDeletions,
          };
          try {
            await writeNow(nextDatabase);
            return structuredClone(snapshot);
          } catch (error) {
            if (
              !(error instanceof SubagentRunStoreGenerationConflictError) ||
              attempt >= MAX_NATIVE_GENERATION_CONFLICT_RETRIES
            ) {
              throw error;
            }
          }
        }
        throw new Error("Subagent run storage could not merge a newer generation.");
      });
    },

    async get(runId: string): Promise<SubagentRunSnapshotV1 | null> {
      if (!safeLookupId(runId)) return null;
      return serialized(async () => {
        // Another store instance can install a deletion intent after this
        // instance cached the run. Ordinary private reads therefore require
        // fresh durable evidence before returning any snapshot.
        const database = await readNow(false, true);
        reconcileTombstonesWithDurableSnapshot(database);
        const run = database.runs.find((entry) => entry.runId === runId);
        // Recheck after the asynchronous read: deleteChat() installs its
        // in-memory tombstone synchronously and can cross this read in flight.
        return run && !deletedChats.has(run.chatId) ? structuredClone(run) : null;
      });
    },

    async listByChat(chatId: string): Promise<SubagentRunSnapshotV1[]> {
      if (!safeLookupId(chatId)) return [];
      return serialized(async () => {
        const database = await readNow(false, true);
        reconcileTombstonesWithDurableSnapshot(database);
        if (deletedChats.has(chatId)) return [];
        return orderedNewestFirst(database.runs.filter((run) => run.chatId === chatId)).map((run) =>
          structuredClone(run),
        );
      });
    },

    async deleteChat(chatId: string): Promise<void> {
      if (!safeLookupId(chatId)) return;
      if (!deletedChats.has(chatId) && deletedChats.size >= MAX_SUBAGENT_CHAT_TOMBSTONES) {
        throw new Error("Too many subagent history deletions are pending.");
      }
      // Synchronous tombstone closes the race with already queued and future
      // projector writes before the serialized delete reaches the disk.
      const attempt = Symbol(chatId);
      const tombstone = deletedChats.get(chatId) ?? {
        attempts: new Set<symbol>(),
        committed: false,
      };
      tombstone.attempts.add(attempt);
      deletedChats.set(chatId, tombstone);
      let durableAbsenceProven = false;
      try {
        await serialized(async () => {
          try {
            const database = await readNow();
            hydratePendingChatDeletions(database);
            if (
              !database.pendingChatDeletions.includes(chatId) &&
              database.pendingChatDeletions.length >= MAX_SUBAGENT_CHAT_TOMBSTONES
            ) {
              throw new Error("Too many subagent history deletions are pending.");
            }
            const runs = database.runs.filter((run) => run.chatId !== chatId);
            const pendingChatDeletions = database.pendingChatDeletions.includes(chatId)
              ? database.pendingChatDeletions
              : [...database.pendingChatDeletions, chatId];
            if (
              runs.length !== database.runs.length ||
              pendingChatDeletions !== database.pendingChatDeletions
            ) {
              await writeNow({
                version: STORE_VERSION,
                runs,
                pendingChatDeletions,
              });
            }
            tombstone.committed = true;
          } catch (error) {
            // A storage write can install its replacement and then fail before
            // acknowledging the new generation. Only a fresh durable read may
            // prove that the provisional intent was never installed.
            cache = undefined;
            try {
              const durable = await readNow(false, true);
              hydratePendingChatDeletions(durable);
              if (durable.pendingChatDeletions.includes(chatId)) {
                tombstone.committed = true;
              } else {
                durableAbsenceProven = true;
              }
            } catch {
              // Indeterminate persistence is privacy-sensitive. Keep the
              // tombstone fail-closed until a later delete/restart reconciles.
            }
            throw error;
          }
        });
        tombstone.attempts.delete(attempt);
      } catch (error) {
        tombstone.attempts.delete(attempt);
        if (!tombstone.committed && tombstone.attempts.size === 0 && durableAbsenceProven) {
          deletedChats.delete(chatId);
        }
        throw error;
      }
    },

    /** List crash-recoverable chat deletions before the renderer can open. */
    async pendingChatDeletions(): Promise<string[]> {
      return serialized(async () => {
        // This method controls whether the outer deletion gate reopens after an
        // error, so cached state is not sufficient evidence.
        const database = await readNow(false, true);
        reconcileTombstonesWithDurableSnapshot(database);
        return [...database.pendingChatDeletions];
      });
    },

    /** Clear the durable intent only after the owning chat is durably absent. */
    async completeChatDeletion(chatId: string): Promise<void> {
      if (!safeLookupId(chatId)) return;
      await serialized(async () => {
        const database = await readNow();
        hydratePendingChatDeletions(database);
        const runs = database.runs.filter((run) => run.chatId !== chatId);
        const pendingChatDeletions = database.pendingChatDeletions.filter(
          (pending) => pending !== chatId,
        );
        if (
          runs.length !== database.runs.length ||
          pendingChatDeletions.length !== database.pendingChatDeletions.length
        ) {
          await writeNow({
            version: STORE_VERSION,
            runs,
            pendingChatDeletions,
          });
        }
        const tombstone = deletedChats.get(chatId);
        if (tombstone && tombstone.attempts.size === 0) {
          deletedChats.delete(chatId);
        }
      });
    },

    /** Wait for every persistence mutation accepted before this call. */
    async flush(): Promise<void> {
      await operationTail;
    },

    async close(): Promise<void> {
      await operationTail;
      await (await storage()).close();
    },
  };
}

export type SubagentRunStore = ReturnType<typeof createSubagentRunStore>;
