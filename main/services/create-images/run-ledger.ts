// Append-friendly run history for Create Images. One row per node attempt; every
// write is a single keyed statement. The ledger is history, not a work queue: a
// restart marks unfinished work interrupted and nothing is ever resubmitted.
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
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
    readonly code: "unsafe" | "unsupported" | "closed",
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
    scope TEXT NOT NULL CHECK(scope IN ('all','from-node','node-only')), scope_node_id TEXT, state TEXT NOT NULL CHECK(state IN
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

const PRUNABLE = `
  WITH latest AS (
    SELECT r.workflow_id AS workflow_id, a.node_id AS node_id, MAX(a.finished_at) AS finished_at
    FROM attempts a JOIN runs r ON r.id = a.run_id
    WHERE a.state = 'succeeded' AND a.output IS NOT NULL
    GROUP BY r.workflow_id, a.node_id
  ),
  holding AS (
    SELECT DISTINCT a.run_id AS id
    FROM attempts a
    JOIN runs r ON r.id = a.run_id
    JOIN latest l ON l.workflow_id = r.workflow_id AND l.node_id = a.node_id AND l.finished_at = a.finished_at
    WHERE a.state = 'succeeded' AND a.output IS NOT NULL
  ),
  recent AS (SELECT id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?)
  SELECT id FROM runs
  WHERE state <> 'running' AND id NOT IN (SELECT id FROM recent) AND id NOT IN (SELECT id FROM holding)
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
      "UPDATE attempts SET state = 'running', submitted_at = ? WHERE run_id = ? AND node_id = ? AND variant = ? AND state = 'queued'",
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
      "SELECT node_id, variant, state, provider, model, submitted_at, finished_at, error_code, error_message, cancel_requested, truncated, cost_usd, cost_status, output FROM attempts WHERE run_id = ? ORDER BY id",
    ),
    latestRun: db.prepare("SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    listRuns: db.prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"),
    latestOutputs: db.prepare(
      "SELECT a.node_id AS node_id, a.output AS output FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.workflow_id = ? AND a.state = 'succeeded' AND a.output IS NOT NULL ORDER BY a.finished_at DESC, a.id DESC",
    ),
    outputSequence: db.prepare(
      "SELECT a.node_id AS node_id, a.id AS sequence FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.workflow_id = ? AND a.state = 'succeeded' AND a.output IS NOT NULL ORDER BY a.finished_at DESC, a.id DESC",
    ),
    imageOutputs: db.prepare(
      "SELECT r.workflow_id AS workflow_id, a.output AS output FROM attempts a JOIN runs r ON r.id = a.run_id WHERE a.state = 'succeeded' AND a.output IS NOT NULL",
    ),
    liveRuns: db.prepare("SELECT id FROM runs WHERE state = 'running' ORDER BY created_at"),
    interruptAttempts: db.prepare(
      "UPDATE attempts SET state = 'interrupted', finished_at = ? WHERE state IN ('queued', 'running')",
    ),
    interruptRuns: db.prepare(
      "UPDATE runs SET state = 'interrupted', finished_at = ?, end_reason = 'app-restart' WHERE state = 'running'",
    ),
    prunable: db.prepare(PRUNABLE),
    deleteRun: db.prepare("DELETE FROM runs WHERE id = ?"),
    workflowRuns: db.prepare("SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at"),
  };
}

export class ImageRunLedger {
  private closed = false;
  private readonly sql: ReturnType<typeof statements>;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {
    this.sql = statements(db);
  }

  static open(options: { directory: string; now?: () => number }): ImageRunLedger {
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
      db.exec("PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
      const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) {
          throw new ImageRunLedgerError("unsafe", "The image run ledger has no schema version.");
        }
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
      } else if (version !== 1) {
        throw new ImageRunLedgerError("unsupported", "The image run ledger uses an unsupported schema.");
      }
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(file + suffix)) assertPrivate(file + suffix, false);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new ImageRunLedger(db, options.now ?? Date.now);
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

  /** Counts one paid request and marks the attempt submitted, atomically, before the call is made. */
  claimProviderRequest(runId: string, nodeId: string, variant: number): boolean {
    try {
      return this.transaction(() => {
        if (Number(this.sql.claim.run(runId).changes) !== 1) return false;
        if (Number(this.sql.submit.run(this.now(), runId, nodeId, variant).changes) !== 1) throw NOT_QUEUED;
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
      if (latest[row.node_id] === undefined) latest[row.node_id] = parseOutput(row.output);
    }
    return latest;
  }

  /** Same ordering as `latestOutputs`, so the two always agree on which attempt is a node's newest. */
  latestOutputSequence(workflowId: string): Record<string, number> {
    this.requireOpen();
    const latest: Record<string, number> = {};
    for (const row of this.sql.outputSequence.all(workflowId) as unknown as { node_id: string; sequence: number }[]) {
      if (latest[row.node_id] === undefined) latest[row.node_id] = Number(row.sequence);
    }
    return latest;
  }

  imageCounts(): Record<string, number> {
    this.requireOpen();
    const seen = new Map<string, Set<string>>();
    for (const row of this.sql.imageOutputs.all() as unknown as { workflow_id: string; output: string }[]) {
      const ids = seen.get(row.workflow_id) ?? new Set<string>();
      for (const ref of parseOutput(row.output)) ids.add(ref.assetId);
      seen.set(row.workflow_id, ids);
    }
    return Object.fromEntries([...seen].filter(([, ids]) => ids.size > 0).map(([workflowId, ids]) => [workflowId, ids.size]));
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

  pruneRuns(keep = RUN_RETENTION): string[] {
    return this.transaction(() => {
      const ids = (this.sql.prunable.all(keep) as unknown as { id: string }[]).map((row) => row.id);
      for (const id of ids) this.sql.deleteRun.run(id);
      return ids;
    });
  }

  deleteWorkflowRuns(workflowId: string): string[] {
    return this.transaction(() => {
      const ids = (this.sql.workflowRuns.all(workflowId) as unknown as { id: string }[]).map((row) => row.id);
      for (const id of ids) this.sql.deleteRun.run(id);
      return ids;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
