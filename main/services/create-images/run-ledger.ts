import { initializeSqliteReclamation, reclaimSqlitePages } from "../sqlite-reclamation.js";
// Append-friendly run history for Create Images. One row per node attempt; every
// write is a single keyed statement. The ledger is history, not a work queue: a
// restart marks unfinished work interrupted and nothing is ever resubmitted.
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AttemptCostStatus,
  AttemptSnapshot,
  AttemptState,
  OutputRef,
  RunScope,
  RunState,
  RunSummary,
} from "../../../renderer/shared/images/run-types.js";

export const RUN_RETENTION = 100;
const FILE = "runs-v1.sqlite";
const MAX_OUTPUTS = 4;
const MAX_ERROR_MESSAGE = 1_024;

export class ImageRunLedgerError extends Error {
  constructor(
    /**
     * `unsafe`: a file-safety refusal (a link, extra hard links, another owner); never repaired.
     * `corrupt` / `unsupported`: a damaged file or a schema this build does not know, which
     * `open({ quarantineDamaged })` moves aside. `closed`: used after `close()`.
     */
    readonly code: "unsafe" | "corrupt" | "unsupported" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "ImageRunLedgerError";
  }
}

export interface CreateRunInput {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  scope: RunScope;
  requestLimit: number;
  attempts: readonly { nodeId: string; variant: number; provider?: string; model?: string }[];
}

export interface AttemptFinish {
  runId: string;
  nodeId: string;
  variant: number;
  state: "succeeded" | "failed" | "skipped" | "cancelled";
  errorCode?: string;
  errorMessage?: string;
  truncated?: boolean;
  costUsd?: number;
  costStatus?: AttemptCostStatus;
  output?: readonly OutputRef[];
}

const SCHEMA = `
  CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('all','from-node','node-only')), scope_node_id TEXT
    CHECK((scope = 'all' AND scope_node_id IS NULL) OR (scope <> 'all' AND coalesce(length(scope_node_id), 0) > 0)),
    state TEXT NOT NULL CHECK(state IN
    ('running','succeeded','partial','failed','cancelled','interrupted')),
    request_limit INTEGER NOT NULL, requests_sent INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, finished_at INTEGER, end_reason TEXT);
  CREATE INDEX runs_by_workflow ON runs(workflow_id, created_at DESC);
  CREATE TABLE attempts (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL, variant INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN
    ('queued','running','succeeded','failed','skipped','cancelled','interrupted')),
    provider TEXT, model TEXT, submitted_at INTEGER, finished_at INTEGER, error_code TEXT,
    error_message TEXT CHECK(length(error_message) <= 1024), cancel_requested INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0, cost_usd REAL, cost_status TEXT, output TEXT,
    UNIQUE(run_id, node_id, variant));
  CREATE INDEX live_attempts ON attempts(state) WHERE state IN ('queued','running');
  PRAGMA user_version=1;
`;

// "Newest" is the attempt id: rows are inserted in order, so it never depends on the wall clock
// (an NTP step backwards would otherwise reorder `finished_at`). Every query that picks a node's
// latest output uses this same ordering, so display, staleness and retention always agree.
const LATEST_PER_NODE = `
  SELECT r.workflow_id AS workflow_id, a.node_id AS node_id, a.run_id AS run_id
  FROM attempts a JOIN runs r ON r.id = a.run_id
  WHERE a.id IN (
    SELECT MAX(b.id) FROM attempts b JOIN runs s ON s.id = b.run_id
    WHERE b.state = 'succeeded' AND b.output IS NOT NULL
    GROUP BY s.workflow_id, b.node_id
  )
`;

/**
 * Additions made after schema v1 shipped. Pre-1.0 there is no migration code and `user_version`
 * stays 1: every open adds whatever is missing, so a ledger from an older build gains them.
 * `attempts.prompt` is the prompt text sent with a Generate request (removed with its run);
 * `exports` maps an image asset to Aiden's auto-saved copy of it in the Pictures folder.
 */
function ensureAdditions(db: DatabaseSync): void {
  const columns = (db.prepare("PRAGMA table_info(attempts)").all() as unknown as { name: string }[]).map((row) => row.name);
  if (!columns.includes("prompt")) db.exec("ALTER TABLE attempts ADD COLUMN prompt TEXT");
  db.exec("CREATE TABLE IF NOT EXISTS exports (asset_id TEXT PRIMARY KEY, path TEXT NOT NULL, exported_at INTEGER NOT NULL)");
}

const OLDER_THAN_RECENT = `
  WITH recent AS (SELECT id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?)
  SELECT id FROM runs WHERE state <> 'running' AND id NOT IN (SELECT id FROM recent)
`;

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_revision: number;
  scope: string;
  scope_node_id: string | null;
  state: RunState;
  request_limit: number;
  requests_sent: number;
  created_at: number;
  finished_at: number | null;
  end_reason: string | null;
}

interface AttemptRow {
  node_id: string;
  variant: number;
  state: AttemptState;
  provider: string | null;
  model: string | null;
  submitted_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  cancel_requested: number;
  truncated: number;
  cost_usd: number | null;
  cost_status: AttemptCostStatus | null;
  output: string | null;
  prompt: string | null;
}

/** One succeeded Generate attempt with its images, for the gallery. */
export interface GeneratedAttempt {
  runId: string;
  workflowId: string;
  nodeId: string;
  variant: number;
  provider: string;
  model: string;
  prompt?: string;
  finishedAt: number;
  output: OutputRef[];
}

interface GeneratedAttemptRow {
  run_id: string;
  workflow_id: string;
  node_id: string;
  variant: number;
  provider: string;
  model: string | null;
  prompt: string | null;
  finished_at: number | null;
  created_at: number;
  output: string;
}

function generatedAttemptFrom(row: GeneratedAttemptRow): GeneratedAttempt {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    nodeId: row.node_id,
    variant: Number(row.variant),
    provider: row.provider,
    model: row.model ?? "",
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    finishedAt: Number(row.finished_at ?? row.created_at),
    output: parseOutput(row.output),
  };
}

const MAY_BE_BILLED = new Set<AttemptState>(["failed", "cancelled", "interrupted"]);
const NOT_QUEUED = Symbol("attempt-not-queued");

function assertPrivate(target: string, directory: boolean): void {
  const stat = lstatSync(target);
  const owned = !process.getuid || stat.uid === process.getuid();
  const shaped = directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1;
  if (stat.isSymbolicLink() || !shaped || !owned) {
    throw new ImageRunLedgerError("unsafe", "The image run ledger is not a private file.");
  }
  chmodSync(target, directory ? 0o700 : 0o600);
}

function isOutputRef(value: unknown): value is OutputRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.assetId === "string" &&
    /^[0-9a-f]{64}$/u.test(ref.assetId) &&
    Number.isSafeInteger(ref.width) &&
    Number.isSafeInteger(ref.height) &&
    (ref.mediaType === "image/png" || ref.mediaType === "image/jpeg" || ref.mediaType === "image/webp")
  );
}

function parseOutput(text: string | null): OutputRef[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter(isOutputRef).slice(0, MAX_OUTPUTS) : [];
  } catch {
    return [];
  }
}

function summaryFrom(row: RunRow): RunSummary {
  return {
    runId: row.id,
    workflowId: row.workflow_id,
    workflowRevision: Number(row.workflow_revision),
    scope:
      (row.scope === "from-node" || row.scope === "node-only") && row.scope_node_id
        ? { kind: row.scope, nodeId: row.scope_node_id }
        : { kind: "all" },
    state: row.state,
    requestLimit: Number(row.request_limit),
    requestsSent: Number(row.requests_sent),
    createdAt: Number(row.created_at),
    ...(row.finished_at !== null ? { finishedAt: Number(row.finished_at) } : {}),
    ...(row.end_reason !== null ? { endReason: row.end_reason } : {}),
  };
}

function attemptFrom(row: AttemptRow): AttemptSnapshot {
  return {
    nodeId: row.node_id,
    variant: Number(row.variant),
    state: row.state,
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.submitted_at !== null ? { submittedAt: Number(row.submitted_at) } : {}),
    ...(row.finished_at !== null ? { finishedAt: Number(row.finished_at) } : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    cancelRequested: Number(row.cancel_requested) === 1,
    truncated: Number(row.truncated) === 1,
    ...(row.cost_usd !== null ? { costUsd: Number(row.cost_usd) } : {}),
    ...(row.cost_status !== null ? { costStatus: row.cost_status } : {}),
    output: parseOutput(row.output),
    mayHaveBeenBilled: row.submitted_at !== null && MAY_BE_BILLED.has(row.state),
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
  };
}

function statements(db: DatabaseSync) {
  return {
    insertRun: db.prepare(
      "INSERT INTO runs (id, workflow_id, workflow_revision, scope, scope_node_id, state, request_limit, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
    ),
    insertAttempt: db.prepare(
      "INSERT INTO attempts (run_id, node_id, variant, state, provider, model) VALUES (?, ?, ?, 'queued', ?, ?)",
    ),
    claim: db.prepare(
      "UPDATE runs SET requests_sent = requests_sent + 1 WHERE id = ? AND state = 'running' AND requests_sent < request_limit",
    ),
    submit: db.prepare(
      "UPDATE attempts SET state = 'running', submitted_at = ?, prompt = ? WHERE run_id = ? AND node_id = ? AND variant = ? AND state = 'queued' AND cancel_requested = 0",
    ),
    finish: db.prepare(
      "UPDATE attempts SET state = ?, finished_at = ?, error_code = ?, error_message = ?, truncated = ?, cost_usd = ?, cost_status = ?, output = ? WHERE run_id = ? AND node_id = ? AND variant = ? AND state IN ('queued', 'running')",
    ),
    requestCancel: db.prepare(
      "UPDATE attempts SET cancel_requested = 1 WHERE run_id = ? AND state IN ('queued', 'running')",
    ),
    endLive: db.prepare(
      "UPDATE attempts SET state = ?, finished_at = ? WHERE run_id = ? AND state IN ('queued', 'running')",
    ),
    finishRun: db.prepare(
      "UPDATE runs SET state = ?, finished_at = ?, end_reason = ? WHERE id = ? AND state = 'running'",
    ),
    run: db.prepare("SELECT * FROM runs WHERE id = ?"),
    attempts: db.prepare(
      "SELECT node_id, variant, state, provider, model, submitted_at, finished_at, error_code, error_message, cancel_requested, truncated, cost_usd, cost_status, output, prompt FROM attempts WHERE run_id = ? ORDER BY id",
    ),
    latestRun: db.prepare("SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    listRuns: db.prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"),
    latestOutputs: db.prepare(
      "SELECT a.node_id AS node_id, a.output AS output FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.workflow_id = ? AND a.state = 'succeeded' AND a.output IS NOT NULL ORDER BY a.id DESC",
    ),
    outputSequence: db.prepare(
      "SELECT a.node_id AS node_id, a.id AS sequence FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.workflow_id = ? AND a.state = 'succeeded' AND a.output IS NOT NULL ORDER BY a.id DESC",
    ),
    // Only provider (Generate) attempts: their outputs are what an `images-run` holder retains.
    // Image Input and Output attempts only forward images other holders already keep.
    generatedOutputs: db.prepare(
      "SELECT r.id AS run_id, r.workflow_id AS workflow_id, a.output AS output FROM runs r LEFT JOIN attempts a ON a.run_id = r.id AND a.state = 'succeeded' AND a.output IS NOT NULL AND a.provider IS NOT NULL",
    ),
    liveRuns: db.prepare("SELECT id FROM runs WHERE state = 'running' ORDER BY created_at"),
    interruptAttempts: db.prepare(
      "UPDATE attempts SET state = 'interrupted', finished_at = ? WHERE state IN ('queued', 'running')",
    ),
    interruptRuns: db.prepare(
      "UPDATE runs SET state = 'interrupted', finished_at = ?, end_reason = 'app-restart' WHERE state = 'running'",
    ),
    latestPerNode: db.prepare(LATEST_PER_NODE),
    olderThanRecent: db.prepare(OLDER_THAN_RECENT),
    deleteRun: db.prepare("DELETE FROM runs WHERE id = ?"),
    workflowRuns: db.prepare("SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at"),
    // Newest first by finish time, then insertion order for attempts that finished in the same millisecond.
    generatedAttempts: db.prepare(
      `SELECT r.id AS run_id, r.workflow_id AS workflow_id, a.node_id AS node_id, a.variant AS variant, a.provider AS provider,
        a.model AS model, a.prompt AS prompt, a.finished_at AS finished_at, r.created_at AS created_at, a.output AS output
      FROM attempts a JOIN runs r ON r.id = a.run_id
      WHERE a.state = 'succeeded' AND a.output IS NOT NULL AND a.provider IS NOT NULL AND (?1 IS NULL OR r.workflow_id = ?1)
      ORDER BY a.finished_at DESC, a.id DESC LIMIT ?2`,
    ),
    allOutputs: db.prepare("SELECT output FROM attempts WHERE output IS NOT NULL"),
    exportPath: db.prepare("SELECT path FROM exports WHERE asset_id = ?"),
    allExports: db.prepare("SELECT asset_id, path FROM exports"),
    recordExport: db.prepare(
      "INSERT INTO exports (asset_id, path, exported_at) VALUES (?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET path = excluded.path, exported_at = excluded.exported_at",
    ),
    exportIds: db.prepare("SELECT asset_id FROM exports"),
    deleteExport: db.prepare("DELETE FROM exports WHERE asset_id = ?"),
  };
}

export interface ImageRunLedgerOptions {
  directory: string;
  now?: () => number;
  /**
   * The node ids a workflow's document has now, `"all"` when its file exists but cannot be read
   * (kept for repair, so nothing of it may be pruned), or undefined when the document is gone.
   * Retention keeps a node's latest output only while that node still exists. Without this option
   * the ledger cannot see documents and treats every node it has history for as live.
   */
  liveNodeIds?: (workflowId: string) => ReadonlySet<string> | "all" | undefined;
  /**
   * When given, a corrupt ledger or one with an unsupported schema is renamed aside (with its
   * -wal and -shm files) and an empty ledger is created; this is told where the old file went.
   * The ledger is history only, so damage must not lock anyone out of their workflows.
   * File-safety refusals are never quarantined.
   */
  quarantineDamaged?: (quarantinedPath: string, error: unknown) => void;
}

/** SQLITE_CORRUPT and SQLITE_NOTADB, the primary result codes for a damaged database file. */
const DAMAGED_SQLITE_CODES = new Set([11, 26]);

function isDamaged(error: unknown): boolean {
  if (error instanceof ImageRunLedgerError) return error.code === "corrupt" || error.code === "unsupported";
  const sqlite = error as { code?: unknown; errcode?: unknown };
  return sqlite?.code === "ERR_SQLITE_ERROR" && typeof sqlite.errcode === "number" && DAMAGED_SQLITE_CODES.has(sqlite.errcode & 0xff);
}

/** Renames the ledger and its sidecars to `runs-v1.sqlite.corrupt-<time>[-n]`, keeping SQLite's suffixes. */
function quarantine(file: string, at: number): string {
  let target = `${file}.corrupt-${at}`;
  for (let n = 1; [target, `${target}-wal`, `${target}-shm`].some((candidate) => existsSync(candidate)); n += 1) {
    target = `${file}.corrupt-${at}-${n}`;
  }
  renameSync(file, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(file + suffix)) renameSync(file + suffix, target + suffix);
  }
  return target;
}

export class ImageRunLedger {
  private closed = false;
  private readonly sql: ReturnType<typeof statements>;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly liveNodeIds: ImageRunLedgerOptions["liveNodeIds"],
  ) {
    this.sql = statements(db);
  }

  static open(options: ImageRunLedgerOptions): ImageRunLedger {
    try {
      return ImageRunLedger.openFile(options);
    } catch (error) {
      if (!options.quarantineDamaged || !isDamaged(error)) throw error;
      const moved = quarantine(path.join(options.directory, FILE), (options.now ?? Date.now)());
      options.quarantineDamaged(moved, error);
      return ImageRunLedger.openFile(options);
    }
  }

  private static openFile(options: ImageRunLedgerOptions): ImageRunLedger {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    assertPrivate(options.directory, true);
    const file = path.join(options.directory, FILE);
    let fd: number;
    try {
      fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ImageRunLedgerError("unsafe", "The image run ledger is a symbolic link.");
      }
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
        throw new ImageRunLedgerError("unsafe", "The image run ledger is not a private file.");
      }
    } finally {
      closeSync(fd);
    }
    assertPrivate(file, false);
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout=100;");
      initializeSqliteReclamation(db);
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
      const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) {
          throw new ImageRunLedgerError("corrupt", "The image run ledger has no schema version.");
        }
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
      } else if (version !== 1) {
        throw new ImageRunLedgerError("unsupported", "The image run ledger uses an unsupported schema.");
      }
      const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'attempts')").get() as { count: number };
      if (Number(tables.count) !== 2) throw new ImageRunLedgerError("corrupt", "The image run ledger is missing its tables.");
      db.exec("BEGIN IMMEDIATE");
      try {
        ensureAdditions(db);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // SQLite may already have rolled back.
        }
        throw error;
      }
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(file + suffix)) assertPrivate(file + suffix, false);
      }
      reclaimSqlitePages(db);
      return new ImageRunLedger(db, options.now ?? Date.now, options.liveNodeIds);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  createRun(input: CreateRunInput): void {
    this.transaction(() => {
      this.sql.insertRun.run(
        input.runId,
        input.workflowId,
        input.workflowRevision,
        input.scope.kind,
        input.scope.kind === "all" ? null : input.scope.nodeId,
        input.requestLimit,
        this.now(),
      );
      for (const attempt of input.attempts) {
        this.sql.insertAttempt.run(input.runId, attempt.nodeId, attempt.variant, attempt.provider ?? null, attempt.model ?? null);
      }
    });
  }

  /**
   * Counts one paid request and marks the attempt submitted, atomically, before the call is made.
   * `prompt` is the exact text the request sends, kept so history can show it; it is stored only
   * here and goes away when the run is pruned.
   */
  claimProviderRequest(runId: string, nodeId: string, variant: number, prompt?: string): boolean {
    try {
      return this.transaction(() => {
        if (Number(this.sql.claim.run(runId).changes) !== 1) return false;
        if (Number(this.sql.submit.run(this.now(), prompt ?? null, runId, nodeId, variant).changes) !== 1) throw NOT_QUEUED;
        return true;
      });
    } catch (error) {
      if (error === NOT_QUEUED) return false;
      throw error;
    }
  }

  finishAttempts(updates: readonly AttemptFinish[]): void {
    if (updates.length === 0) return;
    this.transaction(() => {
      const at = this.now();
      for (const update of updates) {
        this.sql.finish.run(
          update.state,
          at,
          update.errorCode ?? null,
          update.errorMessage?.slice(0, MAX_ERROR_MESSAGE) ?? null,
          update.truncated ? 1 : 0,
          update.costUsd ?? null,
          update.costStatus ?? null,
          update.output && update.output.length > 0 ? JSON.stringify(update.output.slice(0, MAX_OUTPUTS)) : null,
          update.runId,
          update.nodeId,
          update.variant,
        );
      }
    });
  }

  requestCancel(runId: string): void {
    this.requireOpen();
    this.sql.requestCancel.run(runId);
  }

  finishRun(runId: string, state: Exclude<RunState, "running" | "interrupted">, endReason?: string): void {
    this.requireOpen();
    this.sql.finishRun.run(state, this.now(), endReason ?? null, runId);
  }

  /** Ends every live attempt and the run in one transaction (quit, or an executor fault). */
  terminateRun(runId: string, state: "cancelled" | "failed", endReason: string): void {
    this.transaction(() => {
      const at = this.now();
      this.sql.endLive.run(state, at, runId);
      this.sql.finishRun.run(state, at, endReason, runId);
    });
  }

  snapshot(runId: string): { run: RunSummary; attempts: AttemptSnapshot[] } | null {
    this.requireOpen();
    const row = this.sql.run.get(runId) as RunRow | undefined;
    if (!row) return null;
    return {
      run: summaryFrom(row),
      attempts: (this.sql.attempts.all(runId) as unknown as AttemptRow[]).map(attemptFrom),
    };
  }

  latestRunId(workflowId: string): string | null {
    this.requireOpen();
    return (this.sql.latestRun.get(workflowId) as { id: string } | undefined)?.id ?? null;
  }

  listRuns(workflowId: string, limit: number): RunSummary[] {
    this.requireOpen();
    return (this.sql.listRuns.all(workflowId, limit) as unknown as RunRow[]).map(summaryFrom);
  }

  latestOutputs(workflowId: string): Record<string, OutputRef[]> {
    this.requireOpen();
    const latest: Record<string, OutputRef[]> = {};
    for (const row of this.sql.latestOutputs.all(workflowId) as unknown as { node_id: string; output: string }[]) {
      if (!Object.prototype.hasOwnProperty.call(latest, row.node_id)) latest[row.node_id] = parseOutput(row.output);
    }
    return latest;
  }

  /** Same ordering as `latestOutputs`, so the two always agree on which attempt is a node's newest. */
  latestOutputSequence(workflowId: string): Record<string, number> {
    this.requireOpen();
    const latest: Record<string, number> = {};
    for (const row of this.sql.outputSequence.all(workflowId) as unknown as { node_id: string; sequence: number }[]) {
      if (!Object.prototype.hasOwnProperty.call(latest, row.node_id)) latest[row.node_id] = Number(row.sequence);
    }
    return latest;
  }

  /**
   * Distinct generated image assets per workflow, however many attempts hold them: exactly what
   * releasing the workflow's `images-run` holders lets go of. Image Input and Output attempts are
   * not counted; they forward images other holders keep.
   */
  imageAssetIds(): Record<string, string[]> {
    const seen = new Map<string, Set<string>>();
    for (const row of this.generatedRows()) {
      const ids = seen.get(row.workflow_id) ?? new Set<string>();
      for (const ref of parseOutput(row.output)) ids.add(ref.assetId);
      seen.set(row.workflow_id, ids);
    }
    return Object.fromEntries([...seen].filter(([, ids]) => ids.size > 0).map(([workflowId, ids]) => [workflowId, [...ids].sort()]));
  }

  /** Every run in the ledger with the generated assets its `images-run` holder should keep (possibly none). */
  runAssetIds(): Map<string, string[]> {
    const runs = new Map<string, Set<string>>();
    for (const row of this.generatedRows()) {
      const ids = runs.get(row.run_id) ?? new Set<string>();
      for (const ref of parseOutput(row.output)) ids.add(ref.assetId);
      runs.set(row.run_id, ids);
    }
    return new Map([...runs].map(([runId, ids]) => [runId, [...ids].sort()]));
  }

  /**
   * Succeeded Generate attempts with their images, newest first: one workflow's, or every
   * workflow's when `workflowId` is undefined. Includes latest outputs kept past run retention.
   */
  generatedAttempts(workflowId: string | undefined, limit: number): GeneratedAttempt[] {
    this.requireOpen();
    return (this.sql.generatedAttempts.all(workflowId ?? null, limit) as unknown as GeneratedAttemptRow[]).map(generatedAttemptFrom);
  }

  /** The newest succeeded Generate attempt that produced this asset, or undefined when the ledger never generated it. */
  generatedAsset(assetId: string): { attempt: GeneratedAttempt; ref: OutputRef } | undefined {
    this.requireOpen();
    for (const row of this.sql.generatedAttempts.all(null, -1) as unknown as GeneratedAttemptRow[]) {
      const attempt = generatedAttemptFrom(row);
      const ref = attempt.output.find((candidate) => candidate.assetId === assetId);
      if (ref) return { attempt, ref };
    }
    return undefined;
  }

  /** Where Aiden auto-saved this asset, if it recorded doing so. The file may since have moved. */
  exportPath(assetId: string): string | undefined {
    this.requireOpen();
    return (this.sql.exportPath.get(assetId) as { path: string } | undefined)?.path;
  }

  /** Every recorded auto-saved copy, by asset id. */
  exportPaths(): Map<string, string> {
    this.requireOpen();
    return new Map((this.sql.allExports.all() as unknown as { asset_id: string; path: string }[]).map((row) => [row.asset_id, row.path]));
  }

  recordExport(assetId: string, filePath: string): void {
    this.requireOpen();
    this.sql.recordExport.run(assetId, filePath, this.now());
  }

  /** Drops export records of assets no attempt names any more; the files themselves are the person's and stay. */
  private forgetOrphanExports(): void {
    const known = new Set<string>();
    for (const row of this.sql.allOutputs.all() as unknown as { output: string }[]) {
      for (const ref of parseOutput(row.output)) known.add(ref.assetId);
    }
    for (const row of this.sql.exportIds.all() as unknown as { asset_id: string }[]) {
      if (!known.has(row.asset_id)) this.sql.deleteExport.run(row.asset_id);
    }
  }

  private generatedRows(): { run_id: string; workflow_id: string; output: string | null }[] {
    this.requireOpen();
    return this.sql.generatedOutputs.all() as unknown as { run_id: string; workflow_id: string; output: string | null }[];
  }

  /** The single restart sweep: unfinished work becomes history, never a queue. */
  interruptInFlight(): string[] {
    return this.transaction(() => {
      const runs = (this.sql.liveRuns.all() as unknown as { id: string }[]).map((row) => row.id);
      const at = this.now();
      this.sql.interruptAttempts.run(at);
      this.sql.interruptRuns.run(at);
      return runs;
    });
  }

  /**
   * Keeps the newest `keep` runs, every running run, and each run holding the latest output of a
   * node that still exists in its workflow's document (every node, while that document is
   * unreadable). A deleted node or workflow keeps nothing, so retention stays bounded however often
   * node ids change.
   */
  pruneRuns(keep = RUN_RETENTION): string[] {
    return this.transaction(() => {
      const holding = new Set<string>();
      for (const row of this.sql.latestPerNode.all() as unknown as { workflow_id: string; node_id: string; run_id: string }[]) {
        if (this.isLiveNode(row.workflow_id, row.node_id)) holding.add(row.run_id);
      }
      const ids = (this.sql.olderThanRecent.all(keep) as unknown as { id: string }[]).map((row) => row.id).filter((id) => !holding.has(id));
      for (const id of ids) this.sql.deleteRun.run(id);
      if (ids.length > 0) this.forgetOrphanExports();
      return ids;
    });
  }

  private isLiveNode(workflowId: string, nodeId: string): boolean {
    if (!this.liveNodeIds) return true;
    const live = this.liveNodeIds(workflowId);
    return live === "all" || (live?.has(nodeId) ?? false);
  }

  deleteWorkflowRuns(workflowId: string): string[] {
    return this.transaction(() => {
      const ids = (this.sql.workflowRuns.all(workflowId) as unknown as { id: string }[]).map((row) => row.id);
      for (const id of ids) this.sql.deleteRun.run(id);
      if (ids.length > 0) this.forgetOrphanExports();
      return ids;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    reclaimSqlitePages(this.db);
    this.db.close();
  }

  private requireOpen(): void {
    if (this.closed) throw new ImageRunLedgerError("closed", "The image run ledger is closed.");
  }

  private transaction<T>(work: () => T): T {
    this.requireOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back; never mask the original error.
      }
      throw error;
    }
  }
}
