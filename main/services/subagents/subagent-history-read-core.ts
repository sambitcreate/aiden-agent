import {
  isSafeSubagentIdentifier,
  type SubagentEffectActivityV1,
  type SubagentRunSnapshot,
} from "../../../renderer/shared/subagent-runs.js";
import type {
  SubagentHistoryDetailWithTranscriptV1,
  SubagentTranscriptV1,
} from "../../../renderer/shared/subagent-transcript.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  persistedChatReferencesSubagentRun,
  persistedChatWorkspaceId,
} from "../chat-workspace-authority.js";

interface HistoricalChat {
  id: string;
  workspaceId?: string;
  messages: Array<{
    role: string;
    subagents?: {
      generationId: string;
      runIds: readonly string[];
      version: number;
    };
  }>;
}

export interface SubagentSnapshotWithEffects<
  Snapshot extends SubagentRunSnapshot = SubagentRunSnapshot,
> {
  snapshot: Snapshot;
  effects: readonly SubagentEffectActivityV1[];
}

export type SubagentHistoryDetailReadDependencies<
  Snapshot extends SubagentRunSnapshot = SubagentRunSnapshot,
> = {
  getChat(chatId: string): Promise<HistoricalChat | null>;
  /**
   * Combined single-read lookup returning both the run snapshot and its
   * projected effect activity when owned by `chatId`.
   */
  getSnapshotWithEffects?(
    runId: string,
    chatId: string,
  ): Promise<SubagentSnapshotWithEffects<Snapshot> | null>;
  getSnapshot?(runId: string): Promise<Snapshot | null>;
  getEffectActivity?(runId: string, chatId: string): Promise<SubagentEffectActivityV1[]>;
  /**
   * The run's saved conversation. Asked only after the run is proven to
   * belong to this chat, and always with the owning chat's id.
   */
  getTranscript?(runId: string, chatId: string): Promise<SubagentTranscriptV1 | null>;
  /**
   * The main-owned scope of a run a turn is tracking right now, before the
   * chat history references it. Absent, or `null` for the run, means only
   * runs the saved chat already references can be read.
   */
  getTrackedRun?(runId: string): Promise<TrackedSubagentRun | null> | TrackedSubagentRun | null;
};

export async function readSubagentHistoryDetailForOwner<
  Snapshot extends SubagentRunSnapshot,
>(
  owner: RendererDocumentOwner,
  chatId: string,
  runId: string,
  dependencies: SubagentHistoryDetailReadDependencies<Snapshot>,
): Promise<SubagentHistoryDetailWithTranscriptV1 | null> {
  const removeOwnerInvalidation = owner.onInvalidated(() => undefined);
  try {
    const chat = await dependencies.getChat(chatId);
    requireActiveOwner(owner);
    if (!chat || chat.id !== chatId) return null;
    const workspaceId = persistedChatWorkspaceId(chat.workspaceId);

    let snapshot: Snapshot | null = null;
    let combinedEffects: readonly SubagentEffectActivityV1[] | undefined;
    if (dependencies.getSnapshotWithEffects) {
      const combined = await dependencies.getSnapshotWithEffects(runId, chat.id);
      requireActiveOwner(owner);
      if (combined) {
        snapshot = combined.snapshot;
        combinedEffects = combined.effects;
      }
    } else if (dependencies.getSnapshot) {
      snapshot = await dependencies.getSnapshot(runId);
      requireActiveOwner(owner);
    }

    if (
      !snapshot ||
      snapshot.runId !== runId ||
      snapshot.chatId !== chat.id ||
      snapshot.workspaceId !== workspaceId
    ) {
      return null;
    }

    if (!persistedChatReferencesSubagentRun(chat.messages, snapshot.runId, snapshot.generationId)) {
      if (!dependencies.getTrackedRun) return null;
      const tracked = await dependencies.getTrackedRun(runId);
      requireActiveOwner(owner);
      if (
        !tracked ||
        tracked.chatId !== chat.id ||
        tracked.workspaceId !== workspaceId ||
        snapshot.generationId !== tracked.generationId
      ) {
        return null;
      }
    }

    let effects: SubagentEffectActivityV1[];
    if (combinedEffects !== undefined) {
      effects = [...combinedEffects];
    } else if (dependencies.getEffectActivity) {
      effects = await dependencies.getEffectActivity(runId, chatId);
      requireActiveOwner(owner);
    } else {
      effects = [];
    }

    const transcript = await dependencies.getTranscript?.(snapshot.runId, snapshot.chatId);
    requireActiveOwner(owner);
    return {
      version: 1,
      snapshot,
      effects,
      ...(transcript && transcript.runId === snapshot.runId ? { transcript } : {}),
    };
  } finally {
    removeOwnerInvalidation();
  }
}

/** Where a run the supervisor is tracking right now belongs. */
export interface TrackedSubagentRun {
  chatId: string;
  workspaceId: string;
  generationId: string;
}

export interface SubagentHistoryReadDependencies<
  Snapshot extends SubagentRunSnapshot = SubagentRunSnapshot,
> {
  getChat(chatId: string): Promise<HistoricalChat | null>;
  getSnapshot(runId: string): Promise<Snapshot | null>;
}

/** Validate both renderer-controlled lookup keys before any private-store access. */
export function parseSubagentHistoryRequestIds(
  chatId: unknown,
  runId: unknown,
): { chatId: string; runId: string } {
  if (!isSafeSubagentIdentifier(chatId) || !isSafeSubagentIdentifier(runId)) {
    throw new Error("Invalid subagent history request.");
  }
  return { chatId, runId };
}

function requireActiveOwner(owner: RendererDocumentOwner): void {
  if (owner.isDestroyed()) {
    throw new Error("The renderer document is no longer active.");
  }
}

/** Keep the exact invoking document authoritative across both asynchronous reads. */
export async function readSubagentHistoryForOwner<
  Snapshot extends SubagentRunSnapshot,
>(
  owner: RendererDocumentOwner,
  chatId: string,
  runId: string,
  dependencies: SubagentHistoryReadDependencies<Snapshot>,
): Promise<Snapshot | null> {
  const removeOwnerInvalidation = owner.onInvalidated(() => undefined);
  try {
    const chat = await dependencies.getChat(chatId);
    requireActiveOwner(owner);
    if (!chat || chat.id !== chatId) return null;
    const snapshot = await dependencies.getSnapshot(runId);
    requireActiveOwner(owner);
    return snapshot?.chatId === chat.id &&
      snapshot.workspaceId === persistedChatWorkspaceId(chat.workspaceId) &&
      persistedChatReferencesSubagentRun(chat.messages, snapshot.runId, snapshot.generationId)
      ? snapshot
      : null;
  } finally {
    removeOwnerInvalidation();
  }
}
