import {
  DESIGN_HANDOFF_JOURNAL_VERSION,
  type DesignHandoffChatResult,
  type DesignHandoffJournalRecordV1,
  type DesignHandoffLinkResult,
  type DesignHandoffPacketV1,
  type DesignHandoffStage,
  type DesignHandoffTarget,
  type DesignHandoffWorkspaceResult,
  parseDesignHandoffJournalRecord,
  parseDesignHandoffPacket,
  parseDesignHandoffTarget,
} from "./design-handoff-contract.js";
import {
  DesignHandoffJournalConflictError,
  type DesignHandoffJournalPort,
} from "./design-handoff-journal-store.js";

export interface DesignHandoffRollbackResult {
  proven: boolean;
}

/**
 * Every effect port must be idempotent by operationId. Repeating a call after a
 * crash must return the same identity or reject a conflict; it must never make
 * a second worktree, chat, packet installation, or project linkage.
 */
export interface DesignHandoffEffectPorts {
  verifyTarget(target: DesignHandoffTarget): Promise<DesignHandoffTarget>;
  prepareWorkspace(
    operationId: string,
    target: DesignHandoffTarget,
  ): Promise<DesignHandoffWorkspaceResult>;
  createChat(
    operationId: string,
    workspace: DesignHandoffWorkspaceResult,
  ): Promise<DesignHandoffChatResult>;
  installUntrustedContext(
    operationId: string,
    workspace: DesignHandoffWorkspaceResult,
    chat: DesignHandoffChatResult,
    packet: DesignHandoffPacketV1,
  ): Promise<void>;
  publishProjectLink(
    operationId: string,
    packet: DesignHandoffPacketV1,
    workspace: DesignHandoffWorkspaceResult,
    chat: DesignHandoffChatResult,
  ): Promise<DesignHandoffLinkResult>;
  inspectPublication(operationId: string): Promise<DesignHandoffLinkResult | null>;
  rollbackContext(operationId: string): Promise<DesignHandoffRollbackResult>;
  rollbackChat(operationId: string): Promise<DesignHandoffRollbackResult>;
  rollbackWorkspace(operationId: string): Promise<DesignHandoffRollbackResult>;
}

export interface BeginDesignHandoffInput {
  operationId: string;
  packet: DesignHandoffPacketV1;
  target: DesignHandoffTarget;
}

export type DesignHandoffRunResult =
  | { status: "published"; record: DesignHandoffJournalRecordV1 }
  | { status: "rolled-back"; record: DesignHandoffJournalRecordV1 }
  | { status: "recoverable"; record: DesignHandoffJournalRecordV1 };

const NEXT: Readonly<Record<DesignHandoffStage, readonly DesignHandoffStage[]>> = {
  prepared: ["workspace-ready", "rolling-back", "recoverable"],
  "workspace-ready": ["chat-ready", "rolling-back", "recoverable"],
  "chat-ready": ["context-ready", "rolling-back", "recoverable"],
  "context-ready": ["published", "rolling-back", "recoverable"],
  published: ["recoverable"],
  "rolling-back": ["rolled-back", "recoverable"],
  "rolled-back": [],
  recoverable: [],
};

export function assertDesignHandoffTransition(
  previous: DesignHandoffJournalRecordV1,
  next: DesignHandoffJournalRecordV1,
): void {
  parseDesignHandoffJournalRecord(previous);
  parseDesignHandoffJournalRecord(next);
  if (
    previous.operationId !== next.operationId || next.revision !== previous.revision + 1 ||
    JSON.stringify(previous.packet) !== JSON.stringify(next.packet) ||
    JSON.stringify(previous.target) !== JSON.stringify(next.target) ||
    next.startedAt !== previous.startedAt || next.updatedAt < previous.updatedAt ||
    !NEXT[previous.stage].includes(next.stage)
  ) throw new DesignHandoffJournalConflictError("The design handoff transition is invalid.");
  if (previous.cancellationRequested && !next.cancellationRequested) {
    throw new DesignHandoffJournalConflictError("A design handoff cancellation cannot be cleared.");
  }
}

function sameTarget(left: DesignHandoffTarget, right: DesignHandoffTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeReason(reason: string): string {
  const normalized = [...reason]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character)
    .join("")
    .replace(/(?:^|\s)(?:\/\S+|~\/\S+|[A-Za-z]:\\\S*)/gu, " [path redacted]")
    .replace(/file:\/\/\S*/giu, "[path redacted]")
    .replace(/(?:authorization\s*:|bearer\s+|api[-_ ]?key\s*[:=]?|password\s*[:=]?|access[-_ ]?token\s*[:=]?|refresh[-_ ]?token\s*[:=]?)\S*/giu, "[sensitive detail redacted]")
    .trim()
    .slice(0, 160);
  if ((normalized.startsWith("{") && normalized.endsWith("}")) || (normalized.startsWith("[") && normalized.endsWith("]"))) {
    return "Handoff recovery requires review.";
  }
  return normalized || "Handoff recovery requires review.";
}

export function createDesignHandoffCoordinator(options: {
  journal: DesignHandoffJournalPort;
  effects: DesignHandoffEffectPorts;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<DesignHandoffRunResult>>();

  const checkpoint = async (
    current: DesignHandoffJournalRecordV1,
    patch: Partial<DesignHandoffJournalRecordV1> & { stage: DesignHandoffStage },
  ): Promise<DesignHandoffJournalRecordV1> => {
    const next = parseDesignHandoffJournalRecord({
      ...current,
      ...patch,
      version: DESIGN_HANDOFF_JOURNAL_VERSION,
      revision: current.revision + 1,
      updatedAt: now(),
    });
    assertDesignHandoffTransition(current, next);
    return options.journal.replace(current.operationId, current.revision, next);
  };

  const preserve = async (
    current: DesignHandoffJournalRecordV1,
    reason: string,
    linkage?: DesignHandoffLinkResult,
  ): Promise<DesignHandoffJournalRecordV1> => {
    if (current.stage === "recoverable") return current;
    return checkpoint(current, {
      stage: "recoverable",
      recoveryReason: safeReason(reason),
      ...(linkage ? { linkage } : {}),
    });
  };

  const rollback = async (
    initial: DesignHandoffJournalRecordV1,
  ): Promise<DesignHandoffRunResult> => {
    let current = initial;
    let published: DesignHandoffLinkResult | null;
    try {
      published = await options.effects.inspectPublication(current.operationId);
    } catch {
      current = await preserve(current, "Aiden could not determine whether publication completed; the workspace was preserved for recovery.");
      return { status: "recoverable", record: current };
    }
    if (published) {
      current = await preserve(current, "The project linkage crossed the publication boundary; the workspace was preserved for recovery.", published);
      return { status: "recoverable", record: current };
    }
    if (current.stage !== "rolling-back") current = await checkpoint(current, { stage: "rolling-back" });
    for (const [name, effect] of [
      ["handoff context", options.effects.rollbackContext],
      ["workspace chat", options.effects.rollbackChat],
      ["managed workspace", options.effects.rollbackWorkspace],
    ] as const) {
      let outcome: DesignHandoffRollbackResult;
      try {
        outcome = await effect(current.operationId);
      } catch {
        current = await preserve(current, `Could not prove rollback of ${name}; the managed workspace was preserved for review.`);
        return { status: "recoverable", record: current };
      }
      if (!outcome.proven) {
        current = await preserve(current, `Could not prove rollback of ${name}; the managed workspace was preserved for review.`);
        return { status: "recoverable", record: current };
      }
    }
    current = await checkpoint(current, { stage: "rolled-back" });
    return { status: "rolled-back", record: current };
  };

  const run = async (operationId: string): Promise<DesignHandoffRunResult> => {
    for (;;) {
      let current = await options.journal.get(operationId);
      if (!current) throw new Error("Design handoff operation was not found.");
      if (current.stage === "published") return { status: "published", record: current };
      if (current.stage === "rolled-back") return { status: "rolled-back", record: current };
      if (current.stage === "recoverable") return { status: "recoverable", record: current };
      if (current.cancellationRequested || current.stage === "rolling-back") return rollback(current);

      try {
        if (current.stage === "prepared") {
          const verified = parseDesignHandoffTarget(await options.effects.verifyTarget(current.target));
          if (!sameTarget(verified, current.target)) throw new Error("The handoff target changed after confirmation.");
          const workspace = await options.effects.prepareWorkspace(current.operationId, current.target);
          if (
            current.target.kind === "managed-worktree" &&
            (!workspace.managed || workspace.createdFromHead !== current.target.expectedCommittedHead)
          ) throw new Error("The managed worktree was not created from the confirmed committed HEAD.");
          if (
            current.target.kind === "existing-workspace" &&
            (workspace.managed || workspace.workspaceId !== current.target.target.workspaceId)
          ) throw new Error("The existing workspace does not match the confirmed target preview.");
          await checkpoint(current, { stage: "workspace-ready", workspace });
          continue;
        }
        if (current.stage === "workspace-ready") {
          const chat = await options.effects.createChat(current.operationId, current.workspace!);
          await checkpoint(current, { stage: "chat-ready", chat });
          continue;
        }
        if (current.stage === "chat-ready") {
          await options.effects.installUntrustedContext(current.operationId, current.workspace!, current.chat!, current.packet);
          await checkpoint(current, { stage: "context-ready" });
          continue;
        }
        if (current.stage === "context-ready") {
          let linkage: DesignHandoffLinkResult;
          try {
            linkage = await options.effects.publishProjectLink(current.operationId, current.packet, current.workspace!, current.chat!);
          } catch (error) {
            const observed = await options.effects.inspectPublication(current.operationId);
            if (!observed) throw error;
            linkage = observed;
          }
          const latest = await options.journal.get(operationId);
          if (!latest) throw new Error("Design handoff operation disappeared during publication.");
          if (latest.cancellationRequested) {
            const preserved = await preserve(latest, "Cancellation arrived after project-link publication; the workspace was preserved for recovery.", linkage);
            return { status: "recoverable", record: preserved };
          }
          const published = await checkpoint(latest, { stage: "published", linkage });
          return { status: "published", record: published };
        }
      } catch (error) {
        if (error instanceof DesignHandoffJournalConflictError) continue;
        const latest = await options.journal.get(operationId);
        if (latest?.cancellationRequested) return rollback(latest);
        throw error;
      }
    }
  };

  const runExclusive = (operationId: string): Promise<DesignHandoffRunResult> => {
    const existing = inFlight.get(operationId);
    if (existing) return existing;
    const result = run(operationId).finally(() => inFlight.delete(operationId));
    inFlight.set(operationId, result);
    return result;
  };

  return {
    async begin(input: BeginDesignHandoffInput): Promise<DesignHandoffRunResult> {
      const packet = parseDesignHandoffPacket(input.packet);
      const target = parseDesignHandoffTarget(input.target);
      const timestamp = now();
      const initial = parseDesignHandoffJournalRecord({
        version: DESIGN_HANDOFF_JOURNAL_VERSION,
        operationId: input.operationId,
        revision: 0,
        stage: "prepared",
        packet,
        target,
        cancellationRequested: false,
        startedAt: timestamp,
        updatedAt: timestamp,
      });
      await options.journal.create(initial);
      return runExclusive(initial.operationId);
    },

    resume(operationId: string): Promise<DesignHandoffRunResult> {
      return runExclusive(operationId);
    },

    async cancel(operationId: string): Promise<DesignHandoffRunResult> {
      for (;;) {
        const current = await options.journal.get(operationId);
        if (!current) throw new Error("Design handoff operation was not found.");
        if (current.stage === "rolled-back") return { status: "rolled-back", record: current };
        if (current.stage === "recoverable") return { status: "recoverable", record: current };
        if (current.stage === "published") {
          const preserved = await preserve(current, "Cancellation was requested after publication; the linked workspace remains available.", current.linkage);
          return { status: "recoverable", record: preserved };
        }
        if (!current.cancellationRequested) {
          const next = parseDesignHandoffJournalRecord({
            ...current,
            revision: current.revision + 1,
            cancellationRequested: true,
            updatedAt: now(),
          });
          // Cancellation is an orthogonal flag update, not an effect stage transition.
          try {
            await options.journal.replace(operationId, current.revision, next);
          } catch (error) {
            if (error instanceof DesignHandoffJournalConflictError) continue;
            throw error;
          }
        }
        return runExclusive(operationId);
      }
    },

    async resumeRecoverable(): Promise<DesignHandoffRunResult[]> {
      const records = await options.journal.listRecoverable();
      const results: DesignHandoffRunResult[] = [];
      for (const record of records) results.push(await runExclusive(record.operationId));
      return results;
    },
  };
}

export type DesignHandoffCoordinator = ReturnType<typeof createDesignHandoffCoordinator>;
