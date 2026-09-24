import type {
  DurableJobCheckpoint,
  DurableJobInput,
  DurableJobSnapshot,
} from "../../../renderer/shared/durable-jobs.js";
import {
  digest,
  JobError,
  parseEvidence,
  parseInput,
  type RecoveryEvidence,
} from "./contract.js";
import { DurableJobStore, type JobLease } from "./store.js";

export interface JobExecutionContext {
  signal: AbortSignal;
  mode: "start" | "resume" | "retry";
  job: DurableJobSnapshot;
  /** Must run immediately before every provider/tool admission, after awaits. */
  beforeEffect(): void;
  checkpoint(value: DurableJobCheckpoint): void;
}
export interface JobRuntimeSession {
  /** Read authoritative session/effect/child evidence; never dispatches work. */
  evidence(): Promise<RecoveryEvidence>;
  /** Reconcile/append the stable message ID once, with durable input validation. */
  appendInput(): Promise<DurableJobCheckpoint>;
  execute(context: JobExecutionContext): Promise<RecoveryEvidence>;
  /** Settle or quarantine non-abortable work before releasing chat ownership. */
  close(): Promise<void>;
}
export interface DurableJobRuntime {
  validateInput(input: DurableJobInput): Promise<void>;
  /**
   * Reauthorize current Bot/provider/session scope and reserve the chat. Revoke
   * and settle any live predecessor first. Null means unsettled, not safe to run.
   * This port is deliberately not wired to Pi in the foundation PR.
   */
  acquire(
    job: DurableJobSnapshot,
    signal: AbortSignal,
  ): Promise<JobRuntimeSession | null>;
}
const missing = (): RecoveryEvidence => ({
  kind: "missing",
  checkpoint: null,
  resultRef: null,
  waitId: null,
});

export class DurableJobService {
  constructor(
    readonly store: DurableJobStore,
    private readonly runtime: DurableJobRuntime,
  ) {}

  async enqueue(input: DurableJobInput, actor: string, key: string) {
    const snapshot = parseInput(input);
    await this.runtime.validateInput(snapshot);
    return this.store.enqueue(snapshot, actor, key);
  }

  async run(lease: JobLease, signal: AbortSignal): Promise<void> {
    let session: JobRuntimeSession | null = null;
    let closed = false;
    let closeAttempted = false;
    const closeSession = async () => {
      if (!session || closeAttempted) return;
      closeAttempted = true;
      await session.close();
      closed = true;
    };
    const guard = (dispatch = false) => {
      if (signal.aborted) throw new JobError("lost_lease");
      this.store.assertLease(lease, dispatch);
    };
    try {
      guard();
      let job = this.store.get(lease.jobId);
      session = await this.runtime.acquire(job, signal);
      guard();
      let evidence = session
        ? parseEvidence(await session.evidence())
        : { ...missing(), kind: "unsettled" as const };
      guard();
      if (session && job.intent === "none") {
        let mode: JobExecutionContext["mode"] | undefined;
        if (evidence.kind === "not_started" && !job.dispatched) {
          const checkpoint = await session.appendInput();
          guard();
          this.store.admitted(lease, checkpoint);
          mode = "start";
        } else if (
          job.continuation === "resume" &&
          evidence.kind === "checkpoint" &&
          job.checkpoint &&
          digest(evidence.checkpoint) === digest(job.checkpoint)
        ) {
          mode = "resume";
        } else if (
          job.continuation === "retry" &&
          evidence.kind === "failed_safe" &&
          job.checkpoint &&
          digest(evidence.checkpoint) === digest(job.checkpoint)
        ) {
          mode = "retry";
        }
        if (
          !mode &&
          job.continuation !== "none" &&
          (evidence.kind === "checkpoint" || evidence.kind === "failed_safe")
        ) {
          evidence = { ...missing(), kind: "stale_authority" };
        }
        if (mode) {
          guard();
          job = this.store.beginExecution(lease, mode);
          evidence = parseEvidence(
            await session.execute({
              signal,
              mode,
              job,
              beforeEffect: () => guard(true),
              checkpoint: (value) => {
                guard(true);
                this.store.checkpoint(lease, value);
              },
            }),
          );
          guard();
        }
      }
      await closeSession();
      guard();
      this.store.settle(lease, evidence);
    } catch (error) {
      // No inferred success/failure on a host exception. Authoritative evidence
      // remains in the runtime; the next owner may reconcile it without replay.
      await closeSession();
      // A failed settlement retains the lease/reservation; never publish a
      // terminal state that could allow another runtime into this chat.
      if (session && !closed) throw error;
      if (
        signal.aborted ||
        (error instanceof JobError && error.code === "lost_lease")
      )
        return;
      try {
        this.store.settle(lease, missing());
      } catch (settleError) {
        if (
          !(
            settleError instanceof JobError && settleError.code === "lost_lease"
          )
        )
          throw settleError;
      }
      if (!(error instanceof JobError && error.code === "lost_lease"))
        throw error;
    } finally {
      await closeSession();
    }
  }
}
