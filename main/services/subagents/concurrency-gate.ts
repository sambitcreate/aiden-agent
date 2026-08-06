export type SubagentDeployment = "hosted" | "local";

export const MAX_QUEUED_SUBAGENT_CHILDREN = 32;

interface Waiter {
  deployment: SubagentDeployment;
  signal?: AbortSignal;
  resolve(release: () => void): void;
  reject(error: Error): void;
  onAbort?: () => void;
}

/** V1 resource ceiling: two hosted children or one local child at a time. */
export class SubagentConcurrencyGate {
  private readonly limits: Record<SubagentDeployment, number>;
  private readonly active: Record<SubagentDeployment, number> = { hosted: 0, local: 0 };
  private readonly queue: Waiter[] = [];
  private closed = false;

  constructor(
    limits: Record<SubagentDeployment, number> = { hosted: 2, local: 1 },
    private readonly maxQueued = MAX_QUEUED_SUBAGENT_CHILDREN,
  ) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 1_024) {
      throw new Error("Invalid subagent concurrency queue limit.");
    }
    this.limits = {
      hosted: Math.max(1, Math.floor(limits.hosted)),
      local: Math.max(1, Math.floor(limits.local)),
    };
  }

  get activeCount(): number {
    return this.active.hosted + this.active.local;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private dispatch(): void {
    for (let index = 0; index < this.queue.length; ) {
      const waiter = this.queue[index];
      if (!waiter) break;
      if (this.active[waiter.deployment] >= this.limits[waiter.deployment]) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active[waiter.deployment] += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active[waiter.deployment] -= 1;
        this.dispatch();
      });
    }
  }

  acquire(deployment: SubagentDeployment, signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error("Subagent concurrency gate is closed."));
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error("Subagent task cancelled."),
      );
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new Error("The app-wide subagent queue limit was reached."));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { deployment, signal, resolve, reject };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(
          signal?.reason instanceof Error ? signal.reason : new Error("Subagent task cancelled."),
        );
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      if (this.closed) {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Subagent concurrency gate is closed."));
        return;
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.dispatch();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Subagent concurrency gate is closed.");
    for (const waiter of this.queue.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }
}
