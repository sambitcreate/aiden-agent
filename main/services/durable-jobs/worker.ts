import { randomUUID } from "node:crypto";
import { HEARTBEAT_MS } from "./contract.js";
import { DurableJobService } from "./service.js";

/** Polling/heartbeat owner only; no renderer, Remote or Pi singleton imports. */
export class DurableJobWorker {
  readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  /**
   * Every unsettled attempt; stop() waits on these, a later tick never does. A cancel releases
   * the lease at once, so a job can be reclaimed while its earlier attempt is still settling.
   */
  private active = new Set<{ jobId: string; controller: AbortController; done: Promise<void> }>();
  constructor(
    private readonly service: DurableJobService,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick().catch(this.onError);
    }, 1_000);
    void this.tick().catch(this.onError);
  }
  /**
   * Claim what the store admits now and resolve once those jobs settle.
   * Claiming is synchronous, so a later tick claims more while earlier jobs
   * still run; only the store's transactional cap limits concurrency.
   */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const claimed: Promise<void>[] = [];
    // Store admission is transactional across workers, including the global cap.
    for (let index = 0; index < 16 && !this.stopping; index++) {
      let claim;
      try {
        claim = this.service.store.claim(this.owner);
      } catch (error) {
        this.onError(error);
        break;
      }
      if (!claim) break;
      const jobId = claim.job.id;
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        try {
          this.service.store.heartbeat(claim.lease);
        } catch {
          controller.abort();
        }
      }, HEARTBEAT_MS);
      const entry: { jobId: string; controller: AbortController; done: Promise<void> } = {
        jobId,
        controller,
        done: this.service
          .run(claim.lease, controller.signal)
          .catch(this.onError)
          .finally(() => {
            clearInterval(heartbeat);
            this.active.delete(entry);
          }),
      };
      this.active.add(entry);
      claimed.push(entry.done);
    }
    await Promise.all(claimed);
  }
  /** Call after a committed control to promptly abort its exact old attempt. */
  notifyControl(jobId: string): void {
    for (const entry of this.active) if (entry.jobId === jobId) entry.controller.abort();
  }

  /** Bounded shutdown; false retains live reservations until runtime settlement. */
  async stop(timeoutMs = 2_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
      throw new Error("Invalid job shutdown deadline.");
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    const running = [...this.active.values()];
    for (const { controller } of running) controller.abort();
    if (running.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all(running.map(({ done }) => done)).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
