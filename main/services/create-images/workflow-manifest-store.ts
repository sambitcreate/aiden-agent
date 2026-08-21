import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";
import {
  CREATE_IMAGES_MAX_WORKFLOW_BYTES,
  CREATE_IMAGES_SCHEMA_VERSION,
  parseWorkflowDocument,
} from "../../../renderer/shared/create-images/schema.js";
import { decodeUtf8, readRegularFile } from "../regular-file-read.js";

const INDEX_VERSION = 1 as const;
const JOURNAL_VERSION = 1 as const;
const MAX_WORKFLOW_BYTES = CREATE_IMAGES_MAX_WORKFLOW_BYTES;
const MAX_JOURNAL_BYTES = CREATE_IMAGES_MAX_WORKFLOW_BYTES + 64 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_WORKFLOW_COUNT = 1_000;
const DEFAULT_MAX_AGGREGATE_WORKFLOW_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_DELETED_QUARANTINE_ENTRIES = 32;
const DEFAULT_MAX_DELETED_QUARANTINE_BYTES = 128 * 1024 * 1024;
const MAX_QUARANTINE_SCAN_ENTRIES = 4_096;
const WORKFLOW_FILE_NAMES = new Set([
  "autosave.journal",
  "workflow.json",
  "workflow.last-known-good.json",
]);
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CURRENT_FILE = "workflow.json";
const LAST_KNOWN_GOOD_FILE = "workflow.last-known-good.json";
const AUTOSAVE_FILE = "autosave.journal";

interface WorkflowIndexV1 {
  version: typeof INDEX_VERSION;
  workflows: WorkflowManifestSummary[];
}

interface AutosaveJournalV1 {
  version: typeof JOURNAL_VERSION;
  workflowId: string;
  baseRevision: number | null;
  targetRevision: number;
  stagedAt: string;
  snapshot: WorkflowDocumentV1;
}

type FileInspection<T> =
  | { status: "missing" }
  | { status: "healthy"; value: T }
  | { status: "corrupt" }
  | { status: "unsafe" };

export interface WorkflowManifestSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  assetCount: number;
  health: "healthy" | "recovery-required" | "unsafe";
  recoveryAvailable: boolean;
}

export type WorkflowManifestHealth =
  | { status: "healthy"; source: "missing" | "disk"; path: string }
  | { status: "corrupt"; path: string }
  | { status: "unsafe"; path: string };

export type WorkflowRecoveryReason =
  | "current-corrupt"
  | "current-missing"
  | "last-known-good-corrupt"
  | "journal-corrupt"
  | "journal-pending"
  | "journal-conflict";

export type WorkflowRecoveryHealth =
  | {
      status: "missing";
      workflowId: string;
      currentPath: string;
      lastKnownGoodAvailable: false;
      autosave: "none";
    }
  | {
      status: "healthy";
      workflowId: string;
      currentPath: string;
      revision: number;
      lastKnownGoodAvailable: boolean;
      autosave: "none" | "pending";
      autosaveTargetRevision?: number;
    }
  | {
      status: "recovery-required";
      workflowId: string;
      currentPath: string;
      reason: WorkflowRecoveryReason;
      currentRevision?: number;
      lastKnownGoodAvailable: boolean;
      lastKnownGoodRevision?: number;
      autosave: "none" | "pending" | "corrupt";
      autosaveTargetRevision?: number;
    }
  | {
      status: "unsafe";
      workflowId: string;
      currentPath: string;
      reason: "current-future-schema" | "last-known-good-future-schema" | "journal-future-schema";
      lastKnownGoodAvailable: boolean;
      autosave: "none" | "pending" | "unsafe";
    };

export interface WorkflowAutosaveStatus {
  workflowId: string;
  state: "none" | "pending" | "corrupt" | "unsafe";
  baseRevision?: number | null;
  targetRevision?: number;
  stagedAt?: string;
}

export interface WorkflowManifestDurability {
  /** Test seam representing a crash after the journal is durable. */
  afterJournalPublished?: (workflowId: string) => Promise<void>;
  /** Test seam representing a crash after current is durable but before cleanup. */
  afterCurrentPublished?: (workflowId: string) => Promise<void>;
}

export interface WorkflowManifestStoreLimits {
  maxWorkflowCount?: number;
  maxAggregateWorkflowBytes?: number;
  maxDeletedQuarantineEntries?: number;
  maxDeletedQuarantineBytes?: number;
}

export interface WorkflowReferenceInventory {
  complete: boolean;
  records: Array<{
    workflowId: string;
    assetIds: string[];
  }>;
}

export class WorkflowManifestLoadError extends Error {
  constructor(
    readonly status: "corrupt" | "unsafe",
    readonly filePath: string,
  ) {
    super(
      status === "corrupt"
        ? "The Create Images workflow is damaged and has been kept for recovery."
        : "The Create Images workflow belongs to an unsupported future schema and is read-only.",
    );
    this.name = "WorkflowManifestLoadError";
  }
}

export class WorkflowRevisionConflictError extends Error {
  constructor(
    readonly workflowId: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `Workflow "${workflowId}" changed: expected revision ${expectedRevision ?? "absent"}, found ${actualRevision ?? "absent"}.`,
    );
    this.name = "WorkflowRevisionConflictError";
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

function validateWorkflowId(workflowId: string): string {
  if (!WORKFLOW_ID.test(workflowId)) throw new Error("Invalid Create Images workflow ID.");
  return workflowId;
}

function parseSnapshot(value: unknown): WorkflowDocumentV1 {
  const parsed = parseWorkflowDocument(value);
  if (!parsed.success) {
    throw new Error(parsed.issues[0]?.message ?? "Invalid Create Images workflow.");
  }
  return parsed.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFutureVersion(value: unknown, field: "schemaVersion" | "version"): boolean {
  return (
    isRecord(value) &&
    typeof value[field] === "number" &&
    value[field] > (field === "schemaVersion" ? CREATE_IMAGES_SCHEMA_VERSION : 1)
  );
}

function parseJournal(value: unknown): AutosaveJournalV1 | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "workflowId",
          "baseRevision",
          "targetRevision",
          "stagedAt",
          "snapshot",
        ].includes(key),
    )
  ) {
    return undefined;
  }
  const snapshot = parseWorkflowDocument(value.snapshot);
  const baseRevision =
    value.baseRevision === null
      ? null
      : typeof value.baseRevision === "number" && Number.isSafeInteger(value.baseRevision)
        ? value.baseRevision
        : undefined;
  const targetRevision =
    typeof value.targetRevision === "number" && Number.isSafeInteger(value.targetRevision)
      ? value.targetRevision
      : undefined;
  if (
    value.version !== JOURNAL_VERSION ||
    typeof value.workflowId !== "string" ||
    !WORKFLOW_ID.test(value.workflowId) ||
    !snapshot.success ||
    snapshot.value.id !== value.workflowId ||
    baseRevision === undefined ||
    (baseRevision !== null && baseRevision < 1) ||
    targetRevision === undefined ||
    targetRevision < 1 ||
    snapshot.value.revision !== targetRevision ||
    targetRevision !== (baseRevision === null ? 1 : baseRevision + 1) ||
    typeof value.stagedAt !== "string" ||
    !Number.isFinite(Date.parse(value.stagedAt))
  ) {
    return undefined;
  }
  return {
    version: JOURNAL_VERSION,
    workflowId: value.workflowId,
    baseRevision,
    targetRevision,
    stagedAt: value.stagedAt,
    snapshot: snapshot.value,
  };
}

function summaryOf(
  workflow: WorkflowDocumentV1,
  health: WorkflowManifestSummary["health"],
  recoveryAvailable: boolean,
): WorkflowManifestSummary {
  return {
    id: workflow.id,
    title: workflow.title,
    revision: workflow.revision,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    assetCount: workflow.assetRefs.length,
    health,
    recoveryAvailable,
  };
}

function parseLegacyDatabase(value: unknown): Record<string, WorkflowDocumentV1> | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "version" && key !== "workflows") ||
    value.version !== 1 ||
    !isRecord(value.workflows)
  ) {
    return undefined;
  }
  const workflows = Object.create(null) as Record<string, WorkflowDocumentV1>;
  for (const [id, candidate] of Object.entries(value.workflows)) {
    const parsed = parseWorkflowDocument(candidate);
    if (!parsed.success || parsed.value.id !== id) return undefined;
    workflows[id] = parsed.value;
  }
  return workflows;
}

/**
 * Device-local durable Create Images workflow authority.
 *
 * Each workflow is independently bounded and published. `index.json` is a
 * rebuildable projection; workflow manifests, last-known-good snapshots, and
 * autosave journals are the authority. Binary assets and run journals remain
 * outside this store.
 */
export class WorkflowManifestStore {
  private readonly limits: Required<WorkflowManifestStoreLimits>;

  constructor(
    private readonly rootResolver: () => string,
    private readonly durability: WorkflowManifestDurability = {},
    limits: WorkflowManifestStoreLimits = {},
  ) {
    this.limits = {
      maxWorkflowCount: limits.maxWorkflowCount ?? DEFAULT_MAX_WORKFLOW_COUNT,
      maxAggregateWorkflowBytes:
        limits.maxAggregateWorkflowBytes ?? DEFAULT_MAX_AGGREGATE_WORKFLOW_BYTES,
      maxDeletedQuarantineEntries:
        limits.maxDeletedQuarantineEntries ?? DEFAULT_MAX_DELETED_QUARANTINE_ENTRIES,
      maxDeletedQuarantineBytes:
        limits.maxDeletedQuarantineBytes ?? DEFAULT_MAX_DELETED_QUARANTINE_BYTES,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid Create Images storage limit: ${name}.`);
      }
    }
  }

  private root(): string {
    return path.resolve(this.rootResolver());
  }

  private indexPath(): string {
    return path.join(this.root(), "index.json");
  }

  private legacyPath(): string {
    return path.join(this.root(), "workflows.json");
  }

  private workflowsPath(): string {
    return path.join(this.root(), "workflows");
  }

  private workflowDirectory(workflowId: string): string {
    return path.join(this.workflowsPath(), validateWorkflowId(workflowId));
  }

  private deletedWorkflowQuarantinePath(): string {
    return path.join(this.root(), "quarantine", "deleted-workflows");
  }

  private workflowPaths(workflowId: string) {
    const directory = this.workflowDirectory(workflowId);
    return {
      directory,
      current: path.join(directory, CURRENT_FILE),
      lastKnownGood: path.join(directory, LAST_KNOWN_GOOD_FILE),
      autosave: path.join(directory, AUTOSAVE_FILE),
    };
  }

  private async ensureDirectory(target: string): Promise<boolean> {
    const created = await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Create Images storage contains an unsafe directory.");
    }
    if (created !== undefined) await this.syncDirectory(path.dirname(target));
    return created !== undefined;
  }

  private async prepareDirectories(): Promise<void> {
    await this.ensureDirectory(this.root());
    await this.ensureDirectory(this.workflowsPath());
    await this.ensureDirectory(path.join(this.root(), "quarantine"));
    await this.ensureDirectory(this.deletedWorkflowQuarantinePath());
  }

  private async readJson(target: string, maxBytes: number): Promise<FileInspection<unknown>> {
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(target, maxBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "corrupt" };
    }
    try {
      return { status: "healthy", value: JSON.parse(decodeUtf8(bytes)) as unknown };
    } catch {
      return { status: "corrupt" };
    }
  }

  private async inspectWorkflowFile(target: string): Promise<FileInspection<WorkflowDocumentV1>> {
    const raw = await this.readJson(target, MAX_WORKFLOW_BYTES);
    if (raw.status !== "healthy") return raw;
    if (isFutureVersion(raw.value, "schemaVersion")) return { status: "unsafe" };
    const parsed = parseWorkflowDocument(raw.value);
    return parsed.success ? { status: "healthy", value: parsed.value } : { status: "corrupt" };
  }

  private async inspectJournalFile(target: string): Promise<FileInspection<AutosaveJournalV1>> {
    const raw = await this.readJson(target, MAX_JOURNAL_BYTES);
    if (raw.status !== "healthy") return raw;
    if (isFutureVersion(raw.value, "version")) return { status: "unsafe" };
    const journal = parseJournal(raw.value);
    return journal ? { status: "healthy", value: journal } : { status: "corrupt" };
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeAtomic(
    target: string,
    value: unknown,
    maxBytes: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    const directory = path.dirname(target);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      throw new Error("Create Images workflow metadata exceeds its storage limit.");
    }
    const createdDirectory = await this.ensureDirectory(directory);
    const staged = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let publicationError: unknown;
    try {
      try {
        const existing = await fs.lstat(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new Error("Create Images storage contains an unsafe file.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.writeFile(staged, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const handle = await fs.open(staged, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
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

  private async removeFileDurably(target: string): Promise<void> {
    try {
      await fs.rm(target);
      await this.syncDirectory(path.dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async quarantineFile(target: string, label: string): Promise<string | undefined> {
    const quarantine = path.join(
      this.root(),
      "quarantine",
      `${label}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.json`,
    );
    try {
      await fs.rename(target, quarantine);
      await this.syncDirectory(path.dirname(target));
      await this.syncDirectory(path.dirname(quarantine));
      return quarantine;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private serializedBytes(value: unknown): number {
    return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private unsafeStorageEntry(target: string): WorkflowManifestLoadError {
    return new WorkflowManifestLoadError("unsafe", target);
  }

  private async boundedDirectoryEntries(directory: string, maxEntries: number): Promise<Dirent[]> {
    const entries: Dirent[] = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      entries.push(entry);
      if (entries.length > maxEntries) throw this.unsafeStorageEntry(directory);
    }
    return entries;
  }

  private async workflowInventory(): Promise<{
    workflowIds: string[];
    workflowCount: number;
    aggregateBytes: number;
  }> {
    const workflowIds: string[] = [];
    let aggregateBytes = 0;
    const entries = await this.boundedDirectoryEntries(
      this.workflowsPath(),
      this.limits.maxWorkflowCount,
    );
    for (const entry of entries) {
      const entryPath = path.join(this.workflowsPath(), entry.name);
      const info = await fs.lstat(entryPath);
      if (
        !WORKFLOW_ID.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !info.isDirectory() ||
        info.isSymbolicLink()
      ) {
        throw this.unsafeStorageEntry(entryPath);
      }
      workflowIds.push(entry.name);
      for (const child of await this.boundedDirectoryEntries(entryPath, WORKFLOW_FILE_NAMES.size)) {
        const childPath = path.join(entryPath, child.name);
        const childInfo = await fs.lstat(childPath);
        if (
          !WORKFLOW_FILE_NAMES.has(child.name) ||
          !child.isFile() ||
          child.isSymbolicLink() ||
          !childInfo.isFile() ||
          childInfo.isSymbolicLink()
        ) {
          throw this.unsafeStorageEntry(childPath);
        }
        aggregateBytes += childInfo.size;
        if (
          !Number.isSafeInteger(aggregateBytes) ||
          aggregateBytes > this.limits.maxAggregateWorkflowBytes
        ) {
          throw new Error("Create Images workflow storage has reached its aggregate byte limit.");
        }
      }
    }
    return { workflowIds, workflowCount: workflowIds.length, aggregateBytes };
  }

  async referenceInventory(): Promise<WorkflowReferenceInventory> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const inventory = await this.workflowInventory();
      const records: WorkflowReferenceInventory["records"] = [];
      let complete = true;
      for (const workflowId of inventory.workflowIds) {
        const state = await this.inspected(workflowId);
        if (
          state.current.status === "corrupt" ||
          state.current.status === "unsafe" ||
          state.lastKnownGood.status === "corrupt" ||
          state.lastKnownGood.status === "unsafe" ||
          state.journal.status === "corrupt" ||
          state.journal.status === "unsafe"
        ) {
          complete = false;
        }
        const candidates = [
          this.validRecoveryCandidate(state.current, workflowId),
          this.validRecoveryCandidate(state.lastKnownGood, workflowId),
          this.validRecoveryCandidate(state.journal, workflowId),
        ].filter((candidate): candidate is WorkflowDocumentV1 => candidate !== undefined);
        if (candidates.length === 0) complete = false;
        records.push({
          workflowId,
          assetIds: [...new Set(candidates.flatMap((candidate) => candidate.assetRefs))].sort(),
        });
      }
      return { complete, records };
    });
  }

  private async assertMutationWithinLimits(
    workflowId: string,
    replacements: ReadonlyMap<string, unknown | undefined>,
  ): Promise<void> {
    const inventory = await this.workflowInventory();
    const isNewWorkflow = !inventory.workflowIds.includes(workflowId);
    const projectedCount = inventory.workflowCount + (isNewWorkflow ? 1 : 0);
    if (projectedCount > this.limits.maxWorkflowCount) {
      throw new Error("Create Images workflow storage has reached its workflow count limit.");
    }
    let projectedBytes = inventory.aggregateBytes;
    for (const [target, replacement] of replacements) {
      try {
        const existing = await fs.lstat(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw this.unsafeStorageEntry(target);
        }
        projectedBytes -= existing.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (replacement !== undefined) projectedBytes += this.serializedBytes(replacement);
    }
    if (
      !Number.isSafeInteger(projectedBytes) ||
      projectedBytes > this.limits.maxAggregateWorkflowBytes
    ) {
      throw new Error("Create Images workflow storage has reached its aggregate byte limit.");
    }
  }

  private async deletedWorkflowDirectoryBytes(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await this.boundedDirectoryEntries(directory, WORKFLOW_FILE_NAMES.size)) {
      const entryPath = path.join(directory, entry.name);
      const info = await fs.lstat(entryPath);
      if (
        !WORKFLOW_FILE_NAMES.has(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !info.isFile() ||
        info.isSymbolicLink()
      ) {
        throw this.unsafeStorageEntry(entryPath);
      }
      total += info.size;
      if (!Number.isSafeInteger(total)) {
        throw new Error("Create Images quarantine is too large to inventory safely.");
      }
    }
    return total;
  }

  private async pruneDeletedQuarantine(): Promise<void> {
    const quarantinePath = this.deletedWorkflowQuarantinePath();
    const deleted: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
    for (const entry of await this.boundedDirectoryEntries(
      quarantinePath,
      MAX_QUARANTINE_SCAN_ENTRIES,
    )) {
      const entryPath = path.join(quarantinePath, entry.name);
      const info = await fs.lstat(entryPath);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !info.isDirectory() ||
        info.isSymbolicLink()
      ) {
        throw this.unsafeStorageEntry(entryPath);
      }
      deleted.push({
        path: entryPath,
        mtimeMs: info.mtimeMs,
        bytes: await this.deletedWorkflowDirectoryBytes(entryPath),
      });
    }
    deleted.sort(
      (left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path),
    );
    let retainedBytes = 0;
    const removals: string[] = [];
    for (const [index, entry] of deleted.entries()) {
      if (
        index >= this.limits.maxDeletedQuarantineEntries ||
        retainedBytes + entry.bytes > this.limits.maxDeletedQuarantineBytes
      ) {
        removals.push(entry.path);
      } else {
        retainedBytes += entry.bytes;
      }
    }
    for (const target of removals) await fs.rm(target, { recursive: true });
    if (removals.length > 0) await this.syncDirectory(quarantinePath);
  }

  private async legacyBlocker(): Promise<
    Extract<WorkflowManifestHealth, { status: "corrupt" | "unsafe" }> | undefined
  > {
    const raw = await this.readJson(this.legacyPath(), MAX_WORKFLOW_BYTES);
    if (raw.status === "missing") return undefined;
    if (raw.status === "corrupt") return { status: "corrupt", path: this.legacyPath() };
    if (raw.status === "unsafe") return { status: "unsafe", path: this.legacyPath() };
    if (isFutureVersion(raw.value, "version")) {
      return { status: "unsafe", path: this.legacyPath() };
    }
    return parseLegacyDatabase(raw.value)
      ? undefined
      : { status: "corrupt", path: this.legacyPath() };
  }

  private async migrateLegacy(): Promise<void> {
    const raw = await this.readJson(this.legacyPath(), MAX_WORKFLOW_BYTES);
    if (raw.status === "missing") return;
    if (
      raw.status === "corrupt" ||
      (raw.status === "healthy" && isFutureVersion(raw.value, "version"))
    ) {
      throw new WorkflowManifestLoadError(
        raw.status === "corrupt" ? "corrupt" : "unsafe",
        this.legacyPath(),
      );
    }
    if (raw.status !== "healthy") return;
    const legacy = parseLegacyDatabase(raw.value);
    if (!legacy) throw new WorkflowManifestLoadError("corrupt", this.legacyPath());
    for (const workflow of Object.values(legacy)) {
      const paths = this.workflowPaths(workflow.id);
      await this.assertMutationWithinLimits(
        workflow.id,
        new Map<string, unknown>([
          [paths.current, workflow],
          [paths.lastKnownGood, workflow],
        ]),
      );
      await this.ensureDirectory(paths.directory);
      const current = await this.inspectWorkflowFile(paths.current);
      if (current.status === "missing") {
        await this.writeAtomic(paths.current, workflow, MAX_WORKFLOW_BYTES, () => true);
        await this.writeAtomic(paths.lastKnownGood, workflow, MAX_WORKFLOW_BYTES, () => true);
      } else if (
        current.status !== "healthy" ||
        JSON.stringify(current.value) !== JSON.stringify(workflow)
      ) {
        throw new WorkflowManifestLoadError(
          current.status === "unsafe" ? "unsafe" : "corrupt",
          paths.current,
        );
      }
    }
    await this.rebuildIndexInternal();
    const migrated = path.join(this.root(), `workflows.phase-0-migrated-${randomUUID()}.json`);
    await fs.rename(this.legacyPath(), migrated);
    await this.syncDirectory(this.root());
  }

  private async prepare(): Promise<void> {
    await this.prepareDirectories();
    const blocker = await this.legacyBlocker();
    if (blocker) throw new WorkflowManifestLoadError(blocker.status, blocker.path);
    await this.migrateLegacy();
  }

  private async inspected(workflowId: string): Promise<{
    paths: ReturnType<WorkflowManifestStore["workflowPaths"]>;
    current: FileInspection<WorkflowDocumentV1>;
    lastKnownGood: FileInspection<WorkflowDocumentV1>;
    journal: FileInspection<AutosaveJournalV1>;
  }> {
    const paths = this.workflowPaths(workflowId);
    try {
      const directory = await fs.lstat(paths.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        return {
          paths,
          current: { status: "corrupt" },
          lastKnownGood: { status: "corrupt" },
          journal: { status: "corrupt" },
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        paths,
        current: { status: "missing" },
        lastKnownGood: { status: "missing" },
        journal: { status: "missing" },
      };
    }
    const [current, lastKnownGood, journal] = await Promise.all([
      this.inspectWorkflowFile(paths.current),
      this.inspectWorkflowFile(paths.lastKnownGood),
      this.inspectJournalFile(paths.autosave),
    ]);
    return { paths, current, lastKnownGood, journal };
  }

  private validRecoveryCandidate(
    inspection: FileInspection<WorkflowDocumentV1> | FileInspection<AutosaveJournalV1>,
    workflowId: string,
  ): WorkflowDocumentV1 | undefined {
    if (inspection.status !== "healthy") return undefined;
    const value = "snapshot" in inspection.value ? inspection.value.snapshot : inspection.value;
    return value.id === workflowId ? value : undefined;
  }

  private async reconcilePublishedJournal(
    workflowId: string,
    state: Awaited<ReturnType<WorkflowManifestStore["inspected"]>>,
  ): Promise<Awaited<ReturnType<WorkflowManifestStore["inspected"]>>> {
    if (
      state.current.status !== "healthy" ||
      state.current.value.id !== workflowId ||
      state.journal.status !== "healthy" ||
      state.journal.value.workflowId !== workflowId ||
      state.journal.value.targetRevision !== state.current.value.revision ||
      JSON.stringify(state.journal.value.snapshot) !== JSON.stringify(state.current.value) ||
      state.lastKnownGood.status === "corrupt" ||
      state.lastKnownGood.status === "unsafe"
    ) {
      return state;
    }
    // Current is already the exact journal target, so publication completed
    // before the crash. Finish main-owned durability cleanup without depending
    // on renderer liveness; a repeated restart is safe at either boundary.
    await this.writeAtomic(
      state.paths.lastKnownGood,
      state.current.value,
      MAX_WORKFLOW_BYTES,
      () => true,
    );
    await this.removeFileDurably(state.paths.autosave);
    return {
      ...state,
      lastKnownGood: { status: "healthy", value: state.current.value },
      journal: { status: "missing" },
    };
  }

  private recoveryHealthOf(
    workflowId: string,
    state: Awaited<ReturnType<WorkflowManifestStore["inspected"]>>,
  ): WorkflowRecoveryHealth {
    const lastGood = this.validRecoveryCandidate(state.lastKnownGood, workflowId);
    const journal =
      state.journal.status === "healthy" && state.journal.value.workflowId === workflowId
        ? state.journal.value
        : undefined;
    const common = {
      workflowId,
      currentPath: state.paths.current,
      lastKnownGoodAvailable: Boolean(lastGood),
    };
    if (state.current.status === "unsafe") {
      return {
        ...common,
        status: "unsafe",
        reason: "current-future-schema",
        autosave: state.journal.status === "unsafe" ? "unsafe" : journal ? "pending" : "none",
      };
    }
    if (state.lastKnownGood.status === "unsafe") {
      return {
        ...common,
        status: "unsafe",
        reason: "last-known-good-future-schema",
        autosave: state.journal.status === "unsafe" ? "unsafe" : journal ? "pending" : "none",
      };
    }
    if (state.journal.status === "unsafe") {
      return { ...common, status: "unsafe", reason: "journal-future-schema", autosave: "unsafe" };
    }
    if (
      state.current.status === "missing" &&
      state.lastKnownGood.status === "missing" &&
      state.journal.status === "missing"
    ) {
      return {
        status: "missing",
        workflowId,
        currentPath: state.paths.current,
        lastKnownGoodAvailable: false,
        autosave: "none",
      };
    }
    if (state.current.status === "corrupt" || state.current.status === "missing") {
      return {
        ...common,
        status: "recovery-required",
        reason: state.current.status === "corrupt" ? "current-corrupt" : "current-missing",
        ...(lastGood ? { lastKnownGoodRevision: lastGood.revision } : {}),
        autosave: state.journal.status === "corrupt" ? "corrupt" : journal ? "pending" : "none",
        ...(journal ? { autosaveTargetRevision: journal.targetRevision } : {}),
      };
    }
    if (state.lastKnownGood.status === "corrupt") {
      return {
        ...common,
        status: "recovery-required",
        reason: "last-known-good-corrupt",
        currentRevision: state.current.value.revision,
        autosave: state.journal.status === "corrupt" ? "corrupt" : journal ? "pending" : "none",
        ...(journal ? { autosaveTargetRevision: journal.targetRevision } : {}),
      };
    }
    if (state.journal.status === "corrupt") {
      return {
        ...common,
        status: "recovery-required",
        reason: "journal-corrupt",
        currentRevision: state.current.value.revision,
        ...(lastGood ? { lastKnownGoodRevision: lastGood.revision } : {}),
        autosave: "corrupt",
      };
    }
    if (journal && journal.baseRevision === state.current.value.revision) {
      return {
        ...common,
        status: "recovery-required",
        reason: "journal-pending",
        currentRevision: state.current.value.revision,
        ...(lastGood ? { lastKnownGoodRevision: lastGood.revision } : {}),
        autosave: "pending",
        autosaveTargetRevision: journal.targetRevision,
      };
    }
    if (
      journal &&
      !(
        journal.baseRevision === state.current.value.revision ||
        (journal.targetRevision === state.current.value.revision &&
          JSON.stringify(journal.snapshot) === JSON.stringify(state.current.value))
      )
    ) {
      return {
        ...common,
        status: "recovery-required",
        reason: "journal-conflict",
        currentRevision: state.current.value.revision,
        ...(lastGood ? { lastKnownGoodRevision: lastGood.revision } : {}),
        autosave: "pending",
        autosaveTargetRevision: journal.targetRevision,
      };
    }
    return {
      ...common,
      status: "healthy",
      revision: state.current.value.revision,
      autosave: journal ? "pending" : "none",
      ...(journal ? { autosaveTargetRevision: journal.targetRevision } : {}),
    };
  }

  private async scanSummaries(): Promise<WorkflowManifestSummary[]> {
    const summaries: WorkflowManifestSummary[] = [];
    const inventory = await this.workflowInventory();
    for (const workflowId of inventory.workflowIds) {
      const state = await this.reconcilePublishedJournal(
        workflowId,
        await this.inspected(workflowId),
      );
      const health = this.recoveryHealthOf(workflowId, state);
      const current = this.validRecoveryCandidate(state.current, workflowId);
      const lastGood = this.validRecoveryCandidate(state.lastKnownGood, workflowId);
      const journal = this.validRecoveryCandidate(state.journal, workflowId);
      const representative = current ?? lastGood ?? journal;
      if (!representative) {
        summaries.push({
          id: workflowId,
          title: "Workflow needs recovery",
          revision: 0,
          createdAt: "",
          updatedAt: "",
          nodeCount: 0,
          edgeCount: 0,
          assetCount: 0,
          health: health.status === "unsafe" ? "unsafe" : "recovery-required",
          recoveryAvailable: false,
        });
        continue;
      }
      summaries.push(
        summaryOf(
          representative,
          health.status === "healthy"
            ? "healthy"
            : health.status === "unsafe"
              ? "unsafe"
              : "recovery-required",
          Boolean(lastGood || journal),
        ),
      );
    }
    return summaries.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
  }

  private parseIndex(value: unknown): WorkflowIndexV1 | undefined {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => key !== "version" && key !== "workflows") ||
      value.version !== INDEX_VERSION ||
      !Array.isArray(value.workflows)
    ) {
      return undefined;
    }
    const ids = new Set<string>();
    for (const summary of value.workflows) {
      if (
        !isRecord(summary) ||
        Object.keys(summary).some(
          (key) =>
            ![
              "id",
              "title",
              "revision",
              "createdAt",
              "updatedAt",
              "nodeCount",
              "edgeCount",
              "assetCount",
              "health",
              "recoveryAvailable",
            ].includes(key),
        ) ||
        typeof summary.id !== "string" ||
        !WORKFLOW_ID.test(summary.id) ||
        ids.has(summary.id) ||
        typeof summary.title !== "string" ||
        typeof summary.revision !== "number" ||
        !Number.isSafeInteger(summary.revision) ||
        typeof summary.createdAt !== "string" ||
        typeof summary.updatedAt !== "string" ||
        typeof summary.nodeCount !== "number" ||
        !Number.isSafeInteger(summary.nodeCount) ||
        typeof summary.edgeCount !== "number" ||
        !Number.isSafeInteger(summary.edgeCount) ||
        typeof summary.assetCount !== "number" ||
        !Number.isSafeInteger(summary.assetCount) ||
        !["healthy", "recovery-required", "unsafe"].includes(summary.health as string) ||
        typeof summary.recoveryAvailable !== "boolean"
      ) {
        return undefined;
      }
      ids.add(summary.id);
    }
    return value as unknown as WorkflowIndexV1;
  }

  private async inspectIndex(): Promise<FileInspection<WorkflowIndexV1>> {
    const raw = await this.readJson(this.indexPath(), MAX_INDEX_BYTES);
    if (raw.status !== "healthy") return raw;
    if (isFutureVersion(raw.value, "version")) return { status: "unsafe" };
    const parsed = this.parseIndex(raw.value);
    return parsed ? { status: "healthy", value: parsed } : { status: "corrupt" };
  }

  private async rebuildIndexInternal(): Promise<WorkflowManifestSummary[]> {
    const summaries = await this.scanSummaries();
    const existing = await this.inspectIndex();
    if (existing.status === "unsafe") return summaries;
    if (existing.status === "corrupt") await this.quarantineFile(this.indexPath(), "index-corrupt");
    if (
      existing.status !== "healthy" ||
      JSON.stringify(existing.value.workflows) !== JSON.stringify(summaries)
    ) {
      await this.writeAtomic(
        this.indexPath(),
        { version: INDEX_VERSION, workflows: summaries } satisfies WorkflowIndexV1,
        MAX_INDEX_BYTES,
        () => true,
      );
    }
    return summaries;
  }

  private async refreshIndexAfterAuthoritativeMutation(): Promise<void> {
    try {
      await this.rebuildIndexInternal();
    } catch {
      // index.json is a rebuildable projection. Once a manifest mutation is
      // durable, reporting the operation as failed invites a retry that can
      // create duplicates. A later list/initialize performs the repair or
      // reports the underlying inventory problem explicitly.
    }
  }

  async path(): Promise<string> {
    return this.indexPath();
  }

  async health(): Promise<WorkflowManifestHealth> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepareDirectories();
      const blocker = await this.legacyBlocker();
      if (blocker) return blocker;
      await this.migrateLegacy();
      const index = await this.inspectIndex();
      if (index.status === "corrupt") return { status: "corrupt", path: this.indexPath() };
      if (index.status === "unsafe") return { status: "unsafe", path: this.indexPath() };
      return {
        status: "healthy",
        source: index.status === "missing" ? "missing" : "disk",
        path: this.indexPath(),
      };
    });
  }

  async inspect(workflowId: string): Promise<WorkflowRecoveryHealth> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      return this.recoveryHealthOf(workflowId, await this.inspected(workflowId));
    });
  }

  async list(): Promise<WorkflowManifestSummary[]> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      return structuredClone(await this.rebuildIndexInternal());
    });
  }

  async initialize(): Promise<WorkflowManifestSummary[]> {
    return this.list();
  }

  async get(workflowId: string): Promise<WorkflowDocumentV1 | undefined> {
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.reconcilePublishedJournal(
        workflowId,
        await this.inspected(workflowId),
      );
      if (state.current.status === "missing") {
        if (state.lastKnownGood.status !== "missing" || state.journal.status !== "missing") {
          throw new WorkflowManifestLoadError("corrupt", state.paths.current);
        }
        return undefined;
      }
      if (state.current.status !== "healthy") {
        throw new WorkflowManifestLoadError(state.current.status, state.paths.current);
      }
      const health = this.recoveryHealthOf(workflowId, state);
      if (health.status === "unsafe") {
        const unsafePath =
          health.reason === "current-future-schema"
            ? state.paths.current
            : health.reason === "last-known-good-future-schema"
              ? state.paths.lastKnownGood
              : state.paths.autosave;
        throw new WorkflowManifestLoadError("unsafe", unsafePath);
      }
      if (health.status === "recovery-required") {
        const corruptPath =
          health.reason === "last-known-good-corrupt"
            ? state.paths.lastKnownGood
            : health.reason.startsWith("journal-")
              ? state.paths.autosave
              : state.paths.current;
        throw new WorkflowManifestLoadError("corrupt", corruptPath);
      }
      return structuredClone(state.current.value);
    });
  }

  private async stageAutosaveInternal(
    parsed: WorkflowDocumentV1,
    expectedRevision: number | null,
    isCurrent: () => boolean,
  ): Promise<WorkflowDocumentV1> {
    const state = await this.inspected(parsed.id);
    if (state.current.status === "corrupt" || state.current.status === "unsafe") {
      throw new WorkflowManifestLoadError(state.current.status, state.paths.current);
    }
    if (state.journal.status === "corrupt" || state.journal.status === "unsafe") {
      throw new WorkflowManifestLoadError(state.journal.status, state.paths.autosave);
    }
    if (state.lastKnownGood.status === "corrupt" || state.lastKnownGood.status === "unsafe") {
      throw new WorkflowManifestLoadError(state.lastKnownGood.status, state.paths.lastKnownGood);
    }
    if (state.journal.status === "healthy") {
      if (
        state.current.status !== "healthy" ||
        state.journal.value.targetRevision !== state.current.value.revision ||
        JSON.stringify(state.journal.value.snapshot) !== JSON.stringify(state.current.value)
      ) {
        throw new WorkflowManifestLoadError("corrupt", state.paths.autosave);
      }
      // A crash can leave the journal behind after current became authoritative.
      // Reconcile that exact snapshot before accepting another stage; never replace
      // a distinct crash-survived journal.
      await this.writeAtomic(
        state.paths.lastKnownGood,
        state.current.value,
        MAX_WORKFLOW_BYTES,
        () => true,
      );
      await this.removeFileDurably(state.paths.autosave);
    }
    const actualRevision = state.current.status === "healthy" ? state.current.value.revision : null;
    if (actualRevision !== expectedRevision) {
      throw new WorkflowRevisionConflictError(parsed.id, expectedRevision, actualRevision);
    }
    const requiredRevision = expectedRevision === null ? 1 : expectedRevision + 1;
    if (parsed.revision !== requiredRevision) {
      throw new WorkflowRevisionConflictError(parsed.id, requiredRevision, parsed.revision);
    }
    if (state.current.status === "healthy" && state.current.value.createdAt !== parsed.createdAt) {
      throw new Error("A workflow's creation timestamp cannot change.");
    }
    if (state.current.status === "missing" && state.lastKnownGood.status !== "missing") {
      throw new WorkflowManifestLoadError("corrupt", state.paths.current);
    }
    const journal: AutosaveJournalV1 = {
      version: JOURNAL_VERSION,
      workflowId: parsed.id,
      baseRevision: expectedRevision,
      targetRevision: parsed.revision,
      stagedAt: parsed.updatedAt,
      snapshot: parsed,
    };
    await this.assertMutationWithinLimits(
      parsed.id,
      new Map<string, unknown>([
        [state.paths.current, parsed],
        [state.paths.lastKnownGood, parsed],
        [state.paths.autosave, journal],
      ]),
    );
    await this.writeAtomic(state.paths.autosave, journal, MAX_JOURNAL_BYTES, isCurrent);
    await this.durability.afterJournalPublished?.(parsed.id);
    return structuredClone(parsed);
  }

  async stageAutosave(
    snapshot: WorkflowDocumentV1,
    expectedRevision: number | null,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    const parsed = parseSnapshot(snapshot);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      return this.stageAutosaveInternal(parsed, expectedRevision, isCurrent);
    });
  }

  private async finishJournalCommit(
    state: Awaited<ReturnType<WorkflowManifestStore["inspected"]>>,
    journal: AutosaveJournalV1,
    expectedRevision: number | null,
    isCurrent: () => boolean,
  ): Promise<WorkflowDocumentV1> {
    if (journal.workflowId !== journal.snapshot.id || journal.baseRevision !== expectedRevision) {
      throw new WorkflowRevisionConflictError(
        journal.workflowId,
        expectedRevision,
        journal.baseRevision,
      );
    }
    if (state.current.status === "unsafe" || state.current.status === "corrupt") {
      throw new WorkflowManifestLoadError(state.current.status, state.paths.current);
    }
    if (state.lastKnownGood.status === "unsafe" || state.lastKnownGood.status === "corrupt") {
      throw new WorkflowManifestLoadError(state.lastKnownGood.status, state.paths.lastKnownGood);
    }
    const actualRevision = state.current.status === "healthy" ? state.current.value.revision : null;
    await this.assertMutationWithinLimits(
      journal.workflowId,
      new Map<string, unknown | undefined>([
        [state.paths.current, journal.snapshot],
        [state.paths.lastKnownGood, journal.snapshot],
        [state.paths.autosave, undefined],
      ]),
    );
    if (
      actualRevision === journal.targetRevision &&
      state.current.status === "healthy" &&
      JSON.stringify(state.current.value) === JSON.stringify(journal.snapshot)
    ) {
      await this.writeAtomic(
        state.paths.lastKnownGood,
        journal.snapshot,
        MAX_WORKFLOW_BYTES,
        () => true,
      );
      await this.removeFileDurably(state.paths.autosave);
      await this.refreshIndexAfterAuthoritativeMutation();
      return structuredClone(journal.snapshot);
    }
    if (actualRevision !== expectedRevision) {
      throw new WorkflowRevisionConflictError(journal.workflowId, expectedRevision, actualRevision);
    }
    if (state.current.status === "healthy") {
      await this.writeAtomic(
        state.paths.lastKnownGood,
        state.current.value,
        MAX_WORKFLOW_BYTES,
        () => true,
      );
    }
    await this.writeAtomic(state.paths.current, journal.snapshot, MAX_WORKFLOW_BYTES, isCurrent);
    await this.durability.afterCurrentPublished?.(journal.workflowId);
    // Once current is committed, cleanup is main-owned reconciliation and must
    // finish even if the renderer navigates away during these final steps.
    await this.writeAtomic(
      state.paths.lastKnownGood,
      journal.snapshot,
      MAX_WORKFLOW_BYTES,
      () => true,
    );
    await this.removeFileDurably(state.paths.autosave);
    await this.refreshIndexAfterAuthoritativeMutation();
    return structuredClone(journal.snapshot);
  }

  async flushAutosave(
    workflowId: string,
    expectedRevision: number | null,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    validateWorkflowId(workflowId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.inspected(workflowId);
      if (state.journal.status === "missing") {
        throw new Error("There is no pending autosave to flush.");
      }
      if (state.journal.status !== "healthy") {
        throw new WorkflowManifestLoadError(state.journal.status, state.paths.autosave);
      }
      return this.finishJournalCommit(state, state.journal.value, expectedRevision, isCurrent);
    });
  }

  async autosaveStatus(workflowId: string): Promise<WorkflowAutosaveStatus> {
    validateWorkflowId(workflowId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const journal = (await this.inspected(workflowId)).journal;
      if (journal.status === "missing") return { workflowId, state: "none" };
      if (journal.status === "corrupt" || journal.status === "unsafe") {
        return { workflowId, state: journal.status };
      }
      return {
        workflowId,
        state: "pending",
        baseRevision: journal.value.baseRevision,
        targetRevision: journal.value.targetRevision,
        stagedAt: journal.value.stagedAt,
      };
    });
  }

  async discardAutosave(
    workflowId: string,
    expectedTargetRevision: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    validateWorkflowId(workflowId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.inspected(workflowId);
      if (state.current.status !== "healthy") {
        throw new WorkflowManifestLoadError(
          state.current.status === "unsafe" ? "unsafe" : "corrupt",
          state.paths.current,
        );
      }
      if (state.journal.status !== "healthy") {
        if (state.journal.status === "missing") return;
        throw new WorkflowManifestLoadError(state.journal.status, state.paths.autosave);
      }
      if (state.journal.value.targetRevision !== expectedTargetRevision) {
        throw new WorkflowRevisionConflictError(
          workflowId,
          expectedTargetRevision,
          state.journal.value.targetRevision,
        );
      }
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      await this.removeFileDurably(state.paths.autosave);
    });
  }

  async put(
    snapshot: WorkflowDocumentV1,
    expectedRevision: number | null,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    const parsed = parseSnapshot(snapshot);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      await this.stageAutosaveInternal(parsed, expectedRevision, isCurrent);
      const state = await this.inspected(parsed.id);
      if (state.journal.status !== "healthy") {
        throw new WorkflowManifestLoadError(
          state.journal.status === "unsafe" ? "unsafe" : "corrupt",
          state.paths.autosave,
        );
      }
      return this.finishJournalCommit(state, state.journal.value, expectedRevision, isCurrent);
    });
  }

  async save(
    snapshot: WorkflowDocumentV1,
    expectedRevision: number | null,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    return this.put(snapshot, expectedRevision, isCurrent);
  }

  async create(
    snapshot: WorkflowDocumentV1,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    return this.put(snapshot, null, isCurrent);
  }

  async rename(
    workflowId: string,
    title: string,
    expectedRevision: number,
    updatedAt: string,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    const current = await this.get(workflowId);
    if (!current) throw new WorkflowRevisionConflictError(workflowId, expectedRevision, null);
    const next = parseSnapshot({
      ...current,
      title,
      revision: expectedRevision + 1,
      updatedAt,
    });
    return this.put(next, expectedRevision, isCurrent);
  }

  async duplicate(
    sourceWorkflowId: string,
    input: {
      workflowId: string;
      expectedRevision: number;
      title?: string;
      now: string;
    },
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    const source = await this.get(sourceWorkflowId);
    if (!source) throw new Error("The source workflow does not exist.");
    if (source.revision !== input.expectedRevision) {
      throw new WorkflowRevisionConflictError(
        sourceWorkflowId,
        input.expectedRevision,
        source.revision,
      );
    }
    const duplicate = parseSnapshot({
      ...structuredClone(source),
      id: validateWorkflowId(input.workflowId),
      title: input.title ?? `${source.title} copy`,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return this.put(duplicate, null, isCurrent);
  }

  async delete(
    workflowId: string,
    expectedRevision: number,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    validateWorkflowId(workflowId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.inspected(workflowId);
      if (state.current.status === "corrupt" || state.current.status === "unsafe") {
        throw new WorkflowManifestLoadError(state.current.status, state.paths.current);
      }
      const current = state.current.status === "healthy" ? state.current.value : undefined;
      if (!current || current.revision !== expectedRevision) {
        throw new WorkflowRevisionConflictError(
          workflowId,
          expectedRevision,
          current?.revision ?? null,
        );
      }
      const health = this.recoveryHealthOf(workflowId, state);
      if (health.status === "unsafe" || health.status === "recovery-required") {
        throw new WorkflowManifestLoadError(
          health.status === "unsafe" ? "unsafe" : "corrupt",
          health.status !== "unsafe" && health.reason.startsWith("journal-")
            ? state.paths.autosave
            : state.paths.current,
        );
      }
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      const deletedBytes = await this.deletedWorkflowDirectoryBytes(state.paths.directory);
      if (deletedBytes > this.limits.maxDeletedQuarantineBytes) {
        throw new Error(
          "Create Images cannot retain this deleted workflow within its recovery limit.",
        );
      }
      await this.pruneDeletedQuarantine();
      const quarantine = path.join(
        this.deletedWorkflowQuarantinePath(),
        `deleted-${workflowId}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
      );
      await fs.rename(state.paths.directory, quarantine);
      const touchedAt = new Date();
      await fs.utimes(quarantine, touchedAt, touchedAt);
      await this.syncDirectory(this.workflowsPath());
      await this.syncDirectory(path.dirname(quarantine));
      await this.pruneDeletedQuarantine();
      await this.refreshIndexAfterAuthoritativeMutation();
      return structuredClone(current);
    });
  }

  async repairRecoveryMetadata(
    workflowId: string,
    expectedRevision: number,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    validateWorkflowId(workflowId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.inspected(workflowId);
      if (state.current.status !== "healthy") {
        throw new WorkflowManifestLoadError(
          state.current.status === "unsafe" ? "unsafe" : "corrupt",
          state.paths.current,
        );
      }
      if (state.current.value.revision !== expectedRevision) {
        throw new WorkflowRevisionConflictError(
          workflowId,
          expectedRevision,
          state.current.value.revision,
        );
      }
      if (state.lastKnownGood.status === "unsafe" || state.journal.status === "unsafe") {
        throw new WorkflowManifestLoadError(
          "unsafe",
          state.lastKnownGood.status === "unsafe"
            ? state.paths.lastKnownGood
            : state.paths.autosave,
        );
      }
      if (state.journal.status === "healthy") {
        throw new Error(
          "Flush or discard the pending autosave before repairing recovery metadata.",
        );
      }
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      await this.assertMutationWithinLimits(
        workflowId,
        new Map<string, unknown | undefined>([
          [state.paths.lastKnownGood, state.current.value],
          [state.paths.autosave, undefined],
        ]),
      );
      if (state.lastKnownGood.status === "corrupt") {
        await this.quarantineFile(
          state.paths.lastKnownGood,
          `${workflowId}-last-known-good-corrupt`,
        );
      }
      if (state.journal.status === "corrupt") {
        await this.quarantineFile(state.paths.autosave, `${workflowId}-autosave-corrupt`);
      }
      await this.writeAtomic(
        state.paths.lastKnownGood,
        state.current.value,
        MAX_WORKFLOW_BYTES,
        () => true,
      );
      await this.refreshIndexAfterAuthoritativeMutation();
      return structuredClone(state.current.value);
    });
  }

  async recover(
    workflowId: string,
    source: "last-known-good" | "autosave",
    expectedCandidateRevision: number,
    recoveredAt: string,
    isCurrent: () => boolean = () => true,
  ): Promise<WorkflowDocumentV1> {
    validateWorkflowId(workflowId);
    return serializedAtRoot(this.root(), async () => {
      await this.prepare();
      const state = await this.inspected(workflowId);
      if (
        state.current.status === "unsafe" ||
        state.lastKnownGood.status === "unsafe" ||
        state.journal.status === "unsafe"
      ) {
        throw new WorkflowManifestLoadError(
          "unsafe",
          state.current.status === "unsafe"
            ? state.paths.current
            : state.lastKnownGood.status === "unsafe"
              ? state.paths.lastKnownGood
              : state.paths.autosave,
        );
      }
      const health = this.recoveryHealthOf(workflowId, state);
      const healthyCurrentAutosaveRecovery =
        state.current.status === "healthy" &&
        source === "autosave" &&
        state.journal.status === "healthy" &&
        health.status === "recovery-required" &&
        health.reason === "last-known-good-corrupt";
      if (
        state.current.status === "healthy" &&
        !healthyCurrentAutosaveRecovery &&
        !(
          health.status === "recovery-required" &&
          (health.reason === "journal-conflict" || health.reason === "journal-pending")
        )
      ) {
        throw new Error("A healthy workflow does not require recovery.");
      }
      const candidate =
        source === "last-known-good"
          ? this.validRecoveryCandidate(state.lastKnownGood, workflowId)
          : this.validRecoveryCandidate(state.journal, workflowId);
      if (!candidate || candidate.revision !== expectedCandidateRevision) {
        throw new WorkflowRevisionConflictError(
          workflowId,
          expectedCandidateRevision,
          candidate?.revision ?? null,
        );
      }
      const highestRecoveryRevision = Math.max(
        candidate.revision,
        state.current.status === "healthy" ? state.current.value.revision : 0,
        this.validRecoveryCandidate(state.lastKnownGood, workflowId)?.revision ?? 0,
        this.validRecoveryCandidate(state.journal, workflowId)?.revision ?? 0,
      );
      const recovered = parseSnapshot({
        ...structuredClone(candidate),
        revision: highestRecoveryRevision + 1,
        updatedAt: recoveredAt,
      });
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      await this.assertMutationWithinLimits(
        workflowId,
        new Map<string, unknown | undefined>([
          [state.paths.current, recovered],
          [state.paths.lastKnownGood, recovered],
          [state.paths.autosave, undefined],
        ]),
      );
      if (state.current.status === "corrupt") {
        await this.quarantineFile(state.paths.current, `${workflowId}-current-corrupt`);
      }
      if (state.lastKnownGood.status === "corrupt") {
        await this.quarantineFile(
          state.paths.lastKnownGood,
          `${workflowId}-last-known-good-corrupt`,
        );
      }
      await this.writeAtomic(state.paths.current, recovered, MAX_WORKFLOW_BYTES, () => true);
      await this.writeAtomic(state.paths.lastKnownGood, recovered, MAX_WORKFLOW_BYTES, () => true);
      if (state.journal.status !== "missing") {
        if (state.journal.status === "corrupt") {
          await this.quarantineFile(state.paths.autosave, `${workflowId}-autosave-corrupt`);
        } else {
          await this.removeFileDurably(state.paths.autosave);
        }
      }
      await this.refreshIndexAfterAuthoritativeMutation();
      return structuredClone(recovered);
    });
  }
}
