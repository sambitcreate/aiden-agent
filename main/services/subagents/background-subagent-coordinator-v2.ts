import type { SubagentRunStateV2 } from "../../../renderer/shared/subagent-runs.js";
import type { SubagentAuthorityV2 } from "./authority-v2.js";
import {
  BackgroundSubagentLifecycleV2,
  parseBackgroundSubagentManagementRequestV2,
  type BackgroundSubagentManagementRequestV2,
  type BackgroundSubagentRunV2,
} from "./background-lifecycle-v2.js";

const TERMINAL = new Set<SubagentRunStateV2>([
  "completed",
  "failed",
  "timed_out",
  "stopped",
  "interrupted",
  "unknown",
]);

export interface PreparedBackgroundSubagentRunV2 {
  readonly authority: SubagentAuthorityV2;
  readonly snapshot: BackgroundSubagentRunV2["snapshot"];
  readonly task: string;
}

export interface BackgroundSubagentChildStartV2 {
  readonly task: string;
  readonly signal: AbortSignal;
  /** The child calls this only between agent turns/tool calls. */
  safeBoundary(): Promise<void>;
}

export interface BackgroundSubagentCoordinatorDependenciesV2<Child> {
  createChild(run: Readonly<PreparedBackgroundSubagentRunV2>): Child;
  startChild(
    child: Child,
    input: BackgroundSubagentChildStartV2,
  ): Promise<void>;
  /** Delivery acknowledges queue insertion at a safe boundary, not compliance. */
  deliverSteer(child: Child, instruction: string): Promise<void> | void;
  stopChild?(child: Child, reason: Error): void;
}

interface ActiveBackgroundRunV2<Child> {
  readonly prepared: Readonly<PreparedBackgroundSubagentRunV2>;
  readonly child: Child;
  readonly cancellation: AbortController;
  readonly terminalWaiters: Set<() => void>;
  pendingSteering: string[];
  run: BackgroundSubagentRunV2;
  tail: Promise<void>;
}

function immutablePrepared(
  value: PreparedBackgroundSubagentRunV2,
): Readonly<PreparedBackgroundSubagentRunV2> {
  const cloned = structuredClone(value);
  Object.freeze(cloned.authority.capabilities.mcp);
  Object.freeze(cloned.authority.capabilities);
  Object.freeze(cloned.authority.budgets);
  Object.freeze(cloned.authority);
  Object.freeze(cloned.snapshot.warnings);
  if (cloned.snapshot.milestones) Object.freeze(cloned.snapshot.milestones);
  Object.freeze(cloned.snapshot);
  return Object.freeze(cloned);
}

function statusProof(
  run: BackgroundSubagentRunV2,
): BackgroundSubagentManagementRequestV2 {
  const authority = run.manifest.authority;
  return {
    version: 2,
    action: "status",
    runId: run.snapshot.runId,
    chatId: authority.chatId,
    workspaceId: authority.workspaceId,
    ownerDocumentId: authority.ownerDocumentId,
    authorityRevision: authority.authorityRevision,
    expectedRevision: run.snapshot.revision,
  };
}

function asStatus(
  request: BackgroundSubagentManagementRequestV2,
): BackgroundSubagentManagementRequestV2 {
  const { timeoutMs: _timeoutMs, instruction: _instruction, ...base } = request;
  return { ...base, action: "status" };
}

function terminal(run: BackgroundSubagentRunV2): boolean {
  return TERMINAL.has(run.snapshot.state);
}

/**
 * App-lifetime background executor with no parent-generation signal. The
 * lifecycle remains the sole durable authority; this class only owns live
 * children and serialized delivery while this process is alive.
 */
export class BackgroundSubagentCoordinatorV2<Child> {
  private readonly active = new Map<string, ActiveBackgroundRunV2<Child>>();

  constructor(
    private readonly lifecycle: BackgroundSubagentLifecycleV2,
    private readonly dependencies: BackgroundSubagentCoordinatorDependenciesV2<Child>,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  async launch(value: PreparedBackgroundSubagentRunV2): Promise<{
    accepted: true;
    runId: string;
    revision: number;
    state: "queued";
  }> {
    const prepared = immutablePrepared(value);
    if (this.active.has(prepared.snapshot.runId)) {
      throw new Error("Background subagent is already active.");
    }
    const accepted = await this.lifecycle.accept(prepared);
    let child: Child;
    try {
      child = this.dependencies.createChild(prepared);
    } catch (error) {
      const acceptedRun = await this.lifecycle.manage({
        version: 2,
        action: "status",
        runId: prepared.snapshot.runId,
        chatId: prepared.authority.chatId,
        workspaceId: prepared.authority.workspaceId,
        ownerDocumentId: prepared.authority.ownerDocumentId,
        authorityRevision: prepared.authority.authorityRevision,
        expectedRevision: accepted.revision,
      });
      await this.lifecycle.transition(
        statusProof(acceptedRun),
        "failed",
        "Background child could not be created.",
      );
      throw error;
    }
    const acceptedRun = await this.lifecycle.manage({
      version: 2,
      action: "status",
      runId: prepared.snapshot.runId,
      chatId: prepared.authority.chatId,
      workspaceId: prepared.authority.workspaceId,
      ownerDocumentId: prepared.authority.ownerDocumentId,
      authorityRevision: prepared.authority.authorityRevision,
      expectedRevision: accepted.revision,
    });
    const entry: ActiveBackgroundRunV2<Child> = {
      prepared,
      child,
      cancellation: new AbortController(),
      terminalWaiters: new Set(),
      pendingSteering: [],
      run: acceptedRun,
      tail: Promise.resolve(),
    };
    this.active.set(prepared.snapshot.runId, entry);
    void this.execute(entry);
    return accepted;
  }

  async manage(value: unknown): Promise<BackgroundSubagentRunV2> {
    const request = parseBackgroundSubagentManagementRequestV2(value);
    const entry = this.active.get(request.runId);
    if (!entry) {
      const current = await this.lifecycle.manage(asStatus(request));
      if (
        request.action === "status" ||
        request.action === "wait" ||
        request.action === "stop"
      ) {
        return current;
      }
      throw new Error("Background run is not active for steering.");
    }
    const updated = await this.enqueue(entry, async () => {
      const current = await this.lifecycle.manage(asStatus(request));
      entry.run = current;
      if (request.action === "status") return current;
      if (terminal(current)) {
        if (request.action === "steer") {
          throw new Error("Background run is terminal and cannot be steered.");
        }
        return current;
      }
      const updated = await this.lifecycle.manage(request);
      entry.run = updated;
      if (request.action === "steer") {
        entry.pendingSteering.push(request.instruction!);
        return updated;
      }
      if (request.action === "stop") {
        this.abortEntry(
          entry,
          new Error("Background subagent stopped by its owner."),
        );
        this.notifyTerminal(entry);
        return updated;
      }
      return updated;
    });
    return request.action === "wait"
      ? this.waitForTerminal(entry, request.timeoutMs!)
      : updated;
  }

  async chatDeleted(chatId: string): Promise<number> {
    const count = await this.lifecycle.chatDeleted(chatId);
    this.abortMatching(
      (entry) => entry.prepared.authority.chatId === chatId,
      new Error("Background subagent chat was deleted."),
      "stopped",
    );
    return count;
  }

  async workspaceRevoked(workspaceId: string): Promise<number> {
    const count = await this.lifecycle.workspaceRevoked(workspaceId);
    this.abortMatching(
      (entry) => entry.prepared.authority.workspaceId === workspaceId,
      new Error("Background subagent workspace access was revoked."),
      "stopped",
    );
    return count;
  }

  async shutdown(): Promise<number> {
    const count = await this.lifecycle.shutdown();
    this.abortMatching(
      () => true,
      new Error("Background subagent runtime is shutting down."),
      "interrupted",
    );
    return count;
  }

  /** Startup is reconciliation-only: persisted work is never recreated. */
  async reconcileStartup(): Promise<number> {
    const count = await this.lifecycle.reconcileStartup();
    this.abortMatching(
      () => true,
      new Error("Background subagent was interrupted at startup."),
      "interrupted",
    );
    return count;
  }

  private async execute(entry: ActiveBackgroundRunV2<Child>): Promise<void> {
    try {
      await this.enqueue(entry, async () => {
        entry.run = await this.lifecycle.transition(
          statusProof(entry.run),
          "starting",
          "Starting background work.",
        );
      });
      await this.enqueue(entry, async () => {
        entry.run = await this.lifecycle.transition(
          statusProof(entry.run),
          "running",
          "Running in the background.",
        );
      });
      await this.dependencies.startChild(entry.child, {
        task: entry.prepared.task,
        signal: entry.cancellation.signal,
        safeBoundary: () => this.deliverAtSafeBoundary(entry),
      });
      if (!entry.cancellation.signal.aborted) {
        await this.enqueue(entry, async () => {
          if (!terminal(entry.run)) {
            entry.run = await this.lifecycle.transition(
              statusProof(entry.run),
              "completed",
              "Background work completed.",
            );
            this.notifyTerminal(entry);
          }
        });
      }
    } catch {
      if (!entry.cancellation.signal.aborted) {
        try {
          await this.enqueue(entry, async () => {
            if (!terminal(entry.run)) {
              entry.run = await this.lifecycle.transition(
                statusProof(entry.run),
                "failed",
                "Background work failed.",
              );
              this.notifyTerminal(entry);
            }
          });
        } catch {
          // The lifecycle store remains authoritative after a concurrent terminalization.
        }
      }
    } finally {
      this.active.delete(entry.prepared.snapshot.runId);
      this.notifyTerminal(entry);
    }
  }

  private async deliverAtSafeBoundary(
    entry: ActiveBackgroundRunV2<Child>,
  ): Promise<void> {
    await this.enqueue(entry, async () => {
      const pending = entry.pendingSteering.splice(0);
      for (const instruction of pending) {
        await this.dependencies.deliverSteer(entry.child, instruction);
      }
    });
  }

  private enqueue<T>(
    entry: ActiveBackgroundRunV2<Child>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = entry.tail.then(operation, operation);
    entry.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private waitForTerminal(
    entry: ActiveBackgroundRunV2<Child>,
    timeoutMs: number,
  ): Promise<BackgroundSubagentRunV2> {
    if (terminal(entry.run)) return Promise.resolve(structuredClone(entry.run));
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.terminalWaiters.delete(finish);
        resolve(structuredClone(entry.run));
      };
      const timer = setTimeout(finish, timeoutMs);
      entry.terminalWaiters.add(finish);
      if (terminal(entry.run)) finish();
    });
  }

  private notifyTerminal(entry: ActiveBackgroundRunV2<Child>): void {
    if (!terminal(entry.run) && this.active.has(entry.prepared.snapshot.runId))
      return;
    for (const notify of [...entry.terminalWaiters]) notify();
  }

  private abortEntry(entry: ActiveBackgroundRunV2<Child>, reason: Error): void {
    if (!entry.cancellation.signal.aborted) entry.cancellation.abort(reason);
    try {
      this.dependencies.stopChild?.(entry.child, reason);
    } catch {
      // Durable terminal state already won; runtime cleanup cannot undo it.
    }
  }

  private abortMatching(
    matches: (entry: ActiveBackgroundRunV2<Child>) => boolean,
    reason: Error,
    state: "stopped" | "interrupted",
  ): void {
    for (const entry of this.active.values()) {
      if (!matches(entry)) continue;
      if (!terminal(entry.run)) {
        entry.run = {
          ...entry.run,
          snapshot: {
            ...entry.run.snapshot,
            revision: entry.run.snapshot.revision + 1,
            state,
            activity: reason.message,
            updatedAt: Math.max(entry.run.snapshot.updatedAt, Date.now()),
            finishedAt: Math.max(entry.run.snapshot.updatedAt, Date.now()),
          },
        };
      }
      this.abortEntry(entry, reason);
      this.notifyTerminal(entry);
    }
  }
}
