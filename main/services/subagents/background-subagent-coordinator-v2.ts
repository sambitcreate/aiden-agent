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

interface BackgroundInstallationV2<Child> {
  prepared: PreparedBackgroundSubagentRunV2;
  settled: Promise<void>;
  child?: { value: Child };
  childStopped?: boolean;
  invalidated?: Error;
}

/**
 * App-lifetime background executor with no parent-generation signal. The
 * lifecycle remains the sole durable authority; this class only owns live
 * children and serialized delivery while this process is alive.
 */
export class BackgroundSubagentCoordinatorV2<Child> {
  private readonly active = new Map<string, ActiveBackgroundRunV2<Child>>();
  /** Launches whose run is not in `active` yet. Registered before acceptance. */
  private readonly installing = new Map<string, BackgroundInstallationV2<Child>>();

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
    const { runId } = prepared.snapshot;
    if (this.active.has(runId) || this.installing.has(runId)) {
      throw new Error("Background subagent is already active.");
    }
    // Registered before the run is visible anywhere, so a request that learns
    // of it waits here and an invalidation can reach its child.
    let settle!: () => void;
    const installation: BackgroundInstallationV2<Child> = {
      prepared,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.installing.set(runId, installation);
    const finished = () => {
      this.installing.delete(runId);
      settle();
    };
    try {
      return await this.acceptAndInstall(prepared, installation, finished);
    } finally {
      finished();
    }
  }

  private async acceptAndInstall(
    prepared: PreparedBackgroundSubagentRunV2,
    installation: BackgroundInstallationV2<Child>,
    releaseWaiters: () => void,
  ): Promise<{ accepted: true; runId: string; revision: number; state: "queued" }> {
    const accepted = await this.lifecycle.accept(prepared);
    if (installation.invalidated) {
      await this.recordLaunchFailed(prepared, accepted.revision).catch(() => undefined);
      throw installation.invalidated;
    }
    let child: Child;
    try {
      child = this.dependencies.createChild(prepared);
    } catch (error) {
      try {
        await this.recordLaunchFailed(prepared, accepted.revision);
      } catch (recordError) {
        // Report why the child is missing; the recording failure is the cause
        // the run is still queued until startup reconciliation settles it.
        const failure: Error & { cause?: unknown } = new Error(
          error instanceof Error
            ? error.message
            : "Background child could not be created.",
        );
        failure.cause = recordError;
        throw failure;
      }
      throw error;
    }
    installation.child = { value: child };
    await this.install(installation, child, accepted.revision, releaseWaiters);
    return accepted;
  }

  private async recordLaunchFailed(
    prepared: PreparedBackgroundSubagentRunV2,
    acceptedRevision: number,
  ): Promise<void> {
    const acceptedRun = await this.lifecycle.manage({
      version: 2,
      action: "status",
      runId: prepared.snapshot.runId,
      chatId: prepared.authority.chatId,
      workspaceId: prepared.authority.workspaceId,
      ownerDocumentId: prepared.authority.ownerDocumentId,
      authorityRevision: prepared.authority.authorityRevision,
      expectedRevision: acceptedRevision,
    });
    await this.lifecycle.transition(
      statusProof(acceptedRun),
      "failed",
      "Background child could not be created.",
    );
  }

  /** Releases a created child exactly once, whoever gets here first. */
  private stopInstalling(installation: BackgroundInstallationV2<Child>, reason: Error): void {
    if (!installation.child || installation.childStopped) return;
    installation.childStopped = true;
    try {
      this.dependencies.stopChild?.(installation.child.value, reason);
    } catch {
      // The failure that brought us here is the one worth reporting.
    }
  }

  private async install(
    installation: BackgroundInstallationV2<Child>,
    child: Child,
    acceptedRevision: number,
    releaseWaiters: () => void,
  ): Promise<void> {
    const { prepared } = installation;
    let acceptedRun: BackgroundSubagentRunV2;
    try {
      acceptedRun = await this.lifecycle.manage({
        version: 2,
        action: "status",
        runId: prepared.snapshot.runId,
        chatId: prepared.authority.chatId,
        workspaceId: prepared.authority.workspaceId,
        ownerDocumentId: prepared.authority.ownerDocumentId,
        authorityRevision: prepared.authority.authorityRevision,
        expectedRevision: acceptedRevision,
      });
    } catch (error) {
      // The run moved on or its state is unreadable: this child has no owner.
      this.stopInstalling(installation, new Error("Background subagent could not start."));
      throw error;
    }
    // The read may predate an invalidation that already released the child. If
    // its scan missed this run, nothing else would take it out of queued.
    if (installation.invalidated) {
      await this.recordLaunchFailed(prepared, acceptedRevision).catch(() => undefined);
      throw installation.invalidated;
    }
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
    // Requests already waiting queue on this entry before it starts, so a Stop
    // sent during launch is judged against the revision its sender saw.
    releaseWaiters();
    queueMicrotask(() => void this.execute(entry));
  }

  async manage(value: unknown): Promise<BackgroundSubagentRunV2> {
    const request = parseBackgroundSubagentManagementRequestV2(value);
    let entry: ActiveBackgroundRunV2<Child> | undefined;
    for (;;) {
      await this.installing.get(request.runId)?.settled;
      entry = this.active.get(request.runId);
      if (entry) break;
      const current = await this.lifecycle.manage(asStatus(request));
      // A launch that began during that read owns the answer now.
      if (this.installing.has(request.runId) || this.active.has(request.runId)) continue;
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
    let childStarted = false;
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
      childStarted = true;
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
      // A run that moved on before its child started still owns that child.
      if (!childStarted && !entry.cancellation.signal.aborted) {
        this.abortEntry(entry, new Error("Background subagent could not start."));
      }
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
    matches: (entry: { prepared: PreparedBackgroundSubagentRunV2 }) => boolean,
    reason: Error,
    state: "stopped" | "interrupted",
  ): void {
    for (const installation of this.installing.values()) {
      if (!matches(installation)) continue;
      installation.invalidated ??= reason;
      this.stopInstalling(installation, reason);
    }
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
