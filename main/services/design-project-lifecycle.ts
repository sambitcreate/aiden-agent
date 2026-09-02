import { createHash } from "node:crypto";
import type { Chat } from "./types.js";
import type { DesignCommentStore } from "./design-comment-store.js";
import type { DesignReferenceAssetStore } from "./design-reference-asset-store.js";
import type { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { remappedHtmlArtifactMediaId } from "./generative-ui-artifact-store.js";
import type { SourceDesignerActionService } from "./source-designer-actions.js";
import type { SourceDesignerMultifileCoordinator } from "./source-designer-multifile-coordinator.js";
import type { SourceDesignerMultifileJournalPort } from "./source-designer-multifile-journal.js";
import type {
  DesignProjectCascadePlanner,
  DesignProjectDeletePlanV1,
  DesignProjectDuplicatePort,
  DesignProjectStore,
  PreparedDesignProjectDuplicate,
} from "./design-project-store.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import {
  designProjectLifecycleOperationId,
  type DesignProjectDeleteLifecycleRecordV1,
  type DesignProjectDuplicateLifecycleRecordV1,
  type DesignProjectLifecycleJournalPort,
  type DesignProjectLifecycleRecordV1,
} from "./design-project-lifecycle-journal.js";

type DesignProjectPort = Pick<
  DesignProjectStore,
  | "duplicate"
  | "planDelete"
  | "delete"
  | "reconcileDeletePublication"
  | "get"
  | "getByChatId"
  | "list"
>;

export interface DesignProjectDuplicateChatPort {
  get(id: string): Promise<Chat | null>;
  copyVisibleHistory(input: {
    sourceChatId: string;
    targetChatId?: string;
    expectedWorkspaceId?: string;
    assertCurrent?: () => void;
    beforeInstall?: (chat: Chat) => void | Promise<void>;
  }): Promise<Chat>;
  rename(id: string, title: string): Promise<Chat>;
  remove(id: string): Promise<void>;
}

export interface DesignProjectDuplicateArtifactPort extends Pick<
  GenerativeUiArtifactStore,
  "prepareSelectedCopy" | "commit" | "deleteChat"
> {}

export interface DesignProjectLifecycleCascadePort {
  prepareDesignerActions?(chatId: string, expectedIds: readonly string[]): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  deleteComments(projectId: string, expectedIds: readonly string[]): Promise<void>;
  deleteDesignerActions(chatId: string, expectedIds: readonly string[]): Promise<void>;
  deleteReferenceAssets(candidateIds: readonly string[]): Promise<void>;
}

export function createIdempotentDesignProjectChatDelete(input: {
  chats: { get(chatId: string): Promise<Chat | null> };
  application: { remove(chatId: string): Promise<void> };
}): (chatId: string) => Promise<void> {
  return async (chatId) => {
    if (!(await input.chats.get(chatId))) return;
    await input.application.remove(chatId);
  };
}

export interface DesignProjectLifecycleCoordinatorOptions {
  projectStore: DesignProjectPort;
  duplicatePort: RecoverableDesignProjectDuplicatePort;
  journal: DesignProjectLifecycleJournalPort;
  cascade: DesignProjectLifecycleCascadePort;
  now?: () => number;
  onWarning?: (message: string, error: unknown) => void;
}

export interface DesignProjectDeleteConfirmationV1 {
  projectId: string;
  expectedRevision: number;
}

export class DesignProjectDeletionConfirmationRequiredError extends Error {
  readonly name = "DesignProjectDeletionConfirmationRequiredError";

  constructor(readonly plan: DesignProjectDeletePlanV1) {
    super("Deleting this chat requires confirmation of its Design Project cascade.");
  }
}

function timestamp(now: () => number): number {
  const value = Math.floor(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Design Project lifecycle clock is invalid.");
  }
  return value;
}

function targetChatId(targetProjectId: string): string {
  return `design-copy:${createHash("sha256").update(targetProjectId).digest("hex")}`;
}

function htmlMediaIds(chat: Chat): string[] {
  return [
    ...new Set(
      chat.messages.flatMap((message) =>
        (message.htmlArtifacts ?? []).map(({ mediaId }) => mediaId),
      ),
    ),
  ];
}

function duplicateRecord(input: {
  source: DesignProjectSnapshotV1;
  targetProjectId: string;
  targetChatId: string;
  now: number;
}): DesignProjectDuplicateLifecycleRecordV1 {
  return {
    version: 1,
    kind: "duplicate",
    operationId: designProjectLifecycleOperationId("duplicate", input.targetProjectId),
    revision: 0,
    stage: "preparing",
    sourceProjectId: input.source.id,
    sourceProjectRevision: input.source.revision,
    targetProjectId: input.targetProjectId,
    targetChatId: input.targetChatId,
    startedAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Production duplicate adapter. It uses the chat store's existing durable
 * `beforeInstall` boundary so artifact bytes exist before the copied chat can
 * reference them. Its journal remains until the project-row wrapper confirms
 * the final commit.
 */
export class RecoverableDesignProjectDuplicatePort implements DesignProjectDuplicatePort {
  constructor(
    private readonly projectStore: Pick<DesignProjectStore, "get">,
    private readonly chats: DesignProjectDuplicateChatPort,
    private readonly artifacts: DesignProjectDuplicateArtifactPort,
    private readonly journal: DesignProjectLifecycleJournalPort,
    private readonly now: () => number = Date.now,
    private readonly onWarning: (message: string, error: unknown) => void = () => undefined,
  ) {}

  private async cleanup(record: DesignProjectDuplicateLifecycleRecordV1): Promise<void> {
    // Remove the visible owner before its immutable bytes so a failed retry can
    // never leave a chat that renders missing artifact identities.
    await this.chats.remove(record.targetChatId);
    await this.artifacts.deleteChat(record.targetChatId);
    await this.journal.remove(record.operationId);
  }

  async prepareDuplicate(input: {
    source: DesignProjectSnapshotV1;
    targetProjectId: string;
    targetTitle: string;
  }): Promise<PreparedDesignProjectDuplicate> {
    const copiedChatId = targetChatId(input.targetProjectId);
    const created = await this.journal.create(
      duplicateRecord({
        source: input.source,
        targetProjectId: input.targetProjectId,
        targetChatId: copiedChatId,
        now: timestamp(this.now),
      }),
    );
    if (created.kind !== "duplicate") {
      throw new Error("Design Project duplicate recovery identity was reused.");
    }
    let preparedArtifacts: Awaited<
      ReturnType<DesignProjectDuplicateArtifactPort["prepareSelectedCopy"]>
    > = [];
    try {
      const sourceChat = await this.chats.get(input.source.chatId);
      if (!sourceChat || sourceChat.id !== input.source.chatId) {
        throw new Error("The Design Project chat is unavailable for duplication.");
      }
      if (sourceChat.botId) {
        throw new Error("Bot conversations cannot own duplicated Design Projects.");
      }
      const allMediaIds = htmlMediaIds(sourceChat);
      const ownedArtifactIds = new Set(
        input.source.canvas.nodes.flatMap((node) => node.artifactMediaIds ?? []),
      );
      if ([...ownedArtifactIds].some((mediaId) => !allMediaIds.includes(mediaId))) {
        throw new Error("The Design Project artifact history is incomplete.");
      }
      const copied = await this.chats.copyVisibleHistory({
        sourceChatId: input.source.chatId,
        targetChatId: copiedChatId,
        ...(input.source.workspaceId ? { expectedWorkspaceId: input.source.workspaceId } : {}),
        beforeInstall: async () => {
          preparedArtifacts = await this.artifacts.prepareSelectedCopy(
            input.source.chatId,
            copiedChatId,
            allMediaIds,
          );
        },
      });
      if (copied.id !== copiedChatId) {
        throw new Error("The copied Design Project chat identity changed.");
      }
      if (preparedArtifacts.length > 0) {
        await this.artifacts.commit(
          copiedChatId,
          preparedArtifacts.map(({ mediaId }) => mediaId),
        );
      }
      await this.chats.rename(copiedChatId, input.targetTitle);
      const prepared = await this.journal.replace(created.operationId, created.revision, {
        ...created,
        revision: created.revision + 1,
        stage: "prepared",
        updatedAt: Math.max(timestamp(this.now), created.updatedAt),
      });
      if (prepared.kind !== "duplicate") {
        throw new Error("Design Project duplicate recovery changed kind.");
      }
      return {
        targetChatId: copiedChatId,
        artifactMediaIds: [...ownedArtifactIds].map((mediaId) => ({
          from: mediaId,
          to: remappedHtmlArtifactMediaId(copiedChatId, mediaId),
        })),
        // Reference images are immutable and content-addressed. Duplication
        // deliberately shares their bytes while each project owns its link.
        referenceAssetIds: input.source.referenceAssetIds.map((assetId) => ({
          from: assetId,
          to: assetId,
        })),
        rollback: () => this.cleanup(prepared),
      };
    } catch (error) {
      try {
        await this.cleanup(created);
      } catch (cleanupError) {
        this.onWarning("Design Project duplication preparation failed before cleanup.", error);
        throw new Error(
          `Design Project duplication failed and needs restart recovery: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  /** Clear preparation only after `DesignProjectStore.duplicate()` committed. */
  async complete(projectId: string): Promise<void> {
    const operationId = designProjectLifecycleOperationId("duplicate", projectId);
    try {
      await this.journal.remove(operationId);
    } catch (error) {
      this.onWarning("Could not clear completed Design Project duplicate recovery.", error);
    }
  }

  async recover(record: DesignProjectDuplicateLifecycleRecordV1): Promise<void> {
    const installed = await this.projectStore.get(record.targetProjectId);
    if (installed) {
      if (installed.chatId !== record.targetChatId) {
        throw new Error("Recovered Design Project duplicate ownership does not match its journal.");
      }
      await this.journal.remove(record.operationId);
      return;
    }
    await this.cleanup(record);
  }
}

export function createDesignProjectCascadePlanner(
  comments: Pick<DesignCommentStore, "listProject">,
  actions: Pick<SourceDesignerActionService, "inspectChatActionIds">,
  durableActions?: Pick<SourceDesignerMultifileJournalPort, "listProject">,
): DesignProjectCascadePlanner {
  return {
    async inspect(snapshot) {
      const view = await comments.listProject(snapshot.id);
      const durable = durableActions?.listProject
        ? await durableActions.listProject(snapshot.id)
        : [];
      return {
        commentIds: view.comments.map(({ id }) => id),
        designerActionIds: [
          ...actions.inspectChatActionIds(snapshot.chatId),
          ...durable.map(({ actionId }) => actionId),
        ].sort(),
      };
    },
  };
}

export function createDesignProjectCascadePort(input: {
  projectStore: Pick<DesignProjectStore, "list" | "get">;
  deleteChat(chatId: string): Promise<void>;
  comments: Pick<DesignCommentStore, "deleteProject">;
  actions: Pick<SourceDesignerActionService, "deleteChatActions">;
  durableActions?: Pick<SourceDesignerMultifileJournalPort, "get">;
  durableCoordinator?: Pick<
    SourceDesignerMultifileCoordinator,
    "assertProjectDeletionSafe" | "discardForProjectDeletion"
  >;
  referenceAssets: Pick<DesignReferenceAssetStore, "deleteUnreferencedCandidates">;
}): DesignProjectLifecycleCascadePort {
  return {
    async prepareDesignerActions(chatId, expectedIds) {
      if (!input.durableActions || !input.durableCoordinator) return;
      for (const actionId of expectedIds) {
        const record = await input.durableActions.get(actionId);
        if (!record) continue;
        if (record.chatId !== chatId) {
          throw new Error("Durable Designer Action cascade authority changed.");
        }
        await input.durableCoordinator.assertProjectDeletionSafe(actionId, chatId);
      }
    },
    deleteChat: input.deleteChat,
    async deleteComments(projectId, expectedIds) {
      await input.comments.deleteProject(projectId, expectedIds);
    },
    async deleteDesignerActions(chatId, expectedIds) {
      input.actions.deleteChatActions(chatId, expectedIds);
      if (input.durableActions && input.durableCoordinator) {
        for (const actionId of expectedIds) {
          const record = await input.durableActions.get(actionId);
          if (!record) continue;
          if (record.chatId !== chatId) {
            throw new Error("Durable Designer Action cascade authority changed.");
          }
          await input.durableCoordinator.discardForProjectDeletion(actionId, chatId);
        }
      }
    },
    async deleteReferenceAssets(candidateIds) {
      const projects = await input.projectStore.list();
      const snapshots = await Promise.all(projects.map(({ id }) => input.projectStore.get(id)));
      const liveIds = new Set(snapshots.flatMap((snapshot) => snapshot?.referenceAssetIds ?? []));
      await input.referenceAssets.deleteUnreferencedCandidates(candidateIds, liveIds);
    },
  };
}

function deleteRecord(
  plan: DesignProjectDeletePlanV1,
  now: number,
): DesignProjectDeleteLifecycleRecordV1 {
  return {
    version: 1,
    kind: "delete",
    operationId: designProjectLifecycleOperationId("delete", JSON.stringify(plan)),
    revision: 0,
    stage: "planned",
    plan: structuredClone(plan),
    startedAt: now,
    updatedAt: now,
  };
}

export function createDesignProjectLifecycleCoordinator(
  options: DesignProjectLifecycleCoordinatorOptions,
) {
  const now = options.now ?? Date.now;
  const onWarning = options.onWarning ?? (() => undefined);
  let operationTail: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const executeCascade = async (plan: DesignProjectDeletePlanV1): Promise<void> => {
    await options.cascade.deleteComments(plan.projectId, plan.commentIds);
    await options.cascade.deleteDesignerActions(plan.chatId, plan.designerActionIds);
    await options.cascade.deleteChat(plan.chatId);
    await options.cascade.deleteReferenceAssets(plan.unreferencedReferenceAssetIds);
  };

  const clearAfterCommit = async (operationId: string): Promise<void> => {
    try {
      await options.journal.remove(operationId);
    } catch (error) {
      onWarning("Could not clear completed Design Project lifecycle recovery.", error);
    }
  };

  const finishDelete = async (record: DesignProjectDeleteLifecycleRecordV1): Promise<void> => {
    await executeCascade(record.plan);
    await clearAfterCommit(record.operationId);
  };

  const deletePlan = (
    plan: DesignProjectDeletePlanV1,
    beforeDelete?: (plan: DesignProjectDeletePlanV1) => void | Promise<void>,
  ): Promise<void> =>
    serialized(async () => {
      await beforeDelete?.(plan);
      await options.cascade.prepareDesignerActions?.(plan.chatId, plan.designerActionIds);
      const created = await options.journal.create(deleteRecord(plan, timestamp(now)));
      if (created.kind !== "delete") {
        throw new Error("Design Project delete recovery identity was reused.");
      }
      try {
        await options.projectStore.delete(plan);
      } catch (error) {
        // DataStore publication is atomic, but an I/O error can make the caller
        // uncertain whether publication completed. Resolve that ambiguity from
        // a fresh disk snapshot before deciding rollback versus roll-forward.
        // A cached predecessor must never revoke the journal after the delete
        // was already published to disk.
        const publication = await options.projectStore.reconcileDeletePublication(plan);
        if (publication === "present") {
          await options.journal.remove(created.operationId);
          throw error;
        }
        if (publication === "uncertain") throw error;
      }
      let committed = created;
      try {
        committed = (await options.journal.replace(created.operationId, created.revision, {
          ...created,
          revision: created.revision + 1,
          stage: "project-deleted",
          updatedAt: Math.max(timestamp(now), created.updatedAt),
        })) as DesignProjectDeleteLifecycleRecordV1;
      } catch (error) {
        // The planned record plus an absent project row is sufficient for
        // startup to infer the committed side of the boundary.
        onWarning("Could not advance Design Project deletion recovery after commit.", error);
      }
      await finishDelete(committed);
    });

  const recoverRecord = async (record: DesignProjectLifecycleRecordV1): Promise<void> => {
    if (record.kind === "duplicate") {
      await options.duplicatePort.recover(record);
      return;
    }
    if (record.stage === "planned") {
      // Absence by project ID is not publication proof: the database may have
      // been externally replaced while the foreground delete outcome was
      // uncertain. Reuse the exact revision/chat proof before granting cascade
      // authority after restart.
      const publication = await options.projectStore.reconcileDeletePublication(record.plan);
      if (publication === "present") {
        await options.journal.remove(record.operationId);
        return;
      }
      if (publication === "uncertain") {
        throw new Error("Design Project deletion publication is still uncertain.");
      }
    }
    await finishDelete(record);
  };

  return {
    /**
     * Main-only lane for project updates, reference attachment, and comment or
     * action creation that must not race lifecycle reference revalidation.
     * Do not wrap the coordinator's own duplicate/delete methods in this lane.
     */
    runProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
      return serialized(operation);
    },

    duplicate(input: Parameters<DesignProjectPort["duplicate"]>[0]) {
      return serialized(async () => {
        const project = await options.projectStore.duplicate(input);
        await options.duplicatePort.complete(project.id);
        return project;
      });
    },

    previewDelete(input: Parameters<DesignProjectPort["planDelete"]>[0]) {
      return options.projectStore.planDelete(input);
    },

    deletePlan,

    async deleteProject(
      input: Parameters<DesignProjectPort["planDelete"]>[0],
      beforeDelete?: (plan: DesignProjectDeletePlanV1) => void | Promise<void>,
    ): Promise<void> {
      return deletePlan(await options.projectStore.planDelete(input), beforeDelete);
    },

    async routeChatDeletion(input: {
      chatId: string;
      confirmation?: DesignProjectDeleteConfirmationV1;
      deleteOrdinaryChat(chatId: string): Promise<void>;
      beforeDesignDelete?: (plan: DesignProjectDeletePlanV1) => void | Promise<void>;
    }): Promise<{ kind: "ordinary-chat" } | { kind: "design-project"; projectId: string }> {
      const project = await options.projectStore.getByChatId(input.chatId);
      if (!project) {
        await input.deleteOrdinaryChat(input.chatId);
        return { kind: "ordinary-chat" };
      }
      const plan = await options.projectStore.planDelete({
        id: project.id,
        expectedRevision: project.revision,
      });
      if (
        input.confirmation?.projectId !== project.id ||
        input.confirmation.expectedRevision !== project.revision
      ) {
        throw new DesignProjectDeletionConfirmationRequiredError(plan);
      }
      await deletePlan(plan, input.beforeDesignDelete);
      return { kind: "design-project", projectId: project.id };
    },

    recover(): Promise<void> {
      return serialized(async () => {
        let firstError: unknown;
        for (const record of await options.journal.list()) {
          try {
            await recoverRecord(record);
          } catch (error) {
            firstError ??= error;
            onWarning("Could not reconcile one Design Project lifecycle operation.", error);
          }
        }
        if (firstError) throw firstError;
      });
    },
  };
}
