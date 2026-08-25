import { isDeepStrictEqual, TextDecoder } from "node:util";
import {
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshotV2,
  subagentProjectionNoticesAreMonotonic,
  type SubagentRunSnapshotV2,
  type SubagentRunStateV2,
} from "../../../renderer/shared/subagent-runs.js";
import {
  createSubagentAuthorityV2,
  subagentAuthorityDigestV2,
  type CreateSubagentAuthorityV2Input,
  type SubagentAuthorityV2,
} from "./authority-v2.js";
import {
  MAX_SUBAGENT_CHAT_TOMBSTONES,
  MAX_SUBAGENT_RUN_STORE_BYTES,
  MAX_STORED_SUBAGENT_RUNS,
  assertUniqueJsonObjectKeys,
} from "./subagent-run-store-core.js";
import {
  createNativeSubagentRunStoreStorage,
  SubagentRunStoreStorageError,
  type SubagentRunStoreGeneration,
  type SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";
import type {
  SubagentPrivateRunManifestV2 as ImportedSubagentPrivateRunManifestV2,
  SubagentRunMigrationV2,
} from "./subagent-run-store-v2-migration.js";
import {
  MAX_DURABLE_SUBAGENT_EFFECTS,
  durableSubagentEffectRecordsMatchV2,
  isDurableSubagentEffectTerminalV2,
  parseDurableSubagentApprovalV2,
  parseDurableSubagentEffectOwnerV2,
  parseDurableSubagentEffectV2,
  parseFinishDurableSubagentEffectV2Input,
  parsePrepareDurableSubagentEffectV2Input,
  projectDurableSubagentEffectActivityV1,
  subagentEffectEvidenceDigestV2,
  type DurableSubagentApprovalV2,
  type DurableSubagentEffectOwnerV2,
  type DurableSubagentEffectV2,
  type DurableSubagentEffectStateV2,
} from "./subagent-effect-v2.js";
import {
  MAX_BACKGROUND_EVENTS_V2,
  parseBackgroundSubagentRunV2,
  type BackgroundSubagentRunV2,
  type BackgroundSubagentStoreV2,
} from "./background-lifecycle-v2.js";

const STORE_VERSION = 2 as const;
const MIGRATION_ADAPTER_VERSION = 1 as const;
const MAX_NATIVE_GENERATION_CONFLICT_RETRIES = 1;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ACTIVE_STATES = new Set<SubagentRunStateV2>([
  "queued",
  "starting",
  "running",
  "needs_attention",
]);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface NativeSubagentPrivateRunManifestV2 {
  version: typeof STORE_VERSION;
  provenance: "v2_native";
  runId: string;
  generationId: string;
  childId: string;
  chatId: string;
  workspaceId: string;
  task: string;
  /** Persisted for audit/drift checks only. Retry must always resolve a fresh grant. */
  reusableAuthority: false;
  authority: SubagentAuthorityV2;
}

export type MutableSubagentPrivateRunManifestV2 =
  | ImportedSubagentPrivateRunManifestV2
  | NativeSubagentPrivateRunManifestV2;

export interface MutableSubagentRunDatabaseV2 {
  version: typeof STORE_VERSION;
  storeRevision: number;
  migration: SubagentRunMigrationV2;
  snapshots: SubagentRunSnapshotV2[];
  manifests: MutableSubagentPrivateRunManifestV2[];
  approvals: DurableSubagentApprovalV2[];
  effects: DurableSubagentEffectV2[];
  /** Private app-lifetime lifecycle evidence; never returned by renderer projections. */
  backgroundRuns: BackgroundSubagentRunV2[];
  pendingChatDeletions: string[];
  deletionTransactions: [];
}

export interface SubagentRunStoreV2Options {
  now?: () => number;
  maxRuns?: number;
  storageFactory?: (directory: string) => SubagentRunStoreStorage;
}

export interface SubagentRunStoreV1CheckpointV2 {
  source: "missing" | "v1";
  sourceGeneration: SubagentRunStoreGeneration;
  sourceSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) &&
    keys.length >= required.length &&
    keys.length <= required.length + optional.length &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function safeGeneration(value: unknown): value is SubagentRunStoreGeneration {
  return value === "missing" || (typeof value === "string" && /^[0-9a-f]+(?:-[0-9a-f]+){8}$/u.test(value));
}

function parseMigration(value: unknown): SubagentRunMigrationV2 | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["status", "adapterVersion", "source", "sourceGeneration", "sourceSha256", "migratedAt"]) ||
    (value.status !== "prepared" && value.status !== "committed") ||
    value.adapterVersion !== MIGRATION_ADAPTER_VERSION ||
    (value.source !== "missing" && value.source !== "v1") ||
    !safeGeneration(value.sourceGeneration) ||
    typeof value.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
    typeof value.migratedAt !== "number" ||
    !Number.isFinite(value.migratedAt) ||
    value.migratedAt < 0 ||
    (value.source === "missing" && value.sourceGeneration !== "missing") ||
    (value.source === "v1" && value.sourceGeneration === "missing")
  ) {
    return undefined;
  }
  return {
    status: value.status,
    adapterVersion: MIGRATION_ADAPTER_VERSION,
    source: value.source,
    sourceGeneration: value.sourceGeneration,
    sourceSha256: value.sourceSha256,
    migratedAt: value.migratedAt,
  };
}

function boundedPrivateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}

function parseAuthority(value: unknown): SubagentAuthorityV2 | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        "version",
        "grantId",
        "treeRootId",
        "runId",
        "depth",
        "authorityRevision",
        "generationId",
        "chatId",
        "workspaceId",
        "workspaceRevision",
        "ownerDocumentId",
        "providerFingerprint",
        "modelFingerprint",
        "contextRevision",
        "execution",
        "context",
        "thinkingLevel",
        "capabilities",
        "budgets",
        "expiresAt",
      ],
      ["parentRunId"],
    ) ||
    !THINKING_LEVELS.has(value.thinkingLevel as string) ||
    !boundedPrivateString(value.workspaceRevision) ||
    !boundedPrivateString(value.ownerDocumentId) ||
    !boundedPrivateString(value.providerFingerprint) ||
    !boundedPrivateString(value.modelFingerprint) ||
    !boundedPrivateString(value.contextRevision)
  ) {
    return undefined;
  }
  try {
    return createSubagentAuthorityV2(value as unknown as CreateSubagentAuthorityV2Input);
  } catch {
    return undefined;
  }
}

function parseImportedManifest(value: Record<string, unknown>): ImportedSubagentPrivateRunManifestV2 | undefined {
  if (
    !exactKeys(value, [
      "version",
      "provenance",
      "runId",
      "generationId",
      "childId",
      "chatId",
      "workspaceId",
      "task",
      "reusableAuthority",
    ]) ||
    value.version !== STORE_VERSION ||
    value.provenance !== "v1_import" ||
    value.reusableAuthority !== false ||
    ![value.runId, value.generationId, value.childId, value.chatId, value.workspaceId].every(isSafeSubagentIdentifier) ||
    typeof value.task !== "string" ||
    value.task.length === 0 ||
    value.task.length > 240 ||
    value.task.includes("\0")
  ) {
    return undefined;
  }
  return {
    version: STORE_VERSION,
    provenance: "v1_import",
    runId: value.runId as string,
    generationId: value.generationId as string,
    childId: value.childId as string,
    chatId: value.chatId as string,
    workspaceId: value.workspaceId as string,
    task: value.task,
    reusableAuthority: false,
  };
}

function parseNativeManifest(value: Record<string, unknown>): NativeSubagentPrivateRunManifestV2 | undefined {
  if (
    !exactKeys(value, [
      "version",
      "provenance",
      "runId",
      "generationId",
      "childId",
      "chatId",
      "workspaceId",
      "task",
      "reusableAuthority",
      "authority",
    ]) ||
    value.version !== STORE_VERSION ||
    value.provenance !== "v2_native" ||
    value.reusableAuthority !== false ||
    ![value.runId, value.generationId, value.childId, value.chatId, value.workspaceId].every(isSafeSubagentIdentifier) ||
    typeof value.task !== "string" ||
    value.task.length === 0 ||
    value.task.length > 240 ||
    value.task.includes("\0")
  ) {
    return undefined;
  }
  const authority = parseAuthority(value.authority);
  if (!authority) return undefined;
  return {
    version: STORE_VERSION,
    provenance: "v2_native",
    runId: value.runId as string,
    generationId: value.generationId as string,
    childId: value.childId as string,
    chatId: value.chatId as string,
    workspaceId: value.workspaceId as string,
    task: value.task,
    reusableAuthority: false,
    authority,
  };
}

export function parseMutableSubagentPrivateRunManifestV2(value: unknown): MutableSubagentPrivateRunManifestV2 | undefined {
  if (!isRecord(value)) return undefined;
  return value.provenance === "v1_import" ? parseImportedManifest(value) : value.provenance === "v2_native" ? parseNativeManifest(value) : undefined;
}

function manifestMatchesSnapshot(manifest: MutableSubagentPrivateRunManifestV2, snapshot: SubagentRunSnapshotV2): boolean {
  if (
    manifest.runId !== snapshot.runId ||
    manifest.generationId !== snapshot.generationId ||
    manifest.childId !== snapshot.childId ||
    manifest.chatId !== snapshot.chatId ||
    manifest.workspaceId !== snapshot.workspaceId ||
    manifest.task !== snapshot.taskPreview
  ) {
    return false;
  }
  if (manifest.provenance === "v1_import") return snapshot.authorityRevision === 0;
  const authority = manifest.authority;
  return (
    snapshot.authorityRevision === authority.authorityRevision &&
    snapshot.runId === authority.runId &&
    snapshot.generationId === authority.generationId &&
    snapshot.chatId === authority.chatId &&
    snapshot.workspaceId === authority.workspaceId &&
    snapshot.depth === authority.depth &&
    snapshot.parentRunId === authority.parentRunId &&
    snapshot.execution === authority.execution &&
    snapshot.context === authority.context
  );
}

export function parseMutableSubagentRunDatabaseV2(value: unknown): MutableSubagentRunDatabaseV2 | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "version",
      "storeRevision",
      "migration",
      "snapshots",
      "manifests",
      "approvals",
      "effects",
      "pendingChatDeletions",
      "deletionTransactions",
    ], ["backgroundRuns"]) ||
    value.version !== STORE_VERSION ||
    !positiveInteger(value.storeRevision) ||
    !Array.isArray(value.snapshots) ||
    !Array.isArray(value.manifests) ||
    value.snapshots.length > MAX_STORED_SUBAGENT_RUNS ||
    value.manifests.length !== value.snapshots.length ||
    !Array.isArray(value.approvals) ||
    value.approvals.length > MAX_DURABLE_SUBAGENT_EFFECTS ||
    !Array.isArray(value.effects) ||
    value.effects.length > MAX_DURABLE_SUBAGENT_EFFECTS ||
    value.effects.length !== value.approvals.length ||
    (value.backgroundRuns !== undefined && !Array.isArray(value.backgroundRuns)) ||
    (Array.isArray(value.backgroundRuns) && value.backgroundRuns.length > MAX_STORED_SUBAGENT_RUNS) ||
    !Array.isArray(value.pendingChatDeletions) ||
    value.pendingChatDeletions.length > MAX_SUBAGENT_CHAT_TOMBSTONES ||
    !Array.isArray(value.deletionTransactions) ||
    value.deletionTransactions.length !== 0
  ) {
    return undefined;
  }
  const migration = parseMigration(value.migration);
  const snapshots = value.snapshots.map(parseSubagentRunSnapshotV2);
  const manifests = value.manifests.map(parseMutableSubagentPrivateRunManifestV2);
  const approvals = value.approvals.map(parseDurableSubagentApprovalV2);
  const effects = value.effects.map(parseDurableSubagentEffectV2);
  const backgroundRuns = (value.backgroundRuns ?? []).map(parseBackgroundSubagentRunV2);
  const pending = value.pendingChatDeletions;
  if (
    !migration ||
    snapshots.some((entry) => entry === undefined) ||
    manifests.some((entry) => entry === undefined) ||
    approvals.some((entry) => entry === undefined) ||
    effects.some((entry) => entry === undefined) ||
    backgroundRuns.some((entry) => entry === undefined) ||
    pending.some((chatId) => !isSafeSubagentIdentifier(chatId)) ||
    new Set(pending).size !== pending.length
  ) {
    return undefined;
  }
  const parsedSnapshots = snapshots as SubagentRunSnapshotV2[];
  const parsedManifests = manifests as MutableSubagentPrivateRunManifestV2[];
  const parsedApprovals = approvals as DurableSubagentApprovalV2[];
  const parsedEffects = effects as DurableSubagentEffectV2[];
  const parsedBackgroundRuns = backgroundRuns as BackgroundSubagentRunV2[];
  const snapshotIds = new Set(parsedSnapshots.map(({ runId }) => runId));
  const manifestIds = new Set(parsedManifests.map(({ runId }) => runId));
  const pendingSet = new Set(pending as string[]);
  const snapshotsById = new Map(parsedSnapshots.map((snapshot) => [snapshot.runId, snapshot]));
  const manifestsById = new Map(parsedManifests.map((manifest) => [manifest.runId, manifest]));
  const approvalsById = new Map(parsedApprovals.map((approval) => [approval.approvalId, approval]));
  const effectsById = new Map(parsedEffects.map((effect) => [effect.effectId, effect]));
  const backgroundIds = new Set(parsedBackgroundRuns.map(({ snapshot }) => snapshot.runId));
  if (
    snapshotIds.size !== parsedSnapshots.length ||
    manifestIds.size !== parsedManifests.length ||
    snapshotIds.size !== manifestIds.size ||
    parsedManifests.some((manifest) => {
      const snapshot = snapshotsById.get(manifest.runId);
      return !snapshot || !manifestMatchesSnapshot(manifest, snapshot);
    }) ||
    parsedSnapshots.some(({ chatId }) => pendingSet.has(chatId)) ||
    approvalsById.size !== parsedApprovals.length ||
    effectsById.size !== parsedEffects.length ||
    parsedApprovals.some(({ approvalId }) => effectsById.has(approvalId)) ||
    new Set(parsedApprovals.map(({ effectId }) => effectId)).size !== parsedApprovals.length ||
    new Set(parsedEffects.map(({ approvalId }) => approvalId)).size !== parsedEffects.length ||
    new Set(parsedEffects.map(({ runId, toolCallId }) => `${runId}\0${toolCallId}`)).size !== parsedEffects.length ||
    backgroundIds.size !== parsedBackgroundRuns.length ||
    parsedBackgroundRuns.some((run) => {
      const snapshot = snapshotsById.get(run.snapshot.runId);
      const manifest = manifestsById.get(run.snapshot.runId);
      return !snapshot || !manifest || manifest.provenance !== "v2_native" ||
        !isDeepStrictEqual(snapshot, run.snapshot) || !isDeepStrictEqual(manifest.authority, run.manifest.authority) ||
        manifest.task !== run.manifest.task || pendingSet.has(run.snapshot.chatId);
    }) ||
    parsedEffects.some((effect) => {
      const approval = approvalsById.get(effect.approvalId);
      const manifest = manifestsById.get(effect.runId);
      return (
        !approval ||
        !durableSubagentEffectRecordsMatchV2(approval, effect) ||
        !manifest ||
        manifest.provenance !== "v2_native" ||
        manifest.chatId !== effect.chatId ||
        manifest.childId !== effect.childId ||
        subagentAuthorityDigestV2(manifest.authority) !== effect.authorityDigest ||
        pendingSet.has(effect.chatId)
      );
    })
  ) {
    return undefined;
  }
  return {
    version: STORE_VERSION,
    storeRevision: value.storeRevision,
    migration,
    snapshots: parsedSnapshots,
    manifests: parsedManifests,
    approvals: parsedApprovals,
    effects: parsedEffects,
    backgroundRuns: parsedBackgroundRuns,
    pendingChatDeletions: [...(pending as string[])],
    deletionTransactions: [],
  };
}

function serializedDatabase(database: MutableSubagentRunDatabaseV2): string {
  const parsed = parseMutableSubagentRunDatabaseV2(database);
  if (!parsed || !isDeepStrictEqual(parsed, database)) {
    throw new Error("Invalid mutable subagent V2 database.");
  }
  const serialized = `${JSON.stringify(database, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SUBAGENT_RUN_STORE_BYTES) {
    throw new Error("Subagent V2 history exceeds the private store limit.");
  }
  return serialized;
}

function decode(contents: Buffer): string {
  try {
    return STRICT_UTF8.decode(contents);
  } catch {
    throw new Error("Subagent V2 storage contains unreadable evidence and was preserved.");
  }
}

function parseDurableContents(contents: Buffer): MutableSubagentRunDatabaseV2 {
  if (contents.byteLength > MAX_SUBAGENT_RUN_STORE_BYTES) {
    throw new Error("Subagent V2 storage contains oversized evidence and was preserved.");
  }
  const serialized = decode(contents);
  let value: unknown;
  try {
    assertUniqueJsonObjectKeys(serialized);
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Subagent V2 storage contains unreadable evidence and was preserved.");
  }
  const database = parseMutableSubagentRunDatabaseV2(value);
  if (!database) throw new Error("Subagent V2 storage contains invalid evidence and was preserved.");
  return database;
}

function stableIdentity(left: SubagentRunSnapshotV2, right: SubagentRunSnapshotV2): boolean {
  return (
    left.runId === right.runId &&
    left.groupId === right.groupId &&
    left.generationId === right.generationId &&
    left.childId === right.childId &&
    left.chatId === right.chatId &&
    left.workspaceId === right.workspaceId &&
    left.role === right.role &&
    left.label === right.label &&
    left.taskPreview === right.taskPreview &&
    left.startedAt === right.startedAt &&
    left.modelId === right.modelId &&
    left.parentRunId === right.parentRunId &&
    left.retryOfRunId === right.retryOfRunId &&
    left.depth === right.depth &&
    left.execution === right.execution &&
    left.context === right.context &&
    left.authorityRevision === right.authorityRevision
  );
}

function validProgression(existing: SubagentRunSnapshotV2, next: SubagentRunSnapshotV2): boolean {
  const existingMilestones = existing.milestones ?? [];
  const nextMilestones = next.milestones ?? [];
  if (
    !ACTIVE_STATES.has(existing.state) ||
    next.updatedAt < existing.updatedAt ||
    next.turns < existing.turns ||
    next.tools < existing.tools ||
    next.tokens < existing.tokens ||
    nextMilestones.length < existingMilestones.length ||
    existingMilestones.some((milestone, index) => nextMilestones[index] !== milestone) ||
    !subagentProjectionNoticesAreMonotonic(
      existing.projectionNotices,
      next.projectionNotices,
      !ACTIVE_STATES.has(next.state),
    )
  ) {
    return false;
  }
  if (existing.state === "queued") return true;
  if (existing.state === "starting") return next.state !== "queued";
  return next.state !== "queued" && next.state !== "starting";
}

function newestFirst(values: readonly SubagentRunSnapshotV2[]): SubagentRunSnapshotV2[] {
  return [...values].sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision || left.runId.localeCompare(right.runId));
}

function interrupt(snapshot: SubagentRunSnapshotV2, now: number): SubagentRunSnapshotV2 {
  if (!ACTIVE_STATES.has(snapshot.state)) return snapshot;
  if (snapshot.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Active subagent V2 evidence cannot be reconciled losslessly.");
  }
  const interrupted = parseSubagentRunSnapshotV2({
    ...snapshot,
    revision: snapshot.revision + 1,
    state: "interrupted",
    activity: "Interrupted after Aiden restarted.",
    updatedAt: Math.max(snapshot.updatedAt, now),
    finishedAt: Math.max(snapshot.updatedAt, now),
  });
  if (!interrupted) throw new Error("Active subagent V2 evidence cannot be reconciled losslessly.");
  return interrupted;
}

const STARTUP_CANCELLED_EFFECT_DIGEST = subagentEffectEvidenceDigestV2(
  "startup_cancelled_before_dispatch",
);
const STARTUP_UNKNOWN_EFFECT_DIGEST = subagentEffectEvidenceDigestV2(
  "startup_dispatch_outcome_unknown",
);
const EXPLICIT_CANCELLED_EFFECT_DIGEST = subagentEffectEvidenceDigestV2(
  "cancelled_before_dispatch",
);
const TERMINAL_WRITE_UNKNOWN_EFFECT_DIGEST = subagentEffectEvidenceDigestV2(
  "terminal_persistence_failed_outcome_unknown",
);

function effectOwnerMatches(
  effect: DurableSubagentEffectV2,
  owner: DurableSubagentEffectOwnerV2,
): boolean {
  return (
    effect.effectId === owner.effectId &&
    effect.approvalId === owner.approvalId &&
    effect.runId === owner.runId &&
    effect.chatId === owner.chatId
  );
}

function reconcileEffectsAfterRestart(
  database: MutableSubagentRunDatabaseV2,
  restartTime: number,
): Pick<MutableSubagentRunDatabaseV2, "approvals" | "effects"> | undefined {
  let changed = false;
  const effects = database.effects.map((effect) => {
    if (effect.state !== "prepared" && effect.state !== "authorized" && effect.state !== "dispatch_started") {
      return effect;
    }
    changed = true;
    const updatedAt = Math.max(effect.updatedAt, restartTime);
    return effect.state === "dispatch_started"
      ? { ...effect, state: "unknown" as const, updatedAt, terminalDigest: STARTUP_UNKNOWN_EFFECT_DIGEST }
      : { ...effect, state: "cancelled_before_dispatch" as const, updatedAt, terminalDigest: STARTUP_CANCELLED_EFFECT_DIGEST };
  });
  if (!changed) return undefined;
  const effectsByApproval = new Map(effects.map((effect) => [effect.approvalId, effect]));
  const approvals = database.approvals.map((approval) => {
    const effect = effectsByApproval.get(approval.approvalId)!;
    return {
      ...approval,
      state: effect.state === "cancelled_before_dispatch" ? "cancelled" as const : "consumed" as const,
      updatedAt: effect.updatedAt,
    };
  });
  return { approvals, effects };
}

export function createSubagentRunStoreV2(
  resolveDirectory: () => Promise<string>,
  options: SubagentRunStoreV2Options = {},
) {
  const maxRuns = options.maxRuns ?? MAX_STORED_SUBAGENT_RUNS;
  if (!positiveInteger(maxRuns) || maxRuns > MAX_STORED_SUBAGENT_RUNS) {
    throw new Error("Invalid subagent V2 history limit.");
  }
  const now = options.now ?? Date.now;
  const storageFactory = options.storageFactory ?? createNativeSubagentRunStoreStorage;
  let storagePromise: Promise<SubagentRunStoreStorage> | undefined;
  let operationTail: Promise<void> = Promise.resolve();
  let initialized = false;
  const deletedChats = new Set<string>();
  const localDeletionAttempts = new Set<string>();
  const runReservations = new Set<string>();
  const localUnknownEffects = new Map<string, DurableSubagentEffectV2>();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function storage(): Promise<SubagentRunStoreStorage> {
    if (!storagePromise) {
      storagePromise = resolveDirectory().then((directory) => {
        if (!directory.startsWith("/")) throw new Error("Subagent V2 storage requires an absolute directory.");
        return storageFactory(directory);
      });
    }
    return storagePromise;
  }

  function requireInitialized(): void {
    if (!initialized) throw new Error("Subagent V2 storage is not initialized.");
  }

  function currentTime(): number {
    const value = now();
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid subagent V2 store clock.");
    return value;
  }

  async function read(): Promise<{ database: MutableSubagentRunDatabaseV2; generation: SubagentRunStoreGeneration }> {
    const durable = await (await storage()).read();
    if (durable.status === "missing") throw new Error("Committed subagent V2 storage is missing.");
    if (durable.status === "oversized") throw new Error("Subagent V2 storage contains oversized evidence and was preserved.");
    const database = parseDurableContents(durable.contents);
    if (database.migration.status !== "committed") {
      throw new Error("Subagent V2 storage is not committed.");
    }
    for (const [effectId, local] of localUnknownEffects) {
      const persisted = database.effects.find((effect) => effect.effectId === effectId);
      if (persisted && isDurableSubagentEffectTerminalV2(persisted.state)) {
        localUnknownEffects.delete(effectId);
      } else if (!persisted || !effectOwnerMatches(persisted, local)) {
        localUnknownEffects.delete(effectId);
      }
    }
    const durableDeletions = new Set(database.pendingChatDeletions);
    for (const chatId of durableDeletions) deletedChats.add(chatId);
    for (const chatId of deletedChats) {
      if (!durableDeletions.has(chatId) && !localDeletionAttempts.has(chatId)) {
        deletedChats.delete(chatId);
      }
    }
    return { database, generation: durable.generation };
  }

  async function write(expected: SubagentRunStoreGeneration, database: MutableSubagentRunDatabaseV2): Promise<void> {
    await (await storage()).write(expected, serializedDatabase(database));
  }

  async function mutate(
    transform: (database: MutableSubagentRunDatabaseV2) => MutableSubagentRunDatabaseV2 | undefined,
  ): Promise<MutableSubagentRunDatabaseV2> {
    for (let attempt = 0; attempt <= MAX_NATIVE_GENERATION_CONFLICT_RETRIES; attempt += 1) {
      const current = await read();
      const next = transform(current.database);
      if (!next) return current.database;
      try {
        await write(current.generation, next);
        return next;
      } catch (error) {
        if (!(error instanceof SubagentRunStoreStorageError) || error.failure !== "destination_changed" || attempt >= MAX_NATIVE_GENERATION_CONFLICT_RETRIES) {
          throw error;
        }
      }
    }
    throw new Error("Subagent V2 storage could not merge a newer generation.");
  }

  async function transitionEffect(
    value: unknown,
    expectedState: DurableSubagentEffectStateV2,
    nextState: DurableSubagentEffectStateV2,
    approvalState: DurableSubagentApprovalV2["state"],
  ): Promise<DurableSubagentEffectV2> {
    const owner = parseDurableSubagentEffectOwnerV2(value);
    if (!owner) throw new Error("Invalid durable subagent V2 effect owner.");
    return serialized(async () => {
      requireInitialized();
      const updatedAt = currentTime();
      let transitioned: DurableSubagentEffectV2 | undefined;
      let expiredBeforeDispatch = false;
      await mutate((database) => {
        const effectIndex = database.effects.findIndex(({ effectId }) => effectId === owner.effectId);
        const effect = database.effects[effectIndex];
        if (!effect || !effectOwnerMatches(effect, owner)) {
          throw new Error("Durable subagent V2 effect ownership mismatch.");
        }
        if (effect.state !== expectedState) {
          throw new Error(`Durable subagent V2 effect cannot move from ${effect.state} to ${nextState}.`);
        }
        const approvalIndex = database.approvals.findIndex(({ approvalId }) => approvalId === owner.approvalId);
        const approval = database.approvals[approvalIndex]!;
        if (expectedState === "prepared" && approval.expiresAt <= updatedAt) {
          throw new Error("Durable subagent V2 approval expired before authorization.");
        }
        if (expectedState === "authorized" && approval.expiresAt <= updatedAt) {
          expiredBeforeDispatch = true;
          transitioned = {
            ...effect,
            state: "cancelled_before_dispatch",
            updatedAt: Math.max(effect.updatedAt, updatedAt),
            terminalDigest: EXPLICIT_CANCELLED_EFFECT_DIGEST,
          };
          const approvals = [...database.approvals];
          approvals[approvalIndex] = {
            ...approval,
            state: "cancelled",
            updatedAt: transitioned.updatedAt,
          };
          const effects = [...database.effects];
          effects[effectIndex] = transitioned;
          return {
            ...database,
            storeRevision: database.storeRevision + 1,
            approvals,
            effects,
          };
        }
        transitioned = {
          ...effect,
          state: nextState,
          updatedAt: Math.max(effect.updatedAt, updatedAt),
        };
        const approvals = [...database.approvals];
        approvals[approvalIndex] = { ...approval, state: approvalState, updatedAt: transitioned.updatedAt };
        const effects = [...database.effects];
        effects[effectIndex] = transitioned;
        return { ...database, storeRevision: database.storeRevision + 1, approvals, effects };
      });
      if (expiredBeforeDispatch) {
        throw new Error("Durable subagent V2 approval expired before dispatch.");
      }
      return structuredClone(transitioned!);
    });
  }

  function nativeManifestForBackground(run: BackgroundSubagentRunV2): NativeSubagentPrivateRunManifestV2 {
    return {
      version: STORE_VERSION,
      provenance: "v2_native",
      runId: run.snapshot.runId,
      generationId: run.snapshot.generationId,
      childId: run.snapshot.childId,
      chatId: run.snapshot.chatId,
      workspaceId: run.snapshot.workspaceId,
      task: run.manifest.task,
      reusableAuthority: false,
      authority: run.manifest.authority,
    };
  }

  const background: BackgroundSubagentStoreV2 = {
    async get(runId) {
      if (!isSafeSubagentIdentifier(runId)) return null;
      return serialized(async () => {
        requireInitialized();
        const run = (await read()).database.backgroundRuns.find(
          (candidate) => candidate.snapshot.runId === runId,
        );
        return run && !deletedChats.has(run.snapshot.chatId) ? structuredClone(run) : null;
      });
    },

    async list() {
      return serialized(async () => {
        requireInitialized();
        return (await read()).database.backgroundRuns
          .filter((run) => !deletedChats.has(run.snapshot.chatId))
          .map((run) => structuredClone(run));
      });
    },

    async put(value, expectedRevision) {
      const run = parseBackgroundSubagentRunV2(value);
      if (!run || (expectedRevision !== null && (!positiveInteger(expectedRevision)))) {
        throw new Error("Invalid private background lifecycle record.");
      }
      return serialized(async () => {
        requireInitialized();
        if (deletedChats.has(run.snapshot.chatId)) {
          throw new Error("Background lifecycle is no longer available for this chat.");
        }
        let applied = false;
        await mutate((database) => {
          const currentIndex = database.backgroundRuns.findIndex(
            (candidate) => candidate.snapshot.runId === run.snapshot.runId,
          );
          const current = database.backgroundRuns[currentIndex];
          if (
            expectedRevision === null
              ? current !== undefined || database.snapshots.some(({ runId }) => runId === run.snapshot.runId)
              : !current || current.snapshot.revision !== expectedRevision
          ) {
            applied = false;
            return undefined;
          }
          const manifest = nativeManifestForBackground(run);
          if (current) {
            const existingSnapshot = database.snapshots.find(
              ({ runId }) => runId === run.snapshot.runId,
            );
            const existingManifest = database.manifests.find(
              ({ runId }) => runId === run.snapshot.runId,
            );
            if (
              !existingSnapshot ||
              !existingManifest ||
              !stableIdentity(existingSnapshot, run.snapshot) ||
              !isDeepStrictEqual(existingManifest, manifest) ||
              !validProgression(existingSnapshot, run.snapshot)
            ) {
              throw new Error("Background lifecycle identity or progression changed.");
            }
          } else if (database.snapshots.length >= maxRuns) {
            throw new Error("Subagent V2 history is at capacity.");
          }
          applied = true;
          const snapshots = newestFirst([
            run.snapshot,
            ...database.snapshots.filter(({ runId }) => runId !== run.snapshot.runId),
          ]);
          const manifests = [
            manifest,
            ...database.manifests.filter(({ runId }) => runId !== run.snapshot.runId),
          ];
          const backgroundRuns = [
            run,
            ...database.backgroundRuns.filter(
              (candidate) => candidate.snapshot.runId !== run.snapshot.runId,
            ),
          ];
          return {
            ...database,
            storeRevision: database.storeRevision + 1,
            snapshots,
            manifests,
            backgroundRuns,
          };
        });
        return applied;
      });
    },
  };

  return {
    background,
    async reserveRun(runId: string): Promise<void> {
      if (!isSafeSubagentIdentifier(runId)) {
        throw new Error("Invalid subagent V2 run reservation.");
      }
      await serialized(async () => {
        requireInitialized();
        if (runReservations.has(runId)) return;
        const { database } = await read();
        if (database.snapshots.some((snapshot) => snapshot.runId === runId)) {
          throw new Error("Subagent V2 run identity was reused.");
        }
        if (database.snapshots.length + runReservations.size >= maxRuns) {
          throw new Error(
            "Subagent V2 history is at capacity. Delete an older chat before starting more delegated work.",
          );
        }
        runReservations.add(runId);
      });
    },

    releaseRunReservation(runId: string): void {
      runReservations.delete(runId);
    },

    async initialize(): Promise<void> {
      await serialized(async () => {
        if (initialized) return;
        await (await storage()).cleanup();
        const restartTime = currentTime();
        await mutate((database) => {
          const snapshots = database.snapshots.map((snapshot) => interrupt(snapshot, restartTime));
          const snapshotsByRunId = new Map(snapshots.map((snapshot) => [snapshot.runId, snapshot]));
          const backgroundRuns = database.backgroundRuns.map((run) => {
            const snapshot = snapshotsByRunId.get(run.snapshot.runId)!;
            if (snapshot === run.snapshot) return run;
            const nextEvent = {
              sequence: (run.events[run.events.length - 1]?.sequence ?? 0) + 1,
              at: snapshot.updatedAt,
              kind: "reconciled" as const,
              state: snapshot.state,
            };
            return {
              ...run,
              snapshot,
              events:
                run.events.length >= MAX_BACKGROUND_EVENTS_V2
                  ? [...run.events.slice(1), nextEvent]
                  : [...run.events, nextEvent],
            };
          });
          const reconciledEffects = reconcileEffectsAfterRestart(database, restartTime);
          if (
            snapshots.every((snapshot, index) => snapshot === database.snapshots[index]) &&
            backgroundRuns.every((run, index) => run === database.backgroundRuns[index]) &&
            !reconciledEffects
          ) return undefined;
          return {
            ...database,
            storeRevision: database.storeRevision + 1,
            snapshots,
            backgroundRuns,
            ...(reconciledEffects ?? {}),
          };
        });
        initialized = true;
      });
    },

    async upsert(value: unknown, manifestValue: unknown): Promise<SubagentRunSnapshotV2> {
      const snapshot = parseSubagentRunSnapshotV2(value);
      const manifest = parseMutableSubagentPrivateRunManifestV2(manifestValue);
      if (!snapshot || !manifest || !manifestMatchesSnapshot(manifest, snapshot)) {
        throw new Error("Invalid subagent V2 run and manifest.");
      }
      return serialized(async () => {
        requireInitialized();
        if (deletedChats.has(snapshot.chatId)) throw new Error("Subagent history is no longer available for this chat.");
        await mutate((database) => {
          if (database.pendingChatDeletions.includes(snapshot.chatId)) {
            deletedChats.add(snapshot.chatId);
            throw new Error("Subagent history is no longer available for this chat.");
          }
          const existingIndex = database.snapshots.findIndex(({ runId }) => runId === snapshot.runId);
          if (existingIndex >= 0) {
            const existing = database.snapshots[existingIndex]!;
            const existingManifest = database.manifests.find(({ runId }) => runId === snapshot.runId)!;
            if (!stableIdentity(existing, snapshot) || !isDeepStrictEqual(existingManifest, manifest)) {
              throw new Error("Subagent V2 run identity or authority cannot change.");
            }
            if (snapshot.revision <= existing.revision) {
              if (isDeepStrictEqual(snapshot, existing)) return undefined;
              throw new Error("Subagent V2 run revisions must increase monotonically.");
            }
            if (!validProgression(existing, snapshot)) throw new Error("Subagent V2 lifecycle cannot move backward.");
          } else if (
            database.snapshots.length +
              runReservations.size -
              (runReservations.has(snapshot.runId) ? 1 : 0) >=
            maxRuns
          ) {
            throw new Error("Subagent V2 history is at capacity. Delete an older chat before starting more delegated work.");
          }
          const snapshots = newestFirst([snapshot, ...database.snapshots.filter(({ runId }) => runId !== snapshot.runId)]);
          const manifests = [manifest, ...database.manifests.filter(({ runId }) => runId !== snapshot.runId)];
          return { ...database, storeRevision: database.storeRevision + 1, snapshots, manifests };
        });
        runReservations.delete(snapshot.runId);
        return structuredClone(snapshot);
      });
    },

    async get(runId: string): Promise<SubagentRunSnapshotV2 | null> {
      if (!isSafeSubagentIdentifier(runId)) return null;
      return serialized(async () => {
        requireInitialized();
        const { database } = await read();
        const snapshot = database.snapshots.find((entry) => entry.runId === runId);
        return snapshot && !deletedChats.has(snapshot.chatId) ? structuredClone(snapshot) : null;
      });
    },

    async listByChat(chatId: string): Promise<SubagentRunSnapshotV2[]> {
      if (!isSafeSubagentIdentifier(chatId)) return [];
      return serialized(async () => {
        requireInitialized();
        const { database } = await read();
        if (deletedChats.has(chatId)) return [];
        return newestFirst(database.snapshots.filter((snapshot) => snapshot.chatId === chatId)).map((snapshot) => structuredClone(snapshot));
      });
    },

    async prepareEffect(value: unknown): Promise<DurableSubagentEffectV2> {
      const input = parsePrepareDurableSubagentEffectV2Input(value);
      if (!input) throw new Error("Invalid durable subagent V2 effect preparation.");
      return serialized(async () => {
        requireInitialized();
        const preparedAt = currentTime();
        if (input.expiresAt <= preparedAt) throw new Error("Durable subagent V2 approval is already expired.");
        let prepared: DurableSubagentEffectV2 | undefined;
        await mutate((database) => {
          if (database.pendingChatDeletions.includes(input.chatId) || deletedChats.has(input.chatId)) {
            throw new Error("Subagent history is no longer available for this chat.");
          }
          const manifest = database.manifests.find(({ runId }) => runId === input.runId);
          if (
            !manifest ||
            manifest.provenance !== "v2_native" ||
            manifest.chatId !== input.chatId ||
            manifest.childId !== input.childId ||
            subagentAuthorityDigestV2(manifest.authority) !== input.authorityDigest
          ) {
            throw new Error("Durable subagent V2 effect ownership does not match its run.");
          }
          if (database.effects.length >= MAX_DURABLE_SUBAGENT_EFFECTS) {
            throw new Error("Durable subagent V2 effect history is at capacity.");
          }
          if (
            input.approvalId === input.effectId ||
            database.effects.some((effect) =>
              effect.effectId === input.effectId ||
              effect.approvalId === input.approvalId ||
              effect.effectId === input.approvalId ||
              effect.approvalId === input.effectId ||
              (effect.runId === input.runId && effect.toolCallId === input.toolCallId)
            )
          ) {
            throw new Error("Durable subagent V2 effect identity was reused.");
          }
          const approval: DurableSubagentApprovalV2 = {
            version: 1,
            approvalId: input.approvalId,
            effectId: input.effectId,
            runId: input.runId,
            chatId: input.chatId,
            childId: input.childId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            state: "prepared",
            argumentDigest: input.argumentDigest,
            effectDigest: input.effectDigest,
            authorityDigest: input.authorityDigest,
            createdAt: preparedAt,
            updatedAt: preparedAt,
            expiresAt: input.expiresAt,
          };
          prepared = {
            version: 1,
            effectId: input.effectId,
            approvalId: input.approvalId,
            runId: input.runId,
            chatId: input.chatId,
            childId: input.childId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            effectKind: input.effectKind,
            state: "prepared",
            argumentDigest: input.argumentDigest,
            effectDigest: input.effectDigest,
            authorityDigest: input.authorityDigest,
            preparedAt,
            updatedAt: preparedAt,
          };
          return {
            ...database,
            storeRevision: database.storeRevision + 1,
            approvals: [...database.approvals, approval],
            effects: [...database.effects, prepared],
          };
        });
        return structuredClone(prepared!);
      });
    },

    async authorizeEffect(value: unknown): Promise<DurableSubagentEffectV2> {
      return transitionEffect(value, "prepared", "authorized", "authorized");
    },

    async markEffectDispatchStarted(value: unknown): Promise<DurableSubagentEffectV2> {
      return transitionEffect(value, "authorized", "dispatch_started", "consumed");
    },

    async cancelEffectBeforeDispatch(value: unknown): Promise<DurableSubagentEffectV2> {
      const owner = parseDurableSubagentEffectOwnerV2(value);
      if (!owner) throw new Error("Invalid durable subagent V2 effect owner.");
      return serialized(async () => {
        requireInitialized();
        const updatedAt = currentTime();
        let cancelled: DurableSubagentEffectV2 | undefined;
        await mutate((database) => {
          const effectIndex = database.effects.findIndex(({ effectId }) => effectId === owner.effectId);
          const effect = database.effects[effectIndex];
          if (!effect || !effectOwnerMatches(effect, owner)) throw new Error("Durable subagent V2 effect ownership mismatch.");
          if (effect.state !== "prepared" && effect.state !== "authorized") {
            throw new Error("Durable subagent V2 effect cannot be cancelled after dispatch.");
          }
          cancelled = {
            ...effect,
            state: "cancelled_before_dispatch",
            updatedAt: Math.max(effect.updatedAt, updatedAt),
            terminalDigest: EXPLICIT_CANCELLED_EFFECT_DIGEST,
          };
          const approvalIndex = database.approvals.findIndex(({ approvalId }) => approvalId === owner.approvalId);
          const approvals = [...database.approvals];
          approvals[approvalIndex] = { ...approvals[approvalIndex]!, state: "cancelled", updatedAt: cancelled.updatedAt };
          const effects = [...database.effects];
          effects[effectIndex] = cancelled;
          return { ...database, storeRevision: database.storeRevision + 1, approvals, effects };
        });
        return structuredClone(cancelled!);
      });
    },

    async finishEffect(value: unknown): Promise<DurableSubagentEffectV2> {
      const input = parseFinishDurableSubagentEffectV2Input(value);
      if (!input) throw new Error("Invalid durable subagent V2 effect completion.");
      let dispatched: DurableSubagentEffectV2 | undefined;
      try {
        return await serialized(async () => {
          requireInitialized();
          await read();
          const existingUnknown = localUnknownEffects.get(input.effectId);
          if (existingUnknown) {
            if (!effectOwnerMatches(existingUnknown, input)) {
              throw new Error("Durable subagent V2 effect ownership mismatch.");
            }
            return structuredClone(existingUnknown);
          }
          const updatedAt = currentTime();
          let finished: DurableSubagentEffectV2 | undefined;
          await mutate((database) => {
            const effectIndex = database.effects.findIndex(({ effectId }) => effectId === input.effectId);
            const effect = database.effects[effectIndex];
            if (!effect || !effectOwnerMatches(effect, input)) throw new Error("Durable subagent V2 effect ownership mismatch.");
            if (effect.state !== "dispatch_started") {
              throw new Error("Durable subagent V2 effect must be dispatch-started before completion.");
            }
            dispatched = structuredClone(effect);
            finished = {
              ...effect,
              state: input.state,
              updatedAt: Math.max(effect.updatedAt, updatedAt),
              terminalDigest: input.terminalDigest,
            };
            const approvalIndex = database.approvals.findIndex(({ approvalId }) => approvalId === input.approvalId);
            const approvals = [...database.approvals];
            approvals[approvalIndex] = { ...approvals[approvalIndex]!, updatedAt: finished.updatedAt };
            const effects = [...database.effects];
            effects[effectIndex] = finished;
            return { ...database, storeRevision: database.storeRevision + 1, approvals, effects };
          });
          localUnknownEffects.delete(input.effectId);
          return structuredClone(finished!);
        });
      } catch (error) {
        if (dispatched) {
          const failureTime = currentTime();
          const unknown: DurableSubagentEffectV2 = {
            ...dispatched,
            state: "unknown",
            updatedAt: Math.max(dispatched.updatedAt, failureTime),
            terminalDigest: TERMINAL_WRITE_UNKNOWN_EFFECT_DIGEST,
          };
          try {
            await serialized(async () => {
              requireInitialized();
              const persisted = (await read()).database.effects.find(
                ({ effectId }) => effectId === input.effectId,
              );
              if (
                !persisted ||
                !effectOwnerMatches(persisted, input) ||
                !isDurableSubagentEffectTerminalV2(persisted.state)
              ) {
                localUnknownEffects.set(input.effectId, unknown);
              }
            });
          } catch {
            localUnknownEffects.set(input.effectId, unknown);
          }
        }
        throw error;
      }
    },

    async getEffect(value: unknown): Promise<DurableSubagentEffectV2 | null> {
      const owner = parseDurableSubagentEffectOwnerV2(value);
      if (!owner) return null;
      return serialized(async () => {
        requireInitialized();
        const { database } = await read();
        const local = localUnknownEffects.get(owner.effectId);
        if (local) return effectOwnerMatches(local, owner) ? structuredClone(local) : null;
        const effect = database.effects.find(({ effectId }) => effectId === owner.effectId);
        return effect && effectOwnerMatches(effect, owner) ? structuredClone(effect) : null;
      });
    },

    async listEffectsByChat(chatId: string): Promise<DurableSubagentEffectV2[]> {
      if (!isSafeSubagentIdentifier(chatId) || deletedChats.has(chatId)) return [];
      return serialized(async () => {
        requireInitialized();
        const durable = (await read()).database.effects.filter((effect) => effect.chatId === chatId);
        return durable.map((effect) => structuredClone(localUnknownEffects.get(effect.effectId) ?? effect));
      });
    },

    async listEffectActivityForRun(runId: string, chatId: string) {
      if (!isSafeSubagentIdentifier(runId) || !isSafeSubagentIdentifier(chatId)) return [];
      return serialized(async () => {
        requireInitialized();
        const { database } = await read();
        const snapshot = database.snapshots.find((entry) => entry.runId === runId);
        if (!snapshot || snapshot.chatId !== chatId || deletedChats.has(chatId)) return [];
        return database.effects
          .filter((effect) => effect.runId === runId && effect.chatId === chatId)
          .map((effect) => localUnknownEffects.get(effect.effectId) ?? effect)
          .sort((left, right) => left.updatedAt - right.updatedAt || left.effectId.localeCompare(right.effectId))
          .map(projectDurableSubagentEffectActivityV1);
      });
    },

    async preflightChatDeletion(chatId: string): Promise<void> {
      if (!isSafeSubagentIdentifier(chatId)) {
        throw new Error("Invalid subagent V2 chat deletion.");
      }
      await serialized(async () => {
        requireInitialized();
        const { database } = await read();
        if (
          database.effects.some((effect) => {
            if (effect.chatId !== chatId) return false;
            const local = localUnknownEffects.get(effect.effectId);
            return !local && !isDurableSubagentEffectTerminalV2(effect.state);
          })
        ) {
          throw new Error("Subagent V2 chat has active durable effects and cannot be deleted.");
        }
      });
    },

    async deleteChat(chatId: string): Promise<void> {
      if (!isSafeSubagentIdentifier(chatId)) return;
      deletedChats.add(chatId);
      localDeletionAttempts.add(chatId);
      try {
        await serialized(async () => {
          requireInitialized();
          await mutate((database) => {
            if (database.effects.some((effect) => {
              if (effect.chatId !== chatId) return false;
              const local = localUnknownEffects.get(effect.effectId);
              return !local && !isDurableSubagentEffectTerminalV2(effect.state);
            })) {
              throw new Error("Subagent V2 chat has active durable effects and cannot be deleted.");
            }
          const snapshots = database.snapshots.filter((snapshot) => snapshot.chatId !== chatId);
          const manifests = database.manifests.filter((manifest) => manifest.chatId !== chatId);
          const approvals = database.approvals.filter((approval) => approval.chatId !== chatId);
          const effects = database.effects.filter((effect) => effect.chatId !== chatId);
          const backgroundRuns = database.backgroundRuns.filter(
            (run) => run.snapshot.chatId !== chatId,
          );
          const pendingChatDeletions = database.pendingChatDeletions.includes(chatId)
            ? database.pendingChatDeletions
            : [...database.pendingChatDeletions, chatId];
          if (pendingChatDeletions.length > MAX_SUBAGENT_CHAT_TOMBSTONES) throw new Error("Too many subagent V2 history deletions are pending.");
          if (snapshots.length === database.snapshots.length && pendingChatDeletions === database.pendingChatDeletions) return undefined;
          return { ...database, storeRevision: database.storeRevision + 1, snapshots, manifests, approvals, effects, backgroundRuns, pendingChatDeletions };
          });
          for (const [effectId, effect] of localUnknownEffects) {
            if (effect.chatId === chatId) localUnknownEffects.delete(effectId);
          }
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("active durable effects")) {
          deletedChats.delete(chatId);
          localDeletionAttempts.delete(chatId);
        }
        throw error;
      }
      // A rejected write deliberately leaves the local tombstone installed:
      // its durable result may be indeterminate until restart or completion.
      localDeletionAttempts.delete(chatId);
    },

    async pendingChatDeletions(): Promise<string[]> {
      return serialized(async () => {
        requireInitialized();
        return [...(await read()).database.pendingChatDeletions];
      });
    },

    async completeChatDeletion(chatId: string): Promise<void> {
      if (!isSafeSubagentIdentifier(chatId)) return;
      await serialized(async () => {
        requireInitialized();
        await mutate((database) => {
          const pendingChatDeletions = database.pendingChatDeletions.filter((pending) => pending !== chatId);
          if (pendingChatDeletions.length === database.pendingChatDeletions.length) return undefined;
          return { ...database, storeRevision: database.storeRevision + 1, pendingChatDeletions };
        });
        deletedChats.delete(chatId);
        localDeletionAttempts.delete(chatId);
      });
    },

    /**
     * Advance the frozen V1 checkpoint after an intentional rollback-journal
     * mutation. The coordinator must obtain this from a fresh raw V1 read.
     */
    async updateV1Checkpoint(value: SubagentRunStoreV1CheckpointV2): Promise<void> {
      if (
        (value.source !== "missing" && value.source !== "v1") ||
        !safeGeneration(value.sourceGeneration) ||
        !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
        (value.source === "missing" && value.sourceGeneration !== "missing") ||
        (value.source === "v1" && value.sourceGeneration === "missing")
      ) {
        throw new Error("Invalid subagent V1 checkpoint.");
      }
      await serialized(async () => {
        requireInitialized();
        await mutate((database) => {
          if (
            database.migration.source === value.source &&
            database.migration.sourceGeneration === value.sourceGeneration &&
            database.migration.sourceSha256 === value.sourceSha256
          ) {
            return undefined;
          }
          return {
            ...database,
            storeRevision: database.storeRevision + 1,
            migration: {
              ...database.migration,
              source: value.source,
              sourceGeneration: value.sourceGeneration,
              sourceSha256: value.sourceSha256,
            },
          };
        });
      });
    },

    async flush(): Promise<void> {
      await operationTail;
    },

    async close(): Promise<void> {
      await operationTail;
      if (storagePromise) await (await storagePromise).close();
    },
  };
}

export type SubagentRunStoreV2 = ReturnType<typeof createSubagentRunStoreV2>;
