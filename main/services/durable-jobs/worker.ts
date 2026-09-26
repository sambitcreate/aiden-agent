import { randomUUID } from "node:crypto";
import { HEARTBEAT_MS } from "./contract.js";
import { DurableJobService } from "./service.js";

/** Polling/heartbeat owner only; no renderer, Remote or Pi singleton imports. */
export class DurableJobWorker {
  readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private ticking?: Promise<void>;
  private active = new Map<string, AbortController>();
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
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.drain().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async drain() {
    const pending: Promise<void>[] = [];
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
      const controller = new AbortController();
      this.active.set(claim.job.id, controller);
      const heartbeat = setInterval(() => {
        try {
          this.service.store.heartbeat(claim.lease);
        } catch {
          controller.abort();
        }
      }, HEARTBEAT_MS);
      pending.push(
        this.service.run(claim.lease, controller.signal).finally(() => {
          clearInterval(heartbeat);
          this.active.delete(claim.job.id);
        }),
      );
    }
    const results = await Promise.allSettled(pending);
    for (const result of results)
      if (result.status === "rejected") this.onError(result.reason);
  }
  /** Call after a committed control to promptly abort its exact old attempt. */
  notifyControl(jobId: string): void {
    this.active.get(jobId)?.abort();
  }

  /** Bounded shutdown; false retains live reservations until runtime settlement. */
  async stop(timeoutMs = 2_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
      throw new Error("Invalid job shutdown deadline.");
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    if (!this.ticking) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.ticking.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
