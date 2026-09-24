import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DurableJobAction,
  DurableJobCheckpoint,
  DurableJobInput,
  DurableJobSnapshot,
} from "../../../renderer/shared/durable-jobs.js";
import {
  digest,
  identifier,
  integer,
  JOB_LIMITS,
  JobError,
  LEASE_MS,
  parseCheckpoint,
  parseEvidence,
  parseInput,
  parseSnapshot,
  terminal,
  type RecoveryEvidence,
} from "./contract.js";

export interface JobLease {
  jobId: string;
  leaseId: string;
  owner: string;
  fence: number;
}
interface Row {
  id: string;
  chat_id: string;
  state: string;
  revision: number;
  lease_id: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  fence: number;
  data: string;
}
export interface JobControl {
  actor: string;
  key: string;
  jobId: string;
  expectedRevision: number;
  action: DurableJobAction;
}

/** Single-host ledger. No production instance is constructed by this slice. */
export class DurableJobStore {
  private readonly db: DatabaseSync;
  private readonly file: string;
  private readonly rootIdentity: { dev: number; ino: number };
  private readonly fileIdentity: { dev: number; ino: number };
  private closed = false;

  constructor(
    private readonly options: {
      root: string;
      profileId: string;
      now?: () => number;
      maxConcurrent?: number;
      beforeCommit?: () => void;
    },
  ) {
    identifier(options.profileId);
    if (!path.isAbsolute(options.root)) throw new JobError("invalid");
    const limit = options.maxConcurrent ?? 3;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
      throw new JobError("invalid");
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.rootIdentity = this.privatePath(options.root, true);
    this.file = path.join(options.root, "jobs-v1.sqlite");
    const fd = openSync(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new JobError("unsafe");
      this.fileIdentity = { dev: stat.dev, ino: stat.ino };
    } finally {
      closeSync(fd);
    }
    this.checkFiles();
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec("PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON;");
      const version = Number(
        (
          this.db.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      );
      if (version !== 0 && version !== 1)
        throw new JobError("unsafe", "Unsupported durable-job schema.");
      if (
        version === 0 &&
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .get()
      )
        throw new JobError("unsafe", "Unversioned durable-job database.");
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;",
      );
      try {
        if (version === 0)
          this.db.exec(`
          CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), profile TEXT NOT NULL, clock INTEGER NOT NULL);
          CREATE TABLE jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
            lease_id TEXT, lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL, data TEXT NOT NULL);
          CREATE UNIQUE INDEX one_unresolved_chat ON jobs(chat_id) WHERE state NOT IN ('succeeded','cancelled');
          CREATE INDEX claimable_jobs ON jobs(state, lease_until);
          CREATE UNIQUE INDEX unique_input_message ON jobs(json_extract(data, '$.input.messageId'));
          CREATE UNIQUE INDEX unique_logical_turn ON jobs(json_extract(data, '$.input.turnId'));
          CREATE TABLE admissions (actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), PRIMARY KEY(actor,key));
          CREATE TABLE controls (actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,key));
          CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), revision INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
          CREATE TABLE attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT);
          PRAGMA user_version=1;
        `);
        if (version === 0)
          this.db
            .prepare("INSERT INTO metadata VALUES(1,?,0)")
            .run(options.profileId);
        const metadata = this.db
          .prepare("SELECT profile FROM metadata WHERE id=1")
          .get() as { profile: string } | undefined;
        if (metadata?.profile !== options.profileId)
          throw new JobError("unsafe", "Job profile mismatch.");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.checkFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private privatePath(file: string, directory = false) {
    const stat = lstatSync(file);
    if (
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new JobError("unsafe");
    chmodSync(file, directory ? 0o700 : 0o600);
    return { dev: stat.dev, ino: stat.ino };
  }
  private checkFiles() {
    const root = this.privatePath(this.options.root, true);
    const file = this.privatePath(this.file);
    if (
      root.dev !== this.rootIdentity.dev ||
      root.ino !== this.rootIdentity.ino ||
      file.dev !== this.fileIdentity.dev ||
      file.ino !== this.fileIdentity.ino
    )
      throw new JobError("unsafe", "Job storage identity changed.");
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(this.file + suffix)) this.privatePath(this.file + suffix);
  }
  private transaction<T>(operation: (now: number) => T): T {
    if (this.closed) throw new JobError("closed");
    this.checkFiles();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sampled = this.options.now?.() ?? Date.now();
      integer(sampled);
      const previous = (
        this.db.prepare("SELECT clock FROM metadata WHERE id=1").get() as {
          clock: number;
        }
      ).clock;
      integer(previous);
      // Persisted high-water prevents clock rollback from reviving an expired lease.
      const now = Math.max(sampled, previous);
      this.db.prepare("UPDATE metadata SET clock=? WHERE id=1").run(now);
      this.db.exec("SAVEPOINT mutation");
      let result: T;
      try {
        result = operation(now);
        this.checkFiles();
        this.options.beforeCommit?.();
      } catch (error) {
        // Failed CAS/control mutations roll back, but observing an expired lease
        // must still advance the persisted clock (including across reopen).
        this.db.exec("ROLLBACK TO mutation; RELEASE mutation; COMMIT");
        throw error;
      }
      this.db.exec("RELEASE mutation; COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* Already committed only the clock. */
      }
      throw error;
    }
  }
  private row(id: string): Row {
    identifier(id);
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(id) as unknown as Row | undefined;
    if (!row) throw new JobError("invalid", "Unknown durable job.");
    return row;
  }
  private snapshot(row: Row): DurableJobSnapshot {
    const job = parseSnapshot(JSON.parse(row.data));
    if (
      job.id !== row.id ||
      job.input.chatId !== row.chat_id ||
      job.input.profileId !== this.options.profileId ||
      job.state !== row.state ||
      job.revision !== row.revision
    )
      throw new JobError("unsafe");
    return job;
  }
  private save(
    job: DurableJobSnapshot,
    now: number,
    release = false,
  ): DurableJobSnapshot {
    const revision = job.revision;
    job.revision++;
    job.updatedAt = now;
    const data = JSON.stringify(parseSnapshot(job));
    if (Buffer.byteLength(data) > JOB_LIMITS.recordBytes)
      throw new JobError("capacity");
    const updated = this.db
      .prepare(
        `UPDATE jobs SET state=?, revision=?, data=? ${release ? ",lease_id=NULL,lease_owner=NULL,lease_until=NULL" : ""} WHERE id=? AND revision=?`,
      )
      .run(job.state, job.revision, data, job.id, revision);
    if (updated.changes !== 1) throw new JobError("conflict");
    this.db
      .prepare("INSERT INTO events(job_id,revision,state,at) VALUES(?,?,?,?)")
      .run(job.id, job.revision, job.state, now);
    this.db
      .prepare(
        "DELETE FROM events WHERE job_id=? AND sequence NOT IN (SELECT sequence FROM events WHERE job_id=? ORDER BY sequence DESC LIMIT ?)",
      )
      .run(job.id, job.id, JOB_LIMITS.eventsPerJob);
    if (release && job.attemptId)
      this.db
        .prepare("UPDATE attempts SET finished_at=?,outcome=? WHERE id=?")
        .run(now, job.state, job.attemptId);
    return structuredClone(job);
  }
  private owned(lease: JobLease, now: number) {
    const row = this.row(lease.jobId);
    if (
      row.lease_id !== lease.leaseId ||
      row.lease_owner !== lease.owner ||
      row.fence !== lease.fence ||
      row.lease_until === null ||
      row.lease_until <= now
    )
      throw new JobError("lost_lease");
    return this.snapshot(row);
  }
  get(id: string): DurableJobSnapshot {
    return this.transaction(() => this.snapshot(this.row(id)));
  }
  events(id: string, after = 0) {
    identifier(id);
    integer(after);
    return this.transaction(() =>
      this.db
        .prepare(
          "SELECT sequence,revision,state,at FROM events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(id, after, JOB_LIMITS.eventsPerJob),
    );
  }
  attempts(id: string) {
    identifier(id);
    return this.transaction(() =>
      this.db
        .prepare("SELECT * FROM attempts WHERE job_id=? ORDER BY started_at,id")
        .all(id),
    );
  }
  enqueue(
    inputValue: DurableJobInput,
    actor: string,
    key: string,
  ): DurableJobSnapshot {
    const input = parseInput(inputValue);
    identifier(actor);
    identifier(key);
    if (input.profileId !== this.options.profileId)
      throw new JobError("unsafe");
    return this.transaction((now) => {
      const fingerprint = digest(input);
      const previous = this.db
        .prepare("SELECT digest,job_id FROM admissions WHERE actor=? AND key=?")
        .get(actor, key) as { digest: string; job_id: string } | undefined;
      if (previous) {
        if (previous.digest !== fingerprint) throw new JobError("conflict");
        return this.snapshot(this.row(previous.job_id));
      }
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE chat_id=? AND state NOT IN ('succeeded','cancelled')",
          )
          .get(input.chatId)
      )
        throw new JobError("conflict", "Chat already has unresolved work.");
      if (
        Number(
          (
            this.db
              .prepare(
                "SELECT count(*) AS n FROM jobs WHERE state NOT IN ('succeeded','cancelled')",
              )
              .get() as {
              n: number;
            }
          ).n,
        ) >= JOB_LIMITS.unresolvedJobs
      )
        throw new JobError("capacity");
      const job: DurableJobSnapshot = {
        version: 1,
        id: randomUUID(),
        input,
        state: "admitting",
        intent: "none",
        revision: 0,
        createdAt: now,
        updatedAt: now,
        recovery: "not_started",
        checkpoint: null,
        resultRef: null,
        waitId: null,
        dispatched: false,
        executionCount: 0,
        attemptId: null,
        continuation: "none",
        pendingReconciliation: true,
      };
      this.db
        .prepare("INSERT INTO jobs VALUES(?,?,?,?,NULL,NULL,NULL,0,?)")
        .run(
          job.id,
          input.chatId,
          job.state,
          job.revision,
          JSON.stringify(job),
        );
      this.db
        .prepare("INSERT INTO admissions VALUES(?,?,?,?)")
        .run(actor, key, fingerprint, job.id);
      return this.save(job, now);
    });
  }
  claim(owner: string): { job: DurableJobSnapshot; lease: JobLease } | null {
    identifier(owner);
    return this.transaction((now) => {
      const active = Number(
        (
          this.db
            .prepare("SELECT count(*) AS n FROM jobs WHERE lease_until>?")
            .get(now) as { n: number }
        ).n,
      );
      if (active >= (this.options.maxConcurrent ?? 3)) return null;
      const rows = this.db
        .prepare(
          "SELECT * FROM jobs WHERE state NOT IN ('succeeded','cancelled') AND (lease_until IS NULL OR lease_until<=?) ORDER BY rowid",
        )
        .all(now) as unknown as Row[];
      for (const row of rows) {
        const job = this.snapshot(row);
        if (
          !job.pendingReconciliation &&
          job.state !== "queued" &&
          job.state !== "admitting" &&
          job.state !== "running"
        )
          continue;
        const fence = row.fence + 1;
        integer(fence);
        integer(now + LEASE_MS);
        const lease = { jobId: job.id, leaseId: randomUUID(), owner, fence };
        const changed = this.db
          .prepare(
            "UPDATE jobs SET lease_id=?,lease_owner=?,lease_until=?,fence=? WHERE id=? AND fence=? AND (lease_until IS NULL OR lease_until<=?)",
          )
          .run(
            lease.leaseId,
            owner,
            now + LEASE_MS,
            fence,
            job.id,
            row.fence,
            now,
          );
        if (changed.changes !== 1) continue;
        job.pendingReconciliation = true;
        return { lease, job: this.save(job, now) };
      }
      return null;
    });
  }
  assertLease(lease: JobLease, dispatch = false): void {
    this.transaction((now) => {
      const job = this.owned(lease, now);
      if (dispatch && (job.intent !== "none" || job.state !== "running"))
        throw new JobError("lost_lease");
    });
  }
  heartbeat(lease: JobLease): void {
    this.transaction((now) => {
      this.owned(lease, now);
      integer(now + LEASE_MS);
      this.db
        .prepare(
          "UPDATE jobs SET lease_until=? WHERE id=? AND lease_id=? AND fence=?",
        )
        .run(now + LEASE_MS, lease.jobId, lease.leaseId, lease.fence);
    });
  }
  admitted(lease: JobLease, checkpointValue: DurableJobCheckpoint): void {
    const checkpoint = parseCheckpoint(checkpointValue);
    this.transaction((now) => {
      const job = this.owned(lease, now);
      if (
        job.dispatched ||
        checkpoint.inputMessageId !== job.input.messageId ||
        job.intent !== "none"
      )
        throw new JobError("unsafe");
      job.checkpoint = checkpoint;
      job.state = "queued";
      this.save(job, now);
    });
  }
  beginExecution(
    lease: JobLease,
    mode: "start" | "resume" | "retry",
  ): DurableJobSnapshot {
    return this.transaction((now) => {
      const job = this.owned(lease, now);
      if (
        job.intent !== "none" ||
        !job.checkpoint ||
        (mode === "start" ? job.dispatched : job.continuation !== mode)
      )
        throw new JobError("unsafe");
      if (job.executionCount >= JOB_LIMITS.attemptsPerJob)
        throw new JobError("capacity");
      job.state = "running";
      job.dispatched = true;
      job.continuation = "none";
      job.executionCount++;
      job.attemptId = randomUUID();
      this.db
        .prepare("INSERT INTO attempts VALUES(?,?,?,NULL,NULL)")
        .run(job.attemptId, job.id, now);
      return this.save(job, now);
    });
  }
  checkpoint(lease: JobLease, value: DurableJobCheckpoint): void {
    const checkpoint = parseCheckpoint(value);
    this.transaction((now) => {
      const job = this.owned(lease, now);
      if (
        job.state !== "running" ||
        job.intent !== "none" ||
        checkpoint.inputMessageId !== job.input.messageId
      )
        throw new JobError("lost_lease");
      job.checkpoint = checkpoint;
      this.save(job, now);
    });
  }
  settle(lease: JobLease, evidenceValue: RecoveryEvidence): DurableJobSnapshot {
    const evidence = parseEvidence(evidenceValue);
    return this.transaction((now) => {
      const job = this.owned(lease, now);
      if (
        evidence.checkpoint &&
        evidence.checkpoint.inputMessageId !== job.input.messageId
      )
        throw new JobError("unsafe");
      job.recovery = evidence.kind;
      job.resultRef = evidence.resultRef;
      job.waitId = evidence.waitId;
      if (evidence.checkpoint) job.checkpoint = evidence.checkpoint;
      job.pendingReconciliation = false;
      job.continuation = "none";
      const unsafe = [
        "unknown",
        "missing",
        "stale_authority",
        "unsettled",
      ].includes(evidence.kind);
      if (evidence.kind === "completed") job.state = "succeeded";
      else if (unsafe || (evidence.kind === "not_started" && job.dispatched))
        job.state = "needs_attention";
      else if (job.intent === "cancel") job.state = "cancelled";
      else if (job.intent === "stop") job.state = "interrupted";
      else if (job.intent === "pause") job.state = "paused";
      else if (
        evidence.kind === "waiting_approval" ||
        evidence.kind === "waiting_input"
      )
        job.state = evidence.kind;
      else if (evidence.kind === "failed_safe") job.state = "failed";
      else job.state = "interrupted";
      return this.save(job, now, true);
    });
  }
  /** Host-only request to reread evidence; never grants resume or retry. */
  reconcile(id: string, expectedRevision: number): void {
    integer(expectedRevision);
    this.transaction((now) => {
      const row = this.row(id);
      const job = this.snapshot(row);
      if (
        terminal(job.state) ||
        job.revision !== expectedRevision ||
        (row.lease_until !== null && row.lease_until > now)
      )
        throw new JobError("conflict");
      job.pendingReconciliation = true;
      this.save(job, now);
    });
  }
  control(request: JobControl): DurableJobSnapshot {
    return this.applyControl(request);
  }
  interrupt(
    request: Omit<JobControl, "action"> & { turnId: string },
  ): DurableJobSnapshot {
    identifier(request.turnId);
    return this.applyControl({ ...request, action: "stop" }, request.turnId);
  }
  private applyControl(
    request: Omit<JobControl, "action"> & { action: DurableJobAction | "stop" },
    turnId?: string,
  ): DurableJobSnapshot {
    identifier(request.actor);
    identifier(request.key);
    identifier(request.jobId);
    integer(request.expectedRevision);
    if (
      !["pause", "resume", "cancel", "retry", "stop"].includes(request.action)
    )
      throw new JobError("invalid");
    const fingerprint = digest([
      request.jobId,
      request.expectedRevision,
      request.action,
      turnId ?? null,
    ]);
    return this.transaction((now) => {
      const previous = this.db
        .prepare("SELECT digest,response FROM controls WHERE actor=? AND key=?")
        .get(request.actor, request.key) as
        | { digest: string; response: string }
        | undefined;
      if (previous) {
        if (previous.digest !== fingerprint) throw new JobError("conflict");
        return parseSnapshot(JSON.parse(previous.response));
      }
      const row = this.row(request.jobId);
      const job = this.snapshot(row);
      if (
        job.revision !== request.expectedRevision ||
        (turnId && turnId !== job.input.turnId) ||
        terminal(job.state) ||
        (job.intent === "cancel" && request.action !== "cancel")
      )
        throw new JobError("conflict");
      if (
        Number(
          (
            this.db
              .prepare(
                "SELECT count(*) AS n FROM controls JOIN jobs ON jobs.id=json_extract(controls.response, '$.id') WHERE jobs.state NOT IN ('succeeded','cancelled')",
              )
              .get() as {
              n: number;
            }
          ).n,
        ) >= JOB_LIMITS.unresolvedControls
      )
        throw new JobError("capacity");
      if (request.action === "resume" || request.action === "retry") {
        const allowed =
          request.action === "retry"
            ? job.state === "failed" && job.recovery === "failed_safe"
            : (job.state === "paused" || job.state === "interrupted") &&
              (job.recovery === "checkpoint" ||
                (!job.dispatched && job.recovery === "not_started"));
        if (!allowed || job.pendingReconciliation) throw new JobError("unsafe");
        job.continuation = job.dispatched ? request.action : "none";
        job.intent = "none";
        job.state = "queued";
        job.pendingReconciliation = true;
      } else {
        job.intent =
          request.action === "pause"
            ? "pause"
            : request.action === "stop"
              ? "stop"
              : "cancel";
        job.continuation = "none";
        job.pendingReconciliation = true;
        job.state =
          request.action === "pause"
            ? "pause_requested"
            : request.action === "stop"
              ? "interrupted"
              : "cancel_requested";
      }
      // Invalidates an old callback immediately, including between awaits.
      this.db.prepare("UPDATE jobs SET fence=fence+1 WHERE id=?").run(job.id);
      const response = this.save(job, now, true);
      this.db
        .prepare("INSERT INTO controls VALUES(?,?,?,?)")
        .run(request.actor, request.key, fingerprint, JSON.stringify(response));
      return response;
    });
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
