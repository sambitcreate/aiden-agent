import {
  MAX_SUBAGENT_CONTROL_RECORDS,
  SubagentControlRegistryV2,
  type SubagentControlRegistrationV2,
  type SubagentManagementResultV2,
  type SubagentRetryPreparationV2,
  type SubagentRetryRequestV2,
} from "./subagent-control-v2.js";
import {
  parseSubagentManagementRequestV2,
  type SubagentManagementRequestV2,
} from "./management-v2.js";
import {
  type SubagentRunSnapshotV2,
  type SubagentRunStateV2,
} from "../../../renderer/shared/subagent-runs.js";

const TERMINAL_STATES = new Set<SubagentRunStateV2>([
  "completed",
  "failed",
  "timed_out",
  "interrupted",
  "stopped",
]);

export interface SubagentControlDocumentScopeV2 {
  chatId: string;
  workspaceId: string;
  ownerDocumentId: string;
}

export interface SubagentControlMainRegistrationV2 extends SubagentControlRegistrationV2 {
  /** Resolve only after every queued snapshot/store publication is durable. */
  settle(): Promise<void>;
  /** Main-owned live projector state, including non-durable telemetry. */
  currentSnapshot?(): SubagentRunSnapshotV2;
}

export interface SubagentRetryPreparationMainV2
  extends Omit<SubagentRetryPreparationV2, "registration"> {
  registration: SubagentControlMainRegistrationV2;
}

export type SubagentRetryPreparationAdapterV2 = (
  request: SubagentRetryRequestV2,
) => Promise<SubagentRetryPreparationMainV2> | SubagentRetryPreparationMainV2;

interface ControlBinding {
  chatId: string;
  workspaceId: string;
  ownerDocumentId: string;
  authorityRevision: number;
  updatedAt: number;
  terminal: boolean;
  settle(): Promise<void>;
  currentSnapshot?: () => SubagentRunSnapshotV2;
}

interface PendingRetrySettlement {
  runId: string;
  ownerDocumentId: string;
  settle(): Promise<void>;
}

export interface SubagentControlMainOptionsV2 {
  now?: () => number;
  randomUUID?: () => string;
  maxRecords?: number;
}

/**
 * Production-facing bridge around the exact owner-bound registry. The main
 * lifecycle registers document ownership once; IPC callers can only present a
 * run ID and chat ID, never an authority revision or owner tuple.
 */
export class SubagentControlMainV2 {
  private readonly registry: SubagentControlRegistryV2;
  private readonly bindings = new Map<string, ControlBinding>();
  private readonly maxRecords: number;
  private readonly pendingRetrySettlements = new Map<string, PendingRetrySettlement>();
  private retryPreparation?: SubagentRetryPreparationAdapterV2;

  constructor(options: SubagentControlMainOptionsV2 = {}) {
    this.maxRecords = options.maxRecords ?? MAX_SUBAGENT_CONTROL_RECORDS;
    this.registry = new SubagentControlRegistryV2({
      ...options,
      prepareRetry: async (request) => {
        if (!this.retryPreparation) throw new Error("Subagent retry is unavailable.");
        const prepared = await this.retryPreparation(request);
        const settle = () => prepared.registration.settle();
        this.pendingRetrySettlements.set(request.source.runId, {
          runId: prepared.registration.snapshot.runId,
          ownerDocumentId: prepared.registration.ownerDocumentId,
          settle,
        });
        return {
          ...prepared,
          registration: this.wrapRegistration(
            prepared.registration,
            settle,
          ),
        };
      },
    });
  }

  get size(): number {
    return this.registry.size;
  }

  installRetryPreparation(adapter: SubagentRetryPreparationAdapterV2): () => void {
    if (this.retryPreparation) throw new Error("Subagent retry preparation is already installed.");
    this.retryPreparation = adapter;
    return () => {
      if (this.retryPreparation === adapter) this.retryPreparation = undefined;
    };
  }

  register(input: SubagentControlMainRegistrationV2): SubagentRunSnapshotV2 {
    const settle = () => input.settle();
    const snapshot = this.registry.register(this.wrapRegistration(input, settle));
    this.remember(snapshot, input.ownerDocumentId, settle, input.currentSnapshot);
    return snapshot;
  }

  update(runId: string, snapshot: SubagentRunSnapshotV2): SubagentRunSnapshotV2 {
    const binding = this.bindings.get(runId);
    if (!binding) throw new Error("Subagent control registration is unavailable.");
    const updated = this.registry.update(
      {
        chatId: binding.chatId,
        workspaceId: binding.workspaceId,
        ownerDocumentId: binding.ownerDocumentId,
        authorityRevision: binding.authorityRevision,
      },
      snapshot,
    );
    this.remember(updated, binding.ownerDocumentId, binding.settle, binding.currentSnapshot);
    return updated;
  }

  unregisterPrepared(runId: string, ownerDocumentId: string): boolean {
    const binding = this.bindings.get(runId);
    if (!binding || binding.ownerDocumentId !== ownerDocumentId) return false;
    const removed = this.registry.unregisterPrepared(
      {
        chatId: binding.chatId,
        workspaceId: binding.workspaceId,
        ownerDocumentId: binding.ownerDocumentId,
        authorityRevision: binding.authorityRevision,
      },
      runId,
    );
    if (removed) this.bindings.delete(runId);
    return removed;
  }

  stateForRun(runId: string, ownerDocumentId: string): SubagentRunStateV2 | undefined {
    const binding = this.bindings.get(runId);
    if (!binding || binding.ownerDocumentId !== ownerDocumentId) return undefined;
    return this.registry.status(
      {
        chatId: binding.chatId,
        workspaceId: binding.workspaceId,
        ownerDocumentId: binding.ownerDocumentId,
        authorityRevision: binding.authorityRevision,
      },
      runId,
    ).state;
  }

  async executeForDocument(
    scope: SubagentControlDocumentScopeV2,
    value: SubagentManagementRequestV2 | unknown,
  ): Promise<SubagentManagementResultV2> {
    const request = parseSubagentManagementRequestV2(value);
    const binding = this.bindings.get(request.runId);
    if (
      !binding ||
      binding.chatId !== scope.chatId ||
      binding.workspaceId !== scope.workspaceId ||
      binding.ownerDocumentId !== scope.ownerDocumentId
    ) {
      throw new Error("Subagent control authority does not match.");
    }
    try {
      // Drain already-published child telemetry before deriving a control
      // revision. Otherwise stop could mint the same revision that the
      // projector has queued but not yet reflected into this registry.
      await binding.settle();
      const live = binding.currentSnapshot?.();
      const registered = this.registry.status(
        {
          chatId: binding.chatId,
          workspaceId: binding.workspaceId,
          ownerDocumentId: binding.ownerDocumentId,
          authorityRevision: binding.authorityRevision,
        },
        request.runId,
      );
      if (live && live.revision > registered.revision) {
        this.registry.update(
          {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId,
            ownerDocumentId: binding.ownerDocumentId,
            authorityRevision: binding.authorityRevision,
          },
          live,
        );
      }
      const result = await this.registry.execute(
        {
          chatId: binding.chatId,
          workspaceId: binding.workspaceId,
          ownerDocumentId: binding.ownerDocumentId,
          authorityRevision: binding.authorityRevision,
        },
        request,
      );
      if (result.action === "retry") {
        const pendingRetry = this.pendingRetrySettlements.get(request.runId);
        if (!pendingRetry || pendingRetry.runId !== result.snapshot.runId) {
          throw new Error("Subagent retry durability is unavailable.");
        }
        this.remember(
          result.sourceSnapshot,
          binding.ownerDocumentId,
          binding.settle,
        );
        this.remember(
          result.snapshot,
          pendingRetry.ownerDocumentId,
          pendingRetry.settle,
        );
        await binding.settle();
        await pendingRetry.settle();
      } else {
        this.remember(
          result.snapshot,
          binding.ownerDocumentId,
          binding.settle,
          binding.currentSnapshot,
        );
        await binding.settle();
      }
      return result;
    } finally {
      if (request.action === "retry") this.pendingRetrySettlements.delete(request.runId);
    }
  }

  private wrapRegistration(
    input: SubagentControlRegistrationV2,
    settle: () => Promise<void>,
  ): SubagentControlRegistrationV2 {
    return {
      ...input,
      onSnapshot: (snapshot) => {
        this.remember(snapshot, input.ownerDocumentId, settle);
        input.onSnapshot?.(snapshot);
      },
    };
  }

  private remember(
    snapshot: SubagentRunSnapshotV2,
    ownerDocumentId: string,
    settle: () => Promise<void>,
    currentSnapshot?: () => SubagentRunSnapshotV2,
  ): void {
    const retainedCurrentSnapshot =
      currentSnapshot ?? this.bindings.get(snapshot.runId)?.currentSnapshot;
    if (!this.bindings.has(snapshot.runId) && this.bindings.size >= this.maxRecords) {
      const evicted = [...this.bindings.entries()]
        .filter(([, binding]) => binding.terminal)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.updatedAt - right.updatedAt || leftId.localeCompare(rightId),
        )[0];
      if (evicted) this.bindings.delete(evicted[0]);
    }
    if (!this.bindings.has(snapshot.runId) && this.bindings.size >= this.maxRecords) {
      throw new Error("The subagent control binding registry is full.");
    }
    this.bindings.delete(snapshot.runId);
    this.bindings.set(snapshot.runId, {
      chatId: snapshot.chatId,
      workspaceId: snapshot.workspaceId,
      ownerDocumentId,
      authorityRevision: snapshot.authorityRevision,
      updatedAt: snapshot.updatedAt,
      terminal: TERMINAL_STATES.has(snapshot.state),
      settle,
      ...(retainedCurrentSnapshot
        ? { currentSnapshot: retainedCurrentSnapshot }
        : {}),
    });
  }
}

export const subagentControlMainV2 = new SubagentControlMainV2();
