import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  adaptSubagentRunSnapshotV1ToV2,
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV2,
} from "../../../renderer/shared/subagent-runs.js";
import {
  MAX_SUBAGENT_RUN_STORE_BYTES,
  assertUniqueJsonObjectKeys,
  parseSubagentRunDatabaseV1ForMigration,
} from "./subagent-run-store-core.js";
import type {
  SubagentRunStoreGeneration,
  SubagentRunStoreReadResult,
  SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";
import {
  parseMutableSubagentRunDatabaseV2,
  type MutableSubagentRunDatabaseV2,
} from "./subagent-run-store-v2-core.js";

const STORE_VERSION_V2 = 2 as const;
const MIGRATION_ADAPTER_VERSION = 1 as const;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface SubagentRunMigrationV2 {
  status: "prepared" | "committed";
  adapterVersion: typeof MIGRATION_ADAPTER_VERSION;
  source: "missing" | "v1";
  sourceGeneration: SubagentRunStoreGeneration;
  sourceSha256: string;
  migratedAt: number;
}

export interface SubagentPrivateRunManifestV2 {
  version: typeof STORE_VERSION_V2;
  provenance: "v1_import";
  runId: string;
  generationId: string;
  childId: string;
  chatId: string;
  workspaceId: string;
  task: string;
  reusableAuthority: false;
}

export interface SubagentRunDatabaseV2 {
  version: typeof STORE_VERSION_V2;
  storeRevision: number;
  migration: SubagentRunMigrationV2;
  snapshots: SubagentRunSnapshotV2[];
  manifests: SubagentPrivateRunManifestV2[];
  approvals: [];
  effects: [];
  pendingChatDeletions: string[];
  deletionTransactions: [];
}

interface V1Checkpoint {
  source: "missing" | "v1";
  generation: SubagentRunStoreGeneration;
  sha256: string;
  serialized?: string;
}

export interface SubagentRunStoreV1CheckpointEvidenceV2 {
  source: "missing" | "v1";
  sourceGeneration: SubagentRunStoreGeneration;
  sourceSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function safeGeneration(value: unknown): value is SubagentRunStoreGeneration {
  return (
    value === "missing" ||
    (typeof value === "string" && /^[0-9a-f]+(?:-[0-9a-f]+){8}$/u.test(value))
  );
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseMigration(value: unknown): SubagentRunMigrationV2 | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "status",
      "adapterVersion",
      "source",
      "sourceGeneration",
      "sourceSha256",
      "migratedAt",
    ]) ||
    (value.status !== "prepared" && value.status !== "committed") ||
    value.adapterVersion !== MIGRATION_ADAPTER_VERSION ||
    (value.source !== "missing" && value.source !== "v1") ||
    !safeGeneration(value.sourceGeneration) ||
    typeof value.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
    !safeTimestamp(value.migratedAt) ||
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

function parseManifest(value: unknown): SubagentPrivateRunManifestV2 | undefined {
  if (
    !isRecord(value) ||
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
    value.version !== STORE_VERSION_V2 ||
    value.provenance !== "v1_import" ||
    ![value.runId, value.generationId, value.childId, value.chatId, value.workspaceId].every(
      isSafeSubagentIdentifier,
    ) ||
    typeof value.task !== "string" ||
    value.task.trim().length === 0 ||
    value.task.length > 8_000 ||
    value.task.includes("\0") ||
    value.reusableAuthority !== false
  ) {
    return undefined;
  }
  return {
    version: STORE_VERSION_V2,
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

export function parseSubagentRunDatabaseV2(value: unknown): SubagentRunDatabaseV2 | undefined {
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
    ]) ||
    value.version !== STORE_VERSION_V2 ||
    !Number.isSafeInteger(value.storeRevision) ||
    (value.storeRevision as number) < 1 ||
    !Array.isArray(value.snapshots) ||
    !Array.isArray(value.manifests) ||
    value.snapshots.length > 512 ||
    value.manifests.length !== value.snapshots.length ||
    !Array.isArray(value.approvals) ||
    value.approvals.length !== 0 ||
    !Array.isArray(value.effects) ||
    value.effects.length !== 0 ||
    !Array.isArray(value.pendingChatDeletions) ||
    !Array.isArray(value.deletionTransactions) ||
    value.deletionTransactions.length !== 0
  ) {
    return undefined;
  }
  const migration = parseMigration(value.migration);
  const snapshots = value.snapshots.map(parseSubagentRunSnapshotV2);
  const manifests = value.manifests.map(parseManifest);
  if (
    !migration ||
    snapshots.some((snapshot) => snapshot === undefined) ||
    manifests.some((manifest) => manifest === undefined) ||
    value.pendingChatDeletions.length > 512 ||
    value.pendingChatDeletions.some((chatId) => !isSafeSubagentIdentifier(chatId)) ||
    new Set(value.pendingChatDeletions).size !== value.pendingChatDeletions.length
  ) {
    return undefined;
  }
  const parsedSnapshots = snapshots as SubagentRunSnapshotV2[];
  const parsedManifests = manifests as SubagentPrivateRunManifestV2[];
  const pendingChatDeletions = value.pendingChatDeletions as string[];
  const snapshotByRun = new Map(parsedSnapshots.map((snapshot) => [snapshot.runId, snapshot]));
  if (
    snapshotByRun.size !== parsedSnapshots.length ||
    new Set(parsedManifests.map(({ runId }) => runId)).size !== parsedManifests.length ||
    parsedManifests.some((manifest) => {
      const snapshot = snapshotByRun.get(manifest.runId);
      return (
        !snapshot ||
        snapshot.generationId !== manifest.generationId ||
        snapshot.childId !== manifest.childId ||
        snapshot.chatId !== manifest.chatId ||
        snapshot.workspaceId !== manifest.workspaceId ||
        snapshot.taskPreview !== manifest.task ||
        snapshot.authorityRevision !== 0
      );
    }) ||
    parsedSnapshots.some(({ chatId }) => pendingChatDeletions.includes(chatId))
  ) {
    return undefined;
  }
  return {
    version: STORE_VERSION_V2,
    storeRevision: value.storeRevision as number,
    migration,
    snapshots: parsedSnapshots,
    manifests: parsedManifests,
    approvals: [],
    effects: [],
    pendingChatDeletions: [...pendingChatDeletions],
    deletionTransactions: [],
  };
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function decode(contents: Buffer): string {
  try {
    return STRICT_UTF8.decode(contents);
  } catch {
    throw new Error("Subagent run migration contains invalid UTF-8 evidence.");
  }
}

async function readV1Checkpoint(storage: SubagentRunStoreStorage): Promise<V1Checkpoint> {
  const read = await storage.read();
  if (read.status === "oversized") {
    throw new Error("Subagent V1 migration source is oversized and was preserved.");
  }
  if (read.status === "missing") {
    return {
      source: "missing",
      generation: "missing",
      sha256: sha256(Buffer.alloc(0)),
    };
  }
  return {
    source: "v1",
    generation: read.generation,
    sha256: sha256(read.contents),
    serialized: decode(read.contents),
  };
}

/** Fresh raw evidence used after an intentional rollback-journal mutation. */
export async function readSubagentRunStoreV1CheckpointV2(
  storage: SubagentRunStoreStorage,
): Promise<SubagentRunStoreV1CheckpointEvidenceV2> {
  const checkpoint = await readV1Checkpoint(storage);
  return {
    source: checkpoint.source,
    sourceGeneration: checkpoint.generation,
    sourceSha256: checkpoint.sha256,
  };
}

function sameCheckpoint(checkpoint: V1Checkpoint, migration: SubagentRunMigrationV2): boolean {
  // Native generations include st_dev, which macOS may reassign when the APFS
  // data volume is mounted after a reboot. The generation remains useful for
  // same-process compare-before-write operations, but it is not stable durable
  // evidence. Migration equivalence is content-addressed: an identical source
  // and digest require no merge even when filesystem identity has changed.
  return (
    checkpoint.source === migration.source &&
    checkpoint.sha256 === migration.sourceSha256
  );
}

function parseV2Read(read: SubagentRunStoreReadResult): {
  generation: SubagentRunStoreGeneration;
  database?: SubagentRunDatabaseV2 | MutableSubagentRunDatabaseV2;
} {
  if (read.status === "missing") return { generation: "missing" };
  if (read.status === "oversized") {
    throw new Error("Subagent V2 migration evidence is oversized and was preserved.");
  }
  const serialized = decode(read.contents);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SUBAGENT_RUN_STORE_BYTES) {
    throw new Error("Subagent V2 migration evidence is oversized and was preserved.");
  }
  let parsed: unknown;
  try {
    assertUniqueJsonObjectKeys(serialized);
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Subagent V2 migration evidence is unreadable and was preserved.");
  }
  // A prepared migration contains imported V1 manifests only. Once V2 is
  // canonical, however, the same file may also contain native manifests. The
  // activation verifier must understand both exact schemas or it would reject
  // its own first native write on the next restart.
  const database =
    parseSubagentRunDatabaseV2(parsed) ?? parseMutableSubagentRunDatabaseV2(parsed);
  if (!database) {
    throw new Error("Subagent V2 migration evidence is invalid and was preserved.");
  }
  return { generation: read.generation, database };
}

function migratedDatabase(checkpoint: V1Checkpoint, now: number): SubagentRunDatabaseV2 {
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid subagent migration clock.");
  const source = checkpoint.serialized !== undefined
    ? parseSubagentRunDatabaseV1ForMigration(checkpoint.serialized)
    : { version: 1 as const, runs: [], pendingChatDeletions: [] };
  const snapshots = source.runs.map((snapshot) => {
    const migrated = adaptSubagentRunSnapshotV1ToV2(snapshot);
    if (!migrated) throw new Error("Subagent V1 run could not be migrated losslessly.");
    return migrated;
  });
  return {
    version: STORE_VERSION_V2,
    storeRevision: 1,
    migration: {
      status: "prepared",
      adapterVersion: MIGRATION_ADAPTER_VERSION,
      source: checkpoint.source,
      sourceGeneration: checkpoint.generation,
      sourceSha256: checkpoint.sha256,
      migratedAt: now,
    },
    snapshots,
    manifests: source.runs.map((snapshot) => ({
      version: STORE_VERSION_V2,
      provenance: "v1_import",
      runId: snapshot.runId,
      generationId: snapshot.generationId,
      childId: snapshot.childId,
      chatId: snapshot.chatId,
      workspaceId: snapshot.workspaceId,
      task: snapshot.taskPreview,
      reusableAuthority: false,
    })),
    approvals: [],
    effects: [],
    pendingChatDeletions: [...source.pendingChatDeletions],
    deletionTransactions: [],
  };
}

function serialize(database: SubagentRunDatabaseV2): string {
  const serialized = `${JSON.stringify(database, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SUBAGENT_RUN_STORE_BYTES) {
    throw new Error("Subagent V2 migration output exceeds its store limit.");
  }
  return serialized;
}

/** Prepare/commit V2 beside V1 without ever writing or normalizing V1. */
export async function migrateSubagentRunStoreV2(
  v1Storage: SubagentRunStoreStorage,
  v2Storage: SubagentRunStoreStorage,
  now: () => number = Date.now,
): Promise<SubagentRunDatabaseV2 | MutableSubagentRunDatabaseV2> {
  await v2Storage.cleanup();
  const existing = parseV2Read(await v2Storage.read());
  const checkpoint = await readV1Checkpoint(v1Storage);
  if (existing.database?.migration.status === "committed") {
    if (!sameCheckpoint(checkpoint, existing.database.migration)) {
      throw new Error("Subagent V1 changed after V2 migration; automatic merge is blocked.");
    }
    return existing.database;
  }
  let prepared = existing.database
    ? parseSubagentRunDatabaseV2(existing.database)
    : undefined;
  if (existing.database && !prepared) {
    throw new Error("A prepared subagent V2 migration cannot contain native run manifests.");
  }
  let generation = existing.generation;
  if (!prepared) {
    prepared = migratedDatabase(checkpoint, now());
    generation = await v2Storage.write("missing", serialize(prepared));
  } else if (!sameCheckpoint(checkpoint, prepared.migration)) {
    throw new Error("Subagent V1 changed while V2 migration was prepared.");
  }
  const verifiedCheckpoint = await readV1Checkpoint(v1Storage);
  if (!sameCheckpoint(verifiedCheckpoint, prepared.migration)) {
    throw new Error("Subagent V1 changed before V2 migration could commit.");
  }
  const committed: SubagentRunDatabaseV2 = {
    ...prepared,
    storeRevision: prepared.storeRevision + 1,
    migration: { ...prepared.migration, status: "committed" },
  };
  await v2Storage.write(generation, serialize(committed));
  return committed;
}
