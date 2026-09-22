import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  appendCreateImagesRunEvent,
  CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES,
  CREATE_IMAGES_RUN_JOURNAL_VERSION,
  createCreateImagesRunJournal,
  createImagesWorkflowSnapshotFingerprintMaterial,
  isFutureCreateImagesRunJournal,
  hasUnresolvedCreateImagesRunAmbiguity,
  parseCreateImagesRunJournal,
  projectCreateImagesRun,
  type CreateImagesCancellationReason,
  type CreateImagesRunEventV1,
  type CreateImagesRunJournalV1,
  type CreateImagesRunPlanV1,
  type CreateImagesRunProjection,
  type CreateImagesRunProviderAuthorizationV1,
  type CreateImagesRunTerminalStatus,
} from "../../../renderer/shared/create-images/run-contract.js";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";
import { decodeUtf8, readRegularFile } from "../regular-file-read.js";

const PENDING_VERSION = 1 as const;
const CURRENT_FILE = "run.json";
const LAST_KNOWN_GOOD_FILE = "run.last-known-good.json";
const PENDING_FILE = "run.pending.json";
const CURRENT_EVENTS_FILE = "run.events.jsonl";
const LAST_KNOWN_GOOD_EVENTS_FILE = "run.last-known-good.events.jsonl";
const RUN_INDEX_FILE = "run-index.json";
const PRUNE_PENDING_FILE = "run-prune.pending.json";
const DISCARD_PENDING_FILE = "run-discard.pending.json";
const RETIRED_RUNS_DIRECTORY = "retired-runs";
const DISCARDED_RUNS_DIRECTORY = "discarded-runs";
const RUN_FILES = new Set([
  CURRENT_FILE,
  LAST_KNOWN_GOOD_FILE,
  PENDING_FILE,
  CURRENT_EVENTS_FILE,
  LAST_KNOWN_GOOD_EVENTS_FILE,
]);
const STAGED_FILE_PATTERN =
  /^\.(?:run\.json|run\.last-known-good\.json|run\.pending\.json|run\.events\.jsonl|run\.last-known-good\.events\.jsonl)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const ROOT_STAGED_FILE_PATTERN =
  /^\.(?:run-index\.json|run-prune\.pending\.json|run-discard\.pending\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MAX_STAGED_FILES_PER_RUN = 8;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_PENDING_BYTES = CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES + 64 * 1024;
const MAX_EVENT_LOG_BYTES = CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES;
const MAX_HEALTH_PAGE_SIZE = 250;
const MAX_PRUNE_BATCH_SIZE = 100;
const MAX_DISCARD_DIRECTORY_ENTRIES = 32;
const MAX_DISCARD_FINGERPRINT_BYTES = MAX_PENDING_BYTES * 6;
const DEFAULT_MAX_RUN_COUNT = 1_000;
const DEFAULT_MAX_AGGREGATE_RUN_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_CACHE_COUNT = 32;
const DEFAULT_MAX_JOURNAL_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TAIL_CACHE_COUNT = 128;
const DEFAULT_MAX_TAIL_CACHE_BYTES = 64 * 1024;
const MAX_INDEX_QUARANTINES = 4;
const INDEX_QUARANTINE_PATTERN =
  /^run-index\.corrupt\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

interface PendingRunStartMutationV1 {
  version: typeof PENDING_VERSION;
  kind?: "start";
  runId: string;
  baseJournalRevision: number | null;
  targetJournalRevision: number;
  stagedAt: string;
  next: CreateImagesRunJournalV1;
}

interface PendingRunAppendMutationV1 {
  version: typeof PENDING_VERSION;
  kind: "append";
  runId: string;
  baseJournalRevision: number;
  targetJournalRevision: number;
  stagedAt: string;
  event: CreateImagesRunEventV1;
  authority: RunAuthorityIdentity;
  targetJournalDigest: string;
}

type PendingRunMutationV1 = PendingRunStartMutationV1 | PendingRunAppendMutationV1;

interface RunEventLogRecordV1 {
  version: 1;
  runId: string;
  journalRevision: number;
  previousDigest: string;
  digest: string;
  event: CreateImagesRunEventV1;
}

type RunAuthorityFileIdentity =
  | { kind: "missing" }
  | {
      kind: "file";
      device: string;
      inode: string;
      size: string;
      modifiedAtNs: string;
      changedAtNs: string;
    }
  | { kind: "other" };

interface RunAuthorityIdentity {
  current: RunAuthorityFileIdentity;
  lastKnownGood: RunAuthorityFileIdentity;
  currentEvents: RunAuthorityFileIdentity;
  lastKnownGoodEvents: RunAuthorityFileIdentity;
}

interface RunEventLogTailCache {
  bytes: number;
  digest: string;
  identity: RunAuthorityFileIdentity;
}

interface ParsedRunEventLog {
  inspection: FileInspection<CreateImagesRunJournalV1>;
  tailDigest?: string;
}

interface RunIndexEntryV1 {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  journalRevision: number;
  status: CreateImagesRunProjection["status"];
  createdAt: string;
  updatedAt: string;
  terminal: boolean;
  unresolvedAmbiguity: boolean;
  health: "healthy" | "recovery-required" | "unsafe";
  recoveryReason?: CreateImagesRunRecoveryReason;
  unsafeReason?: CreateImagesRunUnsafeReason;
  canRecover?: "from-last-known-good" | "from-current" | false;
  expectedJournalRevision?: number;
}

interface RunIndexV1 {
  version: 1;
  revision: number;
  entries: RunIndexEntryV1[];
  degraded: RunUnassociatedDegradedEntryV1[];
}

interface RunUnassociatedDegradedEntryV1 {
  runId: string;
  status: "recovery-required" | "unsafe";
  recoveryReason?: CreateImagesRunRecoveryReason;
  unsafeReason?: CreateImagesRunUnsafeReason;
  canRecover: false;
}

interface TerminalPruneManifestV1 extends CreateImagesTerminalPrunePlan {
  createdAt: string;
}

interface DegradedRunDiscardManifestV1 extends CreateImagesDegradedRunDiscardPlan {
  createdAt: string;
}

type FileInspection<T> =
  | { status: "missing" }
  | { status: "healthy"; value: T }
  | { status: "corrupt" }
  | { status: "unsafe"; reason: "future-schema" | "unsafe-storage" };

export interface CreateImagesRunStartInput {
  runId: string;
  workflowSnapshot: WorkflowDocumentV1;
  plan: CreateImagesRunPlanV1;
  providerAuthorization?: CreateImagesRunProviderAuthorizationV1;
  createdAt: string;
}

export interface CreateImagesRunJournalDurability {
  /** Crash seam after an authorized start/append intent is durable. */
  afterPendingPublished?: (runId: string) => Promise<void>;
  /** Crash seam after the new current journal is durable. */
  afterCurrentPublished?: (runId: string) => Promise<void>;
  /** Crash seam after the matching recovery copy is durable. */
  afterLastKnownGoodPublished?: (runId: string) => Promise<void>;
  /** Failure-injection seam after a terminal prune manifest is durable. */
  afterPruneManifestPublished?: (token: string) => Promise<void>;
  /** Failure-injection seam after each run directory is atomically retired. */
  afterRunRetired?: (runId: string) => Promise<void>;
  /** Failure-injection seam immediately before retired data is deleted. */
  beforeRetiredDelete?: (token: string) => Promise<void>;
  /** Failure-injection seam after deletion and parent fsync, before commit. */
  afterRetiredDelete?: (token: string) => Promise<void>;
  /** Failure-injection seam before the derived run index is atomically published. */
  beforeIndexPublished?: (revision: number) => Promise<void>;
  /** Failure-injection seam after a degraded-run discard manifest is durable. */
  afterDiscardManifestPublished?: (token: string) => Promise<void>;
  /** Failure-injection seam after a degraded run is atomically quarantined. */
  afterDegradedRunRetired?: (runId: string) => Promise<void>;
  /** Failure-injection seam after discarded data is deleted and its parent is synced. */
  afterDiscardedRunDeleted?: (token: string) => Promise<void>;
}

export interface CreateImagesRunJournalStoreLimits {
  maxRunCount?: number;
  maxAggregateRunBytes?: number;
  maxJournalCacheCount?: number;
  maxJournalCacheBytes?: number;
  maxTailCacheCount?: number;
  maxTailCacheBytes?: number;
}

export type CreateImagesRunRecoveryReason =
  | "current-corrupt"
  | "current-missing"
  | "last-known-good-corrupt"
  | "last-known-good-missing"
  | "last-known-good-mismatch"
  | "pending-corrupt"
  | "pending-conflict";

export type CreateImagesRunUnsafeReason =
  | "current-future-schema"
  | "last-known-good-future-schema"
  | "pending-future-schema"
  | "unsafe-storage";

export type CreateImagesRunJournalHealth =
  | {
      status: "missing";
      runId: string;
    }
  | {
      status: "healthy";
      runId: string;
      journalRevision: number;
      runStatus: CreateImagesRunProjection["status"];
    }
  | {
      status: "recovery-required";
      runId: string;
      reason: CreateImagesRunRecoveryReason;
      canRecover: "from-last-known-good" | "from-current" | false;
      workflowId?: string;
      workflowRevision?: number;
      currentJournalRevision?: number;
      lastKnownGoodJournalRevision?: number;
    }
  | {
      status: "unsafe";
      runId: string;
      reason: CreateImagesRunUnsafeReason;
      workflowId?: string;
      workflowRevision?: number;
    };

export interface CreateImagesTerminalRunSummary {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  journalRevision: number;
  status: CreateImagesRunTerminalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImagesRunReferenceInventory {
  /** False means asset GC must fail closed and retain all assets. */
  complete: boolean;
  records: Array<{ runId: string; assetIds: string[] }>;
}

export interface CreateImagesRunHealthPage {
  records: CreateImagesRunJournalHealth[];
  nextCursor?: string;
}

export interface CreateImagesRunRecoveryCandidate {
  runId: string;
  workflowId?: string;
  workflowRevision?: number;
  reason: CreateImagesRunRecoveryReason;
  canRecover: "from-last-known-good" | "from-current" | false;
  expectedJournalRevision?: number;
}

export interface CreateImagesRunUnsafeCandidate {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  reason: CreateImagesRunUnsafeReason;
}

export type CreateImagesRunDegradedCandidate =
  | ({ status: "recovery-required" } & CreateImagesRunRecoveryCandidate)
  | ({ status: "unsafe" } & CreateImagesRunUnsafeCandidate);

export type CreateImagesRunStorageDegradedRecord =
  | CreateImagesRunDegradedCandidate
  | {
      status: "recovery-required" | "unsafe";
      runId: string;
      reason: CreateImagesRunRecoveryReason | CreateImagesRunUnsafeReason;
      canRecover: false;
    };

export interface CreateImagesTerminalPruneCandidate {
  runId: string;
  journalRevision: number;
}

export interface CreateImagesTerminalPrunePlan {
  version: 1;
  candidates: CreateImagesTerminalPruneCandidate[];
  token: string;
  assetIds: string[];
}

export interface CreateImagesTerminalPruneResult {
  removedRunIds: string[];
  releasedAssetIds: string[];
}

export interface CreateImagesDegradedRunDiscardPlan {
  version: 1;
  runId: string;
  reason: CreateImagesRunRecoveryReason | CreateImagesRunUnsafeReason;
  association: "workflow" | "unassociated";
  workflowId?: string;
  expectedCurrentJournalRevision?: number;
  expectedLastKnownGoodJournalRevision?: number;
  authorizationToken: string;
  recordFingerprint: string;
}

export type CreateImagesDegradedRunDiscardPlanResult =
  | { status: "ready"; plan: CreateImagesDegradedRunDiscardPlan }
  | { status: "not-found" | "not-degraded" | "recoverable" };

export interface CreateImagesDegradedRunDiscardResult {
  runId: string;
  workflowId?: string;
}

export interface CreateImagesDegradedRunDiscardRequest {
  runId: string;
  expectedCurrentJournalRevision?: number;
  expectedLastKnownGoodJournalRevision?: number;
  authorizationToken: string;
}

export type CreateImagesDegradedRunDiscardMutationResult =
  | { status: "discarded"; result: CreateImagesDegradedRunDiscardResult }
  | { status: "conflict" | "not-found" | "not-degraded" | "recoverable" };

export type CreateImagesRunIndexHealth =
  | { status: "missing" }
  | {
      status: "healthy";
      revision: number;
      entryCount: number;
      diagnostic?: "rebuilt-corrupt-index" | "stale-derived-index";
      quarantinedIndexCount?: number;
    }
  | {
      status: "degraded";
      revision: number;
      entryCount: number;
      degradedEntryCount: number;
      diagnostic?: "rebuilt-corrupt-index" | "stale-derived-index";
      quarantinedIndexCount?: number;
    }
  | { status: "corrupt" }
  | { status: "unsafe" };

export type CreateImagesTerminalPruneStatus =
  | { status: "none" }
  | { status: "pending"; plan: CreateImagesTerminalPrunePlan }
  | { status: "corrupt" }
  | { status: "unsafe" };

export interface CreateImagesTerminalRetentionQuery {
  workflowId?: string;
  keepLatest: number;
  olderThan?: string;
  limit?: number;
}

export interface CreateImagesTerminalRetentionCandidate extends CreateImagesTerminalPruneCandidate {
  workflowId: string;
  updatedAt: string;
  assetIds: string[];
}

export interface CreateImagesRunCacheStats {
  journalCount: number;
  journalBytes: number;
  tailCount: number;
  tailBytes: number;
}

export interface CreateImagesWorkflowAdmissionAudit {
  hasDegradedAuthority: boolean;
  hasNonterminalRun: boolean;
  hasUnresolvedAmbiguity: boolean;
}

export class CreateImagesRunJournalLoadError extends Error {
  constructor(
    readonly status: "corrupt" | "unsafe",
    readonly filePath: string,
  ) {
    super(
      status === "unsafe"
        ? "The Create Images run belongs to an unsupported schema or unsafe storage and is read-only."
        : "The Create Images run journal is damaged and has been kept for recovery.",
    );
    this.name = "CreateImagesRunJournalLoadError";
  }
}

export class CreateImagesRunJournalRevisionConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly expectedJournalRevision: number | null,
    readonly actualJournalRevision: number | null,
  ) {
    super(
      `Run "${runId}" changed: expected journal revision ${expectedJournalRevision ?? "absent"}, found ${actualJournalRevision ?? "absent"}.`,
    );
    this.name = "CreateImagesRunJournalRevisionConflictError";
  }
}

const rootMutationTails = new Map<string, Promise<void>>();

function serializedAtRoot<R>(root: string, operation: () => Promise<R>): Promise<R> {
  const key = path.resolve(root);
  const tail = rootMutationTails.get(key) ?? Promise.resolve();
  const result = tail.then(operation, operation);
  rootMutationTails.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

function validateRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid Create Images run ID.");
  return runId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function futureVersion(value: unknown, field: "version"): boolean {
  return isRecord(value) && typeof value[field] === "number" && value[field] > 1;
}

function parsedJournal(value: unknown): CreateImagesRunJournalV1 | undefined {
  const parsed = parseCreateImagesRunJournal(value);
  return parsed.success ? parsed.value : undefined;
}

function parseRunAuthorityFileIdentity(value: unknown): RunAuthorityFileIdentity | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "missing" || value.kind === "other") {
    return Object.keys(value).length === 1 ? { kind: value.kind } : undefined;
  }
  if (
    value.kind !== "file" ||
    Object.keys(value).some(
      (key) => !["kind", "device", "inode", "size", "modifiedAtNs", "changedAtNs"].includes(key),
    ) ||
    ![value.device, value.inode, value.size, value.modifiedAtNs, value.changedAtNs].every(
      (field) => typeof field === "string" && /^\d+$/u.test(field),
    )
  ) {
    return undefined;
  }
  return value as unknown as RunAuthorityFileIdentity;
}

function parseRunAuthorityIdentity(value: unknown): RunAuthorityIdentity | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !["current", "lastKnownGood", "currentEvents", "lastKnownGoodEvents"].every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    return undefined;
  }
  const current = parseRunAuthorityFileIdentity(value.current);
  const lastKnownGood = parseRunAuthorityFileIdentity(value.lastKnownGood);
  const currentEvents = parseRunAuthorityFileIdentity(value.currentEvents);
  const lastKnownGoodEvents = parseRunAuthorityFileIdentity(value.lastKnownGoodEvents);
  return current && lastKnownGood && currentEvents && lastKnownGoodEvents
    ? { current, lastKnownGood, currentEvents, lastKnownGoodEvents }
    : undefined;
}

function parsePending(value: unknown): PendingRunMutationV1 | undefined {
  if (isRecord(value) && value.kind === "append") {
    if (
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "kind",
            "runId",
            "baseJournalRevision",
            "targetJournalRevision",
            "stagedAt",
            "event",
            "authority",
            "targetJournalDigest",
          ].includes(key),
      ) ||
      value.version !== PENDING_VERSION ||
      typeof value.runId !== "string" ||
      !RUN_ID_PATTERN.test(value.runId) ||
      !Number.isSafeInteger(value.baseJournalRevision) ||
      (value.baseJournalRevision as number) < 1 ||
      !Number.isSafeInteger(value.targetJournalRevision) ||
      value.targetJournalRevision !== (value.baseJournalRevision as number) + 1 ||
      typeof value.stagedAt !== "string" ||
      !isRecord(value.event) ||
      value.event.runId !== value.runId ||
      value.event.sequence !== value.baseJournalRevision ||
      value.event.at !== value.stagedAt
    ) {
      return undefined;
    }
    const authority = parseRunAuthorityIdentity(value.authority);
    if (
      !authority ||
      typeof value.targetJournalDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.targetJournalDigest)
    ) {
      return undefined;
    }
    return {
      version: PENDING_VERSION,
      kind: "append",
      runId: value.runId,
      baseJournalRevision: value.baseJournalRevision as number,
      targetJournalRevision: value.targetJournalRevision as number,
      stagedAt: value.stagedAt,
      event: value.event as unknown as CreateImagesRunEventV1,
      authority,
      targetJournalDigest: value.targetJournalDigest,
    };
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "kind",
          "runId",
          "baseJournalRevision",
          "targetJournalRevision",
          "stagedAt",
          "next",
        ].includes(key),
    )
  ) {
    return undefined;
  }
  const next = parsedJournal(value.next);
  const base =
    value.baseJournalRevision === null
      ? null
      : Number.isSafeInteger(value.baseJournalRevision) &&
          (value.baseJournalRevision as number) >= 1
        ? (value.baseJournalRevision as number)
        : undefined;
  const target =
    Number.isSafeInteger(value.targetJournalRevision) &&
    (value.targetJournalRevision as number) >= 1
      ? (value.targetJournalRevision as number)
      : undefined;
  if (
    value.version !== PENDING_VERSION ||
    (value.kind !== undefined && value.kind !== "start") ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    base === undefined ||
    target === undefined ||
    target !== (base === null ? 1 : base + 1) ||
    !next ||
    next.runId !== value.runId ||
    next.journalRevision !== target ||
    typeof value.stagedAt !== "string" ||
    value.stagedAt !== next.updatedAt
  ) {
    return undefined;
  }
  return {
    version: PENDING_VERSION,
    ...(value.kind === "start" ? { kind: "start" as const } : {}),
    runId: value.runId,
    baseJournalRevision: base,
    targetJournalRevision: target,
    stagedAt: value.stagedAt,
    next,
  };
}

function identical(left: CreateImagesRunJournalV1, right: CreateImagesRunJournalV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventRecordDigest(
  runId: string,
  journalRevision: number,
  previousDigest: string,
  event: CreateImagesRunEventV1,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ runId, journalRevision, previousDigest, event }), "utf8")
    .digest("hex");
}

function journalDigest(journal: CreateImagesRunJournalV1): string {
  return createHash("sha256").update(JSON.stringify(journal), "utf8").digest("hex");
}

function initialEventDigest(journal: CreateImagesRunJournalV1): string {
  return journalDigest(journal);
}

function serializedEventRecord(
  base: CreateImagesRunJournalV1,
  event: CreateImagesRunEventV1,
  previousDigest: string,
): { record: RunEventLogRecordV1; bytes: Buffer } {
  const journalRevision = event.sequence + 1;
  const record: RunEventLogRecordV1 = {
    version: 1,
    runId: base.runId,
    journalRevision,
    previousDigest,
    digest: eventRecordDigest(base.runId, journalRevision, previousDigest, event),
    event,
  };
  return { record, bytes: Buffer.from(`${JSON.stringify(record)}\n`, "utf8") };
}

function referencedAssetIds(journal: CreateImagesRunJournalV1): string[] {
  const assetIds = new Set(journal.workflowSnapshot.assetRefs);
  for (const event of journal.events) {
    if (event.type === "node-succeeded" || event.type === "node-output-published") {
      for (const assetId of event.outputAssetIds) assetIds.add(assetId);
    }
  }
  return [...assetIds].sort();
}

export function createImagesWorkflowSnapshotFingerprint(snapshot: WorkflowDocumentV1): string {
  return createHash("sha256")
    .update(createImagesWorkflowSnapshotFingerprintMaterial(snapshot), "utf8")
    .digest("hex");
}

/**
 * Main-owned crash-safe run authority.
 *
 * Renderer liveness is consulted only until a start intent is durably
 * published. Every later append and restart reconciliation is main-owned.
 */
export class CreateImagesRunJournalStore {
  private readonly limits: Required<CreateImagesRunJournalStoreLimits>;
  private inventoryCache?: {
    runIds: string[];
    aggregateBytes: number;
    runBytes: Map<string, number>;
  };
  private indexCache?: RunIndexV1;
  private indexAuthorityCache?: RunAuthorityFileIdentity;
  private readonly journalCache = new Map<string, CreateImagesRunJournalV1>();
  private readonly journalAuthorityCache = new Map<string, RunAuthorityIdentity>();
  private readonly eventLogTailCache = new Map<string, RunEventLogTailCache>();
  private journalCacheBytes = 0;
  private tailCacheBytes = 0;
  private indexDiagnostic?: "rebuilt-corrupt-index";
  private indexDirty = false;
  private readonly pruneTombstones = new Set<string>();
  private pruneStateLoaded = false;
  private discardStateLoaded = false;
  constructor(
    private readonly rootResolver: () => string,
    private readonly durability: CreateImagesRunJournalDurability = {},
    limits: CreateImagesRunJournalStoreLimits = {},
  ) {
    this.limits = {
      maxRunCount: limits.maxRunCount ?? DEFAULT_MAX_RUN_COUNT,
      maxAggregateRunBytes: limits.maxAggregateRunBytes ?? DEFAULT_MAX_AGGREGATE_RUN_BYTES,
      maxJournalCacheCount: limits.maxJournalCacheCount ?? DEFAULT_MAX_JOURNAL_CACHE_COUNT,
      maxJournalCacheBytes: limits.maxJournalCacheBytes ?? DEFAULT_MAX_JOURNAL_CACHE_BYTES,
      maxTailCacheCount: limits.maxTailCacheCount ?? DEFAULT_MAX_TAIL_CACHE_COUNT,
      maxTailCacheBytes: limits.maxTailCacheBytes ?? DEFAULT_MAX_TAIL_CACHE_BYTES,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid Create Images run storage limit: ${name}.`);
      }
    }
  }

  private journalCacheSize(journal: CreateImagesRunJournalV1): number {
    return Buffer.byteLength(JSON.stringify(journal), "utf8");
  }

  private getCachedJournal(runId: string): CreateImagesRunJournalV1 | undefined {
    const journal = this.journalCache.get(runId);
    if (!journal) return undefined;
    this.journalCache.delete(runId);
    this.journalCache.set(runId, journal);
    return journal;
  }

  private cacheJournal(
    runId: string,
    journal: CreateImagesRunJournalV1,
    authority: RunAuthorityIdentity,
  ): void {
    this.evictJournal(runId);
    const bytes = this.journalCacheSize(journal);
    if (bytes > this.limits.maxJournalCacheBytes) return;
    this.journalCache.set(runId, journal);
    this.journalAuthorityCache.set(runId, authority);
    this.journalCacheBytes += bytes;
    while (
      this.journalCache.size > this.limits.maxJournalCacheCount ||
      this.journalCacheBytes > this.limits.maxJournalCacheBytes
    ) {
      const oldest = this.journalCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.evictJournal(oldest);
    }
  }

  private evictJournal(runId: string): void {
    const existing = this.journalCache.get(runId);
    if (existing) {
      this.journalCacheBytes -= this.journalCacheSize(existing);
      this.journalCache.delete(runId);
    }
    this.journalAuthorityCache.delete(runId);
  }

  private async fileAuthorityIdentity(target: string): Promise<RunAuthorityFileIdentity> {
    try {
      const info = await fs.lstat(target, { bigint: true });
      return this.authorityIdentityFromStats(info);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
  }

  private authorityIdentityFromStats(info: BigIntStats): RunAuthorityFileIdentity {
    if (!info.isFile() || info.isSymbolicLink()) return { kind: "other" };
    return {
      kind: "file",
      device: info.dev.toString(),
      inode: info.ino.toString(),
      size: info.size.toString(),
      modifiedAtNs: info.mtimeNs.toString(),
      changedAtNs: info.ctimeNs.toString(),
    };
  }

  private async runAuthorityIdentity(runId: string): Promise<RunAuthorityIdentity> {
    const paths = this.paths(runId);
    const [current, lastKnownGood, currentEvents, lastKnownGoodEvents] = await Promise.all([
      this.fileAuthorityIdentity(paths.current),
      this.fileAuthorityIdentity(paths.lastKnownGood),
      this.fileAuthorityIdentity(paths.currentEvents),
      this.fileAuthorityIdentity(paths.lastKnownGoodEvents),
    ]);
    return { current, lastKnownGood, currentEvents, lastKnownGoodEvents };
  }

  private clearIndexCache(): void {
    this.indexCache = undefined;
    this.indexAuthorityCache = undefined;
  }

  private sameFileAuthorityIdentity(
    left: RunAuthorityFileIdentity | undefined,
    right: RunAuthorityFileIdentity,
  ): boolean {
    return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
  }

  private async bindIndexCache(index: RunIndexV1): Promise<void> {
    const identity = await this.fileAuthorityIdentity(this.indexPath());
    if (identity.kind !== "file") {
      this.clearIndexCache();
      throw new CreateImagesRunJournalLoadError("unsafe", this.indexPath());
    }
    this.indexCache = index;
    this.indexAuthorityCache = identity;
  }

  private async cacheHealthyJournal(
    runId: string,
    journal: CreateImagesRunJournalV1,
  ): Promise<void> {
    this.cacheJournal(runId, journal, await this.runAuthorityIdentity(runId));
  }

  private async cachedAuthorityIsCurrent(runId: string): Promise<boolean> {
    const expected = this.journalAuthorityCache.get(runId);
    if (!expected) return false;
    const pendingExists = await fs
      .lstat(this.paths(runId).pending)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (pendingExists) return false;
    return JSON.stringify(expected) === JSON.stringify(await this.runAuthorityIdentity(runId));
  }

  private sameRunAuthorityIdentity(
    left: RunAuthorityIdentity | undefined,
    right: RunAuthorityIdentity,
  ): boolean {
    return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
  }

  private tailCacheSize(target: string): number {
    return Buffer.byteLength(target, "utf8") + 320;
  }

  private getCachedTail(target: string): RunEventLogTailCache | undefined {
    const tail = this.eventLogTailCache.get(target);
    if (!tail) return undefined;
    this.eventLogTailCache.delete(target);
    this.eventLogTailCache.set(target, tail);
    return tail;
  }

  private cacheTail(target: string, tail: RunEventLogTailCache): void {
    this.evictTail(target);
    const bytes = this.tailCacheSize(target);
    if (bytes > this.limits.maxTailCacheBytes) return;
    this.eventLogTailCache.set(target, tail);
    this.tailCacheBytes += bytes;
    while (
      this.eventLogTailCache.size > this.limits.maxTailCacheCount ||
      this.tailCacheBytes > this.limits.maxTailCacheBytes
    ) {
      const oldest = this.eventLogTailCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.evictTail(oldest);
    }
  }

  private evictTail(target: string): void {
    if (!this.eventLogTailCache.delete(target)) return;
    this.tailCacheBytes -= this.tailCacheSize(target);
  }

  private evictRunCaches(runId: string): void {
    this.evictJournal(runId);
    const paths = this.paths(runId);
    this.evictTail(paths.currentEvents);
    this.evictTail(paths.lastKnownGoodEvents);
  }

  private root(): string {
    return path.resolve(this.rootResolver());
  }

  private runsPath(): string {
    return path.join(this.root(), "runs");
  }

  private runDirectory(runId: string): string {
    return path.join(this.runsPath(), validateRunId(runId));
  }

  private paths(runId: string) {
    const directory = this.runDirectory(runId);
    return {
      directory,
      current: path.join(directory, CURRENT_FILE),
      lastKnownGood: path.join(directory, LAST_KNOWN_GOOD_FILE),
      pending: path.join(directory, PENDING_FILE),
      currentEvents: path.join(directory, CURRENT_EVENTS_FILE),
      lastKnownGoodEvents: path.join(directory, LAST_KNOWN_GOOD_EVENTS_FILE),
    };
  }

  private indexPath(): string {
    return path.join(this.root(), RUN_INDEX_FILE);
  }

  private prunePendingPath(): string {
    return path.join(this.root(), PRUNE_PENDING_FILE);
  }

  private discardPendingPath(): string {
    return path.join(this.root(), DISCARD_PENDING_FILE);
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async ensureDirectory(target: string): Promise<boolean> {
    const created = await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Create Images run storage contains an unsafe directory.");
    }
    if (created !== undefined) await this.syncDirectory(path.dirname(target));
    return created !== undefined;
  }

  private async prepare(): Promise<void> {
    await this.ensureDirectory(this.root());
    await this.ensureDirectory(this.runsPath());
    let removed = false;
    let stagedCount = 0;
    const handle = await fs.opendir(this.root());
    for await (const entry of handle) {
      if (!ROOT_STAGED_FILE_PATTERN.test(entry.name)) continue;
      stagedCount += 1;
      if (stagedCount > MAX_STAGED_FILES_PER_RUN) {
        throw new CreateImagesRunJournalLoadError("unsafe", this.root());
      }
      const target = path.join(this.root(), entry.name);
      const info = await fs.lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()) {
        throw new CreateImagesRunJournalLoadError("unsafe", target);
      }
      await fs.rm(target);
      removed = true;
    }
    if (removed) await this.syncDirectory(this.root());
  }

  private async readJson(target: string, maxBytes: number): Promise<FileInspection<unknown>> {
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(target, maxBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      if (["ELOOP", "EFTYPE", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return { status: "unsafe", reason: "unsafe-storage" };
      }
      return { status: "corrupt" };
    }
    try {
      return {
        status: "healthy",
        value: JSON.parse(decodeUtf8(bytes)) as unknown,
      };
    } catch {
      return { status: "corrupt" };
    }
  }

  private async inspectJournal(target: string): Promise<FileInspection<CreateImagesRunJournalV1>> {
    const raw = await this.readJson(target, CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES);
    if (raw.status !== "healthy") return raw;
    if (isFutureCreateImagesRunJournal(raw.value)) {
      return { status: "unsafe", reason: "future-schema" };
    }
    const journal = parsedJournal(raw.value);
    if (!journal) return { status: "corrupt" };
    const fingerprint = createImagesWorkflowSnapshotFingerprint(journal.workflowSnapshot);
    return fingerprint === journal.workflowFingerprint
      ? { status: "healthy", value: journal }
      : { status: "corrupt" };
  }

  private parseEventLogBytes(
    bytes: Buffer,
    checkpoint: CreateImagesRunJournalV1,
  ): ParsedRunEventLog {
    const text = decodeUtf8(bytes);
    if (text.length > 0 && !text.endsWith("\n")) {
      return { inspection: { status: "corrupt" } };
    }
    const records: RunEventLogRecordV1[] = [];
    let previousDigest = initialEventDigest(checkpoint);
    let revision = checkpoint.journalRevision;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        return { inspection: { status: "corrupt" } };
      }
      if (isRecord(raw) && typeof raw.version === "number" && raw.version > 1) {
        return { inspection: { status: "unsafe", reason: "future-schema" } };
      }
      if (
        !isRecord(raw) ||
        Object.keys(raw).some(
          (key) =>
            !["version", "runId", "journalRevision", "previousDigest", "digest", "event"].includes(
              key,
            ),
        ) ||
        raw.version !== 1 ||
        raw.runId !== checkpoint.runId ||
        raw.journalRevision !== revision + 1 ||
        raw.previousDigest !== previousDigest ||
        typeof raw.digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(raw.digest) ||
        !isRecord(raw.event)
      ) {
        return { inspection: { status: "corrupt" } };
      }
      const event = raw.event as unknown as CreateImagesRunEventV1;
      const digest = eventRecordDigest(
        checkpoint.runId,
        raw.journalRevision,
        previousDigest,
        event,
      );
      if (digest !== raw.digest) return { inspection: { status: "corrupt" } };
      records.push(raw as unknown as RunEventLogRecordV1);
      previousDigest = digest;
      revision = raw.journalRevision;
    }
    const last = records[records.length - 1];
    const candidate = {
      ...checkpoint,
      journalRevision: revision,
      updatedAt: last?.event.at ?? checkpoint.updatedAt,
      events: [...checkpoint.events, ...records.map((record) => record.event)],
    };
    const parsed = parsedJournal(candidate);
    return parsed
      ? { inspection: { status: "healthy", value: parsed }, tailDigest: previousDigest }
      : { inspection: { status: "corrupt" } };
  }

  private async inspectEventLog(
    target: string,
    checkpoint: CreateImagesRunJournalV1,
  ): Promise<FileInspection<CreateImagesRunJournalV1>> {
    const identityBeforeRead = await this.fileAuthorityIdentity(target);
    if (identityBeforeRead.kind === "other") {
      return { status: "unsafe", reason: "unsafe-storage" };
    }
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(target, MAX_EVENT_LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const identityAfterRead = await this.fileAuthorityIdentity(target);
        if (
          identityBeforeRead.kind !== "missing" ||
          !this.sameFileAuthorityIdentity(identityBeforeRead, identityAfterRead)
        ) {
          return { status: "corrupt" };
        }
        this.cacheTail(target, {
          bytes: 0,
          digest: initialEventDigest(checkpoint),
          identity: identityAfterRead,
        });
        return { status: "healthy", value: checkpoint };
      }
      if (["ELOOP", "EFTYPE", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return { status: "unsafe", reason: "unsafe-storage" };
      }
      return { status: "corrupt" };
    }
    const identityAfterRead = await this.fileAuthorityIdentity(target);
    if (
      identityAfterRead.kind !== "file" ||
      !this.sameFileAuthorityIdentity(identityBeforeRead, identityAfterRead) ||
      BigInt(bytes.length) !== BigInt(identityAfterRead.size)
    ) {
      return identityAfterRead.kind === "other"
        ? { status: "unsafe", reason: "unsafe-storage" }
        : { status: "corrupt" };
    }
    const parsed = this.parseEventLogBytes(bytes, checkpoint);
    if (parsed.inspection.status === "healthy" && parsed.tailDigest) {
      this.cacheTail(target, {
        bytes: bytes.length,
        digest: parsed.tailDigest,
        identity: identityAfterRead,
      });
    }
    return parsed.inspection;
  }

  private async inspectPending(target: string): Promise<FileInspection<PendingRunMutationV1>> {
    const raw = await this.readJson(target, MAX_PENDING_BYTES);
    if (raw.status !== "healthy") return raw;
    if (futureVersion(raw.value, "version")) {
      return { status: "unsafe", reason: "future-schema" };
    }
    const pending = parsePending(raw.value);
    if (!pending) return { status: "corrupt" };
    if (pending.kind === "append") return { status: "healthy", value: pending };
    const fingerprint = createImagesWorkflowSnapshotFingerprint(pending.next.workflowSnapshot);
    return fingerprint === pending.next.workflowFingerprint
      ? { status: "healthy", value: pending }
      : { status: "corrupt" };
  }

  private async inspected(runId: string): Promise<{
    paths: ReturnType<CreateImagesRunJournalStore["paths"]>;
    current: FileInspection<CreateImagesRunJournalV1>;
    lastKnownGood: FileInspection<CreateImagesRunJournalV1>;
    pending: FileInspection<PendingRunMutationV1>;
  }> {
    const paths = this.paths(runId);
    try {
      const info = await fs.lstat(paths.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return {
          paths,
          current: { status: "unsafe", reason: "unsafe-storage" },
          lastKnownGood: { status: "unsafe", reason: "unsafe-storage" },
          pending: { status: "unsafe", reason: "unsafe-storage" },
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        paths,
        current: { status: "missing" },
        lastKnownGood: { status: "missing" },
        pending: { status: "missing" },
      };
    }
    const [unboundCurrentCheckpoint, unboundLastKnownGoodCheckpoint, unboundPending] =
      await Promise.all([
        this.inspectJournal(paths.current),
        this.inspectJournal(paths.lastKnownGood),
        this.inspectPending(paths.pending),
      ]);
    const bindJournal = (
      inspection: FileInspection<CreateImagesRunJournalV1>,
    ): FileInspection<CreateImagesRunJournalV1> =>
      inspection.status === "healthy" && inspection.value.runId !== runId
        ? { status: "corrupt" }
        : inspection;
    const currentCheckpoint = bindJournal(unboundCurrentCheckpoint);
    const lastKnownGoodCheckpoint = bindJournal(unboundLastKnownGoodCheckpoint);
    const pending: FileInspection<PendingRunMutationV1> =
      unboundPending.status === "healthy" && unboundPending.value.runId !== runId
        ? { status: "corrupt" }
        : unboundPending;
    const [current, lastKnownGood] = await Promise.all([
      currentCheckpoint.status === "healthy"
        ? this.inspectEventLog(paths.currentEvents, currentCheckpoint.value)
        : currentCheckpoint,
      lastKnownGoodCheckpoint.status === "healthy"
        ? this.inspectEventLog(paths.lastKnownGoodEvents, lastKnownGoodCheckpoint.value)
        : lastKnownGoodCheckpoint,
    ]);
    return { paths, current, lastKnownGood, pending };
  }

  private async writeAtomic(
    target: string,
    value: unknown,
    maxBytes: number,
    canPublish: () => boolean = () => true,
  ): Promise<void> {
    const directory = path.dirname(target);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      throw new Error("Create Images run metadata exceeds its storage limit.");
    }
    const createdDirectory = await this.ensureDirectory(directory);
    const staged = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let publicationError: unknown;
    try {
      try {
        const existing = await fs.lstat(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new Error("Create Images run storage contains an unsafe file.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.writeFile(staged, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const handle = await fs.open(staged, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!canPublish()) throw new Error("The renderer document is no longer active.");
      await fs.rename(staged, target);
      await this.syncDirectory(directory);
    } catch (error) {
      publicationError = error;
    }
    await fs.rm(staged, { force: true }).catch(() => undefined);
    if (createdDirectory) {
      try {
        await fs.rmdir(directory);
        await this.syncDirectory(path.dirname(directory));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          publicationError === undefined &&
          code !== "ENOENT" &&
          code !== "ENOTEMPTY" &&
          code !== "EEXIST"
        ) {
          publicationError = error;
        }
      }
    }
    if (publicationError !== undefined) throw publicationError;
  }

  private async appendEventRecord(
    target: string,
    checkpointTarget: string,
    base: CreateImagesRunJournalV1,
    event: CreateImagesRunEventV1,
    expectedCheckpointIdentity?: RunAuthorityFileIdentity,
    expectedEventLogIdentity?: RunAuthorityFileIdentity,
  ): Promise<RunAuthorityFileIdentity> {
    const directory = path.dirname(target);
    await this.ensureDirectory(directory);
    let previousDigest = initialEventDigest(base);
    let created = false;
    let existingBytes = 0;
    const cachedTail = this.getCachedTail(target);
    const checkpointIdentity = await this.fileAuthorityIdentity(checkpointTarget);
    const eventLogIdentity = await this.fileAuthorityIdentity(target);
    if (checkpointIdentity.kind !== "file" || eventLogIdentity.kind === "other") {
      throw new CreateImagesRunJournalLoadError("unsafe", target);
    }
    if (
      (expectedCheckpointIdentity &&
        !this.sameFileAuthorityIdentity(expectedCheckpointIdentity, checkpointIdentity)) ||
      (expectedEventLogIdentity &&
        !this.sameFileAuthorityIdentity(expectedEventLogIdentity, eventLogIdentity))
    ) {
      throw new CreateImagesRunJournalLoadError("corrupt", target);
    }
    if (eventLogIdentity.kind === "file") {
      existingBytes = Number(eventLogIdentity.size);
      if (
        cachedTail?.bytes === existingBytes &&
        this.sameFileAuthorityIdentity(cachedTail.identity, eventLogIdentity)
      ) {
        previousDigest = cachedTail.digest;
      } else {
        const checkpoint = await this.inspectJournal(checkpointTarget);
        if (checkpoint.status !== "healthy") {
          throw new CreateImagesRunJournalLoadError(
            checkpoint.status === "unsafe" ? "unsafe" : "corrupt",
            checkpointTarget,
          );
        }
        const reconstructed = await this.inspectEventLog(target, checkpoint.value);
        if (reconstructed.status !== "healthy" || !identical(reconstructed.value, base)) {
          throw new CreateImagesRunJournalLoadError("corrupt", target);
        }
        const validatedTail = this.getCachedTail(target);
        if (
          !validatedTail ||
          !this.sameFileAuthorityIdentity(validatedTail.identity, eventLogIdentity)
        ) {
          throw new CreateImagesRunJournalLoadError("corrupt", target);
        }
        previousDigest = validatedTail.digest;
      }
    } else {
      created = true;
    }
    const journalRevision = event.sequence + 1;
    const record: RunEventLogRecordV1 = {
      version: 1,
      runId: base.runId,
      journalRevision,
      previousDigest,
      digest: eventRecordDigest(base.runId, journalRevision, previousDigest, event),
      event,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (existingBytes + serializedBytes > MAX_EVENT_LOG_BYTES) {
      throw new Error("Create Images run metadata exceeds its storage limit.");
    }
    if (
      !this.sameFileAuthorityIdentity(
        checkpointIdentity,
        await this.fileAuthorityIdentity(checkpointTarget),
      ) ||
      !this.sameFileAuthorityIdentity(eventLogIdentity, await this.fileAuthorityIdentity(target))
    ) {
      throw new CreateImagesRunJournalLoadError("corrupt", target);
    }
    const flags = created
      ? constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, flags, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new CreateImagesRunJournalLoadError(
        ["ELOOP", "EFTYPE", "ENXIO"].includes(code ?? "") ? "unsafe" : "corrupt",
        target,
      );
    }
    let finalIdentity: RunAuthorityFileIdentity;
    try {
      const descriptorIdentity = this.authorityIdentityFromStats(
        await handle.stat({ bigint: true }),
      );
      if (
        descriptorIdentity.kind !== "file" ||
        (!created && !this.sameFileAuthorityIdentity(eventLogIdentity, descriptorIdentity))
      ) {
        throw new CreateImagesRunJournalLoadError("corrupt", target);
      }
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      finalIdentity = this.authorityIdentityFromStats(await handle.stat({ bigint: true }));
      if (
        finalIdentity.kind !== "file" ||
        Number(finalIdentity.size) !== existingBytes + serializedBytes
      ) {
        throw new CreateImagesRunJournalLoadError("corrupt", target);
      }
    } finally {
      await handle.close();
    }
    const publishedIdentity = await this.fileAuthorityIdentity(target);
    if (
      !this.sameFileAuthorityIdentity(finalIdentity, publishedIdentity) ||
      !this.sameFileAuthorityIdentity(
        checkpointIdentity,
        await this.fileAuthorityIdentity(checkpointTarget),
      )
    ) {
      throw new CreateImagesRunJournalLoadError(
        publishedIdentity.kind === "other" ? "unsafe" : "corrupt",
        target,
      );
    }
    this.cacheTail(target, {
      bytes: existingBytes + serializedBytes,
      digest: record.digest,
      identity: publishedIdentity,
    });
    if (created) await this.syncDirectory(directory);
    return publishedIdentity;
  }

  private async replaceTornEventLog(
    target: string,
    bytes: Buffer,
    expectedTornIdentity: RunAuthorityFileIdentity,
    tailDigest: string,
  ): Promise<RunAuthorityFileIdentity> {
    if (bytes.length > MAX_EVENT_LOG_BYTES || expectedTornIdentity.kind !== "file") {
      throw new CreateImagesRunJournalLoadError("corrupt", target);
    }
    const directory = path.dirname(target);
    await this.ensureDirectory(directory);
    const staged = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      if (
        !this.sameFileAuthorityIdentity(
          expectedTornIdentity,
          await this.fileAuthorityIdentity(target),
        )
      ) {
        throw new CreateImagesRunJournalLoadError("corrupt", target);
      }
      await fs.writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
      const stagedHandle = await fs.open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await stagedHandle.sync();
      } finally {
        await stagedHandle.close();
      }
      if (
        !this.sameFileAuthorityIdentity(
          expectedTornIdentity,
          await this.fileAuthorityIdentity(target),
        )
      ) {
        throw new CreateImagesRunJournalLoadError("corrupt", target);
      }
      await fs.rename(staged, target);
      await this.syncDirectory(directory);
    } catch (error) {
      await fs.rm(staged, { force: true }).catch(() => undefined);
      throw error;
    }
    const identity = await this.fileAuthorityIdentity(target);
    if (identity.kind !== "file" || Number(identity.size) !== bytes.length) {
      throw new CreateImagesRunJournalLoadError("corrupt", target);
    }
    this.cacheTail(target, { bytes: bytes.length, digest: tailDigest, identity });
    return identity;
  }

  private async replaceCheckpoint(
    checkpointPath: string,
    eventLogPath: string,
    journal: CreateImagesRunJournalV1,
  ): Promise<void> {
    await this.writeAtomic(checkpointPath, journal, CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES);
    await this.removeDurably(eventLogPath);
    this.cacheTail(eventLogPath, {
      bytes: 0,
      digest: initialEventDigest(journal),
      identity: { kind: "missing" },
    });
  }

  private async removeDurably(target: string): Promise<void> {
    try {
      await fs.rm(target);
      await this.syncDirectory(path.dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async boundedEntries(directory: string, maxEntries: number): Promise<Dirent[]> {
    const entries: Dirent[] = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      entries.push(entry);
      if (entries.length > maxEntries) {
        throw new CreateImagesRunJournalLoadError("unsafe", directory);
      }
    }
    return entries;
  }

  private async inventory(force = false): Promise<{
    runIds: string[];
    aggregateBytes: number;
    runBytes: Map<string, number>;
  }> {
    if (!force && this.inventoryCache) return this.inventoryCache;
    const runIds: string[] = [];
    const runBytes = new Map<string, number>();
    let aggregateBytes = 0;
    for (const entry of await this.boundedEntries(this.runsPath(), this.limits.maxRunCount)) {
      const entryPath = path.join(this.runsPath(), entry.name);
      const info = await fs.lstat(entryPath);
      if (
        !RUN_ID_PATTERN.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !info.isDirectory() ||
        info.isSymbolicLink()
      ) {
        throw new CreateImagesRunJournalLoadError("unsafe", entryPath);
      }
      runIds.push(entry.name);
      let bytesForRun = 0;
      let removedStagedFile = false;
      for (const child of await this.boundedEntries(
        entryPath,
        RUN_FILES.size + MAX_STAGED_FILES_PER_RUN,
      )) {
        const childPath = path.join(entryPath, child.name);
        const childInfo = await fs.lstat(childPath);
        if (STAGED_FILE_PATTERN.test(child.name)) {
          if (
            !child.isFile() ||
            child.isSymbolicLink() ||
            !childInfo.isFile() ||
            childInfo.isSymbolicLink()
          ) {
            throw new CreateImagesRunJournalLoadError("unsafe", childPath);
          }
          await fs.rm(childPath);
          removedStagedFile = true;
          continue;
        }
        if (
          !RUN_FILES.has(child.name) ||
          !child.isFile() ||
          child.isSymbolicLink() ||
          !childInfo.isFile() ||
          childInfo.isSymbolicLink()
        ) {
          throw new CreateImagesRunJournalLoadError("unsafe", childPath);
        }
        aggregateBytes += childInfo.size;
        bytesForRun += childInfo.size;
        if (
          !Number.isSafeInteger(aggregateBytes) ||
          aggregateBytes > this.limits.maxAggregateRunBytes
        ) {
          throw new Error("Create Images run storage has reached its aggregate byte limit.");
        }
      }
      runBytes.set(entry.name, bytesForRun);
      if (removedStagedFile) await this.syncDirectory(entryPath);
    }
    this.inventoryCache = { runIds: runIds.sort(), aggregateBytes, runBytes };
    return this.inventoryCache;
  }

  private async refreshInventoryRun(runId: string): Promise<void> {
    if (!this.inventoryCache) return;
    const oldBytes = this.inventoryCache.runBytes.get(runId) ?? 0;
    let nextBytes = 0;
    try {
      for (const child of await this.boundedEntries(
        this.runDirectory(runId),
        RUN_FILES.size + MAX_STAGED_FILES_PER_RUN,
      )) {
        if (!RUN_FILES.has(child.name)) continue;
        const info = await fs.lstat(path.join(this.runDirectory(runId), child.name));
        if (!info.isFile() || info.isSymbolicLink()) {
          this.inventoryCache = undefined;
          return;
        }
        nextBytes += info.size;
      }
    } catch {
      this.inventoryCache = undefined;
      return;
    }
    this.inventoryCache.aggregateBytes += nextBytes - oldBytes;
    this.inventoryCache.runBytes.set(runId, nextBytes);
    if (!this.inventoryCache.runIds.includes(runId)) {
      this.inventoryCache.runIds.push(runId);
      this.inventoryCache.runIds.sort();
    }
  }

  private serializedBytes(value: unknown): number {
    return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private parseIndex(value: unknown): RunIndexV1 | undefined {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !["version", "revision", "entries", "degraded"].includes(key),
      ) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > this.limits.maxRunCount ||
      (value.degraded !== undefined && !Array.isArray(value.degraded))
    ) {
      return undefined;
    }
    const statuses = new Set<CreateImagesRunProjection["status"]>([
      "queued",
      "running",
      "cancel_requested",
      "needs_attention",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    const entries: RunIndexEntryV1[] = [];
    const seen = new Set<string>();
    for (const candidate of value.entries) {
      if (
        !isRecord(candidate) ||
        Object.keys(candidate).some(
          (key) =>
            ![
              "runId",
              "workflowId",
              "workflowRevision",
              "journalRevision",
              "status",
              "createdAt",
              "updatedAt",
              "terminal",
              "unresolvedAmbiguity",
              // Accepted only for migration from the original derived index.
              // References are authoritative in the journals and event logs;
              // retaining them here made a 1,000-run index exceed 16 MiB.
              "assetIds",
              "health",
              "recoveryReason",
              "unsafeReason",
              "canRecover",
              "expectedJournalRevision",
            ].includes(key),
        ) ||
        typeof candidate.runId !== "string" ||
        !RUN_ID_PATTERN.test(candidate.runId) ||
        seen.has(candidate.runId) ||
        typeof candidate.workflowId !== "string" ||
        !RUN_ID_PATTERN.test(candidate.workflowId) ||
        !Number.isSafeInteger(candidate.workflowRevision) ||
        (candidate.workflowRevision as number) < 1 ||
        !Number.isSafeInteger(candidate.journalRevision) ||
        (candidate.journalRevision as number) < 1 ||
        typeof candidate.status !== "string" ||
        !statuses.has(candidate.status as CreateImagesRunProjection["status"]) ||
        typeof candidate.createdAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.createdAt)) ||
        typeof candidate.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.updatedAt)) ||
        typeof candidate.terminal !== "boolean" ||
        (candidate.unresolvedAmbiguity !== undefined &&
          typeof candidate.unresolvedAmbiguity !== "boolean") ||
        (candidate.assetIds !== undefined &&
          (!Array.isArray(candidate.assetIds) ||
            candidate.assetIds.length > 10_000 ||
            candidate.assetIds.some(
              (assetId) => typeof assetId !== "string" || !/^[a-f0-9]{64}$/u.test(assetId),
            ) ||
            new Set(candidate.assetIds).size !== candidate.assetIds.length))
      ) {
        return undefined;
      }
      const health = candidate.health ?? "healthy";
      if (health !== "healthy" && health !== "recovery-required" && health !== "unsafe")
        return undefined;
      if (health === "recovery-required") {
        if (
          ![
            "current-corrupt",
            "current-missing",
            "last-known-good-corrupt",
            "last-known-good-missing",
            "last-known-good-mismatch",
            "pending-corrupt",
            "pending-conflict",
          ].includes(candidate.recoveryReason as string) ||
          !["from-last-known-good", "from-current", false].includes(
            candidate.canRecover as never,
          ) ||
          (candidate.expectedJournalRevision !== undefined &&
            (!Number.isSafeInteger(candidate.expectedJournalRevision) ||
              (candidate.expectedJournalRevision as number) < 1)) ||
          candidate.unsafeReason !== undefined
        ) {
          return undefined;
        }
      } else if (health === "unsafe") {
        if (
          ![
            "current-future-schema",
            "last-known-good-future-schema",
            "pending-future-schema",
            "unsafe-storage",
          ].includes(candidate.unsafeReason as string) ||
          candidate.recoveryReason !== undefined ||
          candidate.canRecover !== undefined ||
          candidate.expectedJournalRevision !== undefined
        ) {
          return undefined;
        }
      } else if (
        candidate.recoveryReason !== undefined ||
        candidate.unsafeReason !== undefined ||
        candidate.canRecover !== undefined ||
        candidate.expectedJournalRevision !== undefined
      ) {
        return undefined;
      }
      seen.add(candidate.runId);
      const { assetIds: _legacyAssetIds, ...metadata } = candidate;
      entries.push({
        ...(metadata as unknown as RunIndexEntryV1),
        health,
        unresolvedAmbiguity: candidate.unresolvedAmbiguity ?? false,
      });
    }
    const degraded: RunUnassociatedDegradedEntryV1[] = [];
    const degradedValues = (value.degraded ?? []) as unknown[];
    if (degradedValues.length + entries.length > this.limits.maxRunCount) return undefined;
    for (const candidate of degradedValues) {
      if (
        !isRecord(candidate) ||
        Object.keys(candidate).some(
          (key) =>
            !["runId", "status", "recoveryReason", "unsafeReason", "canRecover"].includes(key),
        ) ||
        typeof candidate.runId !== "string" ||
        !RUN_ID_PATTERN.test(candidate.runId) ||
        seen.has(candidate.runId) ||
        candidate.canRecover !== false
      ) {
        return undefined;
      }
      if (
        candidate.status === "recovery-required" &&
        [
          "current-corrupt",
          "current-missing",
          "last-known-good-corrupt",
          "last-known-good-missing",
          "last-known-good-mismatch",
          "pending-corrupt",
          "pending-conflict",
        ].includes(candidate.recoveryReason as string) &&
        candidate.unsafeReason === undefined
      ) {
        degraded.push(candidate as unknown as RunUnassociatedDegradedEntryV1);
      } else if (
        candidate.status === "unsafe" &&
        [
          "current-future-schema",
          "last-known-good-future-schema",
          "pending-future-schema",
          "unsafe-storage",
        ].includes(candidate.unsafeReason as string) &&
        candidate.recoveryReason === undefined
      ) {
        degraded.push(candidate as unknown as RunUnassociatedDegradedEntryV1);
      } else {
        return undefined;
      }
      seen.add(candidate.runId);
    }
    return {
      version: 1,
      revision: value.revision as number,
      entries,
      degraded,
    };
  }

  private async quarantineCorruptIndex(): Promise<void> {
    const existing = await this.quarantinedIndexCount();
    if (existing >= MAX_INDEX_QUARANTINES) {
      throw new CreateImagesRunJournalLoadError("corrupt", this.indexPath());
    }
    const quarantine = path.join(this.root(), `run-index.corrupt.${randomUUID()}.json`);
    await fs.rename(this.indexPath(), quarantine);
    await this.syncDirectory(this.root());
    this.indexDiagnostic = "rebuilt-corrupt-index";
    this.clearIndexCache();
  }

  private async quarantinedIndexCount(): Promise<number> {
    let count = 0;
    const handle = await fs.opendir(this.root());
    for await (const entry of handle) {
      if (!INDEX_QUARANTINE_PATTERN.test(entry.name)) continue;
      const info = await fs.lstat(path.join(this.root(), entry.name));
      if (!entry.isFile() || entry.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()) {
        throw new CreateImagesRunJournalLoadError("unsafe", this.root());
      }
      count += 1;
      if (count > MAX_INDEX_QUARANTINES) {
        throw new CreateImagesRunJournalLoadError("corrupt", this.root());
      }
    }
    return count;
  }

  private async loadIndex(recoverCorrupt = false): Promise<RunIndexV1 | undefined> {
    if (this.indexCache) {
      const identity = await this.fileAuthorityIdentity(this.indexPath());
      if (this.sameFileAuthorityIdentity(this.indexAuthorityCache, identity)) {
        return this.indexCache;
      }
      this.clearIndexCache();
    }
    const identityBeforeRead = await this.fileAuthorityIdentity(this.indexPath());
    const raw = await this.readJson(this.indexPath(), CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES);
    const identityAfterRead = await this.fileAuthorityIdentity(this.indexPath());
    if (!this.sameFileAuthorityIdentity(identityBeforeRead, identityAfterRead)) {
      this.clearIndexCache();
      throw new CreateImagesRunJournalLoadError("unsafe", this.indexPath());
    }
    if (raw.status === "missing") return undefined;
    if (raw.status === "unsafe") {
      throw new CreateImagesRunJournalLoadError("unsafe", this.indexPath());
    }
    if (raw.status !== "healthy") {
      if (recoverCorrupt && raw.status === "corrupt") {
        await this.quarantineCorruptIndex();
        return undefined;
      }
      throw new CreateImagesRunJournalLoadError("corrupt", this.indexPath());
    }
    if (futureVersion(raw.value, "version")) {
      throw new CreateImagesRunJournalLoadError("unsafe", this.indexPath());
    }
    const index = this.parseIndex(raw.value);
    if (!index && recoverCorrupt) {
      await this.quarantineCorruptIndex();
      return undefined;
    }
    if (!index) throw new CreateImagesRunJournalLoadError("corrupt", this.indexPath());
    if (identityAfterRead.kind !== "file") {
      throw new CreateImagesRunJournalLoadError("unsafe", this.indexPath());
    }
    this.indexCache = index;
    this.indexAuthorityCache = identityAfterRead;
    return index;
  }

  private entryFor(journal: CreateImagesRunJournalV1): RunIndexEntryV1 {
    const projection = projectCreateImagesRun(journal);
    return {
      runId: journal.runId,
      workflowId: journal.workflowId,
      workflowRevision: journal.workflowRevision,
      journalRevision: journal.journalRevision,
      status: projection.status,
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
      terminal: projection.terminal !== undefined,
      unresolvedAmbiguity: hasUnresolvedCreateImagesRunAmbiguity(projection),
      health: "healthy",
    };
  }

  private entryForState(
    runId: string,
    state: Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>>,
    prior?: RunIndexEntryV1,
  ): RunIndexEntryV1 | undefined {
    const health = this.healthOf(runId, state);
    if (health.status === "healthy" && state.current.status === "healthy") {
      return this.entryFor(state.current.value);
    }
    const authority =
      state.current.status === "healthy"
        ? state.current.value
        : state.lastKnownGood.status === "healthy"
          ? state.lastKnownGood.value
          : undefined;
    const base = authority ? this.entryFor(authority) : prior;
    if (!base) return undefined;
    const {
      recoveryReason: _recoveryReason,
      unsafeReason: _unsafeReason,
      canRecover: _canRecover,
      expectedJournalRevision: _expectedJournalRevision,
      ...cleanBase
    } = base;
    if (health.status === "unsafe") {
      return {
        ...cleanBase,
        health: "unsafe",
        unsafeReason: health.reason,
      };
    }
    if (health.status !== "recovery-required") return undefined;
    return {
      ...cleanBase,
      health: "recovery-required",
      recoveryReason: health.reason,
      canRecover: health.canRecover,
      ...(health.canRecover === "from-last-known-good" &&
      health.lastKnownGoodJournalRevision !== undefined
        ? { expectedJournalRevision: health.lastKnownGoodJournalRevision }
        : health.canRecover === "from-current" && health.currentJournalRevision !== undefined
          ? { expectedJournalRevision: health.currentJournalRevision }
          : {}),
    };
  }

  private unassociatedDegradedForState(
    runId: string,
    state: Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>>,
  ): RunUnassociatedDegradedEntryV1 | undefined {
    const health = this.healthOf(runId, state);
    if (health.status === "unsafe") {
      return {
        runId,
        status: "unsafe",
        unsafeReason: health.reason,
        canRecover: false,
      };
    }
    if (health.status === "recovery-required") {
      return {
        runId,
        status: "recovery-required",
        recoveryReason: health.reason,
        canRecover: false,
      };
    }
    return undefined;
  }

  private async publishIndex(
    entries: RunIndexEntryV1[],
    revision?: number,
    degraded: RunUnassociatedDegradedEntryV1[] = this.indexCache?.degraded ?? [],
  ): Promise<void> {
    const current = this.indexCache;
    const next: RunIndexV1 = {
      version: 1,
      revision: revision ?? (current?.revision ?? 0) + 1,
      entries: [...entries].sort((left, right) => left.runId.localeCompare(right.runId)),
      degraded: [...degraded].sort((left, right) => left.runId.localeCompare(right.runId)),
    };
    await this.durability.beforeIndexPublished?.(next.revision);
    await this.writeAtomic(this.indexPath(), next, CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES);
    await this.bindIndexCache(next);
    this.indexDirty = false;
  }

  private markIndexDirty(): void {
    this.indexDirty = true;
    this.clearIndexCache();
  }

  private async updateIndexEntry(journal: CreateImagesRunJournalV1): Promise<void> {
    const index = await this.indexed();
    const entries = index.entries.filter((entry) => entry.runId !== journal.runId);
    entries.push(this.entryFor(journal));
    await this.publishIndex(
      entries,
      index.revision + 1,
      index.degraded.filter((entry) => entry.runId !== journal.runId),
    );
  }

  private async updateIndexState(
    runId: string,
    state: Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>>,
  ): Promise<void> {
    const index = await this.indexed();
    const prior = index.entries.find((candidate) => candidate.runId === runId);
    const entry = this.entryForState(runId, state, prior);
    const entries = index.entries.filter((candidate) => candidate.runId !== runId);
    if (entry) entries.push(entry);
    const degraded = index.degraded.filter((candidate) => candidate.runId !== runId);
    if (!entry) {
      const unassociated = this.unassociatedDegradedForState(runId, state);
      if (unassociated) degraded.push(unassociated);
    }
    const sorted = entries.sort((left, right) => left.runId.localeCompare(right.runId));
    degraded.sort((left, right) => left.runId.localeCompare(right.runId));
    if (
      JSON.stringify(sorted) !== JSON.stringify(index.entries) ||
      JSON.stringify(degraded) !== JSON.stringify(index.degraded)
    ) {
      await this.publishIndex(sorted, index.revision + 1, degraded);
    }
  }

  private async enrichDegradedHealth(
    health: CreateImagesRunJournalHealth,
  ): Promise<CreateImagesRunJournalHealth> {
    if (
      (health.status !== "recovery-required" && health.status !== "unsafe") ||
      health.workflowId !== undefined
    ) {
      return health;
    }
    const prior = (await this.indexed()).entries.find((entry) => entry.runId === health.runId);
    return prior
      ? {
          ...health,
          workflowId: prior.workflowId,
          workflowRevision: prior.workflowRevision,
        }
      : health;
  }

  private async rebuildIndex(runIds: readonly string[], prior?: RunIndexV1): Promise<void> {
    const entries: RunIndexEntryV1[] = [];
    const degraded: RunUnassociatedDegradedEntryV1[] = [];
    const priorEntries = new Map(prior?.entries.map((entry) => [entry.runId, entry]) ?? []);
    for (const runId of runIds) {
      const state = await this.inspected(runId);
      const entry = this.entryForState(runId, state, priorEntries.get(runId));
      if (entry) entries.push(entry);
      else {
        const unassociated = this.unassociatedDegradedForState(runId, state);
        if (unassociated) degraded.push(unassociated);
      }
    }
    await this.publishIndex(entries, undefined, degraded);
  }

  private async indexed(): Promise<RunIndexV1> {
    if (this.indexDirty) {
      const prior = await this.loadIndex(true);
      const { runIds } = await this.inventory(true);
      await this.rebuildIndex(runIds, prior);
      return this.indexCache as RunIndexV1;
    }
    const existing = await this.loadIndex();
    if (existing) return existing;
    const { runIds } = await this.inventory();
    await this.rebuildIndex(runIds);
    return this.indexCache as RunIndexV1;
  }

  private pruneToken(
    candidates: readonly CreateImagesTerminalPruneCandidate[],
    assetIds: readonly string[],
  ): string {
    return createHash("sha256")
      .update(JSON.stringify({ version: 1, candidates, assetIds }), "utf8")
      .digest("hex");
  }

  private discardToken(
    plan: Omit<CreateImagesDegradedRunDiscardPlan, "authorizationToken">,
  ): string {
    return createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex");
  }

  private async degradedRecordFingerprint(runId: string): Promise<string> {
    const directory = this.runDirectory(runId);
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new CreateImagesRunJournalLoadError("unsafe", directory);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_DISCARD_DIRECTORY_ENTRIES) {
      throw new CreateImagesRunJournalLoadError("unsafe", directory);
    }
    const digest = createHash("sha256");
    let totalBytes = 0;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const info = await fs.lstat(target, { bigint: true });
      digest.update(
        JSON.stringify({
          name: entry.name,
          mode: info.mode.toString(),
          size: info.size.toString(),
          mtimeNs: info.mtimeNs.toString(),
          ctimeNs: info.ctimeNs.toString(),
          type: entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : entry.isDirectory()
                ? "directory"
                : "other",
        }),
        "utf8",
      );
      if (entry.isFile() && !entry.isSymbolicLink()) {
        const size = Number(info.size);
        if (!Number.isSafeInteger(size) || size > MAX_PENDING_BYTES) {
          throw new CreateImagesRunJournalLoadError("unsafe", target);
        }
        totalBytes += size;
        if (totalBytes > MAX_DISCARD_FINGERPRINT_BYTES) {
          throw new CreateImagesRunJournalLoadError("unsafe", directory);
        }
        digest.update(await readRegularFile(target, MAX_PENDING_BYTES));
      } else if (entry.isSymbolicLink()) {
        digest.update(await fs.readlink(target), "utf8");
      }
    }
    return digest.digest("hex");
  }

  private parseDiscardManifest(value: unknown): DegradedRunDiscardManifestV1 | undefined {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "runId",
            "reason",
            "association",
            "workflowId",
            "expectedCurrentJournalRevision",
            "expectedLastKnownGoodJournalRevision",
            "authorizationToken",
            "recordFingerprint",
            "createdAt",
          ].includes(key),
      ) ||
      value.version !== 1 ||
      typeof value.runId !== "string" ||
      !RUN_ID_PATTERN.test(value.runId) ||
      typeof value.reason !== "string" ||
      ![
        "current-corrupt",
        "current-missing",
        "last-known-good-corrupt",
        "last-known-good-missing",
        "last-known-good-mismatch",
        "pending-corrupt",
        "pending-conflict",
        "current-future-schema",
        "last-known-good-future-schema",
        "pending-future-schema",
        "unsafe-storage",
      ].includes(value.reason) ||
      (value.association !== "workflow" && value.association !== "unassociated") ||
      (value.association === "workflow"
        ? typeof value.workflowId !== "string" || !RUN_ID_PATTERN.test(value.workflowId)
        : value.workflowId !== undefined) ||
      typeof value.recordFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.recordFingerprint) ||
      typeof value.authorizationToken !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.authorizationToken) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return undefined;
    }
    for (const revision of [
      value.expectedCurrentJournalRevision,
      value.expectedLastKnownGoodJournalRevision,
    ]) {
      if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 1)) {
        return undefined;
      }
    }
    const withoutToken: Omit<CreateImagesDegradedRunDiscardPlan, "authorizationToken"> = {
      version: 1,
      runId: value.runId,
      reason: value.reason as CreateImagesRunRecoveryReason | CreateImagesRunUnsafeReason,
      association: value.association,
      ...(value.workflowId === undefined ? {} : { workflowId: value.workflowId as string }),
      ...(value.expectedCurrentJournalRevision === undefined
        ? {}
        : {
            expectedCurrentJournalRevision: value.expectedCurrentJournalRevision as number,
          }),
      ...(value.expectedLastKnownGoodJournalRevision === undefined
        ? {}
        : {
            expectedLastKnownGoodJournalRevision:
              value.expectedLastKnownGoodJournalRevision as number,
          }),
      recordFingerprint: value.recordFingerprint,
    };
    if (this.discardToken(withoutToken) !== value.authorizationToken) return undefined;
    return {
      ...withoutToken,
      authorizationToken: value.authorizationToken,
      createdAt: value.createdAt,
    };
  }

  private async inspectDiscardManifest(): Promise<FileInspection<DegradedRunDiscardManifestV1>> {
    const raw = await this.readJson(this.discardPendingPath(), 64 * 1024);
    if (raw.status !== "healthy") return raw;
    if (futureVersion(raw.value, "version")) {
      return { status: "unsafe", reason: "future-schema" };
    }
    const manifest = this.parseDiscardManifest(raw.value);
    return manifest ? { status: "healthy", value: manifest } : { status: "corrupt" };
  }

  private parsePruneManifest(value: unknown): TerminalPruneManifestV1 | undefined {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !["version", "candidates", "token", "assetIds", "createdAt"].includes(key),
      ) ||
      value.version !== 1 ||
      !Array.isArray(value.candidates) ||
      value.candidates.length < 1 ||
      value.candidates.length > MAX_PRUNE_BATCH_SIZE ||
      !Array.isArray(value.assetIds) ||
      value.assetIds.length > 10_000 ||
      value.assetIds.some(
        (assetId) => typeof assetId !== "string" || !/^[a-f0-9]{64}$/u.test(assetId),
      ) ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.token) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return undefined;
    }
    const candidates: CreateImagesTerminalPruneCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of value.candidates) {
      if (
        !isRecord(candidate) ||
        Object.keys(candidate).some((key) => !["runId", "journalRevision"].includes(key)) ||
        typeof candidate.runId !== "string" ||
        !RUN_ID_PATTERN.test(candidate.runId) ||
        seen.has(candidate.runId) ||
        !Number.isSafeInteger(candidate.journalRevision) ||
        (candidate.journalRevision as number) < 1
      ) {
        return undefined;
      }
      seen.add(candidate.runId);
      candidates.push({
        runId: candidate.runId,
        journalRevision: candidate.journalRevision as number,
      });
    }
    const assetIds = [...(value.assetIds as string[])];
    if (
      new Set(assetIds).size !== assetIds.length ||
      value.token !== this.pruneToken(candidates, assetIds)
    ) {
      return undefined;
    }
    return {
      version: 1,
      candidates,
      token: value.token,
      assetIds,
      createdAt: value.createdAt,
    };
  }

  private async inspectPruneManifest(): Promise<FileInspection<TerminalPruneManifestV1>> {
    const raw = await this.readJson(this.prunePendingPath(), 1024 * 1024);
    if (raw.status !== "healthy") return raw;
    if (futureVersion(raw.value, "version")) {
      return { status: "unsafe", reason: "future-schema" };
    }
    const manifest = this.parsePruneManifest(raw.value);
    return manifest ? { status: "healthy", value: manifest } : { status: "corrupt" };
  }

  private async ensurePruneTombstones(): Promise<void> {
    if (!this.pruneStateLoaded) {
      const state = await this.inspectPruneManifest();
      if (state.status === "unsafe" || state.status === "corrupt") {
        throw new CreateImagesRunJournalLoadError(
          state.status === "unsafe" ? "unsafe" : "corrupt",
          this.prunePendingPath(),
        );
      }
      if (state.status === "healthy") {
        for (const candidate of state.value.candidates) {
          this.pruneTombstones.add(candidate.runId);
          this.evictRunCaches(candidate.runId);
        }
      }
      this.pruneStateLoaded = true;
    }
    if (!this.discardStateLoaded) {
      const discard = await this.inspectDiscardManifest();
      if (discard.status === "unsafe" || discard.status === "corrupt") {
        throw new CreateImagesRunJournalLoadError(
          discard.status === "unsafe" ? "unsafe" : "corrupt",
          this.discardPendingPath(),
        );
      }
      if (discard.status === "healthy") {
        this.pruneTombstones.add(discard.value.runId);
        this.evictRunCaches(discard.value.runId);
      }
      this.discardStateLoaded = true;
    }
  }

  private async buildDegradedRunDiscardPlan(
    runId: string,
  ): Promise<CreateImagesDegradedRunDiscardPlanResult> {
    const index = await this.indexed();
    const state = await this.inspected(runId);
    const health = this.healthOf(runId, state);
    if (health.status === "missing") return { status: "not-found" };
    if (health.status === "healthy") return { status: "not-degraded" };
    if (health.status === "recovery-required" && health.canRecover !== false) {
      return { status: "recoverable" };
    }
    const prior = index.entries.find((entry) => entry.runId === runId);
    const workflowId =
      "workflowId" in health && typeof health.workflowId === "string"
        ? health.workflowId
        : prior?.workflowId;
    const withoutToken: Omit<CreateImagesDegradedRunDiscardPlan, "authorizationToken"> = {
      version: 1,
      runId,
      reason: health.reason,
      association: workflowId ? "workflow" : "unassociated",
      ...(workflowId ? { workflowId } : {}),
      ...(state.current.status === "healthy"
        ? {
            expectedCurrentJournalRevision: state.current.value.journalRevision,
          }
        : {}),
      ...(state.lastKnownGood.status === "healthy"
        ? {
            expectedLastKnownGoodJournalRevision: state.lastKnownGood.value.journalRevision,
          }
        : {}),
      recordFingerprint: await this.degradedRecordFingerprint(runId),
    };
    return {
      status: "ready",
      plan: {
        ...withoutToken,
        authorizationToken: this.discardToken(withoutToken),
      },
    };
  }

  private async assertWithinLimits(
    runId: string,
    replacements: ReadonlyMap<string, unknown | undefined>,
    additionalBytes = 0,
  ): Promise<void> {
    const inventory = await this.inventory();
    const isNew = !inventory.runIds.includes(runId);
    if (inventory.runIds.length + (isNew ? 1 : 0) > this.limits.maxRunCount) {
      throw new Error("Create Images run storage has reached its run count limit.");
    }
    let projected = inventory.aggregateBytes;
    for (const [target, replacement] of replacements) {
      try {
        const existing = await fs.lstat(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new CreateImagesRunJournalLoadError("unsafe", target);
        }
        projected -= existing.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (replacement !== undefined) projected += this.serializedBytes(replacement);
    }
    projected += additionalBytes;
    if (!Number.isSafeInteger(projected) || projected > this.limits.maxAggregateRunBytes) {
      throw new Error("Create Images run storage has reached its aggregate byte limit.");
    }
  }

  private healthOf(
    runId: string,
    state: Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>>,
  ): CreateImagesRunJournalHealth {
    const identity =
      state.current.status === "healthy"
        ? {
            workflowId: state.current.value.workflowId,
            workflowRevision: state.current.value.workflowRevision,
          }
        : state.lastKnownGood.status === "healthy"
          ? {
              workflowId: state.lastKnownGood.value.workflowId,
              workflowRevision: state.lastKnownGood.value.workflowRevision,
            }
          : {};
    if (
      state.current.status === "unsafe" ||
      state.lastKnownGood.status === "unsafe" ||
      state.pending.status === "unsafe"
    ) {
      return {
        status: "unsafe",
        runId,
        ...identity,
        reason:
          (state.current.status === "unsafe" && state.current.reason === "unsafe-storage") ||
          (state.lastKnownGood.status === "unsafe" &&
            state.lastKnownGood.reason === "unsafe-storage") ||
          (state.pending.status === "unsafe" && state.pending.reason === "unsafe-storage")
            ? "unsafe-storage"
            : state.current.status === "unsafe"
              ? "current-future-schema"
              : state.lastKnownGood.status === "unsafe"
                ? "last-known-good-future-schema"
                : "pending-future-schema",
      };
    }
    if (
      state.current.status === "missing" &&
      state.lastKnownGood.status === "missing" &&
      state.pending.status === "missing"
    ) {
      return { status: "missing", runId };
    }
    const revisions = {
      ...(state.current.status === "healthy"
        ? { currentJournalRevision: state.current.value.journalRevision }
        : {}),
      ...(state.lastKnownGood.status === "healthy"
        ? {
            lastKnownGoodJournalRevision: state.lastKnownGood.value.journalRevision,
          }
        : {}),
    };
    if (state.pending.status === "corrupt") {
      return {
        status: "recovery-required",
        runId,
        reason: "pending-corrupt",
        canRecover: false,
        ...identity,
        ...revisions,
      };
    }
    if (state.pending.status === "healthy") {
      return {
        status: "recovery-required",
        runId,
        reason: "pending-conflict",
        canRecover: false,
        ...identity,
        ...revisions,
      };
    }
    if (state.current.status !== "healthy") {
      return {
        status: "recovery-required",
        runId,
        reason: state.current.status === "missing" ? "current-missing" : "current-corrupt",
        canRecover: state.lastKnownGood.status === "healthy" ? "from-last-known-good" : false,
        ...identity,
        ...revisions,
      };
    }
    if (state.lastKnownGood.status !== "healthy") {
      return {
        status: "recovery-required",
        runId,
        reason:
          state.lastKnownGood.status === "missing"
            ? "last-known-good-missing"
            : "last-known-good-corrupt",
        canRecover: state.current.status === "healthy" ? "from-current" : false,
        ...identity,
        ...revisions,
      };
    }
    if (!identical(state.current.value, state.lastKnownGood.value)) {
      return {
        status: "recovery-required",
        runId,
        reason: "last-known-good-mismatch",
        canRecover: false,
        ...identity,
        ...revisions,
      };
    }
    return {
      status: "healthy",
      runId,
      journalRevision: state.current.value.journalRevision,
      runStatus: projectCreateImagesRun(state.current.value).status,
    };
  }

  private plausibleTornAppendIdentity(
    original: RunAuthorityFileIdentity,
    current: RunAuthorityFileIdentity,
  ): boolean {
    if (current.kind !== "file") return false;
    if (original.kind === "missing") return BigInt(current.size) > 0n;
    return (
      original.kind === "file" &&
      original.device === current.device &&
      original.inode === current.inode &&
      BigInt(current.size) > BigInt(original.size)
    );
  }

  private async recoverTornEventAppend(
    checkpointTarget: string,
    eventLogTarget: string,
    originalCheckpointIdentity: RunAuthorityFileIdentity,
    originalEventLogIdentity: RunAuthorityFileIdentity,
    pending: PendingRunAppendMutationV1,
  ): Promise<boolean> {
    const checkpointIdentity = await this.fileAuthorityIdentity(checkpointTarget);
    const tornIdentity = await this.fileAuthorityIdentity(eventLogTarget);
    if (
      !this.sameFileAuthorityIdentity(originalCheckpointIdentity, checkpointIdentity) ||
      !this.plausibleTornAppendIdentity(originalEventLogIdentity, tornIdentity)
    ) {
      return false;
    }
    if (tornIdentity.kind !== "file") return false;
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(eventLogTarget, MAX_EVENT_LOG_BYTES);
    } catch {
      return false;
    }
    if (
      !this.sameFileAuthorityIdentity(
        tornIdentity,
        await this.fileAuthorityIdentity(eventLogTarget),
      ) ||
      bytes.length !== Number(tornIdentity.size)
    ) {
      return false;
    }
    const originalBytes =
      originalEventLogIdentity.kind === "file" ? Number(originalEventLogIdentity.size) : 0;
    if (originalBytes < 0 || originalBytes >= bytes.length) return false;
    const checkpoint = await this.inspectJournal(checkpointTarget);
    if (
      checkpoint.status !== "healthy" ||
      checkpoint.value.journalRevision > pending.baseJournalRevision ||
      !this.sameFileAuthorityIdentity(
        originalCheckpointIdentity,
        await this.fileAuthorityIdentity(checkpointTarget),
      )
    ) {
      return false;
    }
    const prefix = bytes.subarray(0, originalBytes);
    const parsedPrefix = this.parseEventLogBytes(prefix, checkpoint.value);
    if (
      parsedPrefix.inspection.status !== "healthy" ||
      !parsedPrefix.tailDigest ||
      parsedPrefix.inspection.value.journalRevision !== pending.baseJournalRevision
    ) {
      return false;
    }
    let next: CreateImagesRunJournalV1;
    try {
      next = appendCreateImagesRunEvent(parsedPrefix.inspection.value, pending.event);
    } catch {
      return false;
    }
    if (journalDigest(next) !== pending.targetJournalDigest) return false;
    const expected = serializedEventRecord(
      parsedPrefix.inspection.value,
      pending.event,
      parsedPrefix.tailDigest,
    );
    const suffix = bytes.subarray(originalBytes);
    if (
      suffix.length === 0 ||
      suffix.length >= expected.bytes.length ||
      !suffix.equals(expected.bytes.subarray(0, suffix.length))
    ) {
      return false;
    }
    await this.replaceTornEventLog(
      eventLogTarget,
      Buffer.concat([prefix, expected.bytes]),
      tornIdentity,
      expected.record.digest,
    );
    return true;
  }

  private async finishPending(
    state: Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>>,
    invokeCrashSeams: boolean,
    observedAuthority?: RunAuthorityIdentity,
  ): Promise<boolean> {
    if (state.pending.status !== "healthy") return false;
    const pending = state.pending.value;
    if (pending.kind === "append") {
      let authorityAtFinish = await this.runAuthorityIdentity(pending.runId);
      if (
        observedAuthority &&
        !this.sameRunAuthorityIdentity(observedAuthority, authorityAtFinish)
      ) {
        return false;
      }
      const eventMatches = (journal: CreateImagesRunJournalV1): boolean =>
        JSON.stringify(journal.events[journal.events.length - 1]) === JSON.stringify(pending.event);
      const targetMatches = (journal: CreateImagesRunJournalV1): boolean =>
        journal.journalRevision === pending.targetJournalRevision &&
        eventMatches(journal) &&
        journalDigest(journal) === pending.targetJournalDigest;
      const refreshAfterRepair = async (): Promise<boolean> => {
        const authorityBeforeInspection = await this.runAuthorityIdentity(pending.runId);
        const repairedState = await this.inspected(pending.runId);
        const authorityAfterInspection = await this.runAuthorityIdentity(pending.runId);
        if (!this.sameRunAuthorityIdentity(authorityBeforeInspection, authorityAfterInspection)) {
          return false;
        }
        state = repairedState;
        authorityAtFinish = authorityAfterInspection;
        return true;
      };
      const currentCanRecoverFromTornAppend =
        state.current.status === "corrupt" &&
        state.lastKnownGood.status === "healthy" &&
        state.lastKnownGood.value.journalRevision === pending.baseJournalRevision &&
        this.sameFileAuthorityIdentity(
          pending.authority.lastKnownGood,
          authorityAtFinish.lastKnownGood,
        ) &&
        this.sameFileAuthorityIdentity(
          pending.authority.lastKnownGoodEvents,
          authorityAtFinish.lastKnownGoodEvents,
        );
      if (currentCanRecoverFromTornAppend) {
        const recovered = await this.recoverTornEventAppend(
          state.paths.current,
          state.paths.currentEvents,
          pending.authority.current,
          pending.authority.currentEvents,
          pending,
        );
        if (recovered && !(await refreshAfterRepair())) return false;
      }
      const lastKnownGoodCanRecoverFromTornAppend =
        state.lastKnownGood.status === "corrupt" &&
        state.current.status === "healthy" &&
        targetMatches(state.current.value) &&
        this.sameFileAuthorityIdentity(pending.authority.current, authorityAtFinish.current);
      if (lastKnownGoodCanRecoverFromTornAppend) {
        const recovered = await this.recoverTornEventAppend(
          state.paths.lastKnownGood,
          state.paths.lastKnownGoodEvents,
          pending.authority.lastKnownGood,
          pending.authority.lastKnownGoodEvents,
          pending,
        );
        if (recovered && !(await refreshAfterRepair())) return false;
      }
      const currentIsBase =
        state.current.status === "healthy" &&
        state.current.value.journalRevision === pending.baseJournalRevision;
      const currentIsTarget =
        state.current.status === "healthy" && targetMatches(state.current.value);
      const lastKnownGoodIsBase =
        state.lastKnownGood.status === "healthy" &&
        state.lastKnownGood.value.journalRevision === pending.baseJournalRevision;
      const lastKnownGoodIsTarget =
        state.lastKnownGood.status === "healthy" && targetMatches(state.lastKnownGood.value);
      const original = pending.authority;
      const checkpointsUnchanged =
        this.sameFileAuthorityIdentity(original.current, authorityAtFinish.current) &&
        this.sameFileAuthorityIdentity(original.lastKnownGood, authorityAtFinish.lastKnownGood);
      const currentBaseLogUnchanged = this.sameFileAuthorityIdentity(
        original.currentEvents,
        authorityAtFinish.currentEvents,
      );
      const lastKnownGoodBaseLogUnchanged = this.sameFileAuthorityIdentity(
        original.lastKnownGoodEvents,
        authorityAtFinish.lastKnownGoodEvents,
      );
      if (
        !checkpointsUnchanged ||
        (currentIsBase && !currentBaseLogUnchanged) ||
        (lastKnownGoodIsBase && !lastKnownGoodBaseLogUnchanged) ||
        (!currentIsBase && !currentIsTarget) ||
        (!lastKnownGoodIsBase && !lastKnownGoodIsTarget) ||
        (currentIsBase && lastKnownGoodIsTarget)
      ) {
        return false;
      }
      let expectedAuthority = authorityAtFinish;
      let next: CreateImagesRunJournalV1;
      if (
        state.current.status === "healthy" &&
        state.current.value.journalRevision === pending.targetJournalRevision
      ) {
        if (!targetMatches(state.current.value)) {
          return false;
        }
        next = state.current.value;
      } else {
        const base =
          state.current.status === "healthy" &&
          state.current.value.journalRevision === pending.baseJournalRevision
            ? state.current.value
            : state.lastKnownGood.status === "healthy" &&
                state.lastKnownGood.value.journalRevision === pending.baseJournalRevision
              ? state.lastKnownGood.value
              : undefined;
        if (!base) return false;
        try {
          next = appendCreateImagesRunEvent(base, pending.event);
        } catch {
          return false;
        }
        if (state.current.status !== "healthy") {
          return false;
        } else {
          const currentEvents = await this.appendEventRecord(
            state.paths.currentEvents,
            state.paths.current,
            state.current.value,
            pending.event,
            expectedAuthority.current,
            expectedAuthority.currentEvents,
          );
          expectedAuthority = { ...expectedAuthority, currentEvents };
        }
        if (invokeCrashSeams) await this.durability.afterCurrentPublished?.(pending.runId);
      }
      if (
        state.lastKnownGood.status === "healthy" &&
        state.lastKnownGood.value.journalRevision === pending.targetJournalRevision
      ) {
        if (!identical(state.lastKnownGood.value, next)) return false;
      } else if (
        state.lastKnownGood.status === "healthy" &&
        state.lastKnownGood.value.journalRevision === pending.baseJournalRevision
      ) {
        if (
          !this.sameRunAuthorityIdentity(
            expectedAuthority,
            await this.runAuthorityIdentity(pending.runId),
          )
        ) {
          return false;
        }
        const lastKnownGoodEvents = await this.appendEventRecord(
          state.paths.lastKnownGoodEvents,
          state.paths.lastKnownGood,
          state.lastKnownGood.value,
          pending.event,
          expectedAuthority.lastKnownGood,
          expectedAuthority.lastKnownGoodEvents,
        );
        expectedAuthority = { ...expectedAuthority, lastKnownGoodEvents };
      } else if (
        state.lastKnownGood.status !== "unsafe" &&
        state.current.status === "healthy" &&
        state.current.value.journalRevision === pending.targetJournalRevision
      ) {
        return false;
      } else {
        return false;
      }
      if (invokeCrashSeams) await this.durability.afterLastKnownGoodPublished?.(pending.runId);
      if (
        !this.sameRunAuthorityIdentity(
          expectedAuthority,
          await this.runAuthorityIdentity(pending.runId),
        )
      ) {
        return false;
      }
      await this.removeDurably(state.paths.pending);
      return true;
    }
    if (state.current.status === "unsafe" || state.current.status === "corrupt") return false;
    if (state.lastKnownGood.status === "unsafe" || state.lastKnownGood.status === "corrupt")
      return false;
    if (state.current.status === "missing") {
      if (pending.baseJournalRevision !== null) return false;
      await this.writeAtomic(
        state.paths.current,
        pending.next,
        CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES,
      );
      await this.removeDurably(state.paths.currentEvents);
      if (invokeCrashSeams) await this.durability.afterCurrentPublished?.(pending.runId);
    } else if (state.current.value.journalRevision === pending.targetJournalRevision) {
      if (!identical(state.current.value, pending.next)) return false;
    } else if (
      pending.baseJournalRevision !== null &&
      state.current.value.journalRevision === pending.baseJournalRevision
    ) {
      await this.writeAtomic(
        state.paths.current,
        pending.next,
        CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES,
      );
      await this.removeDurably(state.paths.currentEvents);
      if (invokeCrashSeams) await this.durability.afterCurrentPublished?.(pending.runId);
    } else {
      return false;
    }
    await this.writeAtomic(
      state.paths.lastKnownGood,
      pending.next,
      CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES,
    );
    await this.removeDurably(state.paths.lastKnownGoodEvents);
    if (invokeCrashSeams) await this.durability.afterLastKnownGoodPublished?.(pending.runId);
    await this.removeDurably(state.paths.pending);
    return true;
  }

  private async reconcile(runId: string): Promise<void> {
    await this.ensurePruneTombstones();
    if (this.pruneTombstones.has(runId)) {
      this.evictRunCaches(runId);
      return;
    }
    if (this.getCachedJournal(runId)) {
      try {
        if (await this.cachedAuthorityIsCurrent(runId)) return;
      } catch {
        // Fall through to the authoritative parser so storage failures are
        // classified consistently with uncached reads.
      }
      if (this.journalCache.has(runId)) {
        // Cached state is an optimization, never mutation authority. Any
        // identity change (including same-size writes with restored mtime)
        // invalidates the journal and event-log tails before a full parse.
        this.evictRunCaches(runId);
      }
    }
    const authorityBeforeInspection = await this.runAuthorityIdentity(runId);
    const state = await this.inspected(runId);
    const authorityAfterInspection = await this.runAuthorityIdentity(runId);
    if (!this.sameRunAuthorityIdentity(authorityBeforeInspection, authorityAfterInspection)) {
      this.evictRunCaches(runId);
      return;
    }
    if (state.pending.status === "healthy") {
      await this.finishPending(state, false, authorityAfterInspection);
    }
    const reconciled = await this.inspected(runId);
    if (
      this.healthOf(runId, reconciled).status === "healthy" &&
      reconciled.current.status === "healthy"
    ) {
      await this.cacheHealthyJournal(runId, reconciled.current.value);
    } else {
      this.evictJournal(runId);
    }
  }

  private cachedState(
    runId: string,
  ): Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>> | undefined {
    const journal = this.getCachedJournal(runId);
    if (!journal) return undefined;
    return {
      paths: this.paths(runId),
      current: { status: "healthy", value: journal },
      lastKnownGood: { status: "healthy", value: journal },
      pending: { status: "missing" },
    };
  }

  private async appendInternal(
    runId: string,
    expectedJournalRevision: number,
    eventFactory: (journal: CreateImagesRunJournalV1) => CreateImagesRunEventV1,
  ): Promise<CreateImagesRunJournalV1> {
    await this.reconcile(runId);
    if (this.pruneTombstones.has(runId)) {
      throw new CreateImagesRunJournalLoadError("corrupt", this.paths(runId).current);
    }
    let state = this.cachedState(runId);
    let authority: RunAuthorityIdentity;
    if (state) {
      authority = await this.runAuthorityIdentity(runId);
      if (!this.sameRunAuthorityIdentity(this.journalAuthorityCache.get(runId), authority)) {
        this.evictRunCaches(runId);
        throw new CreateImagesRunJournalLoadError("corrupt", state.paths.current);
      }
    } else {
      const authorityBeforeInspection = await this.runAuthorityIdentity(runId);
      state = await this.inspected(runId);
      authority = await this.runAuthorityIdentity(runId);
      if (!this.sameRunAuthorityIdentity(authorityBeforeInspection, authority)) {
        this.evictRunCaches(runId);
        throw new CreateImagesRunJournalLoadError("corrupt", state.paths.current);
      }
    }
    const health = this.healthOf(runId, state);
    if (health.status !== "healthy" || state.current.status !== "healthy") {
      throw new CreateImagesRunJournalLoadError(
        health.status === "unsafe" ? "unsafe" : "corrupt",
        state.paths.current,
      );
    }
    if (state.current.value.journalRevision !== expectedJournalRevision) {
      throw new CreateImagesRunJournalRevisionConflictError(
        runId,
        expectedJournalRevision,
        state.current.value.journalRevision,
      );
    }
    const next = appendCreateImagesRunEvent(state.current.value, eventFactory(state.current.value));
    const pending: PendingRunMutationV1 = {
      version: PENDING_VERSION,
      kind: "append",
      runId,
      baseJournalRevision: expectedJournalRevision,
      targetJournalRevision: next.journalRevision,
      stagedAt: next.updatedAt,
      event: next.events[next.events.length - 1] as CreateImagesRunEventV1,
      authority,
      targetJournalDigest: journalDigest(next),
    };
    const recordBytes = this.serializedBytes({
      version: 1,
      runId,
      journalRevision: next.journalRevision,
      previousDigest: "0".repeat(64),
      digest: "0".repeat(64),
      event: pending.event,
    });
    await this.assertWithinLimits(
      runId,
      new Map<string, unknown>([[state.paths.pending, pending]]),
      recordBytes * 2,
    );
    await this.writeAtomic(state.paths.pending, pending, MAX_PENDING_BYTES);
    await this.durability.afterPendingPublished?.(runId);
    const pendingState = {
      ...state,
      pending: { status: "healthy", value: pending },
    } as Awaited<ReturnType<CreateImagesRunJournalStore["inspected"]>>;
    if (!(await this.finishPending(pendingState, true, authority))) {
      this.evictRunCaches(runId);
      throw new CreateImagesRunJournalLoadError("corrupt", state.paths.pending);
    }
    await this.refreshInventoryRun(runId);
    if (
      pending.event.type === "run-terminal" ||
      pending.event.type === "run-ambiguity-acknowledged"
    ) {
      try {
        await this.updateIndexEntry(next);
      } catch (error) {
        // The journal is already authoritative. Never let a stale derived
        // index authorize work after its publication failed.
        this.markIndexDirty();
        await this.cacheHealthyJournal(runId, next);
        throw error;
      }
    }
    await this.cacheHealthyJournal(runId, next);
    return next;
  }

  async initialize(): Promise<CreateImagesRunJournalHealth[]> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      this.clearIndexCache();
      const loadedIndex = await this.loadIndex(true);
      const prune = await this.inspectPruneManifest();
      if (prune.status === "unsafe" || prune.status === "corrupt") {
        throw new CreateImagesRunJournalLoadError(
          prune.status === "unsafe" ? "unsafe" : "corrupt",
          this.prunePendingPath(),
        );
      }
      if (prune.status === "healthy") {
        this.pruneStateLoaded = true;
        for (const candidate of prune.value.candidates) {
          this.pruneTombstones.add(candidate.runId);
          this.evictRunCaches(candidate.runId);
        }
        await this.resumeTerminalPrune(prune.value);
      } else {
        this.pruneStateLoaded = true;
      }
      const discard = await this.inspectDiscardManifest();
      if (discard.status === "unsafe" || discard.status === "corrupt") {
        throw new CreateImagesRunJournalLoadError(
          discard.status === "unsafe" ? "unsafe" : "corrupt",
          this.discardPendingPath(),
        );
      }
      if (discard.status === "healthy") {
        this.discardStateLoaded = true;
        this.pruneTombstones.add(discard.value.runId);
        this.evictRunCaches(discard.value.runId);
        await this.resumeDegradedRunDiscard(discard.value);
      } else {
        this.discardStateLoaded = true;
      }
      const { runIds } = await this.inventory(true);
      const index = this.indexCache ?? loadedIndex;
      const indexedEntries = new Map(index?.entries.map((entry) => [entry.runId, entry]) ?? []);
      const results: CreateImagesRunJournalHealth[] = [];
      const refreshedEntries = new Map<string, RunIndexEntryV1>();
      const refreshedDegraded = new Map<string, RunUnassociatedDegradedEntryV1>();
      // The index is a derived history accelerator, never execution
      // authority. Revalidate every bounded run directory before restart
      // reconciliation so a stale terminal bit cannot hide queued work.
      for (const runId of runIds) {
        await this.reconcile(runId);
        const state = await this.inspected(runId);
        const health = this.healthOf(runId, state);
        results.push(health);
        const entry = this.entryForState(runId, state, indexedEntries.get(runId));
        if (entry) refreshedEntries.set(runId, entry);
        else {
          const degraded = this.unassociatedDegradedForState(runId, state);
          if (degraded) refreshedDegraded.set(runId, degraded);
        }
      }
      if (runIds.length > 0) await this.inventory(true);
      const entries = [...refreshedEntries.values()].sort((left, right) =>
        left.runId.localeCompare(right.runId),
      );
      const degraded = [...refreshedDegraded.values()].sort((left, right) =>
        left.runId.localeCompare(right.runId),
      );
      if (!index) {
        await this.publishIndex(entries, undefined, degraded);
      } else if (
        JSON.stringify(entries) !== JSON.stringify(index.entries) ||
        JSON.stringify(degraded) !== JSON.stringify(index.degraded)
      ) {
        await this.publishIndex(entries, index.revision + 1, degraded);
      } else {
        // A complete authoritative scan proved that an earlier ambiguous
        // write outcome already contains the exact derived state.
        this.indexDirty = false;
      }
      return results;
    });
  }

  async health(runId: string): Promise<CreateImagesRunJournalHealth> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.reconcile(runId);
      if (this.pruneTombstones.has(runId)) return { status: "missing", runId };
      const state = await this.inspected(runId);
      const health = await this.enrichDegradedHealth(this.healthOf(runId, state));
      if (health.status === "healthy" && state.current.status === "healthy") {
        await this.cacheHealthyJournal(runId, state.current.value);
      } else {
        this.evictJournal(runId);
      }
      if (health.status === "recovery-required" || health.status === "unsafe") {
        await this.updateIndexState(runId, state);
      }
      return health;
    });
  }

  async indexHealth(): Promise<CreateImagesRunIndexHealth> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const raw = await this.readJson(this.indexPath(), CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES);
      if (raw.status === "missing") {
        return this.indexDirty
          ? {
              status: "degraded",
              revision: 0,
              entryCount: 0,
              degradedEntryCount: 1,
              diagnostic: "stale-derived-index",
            }
          : { status: "missing" };
      }
      if (raw.status === "unsafe") return { status: "unsafe" };
      if (raw.status === "corrupt" || futureVersion(raw.value, "version")) {
        return futureVersion(raw.status === "healthy" ? raw.value : undefined, "version")
          ? { status: "unsafe" }
          : { status: "corrupt" };
      }
      const index = this.parseIndex(raw.value);
      if (!index) return { status: "corrupt" };
      const quarantinedIndexCount = await this.quarantinedIndexCount();
      const degradedEntryCount =
        index.degraded.length + index.entries.filter((entry) => entry.health !== "healthy").length;
      const details = {
        revision: index.revision,
        entryCount: index.entries.length + index.degraded.length,
        ...(this.indexDirty
          ? { diagnostic: "stale-derived-index" as const }
          : this.indexDiagnostic
            ? { diagnostic: this.indexDiagnostic }
            : {}),
        ...(quarantinedIndexCount > 0 ? { quarantinedIndexCount } : {}),
      };
      return degradedEntryCount > 0 || this.indexDirty
        ? {
            status: "degraded",
            ...details,
            degradedEntryCount: Math.max(1, degradedEntryCount),
          }
        : { status: "healthy", ...details };
    });
  }

  async terminalPruneStatus(): Promise<CreateImagesTerminalPruneStatus> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.inspectPruneManifest();
      if (state.status === "missing") return { status: "none" };
      if (state.status === "unsafe") return { status: "unsafe" };
      if (state.status === "corrupt") return { status: "corrupt" };
      const { createdAt: _createdAt, ...plan } = state.value;
      return { status: "pending", plan };
    });
  }

  async get(runId: string): Promise<CreateImagesRunJournalV1 | undefined> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.reconcile(runId);
      if (this.pruneTombstones.has(runId)) return undefined;
      const cached = this.getCachedJournal(runId);
      if (cached) return cached;
      const state = await this.inspected(runId);
      const health = this.healthOf(runId, state);
      if (health.status === "missing") return undefined;
      if (health.status !== "healthy" || state.current.status !== "healthy") {
        throw new CreateImagesRunJournalLoadError(
          health.status === "unsafe" ? "unsafe" : "corrupt",
          state.paths.current,
        );
      }
      return state.current.value;
    });
  }

  async start(
    input: CreateImagesRunStartInput,
    isRendererCurrent: () => boolean,
  ): Promise<CreateImagesRunJournalV1> {
    validateRunId(input.runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.reconcile(input.runId);
      if (this.pruneTombstones.has(input.runId)) {
        throw new CreateImagesRunJournalRevisionConflictError(input.runId, null, null);
      }
      const state = await this.inspected(input.runId);
      const health = this.healthOf(input.runId, state);
      if (health.status !== "missing") {
        throw new CreateImagesRunJournalRevisionConflictError(
          input.runId,
          null,
          state.current.status === "healthy" ? state.current.value.journalRevision : null,
        );
      }
      const next = createCreateImagesRunJournal({
        ...input,
        workflowFingerprint: createImagesWorkflowSnapshotFingerprint(input.workflowSnapshot),
      });
      const pending: PendingRunMutationV1 = {
        version: PENDING_VERSION,
        runId: input.runId,
        baseJournalRevision: null,
        targetJournalRevision: 1,
        stagedAt: input.createdAt,
        next,
      };
      await this.assertWithinLimits(
        input.runId,
        new Map<string, unknown>([
          [state.paths.pending, pending],
          [state.paths.current, next],
          [state.paths.lastKnownGood, next],
        ]),
      );
      await this.writeAtomic(state.paths.pending, pending, MAX_PENDING_BYTES, isRendererCurrent);
      await this.durability.afterPendingPublished?.(input.runId);
      const pendingState = await this.inspected(input.runId);
      if (!(await this.finishPending(pendingState, true))) {
        throw new CreateImagesRunJournalLoadError("corrupt", state.paths.pending);
      }
      await this.refreshInventoryRun(input.runId);
      try {
        await this.updateIndexEntry(next);
      } catch (error) {
        this.markIndexDirty();
        await this.cacheHealthyJournal(input.runId, next);
        throw error;
      }
      await this.cacheHealthyJournal(input.runId, next);
      return next;
    });
  }

  async append(
    runId: string,
    expectedJournalRevision: number,
    event: CreateImagesRunEventV1,
  ): Promise<CreateImagesRunJournalV1> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      try {
        return await this.appendInternal(runId, expectedJournalRevision, () => event);
      } catch (error) {
        this.evictJournal(runId);
        throw error;
      }
    });
  }

  async requestCancellation(
    runId: string,
    expectedJournalRevision: number,
    input: { at: string; reason: CreateImagesCancellationReason },
  ): Promise<CreateImagesRunJournalV1> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      try {
        return await this.appendInternal(runId, expectedJournalRevision, (journal) => ({
          type: "run-cancel-requested",
          workflowId: journal.workflowId,
          workflowRevision: journal.workflowRevision,
          runId: journal.runId,
          sequence: journal.events.length + 1,
          at: input.at,
          reason: input.reason,
        }));
      } catch (error) {
        this.evictJournal(runId);
        throw error;
      }
    });
  }

  async reconciliationCandidates(): Promise<CreateImagesRunJournalV1[]> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const runIds = (await this.indexed()).entries
        .filter(
          (entry) =>
            entry.health === "healthy" && !entry.terminal && !this.pruneTombstones.has(entry.runId),
        )
        .map((entry) => entry.runId);
      const candidates: CreateImagesRunJournalV1[] = [];
      for (const runId of runIds) {
        await this.reconcile(runId);
        const state = await this.inspected(runId);
        if (
          this.healthOf(runId, state).status === "healthy" &&
          state.current.status === "healthy" &&
          !projectCreateImagesRun(state.current.value).terminal
        ) {
          candidates.push(state.current.value);
        }
      }
      return candidates.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
      );
    });
  }

  async terminalHistory(): Promise<CreateImagesTerminalRunSummary[]> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const summaries = (await this.indexed()).entries
        .filter(
          (
            entry,
          ): entry is RunIndexEntryV1 & {
            status: CreateImagesRunTerminalStatus;
          } =>
            entry.health === "healthy" && entry.terminal && !this.pruneTombstones.has(entry.runId),
        )
        .map(
          ({
            runId,
            workflowId,
            workflowRevision,
            journalRevision,
            status,
            createdAt,
            updatedAt,
          }) => ({
            runId,
            workflowId,
            workflowRevision,
            journalRevision,
            status,
            createdAt,
            updatedAt,
          }),
        );
      return summaries.sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId),
      );
    });
  }

  async referenceInventory(): Promise<CreateImagesRunReferenceInventory> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const pruneManifest = await this.inspectPruneManifest();
      const discardManifest = await this.inspectDiscardManifest();
      if (
        pruneManifest.status === "unsafe" ||
        pruneManifest.status === "corrupt" ||
        discardManifest.status === "unsafe" ||
        discardManifest.status === "corrupt"
      ) {
        return { complete: false, records: [] };
      }
      const { runIds } = await this.inventory();
      const records: CreateImagesRunReferenceInventory["records"] = [];
      let complete =
        (pruneManifest.status === "missing" || pruneManifest.status === "healthy") &&
        discardManifest.status === "missing";
      for (const runId of runIds) {
        await this.reconcile(runId);
        const state = await this.inspected(runId);
        const health = this.healthOf(runId, state);
        if (health.status !== "healthy") complete = false;
        const candidates = [
          state.current.status === "healthy" ? state.current.value : undefined,
          state.lastKnownGood.status === "healthy" ? state.lastKnownGood.value : undefined,
          state.pending.status === "healthy" && state.pending.value.kind !== "append"
            ? state.pending.value.next
            : undefined,
        ].filter((candidate): candidate is CreateImagesRunJournalV1 => candidate !== undefined);
        const assetIds = new Set<string>();
        for (const candidate of candidates) {
          for (const assetId of referencedAssetIds(candidate)) assetIds.add(assetId);
        }
        if (
          state.pending.status === "healthy" &&
          state.pending.value.kind === "append" &&
          (state.pending.value.event.type === "node-output-published" ||
            state.pending.value.event.type === "node-succeeded")
        ) {
          for (const assetId of state.pending.value.event.outputAssetIds) assetIds.add(assetId);
        }
        records.push({ runId, assetIds: [...assetIds].sort() });
      }
      if (pruneManifest.status === "healthy") {
        const retainedByManifest = new Set(pruneManifest.value.assetIds);
        const firstRunId = pruneManifest.value.candidates[0]?.runId;
        if (firstRunId) {
          const existing = records.find((record) => record.runId === firstRunId);
          if (existing) {
            for (const assetId of existing.assetIds) retainedByManifest.add(assetId);
            existing.assetIds = [...retainedByManifest].sort();
          } else {
            records.push({
              runId: firstRunId,
              assetIds: [...retainedByManifest].sort(),
            });
          }
        }
      }
      return { complete, records };
    });
  }

  private async buildTerminalPrunePlan(
    requested: readonly CreateImagesTerminalPruneCandidate[],
  ): Promise<CreateImagesTerminalPrunePlan> {
    if (requested.length < 1 || requested.length > MAX_PRUNE_BATCH_SIZE) {
      throw new Error("Create Images terminal prune batch is outside its bounded limit.");
    }
    const candidates = [...requested].sort((left, right) => left.runId.localeCompare(right.runId));
    if (new Set(candidates.map((candidate) => candidate.runId)).size !== candidates.length) {
      throw new Error("Create Images terminal prune candidates must be unique.");
    }
    const assetIds = new Set<string>();
    for (const candidate of candidates) {
      validateRunId(candidate.runId);
      if (!Number.isSafeInteger(candidate.journalRevision) || candidate.journalRevision < 1) {
        throw new Error("Invalid Create Images terminal prune revision.");
      }
      const state = await this.inspected(candidate.runId);
      const health = this.healthOf(candidate.runId, state);
      if (health.status !== "healthy" || state.current.status !== "healthy") {
        throw new CreateImagesRunJournalLoadError(
          health.status === "unsafe" ? "unsafe" : "corrupt",
          state.paths.current,
        );
      }
      if (state.current.value.journalRevision !== candidate.journalRevision) {
        throw new CreateImagesRunJournalRevisionConflictError(
          candidate.runId,
          candidate.journalRevision,
          state.current.value.journalRevision,
        );
      }
      const projection = projectCreateImagesRun(state.current.value);
      if (!projection.terminal) {
        throw new Error("Only terminal Create Images runs can be retired.");
      }
      if (hasUnresolvedCreateImagesRunAmbiguity(projection)) {
        throw new Error(
          "Unresolved Create Images submissions must be acknowledged before retirement.",
        );
      }
      for (const assetId of referencedAssetIds(state.current.value)) assetIds.add(assetId);
      if (assetIds.size > 10_000) {
        throw new Error("Create Images terminal prune references exceed the bounded limit.");
      }
    }
    const sortedAssetIds = [...assetIds].sort();
    return {
      version: 1,
      candidates,
      token: this.pruneToken(candidates, sortedAssetIds),
      assetIds: sortedAssetIds,
    };
  }

  async planTerminalPrune(
    requested: readonly CreateImagesTerminalPruneCandidate[],
  ): Promise<CreateImagesTerminalPrunePlan> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const pending = await this.inspectPruneManifest();
      if (pending.status !== "missing") {
        throw new CreateImagesRunJournalLoadError(
          pending.status === "unsafe" ? "unsafe" : "corrupt",
          this.prunePendingPath(),
        );
      }
      return this.buildTerminalPrunePlan(requested);
    });
  }

  private async resumeTerminalPrune(
    manifest: TerminalPruneManifestV1,
  ): Promise<CreateImagesTerminalPruneResult> {
    for (const candidate of manifest.candidates) {
      this.pruneTombstones.add(candidate.runId);
      this.evictRunCaches(candidate.runId);
    }
    const retiredRoot = path.join(this.root(), RETIRED_RUNS_DIRECTORY);
    const retiredBatch = path.join(retiredRoot, manifest.token);
    await this.ensureDirectory(retiredRoot);
    await this.ensureDirectory(retiredBatch);
    const index = await this.indexed();
    const indexedRunIds = new Set(index.entries.map((entry) => entry.runId));
    for (const candidate of manifest.candidates) {
      const source = this.runDirectory(candidate.runId);
      const destination = path.join(retiredBatch, candidate.runId);
      const [sourceInfo, destinationInfo] = await Promise.all([
        fs.lstat(source).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }),
        fs.lstat(destination).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }),
      ]);
      if (sourceInfo && destinationInfo) {
        throw new CreateImagesRunJournalLoadError("unsafe", source);
      }
      if (sourceInfo) {
        if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
          throw new CreateImagesRunJournalLoadError("unsafe", source);
        }
        await fs.rename(source, destination);
        await this.syncDirectory(this.runsPath());
        await this.syncDirectory(retiredBatch);
        await this.durability.afterRunRetired?.(candidate.runId);
      } else if (destinationInfo) {
        if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
          throw new CreateImagesRunJournalLoadError("unsafe", destination);
        }
      } else if (indexedRunIds.has(candidate.runId)) {
        throw new CreateImagesRunJournalLoadError("corrupt", source);
      }
    }

    const removed = new Set(manifest.candidates.map((candidate) => candidate.runId));
    if (index.entries.some((entry) => removed.has(entry.runId))) {
      await this.publishIndex(
        index.entries.filter((entry) => !removed.has(entry.runId)),
        index.revision + 1,
      );
    }
    await this.durability.beforeRetiredDelete?.(manifest.token);
    await fs.rm(retiredBatch, { recursive: true, force: true });
    await this.syncDirectory(retiredRoot);
    await this.durability.afterRetiredDelete?.(manifest.token);
    await this.removeDurably(this.prunePendingPath());
    this.inventoryCache = undefined;
    for (const candidate of manifest.candidates) {
      this.evictRunCaches(candidate.runId);
      this.pruneTombstones.delete(candidate.runId);
    }
    return {
      removedRunIds: manifest.candidates.map((candidate) => candidate.runId),
      releasedAssetIds: [...manifest.assetIds],
    };
  }

  async pruneTerminalRuns(
    plan: CreateImagesTerminalPrunePlan,
  ): Promise<CreateImagesTerminalPruneResult> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      let manifestState = await this.inspectPruneManifest();
      let manifest: TerminalPruneManifestV1;
      if (manifestState.status === "healthy") {
        manifest = manifestState.value;
        if (
          manifest.token !== plan.token ||
          JSON.stringify(manifest.candidates) !== JSON.stringify(plan.candidates) ||
          JSON.stringify(manifest.assetIds) !== JSON.stringify(plan.assetIds)
        ) {
          throw new Error("Another Create Images terminal prune is already in progress.");
        }
      } else if (manifestState.status === "missing") {
        const verified = await this.buildTerminalPrunePlan(plan.candidates);
        if (
          verified.token !== plan.token ||
          JSON.stringify(verified.assetIds) !== JSON.stringify(plan.assetIds)
        ) {
          throw new Error("Create Images terminal prune authorization is stale.");
        }
        manifest = { ...verified, createdAt: new Date().toISOString() };
        await this.writeAtomic(this.prunePendingPath(), manifest, 1024 * 1024);
        this.pruneStateLoaded = true;
        for (const candidate of manifest.candidates) {
          this.pruneTombstones.add(candidate.runId);
          this.evictRunCaches(candidate.runId);
        }
        await this.durability.afterPruneManifestPublished?.(manifest.token);
        manifestState = { status: "healthy", value: manifest };
      } else {
        throw new CreateImagesRunJournalLoadError(
          manifestState.status === "unsafe" ? "unsafe" : "corrupt",
          this.prunePendingPath(),
        );
      }

      return this.resumeTerminalPrune(manifest);
    });
  }

  async planDegradedRunDiscard(runId: string): Promise<CreateImagesDegradedRunDiscardPlanResult> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      if (this.pruneTombstones.has(runId)) return { status: "not-found" };
      const pending = await this.inspectDiscardManifest();
      if (pending.status !== "missing") {
        throw new CreateImagesRunJournalLoadError(
          pending.status === "unsafe" ? "unsafe" : "corrupt",
          this.discardPendingPath(),
        );
      }
      return this.buildDegradedRunDiscardPlan(runId);
    });
  }

  private async resumeDegradedRunDiscard(
    manifest: DegradedRunDiscardManifestV1,
  ): Promise<CreateImagesDegradedRunDiscardResult> {
    this.pruneTombstones.add(manifest.runId);
    this.evictRunCaches(manifest.runId);
    const discardedRoot = path.join(this.root(), DISCARDED_RUNS_DIRECTORY);
    const discardedBatch = path.join(discardedRoot, manifest.authorizationToken);
    const source = this.runDirectory(manifest.runId);
    const destination = path.join(discardedBatch, manifest.runId);
    await this.ensureDirectory(discardedRoot);
    await this.ensureDirectory(discardedBatch);
    const index = await this.indexed();
    const [sourceInfo, destinationInfo] = await Promise.all([
      fs.lstat(source).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }),
      fs.lstat(destination).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }),
    ]);
    if (sourceInfo && destinationInfo) {
      throw new CreateImagesRunJournalLoadError("unsafe", source);
    }
    if (sourceInfo) {
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new CreateImagesRunJournalLoadError("unsafe", source);
      }
      const verified = await this.buildDegradedRunDiscardPlan(manifest.runId);
      if (
        verified.status !== "ready" ||
        verified.plan.authorizationToken !== manifest.authorizationToken ||
        verified.plan.recordFingerprint !== manifest.recordFingerprint ||
        verified.plan.reason !== manifest.reason ||
        verified.plan.association !== manifest.association ||
        verified.plan.workflowId !== manifest.workflowId ||
        verified.plan.expectedCurrentJournalRevision !== manifest.expectedCurrentJournalRevision ||
        verified.plan.expectedLastKnownGoodJournalRevision !==
          manifest.expectedLastKnownGoodJournalRevision
      ) {
        throw new CreateImagesRunJournalRevisionConflictError(
          manifest.runId,
          manifest.expectedCurrentJournalRevision ?? null,
          verified.status === "ready"
            ? (verified.plan.expectedCurrentJournalRevision ?? null)
            : null,
        );
      }
      await fs.rename(source, destination);
      await this.syncDirectory(this.runsPath());
      await this.syncDirectory(discardedBatch);
      await this.durability.afterDegradedRunRetired?.(manifest.runId);
    } else if (destinationInfo) {
      if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
        throw new CreateImagesRunJournalLoadError("unsafe", destination);
      }
    } else if (
      index.entries.some((entry) => entry.runId === manifest.runId) ||
      index.degraded.some((entry) => entry.runId === manifest.runId)
    ) {
      throw new CreateImagesRunJournalLoadError("corrupt", source);
    }

    if (
      index.entries.some((entry) => entry.runId === manifest.runId) ||
      index.degraded.some((entry) => entry.runId === manifest.runId)
    ) {
      try {
        await this.publishIndex(
          index.entries.filter((entry) => entry.runId !== manifest.runId),
          index.revision + 1,
          index.degraded.filter((entry) => entry.runId !== manifest.runId),
        );
      } catch (error) {
        this.markIndexDirty();
        throw error;
      }
    }
    await fs.rm(discardedBatch, { recursive: true, force: true });
    await this.syncDirectory(discardedRoot);
    await this.durability.afterDiscardedRunDeleted?.(manifest.authorizationToken);
    await this.removeDurably(this.discardPendingPath());
    this.inventoryCache = undefined;
    this.evictRunCaches(manifest.runId);
    this.pruneTombstones.delete(manifest.runId);
    return {
      runId: manifest.runId,
      ...(manifest.workflowId ? { workflowId: manifest.workflowId } : {}),
    };
  }

  async discardDegradedRun(
    input: CreateImagesDegradedRunDiscardRequest,
  ): Promise<CreateImagesDegradedRunDiscardMutationResult> {
    validateRunId(input.runId);
    if (!/^[a-f0-9]{64}$/u.test(input.authorizationToken)) {
      throw new Error("Invalid Create Images degraded-run discard authorization.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      let pending = await this.inspectDiscardManifest();
      if (this.pruneTombstones.has(input.runId) && pending.status === "missing") {
        return { status: "not-found" };
      }
      let manifest: DegradedRunDiscardManifestV1;
      if (pending.status === "healthy") {
        manifest = pending.value;
        if (
          manifest.runId !== input.runId ||
          manifest.authorizationToken !== input.authorizationToken ||
          manifest.expectedCurrentJournalRevision !== input.expectedCurrentJournalRevision ||
          manifest.expectedLastKnownGoodJournalRevision !==
            input.expectedLastKnownGoodJournalRevision
        ) {
          return { status: "conflict" };
        }
      } else if (pending.status === "missing") {
        const planned = await this.buildDegradedRunDiscardPlan(input.runId);
        if (planned.status !== "ready") return planned;
        if (
          planned.plan.authorizationToken !== input.authorizationToken ||
          planned.plan.expectedCurrentJournalRevision !== input.expectedCurrentJournalRevision ||
          planned.plan.expectedLastKnownGoodJournalRevision !==
            input.expectedLastKnownGoodJournalRevision
        ) {
          return { status: "conflict" };
        }
        manifest = { ...planned.plan, createdAt: new Date().toISOString() };
        await this.writeAtomic(this.discardPendingPath(), manifest, 64 * 1024);
        this.discardStateLoaded = true;
        this.pruneTombstones.add(manifest.runId);
        this.evictRunCaches(manifest.runId);
        await this.durability.afterDiscardManifestPublished?.(manifest.authorizationToken);
        pending = { status: "healthy", value: manifest };
      } else {
        throw new CreateImagesRunJournalLoadError(
          pending.status === "unsafe" ? "unsafe" : "corrupt",
          this.discardPendingPath(),
        );
      }
      return {
        status: "discarded",
        result: await this.resumeDegradedRunDiscard(manifest),
      };
    });
  }

  async recoverFromLastKnownGood(
    runId: string,
    expectedJournalRevision: number,
  ): Promise<CreateImagesRunJournalV1> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      if (this.pruneTombstones.has(runId)) {
        throw new CreateImagesRunJournalLoadError("corrupt", this.paths(runId).current);
      }
      const state = await this.inspected(runId);
      if (state.pending.status !== "missing" || state.lastKnownGood.status !== "healthy") {
        throw new CreateImagesRunJournalLoadError("corrupt", state.paths.current);
      }
      if (state.lastKnownGood.value.journalRevision !== expectedJournalRevision) {
        throw new CreateImagesRunJournalRevisionConflictError(
          runId,
          expectedJournalRevision,
          state.lastKnownGood.value.journalRevision,
        );
      }
      if (state.current.status === "unsafe") {
        throw new CreateImagesRunJournalLoadError("unsafe", state.paths.current);
      }
      if (
        state.current.status === "healthy" &&
        identical(state.current.value, state.lastKnownGood.value)
      ) {
        return state.current.value;
      }
      await this.assertWithinLimits(
        runId,
        new Map([[state.paths.current, state.lastKnownGood.value]]),
      );
      await this.replaceCheckpoint(
        state.paths.current,
        state.paths.currentEvents,
        state.lastKnownGood.value,
      );
      await this.refreshInventoryRun(runId);
      await this.updateIndexEntry(state.lastKnownGood.value);
      return state.lastKnownGood.value;
    });
  }

  async recoverLastKnownGoodFromCurrent(
    runId: string,
    expectedJournalRevision: number,
  ): Promise<CreateImagesRunJournalV1> {
    validateRunId(runId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      if (this.pruneTombstones.has(runId)) {
        throw new CreateImagesRunJournalLoadError("corrupt", this.paths(runId).lastKnownGood);
      }
      const state = await this.inspected(runId);
      if (state.pending.status !== "missing" || state.current.status !== "healthy") {
        throw new CreateImagesRunJournalLoadError("corrupt", state.paths.lastKnownGood);
      }
      if (state.current.value.journalRevision !== expectedJournalRevision) {
        throw new CreateImagesRunJournalRevisionConflictError(
          runId,
          expectedJournalRevision,
          state.current.value.journalRevision,
        );
      }
      if (state.lastKnownGood.status === "unsafe") {
        throw new CreateImagesRunJournalLoadError("unsafe", state.paths.lastKnownGood);
      }
      if (
        state.lastKnownGood.status === "healthy" &&
        identical(state.current.value, state.lastKnownGood.value)
      ) {
        return state.current.value;
      }
      await this.assertWithinLimits(
        runId,
        new Map([[state.paths.lastKnownGood, state.current.value]]),
      );
      await this.replaceCheckpoint(
        state.paths.lastKnownGood,
        state.paths.lastKnownGoodEvents,
        state.current.value,
      );
      await this.refreshInventoryRun(runId);
      await this.updateIndexEntry(state.current.value);
      return state.current.value;
    });
  }

  async healthPage(cursor?: string, limit = 100): Promise<CreateImagesRunHealthPage> {
    if (cursor !== undefined) validateRunId(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HEALTH_PAGE_SIZE) {
      throw new Error("Invalid Create Images run health page size.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const { runIds } = await this.inventory();
      const start = cursor === undefined ? 0 : runIds.findIndex((runId) => runId > cursor);
      if (start < 0) return { records: [] };
      const selected = runIds.slice(start, start + limit);
      const records: CreateImagesRunJournalHealth[] = [];
      for (const runId of selected) {
        await this.reconcile(runId);
        records.push(
          this.pruneTombstones.has(runId)
            ? { status: "missing", runId }
            : this.healthOf(runId, await this.inspected(runId)),
        );
      }
      const last = selected[selected.length - 1];
      return {
        records,
        ...(last && start + selected.length < runIds.length ? { nextCursor: last } : {}),
      };
    });
  }

  async recoveryCandidates(limit = 100): Promise<CreateImagesRunRecoveryCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HEALTH_PAGE_SIZE) {
      throw new Error("Invalid Create Images run recovery candidate limit.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      return (await this.indexed()).entries
        .filter(
          (
            entry,
          ): entry is RunIndexEntryV1 & {
            recoveryReason: CreateImagesRunRecoveryReason;
          } =>
            entry.health === "recovery-required" &&
            entry.recoveryReason !== undefined &&
            !this.pruneTombstones.has(entry.runId),
        )
        .slice(0, limit)
        .map((entry) => this.recoveryCandidateFromEntry(entry));
    });
  }

  private recoveryCandidateFromEntry(
    entry: RunIndexEntryV1 & { recoveryReason: CreateImagesRunRecoveryReason },
  ): CreateImagesRunRecoveryCandidate {
    return {
      runId: entry.runId,
      workflowId: entry.workflowId,
      workflowRevision: entry.workflowRevision,
      reason: entry.recoveryReason,
      canRecover: entry.canRecover ?? false,
      ...(entry.expectedJournalRevision !== undefined
        ? { expectedJournalRevision: entry.expectedJournalRevision }
        : {}),
    };
  }

  private degradedCandidateFromEntry(
    entry: RunIndexEntryV1,
  ): CreateImagesRunDegradedCandidate | undefined {
    if (entry.health === "recovery-required" && entry.recoveryReason) {
      return {
        status: "recovery-required",
        ...this.recoveryCandidateFromEntry({
          ...entry,
          recoveryReason: entry.recoveryReason,
        }),
      };
    }
    if (entry.health === "unsafe" && entry.unsafeReason) {
      return {
        status: "unsafe",
        runId: entry.runId,
        workflowId: entry.workflowId,
        workflowRevision: entry.workflowRevision,
        reason: entry.unsafeReason,
      };
    }
    return undefined;
  }

  /**
   * Bounded, path-free diagnostics for every degraded run known to the
   * derived index. Workflow-less records are deliberately not authorizable.
   */
  async degradedRuns(
    limit = this.limits.maxRunCount,
  ): Promise<CreateImagesRunStorageDegradedRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxRunCount) {
      throw new Error("Invalid Create Images degraded run limit.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const index = await this.indexed();
      const associated = index.entries
        .map((entry) => this.degradedCandidateFromEntry(entry))
        .filter(
          (candidate): candidate is CreateImagesRunDegradedCandidate =>
            candidate !== undefined && !this.pruneTombstones.has(candidate.runId),
        );
      const unassociated = index.degraded
        .filter((entry) => !this.pruneTombstones.has(entry.runId))
        .map(
          (entry): CreateImagesRunStorageDegradedRecord => ({
            status: entry.status,
            runId: entry.runId,
            reason:
              entry.status === "unsafe"
                ? (entry.unsafeReason as CreateImagesRunUnsafeReason)
                : (entry.recoveryReason as CreateImagesRunRecoveryReason),
            canRecover: false,
          }),
        );
      return [...associated, ...unassociated]
        .sort((left, right) => left.runId.localeCompare(right.runId))
        .slice(0, limit);
    });
  }

  async degradedRunCount(): Promise<number> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const index = await this.indexed();
      return (
        index.entries.filter(
          (entry) => entry.health !== "healthy" && !this.pruneTombstones.has(entry.runId),
        ).length + index.degraded.filter((entry) => !this.pruneTombstones.has(entry.runId)).length
      );
    });
  }

  async refreshWorkflowDegradedMetadata(
    workflowId: string,
    runIds: readonly string[],
  ): Promise<CreateImagesRunDegradedCandidate[]> {
    if (!RUN_ID_PATTERN.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
    if (
      runIds.length > MAX_PRUNE_BATCH_SIZE ||
      new Set(runIds).size !== runIds.length ||
      runIds.some((runId) => !RUN_ID_PATTERN.test(runId))
    ) {
      throw new Error("Invalid bounded Create Images recovery refresh.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const index = await this.indexed();
      const refreshed = new Map(index.entries.map((entry) => [entry.runId, entry]));
      const degraded = new Map(index.degraded.map((entry) => [entry.runId, entry]));
      for (const runId of runIds) {
        await this.reconcile(runId);
        if (this.pruneTombstones.has(runId)) {
          refreshed.delete(runId);
          degraded.delete(runId);
          continue;
        }
        const state = await this.inspected(runId);
        const entry = this.entryForState(runId, state, refreshed.get(runId));
        if (entry) {
          refreshed.set(runId, entry);
          degraded.delete(runId);
        } else {
          refreshed.delete(runId);
          const unassociated = this.unassociatedDegradedForState(runId, state);
          if (unassociated) degraded.set(runId, unassociated);
        }
      }
      const entries = [...refreshed.values()].sort((left, right) =>
        left.runId.localeCompare(right.runId),
      );
      const degradedEntries = [...degraded.values()].sort((left, right) =>
        left.runId.localeCompare(right.runId),
      );
      if (
        JSON.stringify(entries) !== JSON.stringify(index.entries) ||
        JSON.stringify(degradedEntries) !== JSON.stringify(index.degraded)
      ) {
        await this.publishIndex(entries, index.revision + 1, degradedEntries);
      }
      return entries
        .filter(
          (entry) => entry.workflowId === workflowId && !this.pruneTombstones.has(entry.runId),
        )
        .map((entry) => this.degradedCandidateFromEntry(entry))
        .filter(
          (candidate): candidate is CreateImagesRunDegradedCandidate => candidate !== undefined,
        );
    });
  }

  async refreshWorkflowRecoveryMetadata(
    workflowId: string,
    runIds: readonly string[],
  ): Promise<CreateImagesRunRecoveryCandidate[]> {
    const degraded = await this.refreshWorkflowDegradedMetadata(workflowId, runIds);
    return degraded
      .filter(
        (
          candidate,
        ): candidate is Extract<
          CreateImagesRunDegradedCandidate,
          { status: "recovery-required" }
        > => candidate.status === "recovery-required",
      )
      .map(({ status: _status, ...candidate }) => candidate);
  }

  async workflowDegradedCandidates(
    workflowId: string,
    limit = this.limits.maxRunCount,
  ): Promise<CreateImagesRunDegradedCandidate[]> {
    if (!RUN_ID_PATTERN.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxRunCount) {
      throw new Error("Invalid Create Images degraded run limit.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      return (await this.indexed()).entries
        .filter(
          (entry) =>
            entry.workflowId === workflowId &&
            entry.health !== "healthy" &&
            !this.pruneTombstones.has(entry.runId),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
        )
        .map((entry) => this.degradedCandidateFromEntry(entry))
        .filter(
          (candidate): candidate is CreateImagesRunDegradedCandidate => candidate !== undefined,
        )
        .slice(0, limit);
    });
  }

  /**
   * Revalidates start authority from the bounded on-disk run inventory.
   * The derived index is used only as an association hint for records whose
   * two authoritative checkpoints are damaged; its status bits never admit a
   * new run.
   */
  async auditWorkflowAdmission(workflowId: string): Promise<CreateImagesWorkflowAdmissionAudit> {
    if (!RUN_ID_PATTERN.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const prior = await this.loadIndex(true);
      const { runIds } = await this.inventory(true);
      const inventoryRunIds = new Set(runIds);
      const priorEntries = new Map(prior?.entries.map((entry) => [entry.runId, entry]) ?? []);
      for (const entry of prior?.entries ?? []) {
        if (
          entry.workflowId === workflowId &&
          !inventoryRunIds.has(entry.runId) &&
          !this.pruneTombstones.has(entry.runId)
        ) {
          throw new CreateImagesRunJournalLoadError("corrupt", this.runDirectory(entry.runId));
        }
      }
      if (
        (prior?.degraded ?? []).some(
          (entry) => !inventoryRunIds.has(entry.runId) && !this.pruneTombstones.has(entry.runId),
        )
      ) {
        throw new CreateImagesRunJournalLoadError("corrupt", this.runsPath());
      }

      const audit: CreateImagesWorkflowAdmissionAudit = {
        hasDegradedAuthority: false,
        hasNonterminalRun: false,
        hasUnresolvedAmbiguity: false,
      };
      const entries: RunIndexEntryV1[] = [];
      const degraded: RunUnassociatedDegradedEntryV1[] = [];
      for (const runId of runIds) {
        if (this.pruneTombstones.has(runId)) continue;
        await this.reconcile(runId);
        const state = await this.inspected(runId);
        const health = this.healthOf(runId, state);
        if (health.status === "missing") {
          throw new CreateImagesRunJournalLoadError("corrupt", state.paths.current);
        }
        const entry = this.entryForState(runId, state, priorEntries.get(runId));
        if (entry) {
          entries.push(entry);
          if (entry.health !== "healthy") {
            // A derived-index association is useful for recovery UI, but it
            // cannot scope admission when neither checkpoint still proves
            // identity. Unassociated damage therefore blocks every workflow.
            const trustedWorkflowId = "workflowId" in health ? health.workflowId : undefined;
            if (trustedWorkflowId === undefined || trustedWorkflowId === workflowId) {
              audit.hasDegradedAuthority = true;
            }
          } else if (entry.workflowId === workflowId) {
            audit.hasNonterminalRun ||= !entry.terminal;
            audit.hasUnresolvedAmbiguity ||= entry.unresolvedAmbiguity;
          }
        } else {
          const unassociated = this.unassociatedDegradedForState(runId, state);
          if (!unassociated) {
            throw new CreateImagesRunJournalLoadError("corrupt", state.paths.current);
          }
          degraded.push(unassociated);
          audit.hasDegradedAuthority = true;
        }
        if (health.status === "healthy" && state.current.status === "healthy") {
          await this.cacheHealthyJournal(runId, state.current.value);
        } else {
          this.evictJournal(runId);
        }
      }

      entries.sort((left, right) => left.runId.localeCompare(right.runId));
      degraded.sort((left, right) => left.runId.localeCompare(right.runId));
      if (
        !prior ||
        JSON.stringify(entries) !== JSON.stringify(prior.entries) ||
        JSON.stringify(degraded) !== JSON.stringify(prior.degraded)
      ) {
        try {
          await this.publishIndex(entries, prior ? prior.revision + 1 : undefined, degraded);
        } catch (error) {
          this.markIndexDirty();
          throw error;
        }
      } else {
        this.indexDirty = false;
      }
      return audit;
    });
  }

  async hasUnresolvedAmbiguity(workflowId: string): Promise<boolean> {
    if (!RUN_ID_PATTERN.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      return (await this.indexed()).entries.some(
        (entry) =>
          entry.workflowId === workflowId &&
          entry.health === "healthy" &&
          entry.unresolvedAmbiguity &&
          !this.pruneTombstones.has(entry.runId),
      );
    });
  }

  async hasNonterminalRun(workflowId: string): Promise<boolean> {
    if (!RUN_ID_PATTERN.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      return (await this.indexed()).entries.some(
        (entry) =>
          entry.workflowId === workflowId &&
          entry.health === "healthy" &&
          !entry.terminal &&
          !this.pruneTombstones.has(entry.runId),
      );
    });
  }

  async hasUnassociatedDegradedRuns(): Promise<boolean> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      return (await this.indexed()).degraded.some(
        (entry) => !this.pruneTombstones.has(entry.runId),
      );
    });
  }

  async workflowRecoveryCandidates(
    workflowId: string,
    limit = 100,
  ): Promise<CreateImagesRunRecoveryCandidate[]> {
    if (!RUN_ID_PATTERN.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HEALTH_PAGE_SIZE) {
      throw new Error("Invalid Create Images run recovery candidate limit.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      return (await this.indexed()).entries
        .filter(
          (
            entry,
          ): entry is RunIndexEntryV1 & {
            recoveryReason: CreateImagesRunRecoveryReason;
          } =>
            entry.workflowId === workflowId &&
            entry.health === "recovery-required" &&
            entry.recoveryReason !== undefined &&
            !this.pruneTombstones.has(entry.runId),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
        )
        .slice(0, limit)
        .map((entry) => this.recoveryCandidateFromEntry(entry));
    });
  }

  async terminalRetentionCandidates(
    query: CreateImagesTerminalRetentionQuery,
  ): Promise<CreateImagesTerminalRetentionCandidate[]> {
    if (
      !Number.isSafeInteger(query.keepLatest) ||
      query.keepLatest < 0 ||
      query.keepLatest > 1_000
    ) {
      throw new Error("Invalid Create Images terminal retention keep count.");
    }
    const limit = query.limit ?? MAX_PRUNE_BATCH_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE_BATCH_SIZE) {
      throw new Error("Invalid Create Images terminal retention candidate limit.");
    }
    if (query.workflowId !== undefined && !RUN_ID_PATTERN.test(query.workflowId)) {
      throw new Error("Invalid Create Images workflow ID.");
    }
    if (query.olderThan !== undefined && !Number.isFinite(Date.parse(query.olderThan))) {
      throw new Error("Invalid Create Images terminal retention cutoff.");
    }
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.ensurePruneTombstones();
      const entries = (await this.indexed()).entries
        .filter(
          (entry) =>
            entry.health === "healthy" &&
            entry.terminal &&
            !entry.unresolvedAmbiguity &&
            !this.pruneTombstones.has(entry.runId) &&
            (query.workflowId === undefined || entry.workflowId === query.workflowId),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId),
        );
      const retainedByWorkflow = new Map<string, number>();
      const candidates: CreateImagesTerminalRetentionCandidate[] = [];
      const plannedAssetIds = new Set<string>();
      for (const entry of entries) {
        const retentionKey = query.workflowId === undefined ? "__global__" : entry.workflowId;
        const retained = retainedByWorkflow.get(retentionKey) ?? 0;
        if (retained < query.keepLatest) {
          retainedByWorkflow.set(retentionKey, retained + 1);
          continue;
        }
        if (query.olderThan !== undefined && entry.updatedAt >= query.olderThan) continue;
        const state = await this.inspected(entry.runId);
        const health = this.healthOf(entry.runId, state);
        if (health.status !== "healthy" || state.current.status !== "healthy") {
          await this.updateIndexState(entry.runId, state);
          continue;
        }
        const assetIds = referencedAssetIds(state.current.value);
        const nextAssetIds = new Set(plannedAssetIds);
        for (const assetId of assetIds) nextAssetIds.add(assetId);
        // The crash-resumable prune manifest is intentionally bounded. A
        // high-output history is retired in multiple authorized batches.
        if (nextAssetIds.size > 10_000) {
          if (candidates.length === 0) {
            throw new Error("A Create Images run exceeds the bounded prune reference limit.");
          }
          break;
        }
        plannedAssetIds.clear();
        for (const assetId of nextAssetIds) plannedAssetIds.add(assetId);
        candidates.push({
          runId: entry.runId,
          workflowId: entry.workflowId,
          journalRevision: entry.journalRevision,
          updatedAt: entry.updatedAt,
          assetIds,
        });
        if (candidates.length === limit) break;
      }
      return candidates;
    });
  }

  cacheStats(): CreateImagesRunCacheStats {
    return {
      journalCount: this.journalCache.size,
      journalBytes: this.journalCacheBytes,
      tailCount: this.eventLogTailCache.size,
      tailBytes: this.tailCacheBytes,
    };
  }
}

// Keep the shared contract's version visible to main-only feature-surface tests.
export const CREATE_IMAGES_RUN_STORE_SCHEMA_VERSION = CREATE_IMAGES_RUN_JOURNAL_VERSION;
