import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import type {
  AttachFileAction,
  AttachToWorkspaceResult,
  InspectAttachFilesResult,
} from "../../renderer/shared/chat-attach-workspace.js";
import { chatSurface } from "../../renderer/shared/chat-visibility.js";
import { analyticsWorkspaceKind } from "./analytics/analytics-ids.js";
import { captureAnalyticsReporter, reportAnalyticsEvent } from "./analytics/analytics-report.js";
import type { AidenRemoteAttachmentStore } from "./aiden-remote-attachments.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { ParsedPublicChatCreate } from "../handlers/chat-create-params.js";
import type { ChatStartedByV1 } from "../../renderer/shared/chat-started-by.js";
import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import type { chatStore } from "./chat-store.js";
import type { ChatPullRequestStore } from "./chat-pull-request-store.js";
import type { configStore } from "./config-store.js";
import type { displayImageArtifactStore } from "./display-image-artifact-store.js";
import type { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import type { DesignCanvasStore } from "./design-canvas/store.js";
import type { ToolOutputStore } from "./tool-output-store.js";
import {
  ChatStoreError,
  DESIGN_MODE_UNAVAILABLE_MESSAGE,
  isChatCreateReconciliationRequiredError,
} from "./chat-store-core.js";
import type { llmClient } from "./llm-client.js";
import type { Chat, Workspace } from "./types.js";
import { assertRenameAllowedFromChat } from "./chat-title-policy.js";
import {
  copyScratchFilesToWorkspaceWithRollback,
  inspectScratchFolderFiles,
} from "./chat-attach-workspace.js";
import {
  WorkspaceFolderMissingError,
  workspaceFolderMissing as defaultWorkspaceFolderMissing,
} from "./workspace-folder-presence.js";
import { assertManagedWorktreeAdmission as defaultAssertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import type { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import type { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import type { subagentRunStore } from "./subagents/subagent-run-store.js";
import { chatForRenderer } from "./visible-chat-projection.js";
import { releaseChatCacheWarmer } from "./pi-cache-warming.js";
import type { workspaceMutationGate } from "./workspace-mutation-gate.js";
import {
  admitOwnedWorkspaceOperation,
  type workspaceOperationRegistry,
  type WorkspaceOperationDocumentOwner,
} from "./workspace-operation-registry.js";

export interface ChatApplicationOwner extends WorkspaceOperationDocumentOwner {
  documentId: string;
}

export interface ChatApplicationMutationOptions {
  assertCurrent?: (chat: Chat) => void | Promise<void>;
  /** Renderer-initiated rename/delete refuses feature-owned (Design Studio) chats. */
  rejectFeatureOwned?: boolean;
  /**
   * Main-owned notification that cross-store deletion has durably installed its
   * subagent tombstone. From this point restart reconciliation can only roll the
   * deletion forward, even if a later private-store or chat-store step fails.
   */
  onDeletionRollForward?: () => void;
}

export interface ChatApplicationDependencies {
  toolOutputStore?: Pick<ToolOutputStore, "deleteByChat">;
  chatStore: Pick<
    typeof chatStore,
    | "list"
    | "listRegular"
    | "get"
    | "create"
    | "rename"
    | "setChatModelSelection"
    | "setDesignMode"
    | "moveEmptyChatToWorkspace"
    | "remove"
  > &
    Partial<
      Pick<
        typeof chatStore,
        | "listSummaryMetadata"
        | "getWithImageReferences"
        | "promoteEphemeralChat"
        | "attachChatToWorkspace"
      >
    >;
  configStore: Pick<typeof configStore, "getWorkspace">;
  llmClient: Pick<
    typeof llmClient,
    | "isChatOwnedByInactiveRenderer"
    | "isChatBusy"
    | "waitForChatIdle"
    | "requiresAppendReconciliation"
    | "markAppendReconciliationRequired"
    | "clearAppendReconciliationRequired"
    | "beginChatWorkspaceChange"
    | "beginChatDeletion"
    | "cancelChat"
  >;
  displayImageArtifactStore: Pick<
    typeof displayImageArtifactStore,
    "availability" | "hasPending" | "deleteChat"
  >;
  generativeUiArtifactStore: Pick<
    typeof generativeUiArtifactStore,
    "availability" | "hasPending" | "deleteChat"
  >;
  workspaceMutationGate: Pick<typeof workspaceMutationGate, "admit">;
  workspaceOperationRegistry: typeof workspaceOperationRegistry;
  subagentRunStore: Pick<
    typeof subagentRunStore,
    "deleteChat" | "completeChatDeletion" | "pendingChatDeletions"
  >;
  piRuntimeEffectStore: Pick<typeof piRuntimeEffectStore, "deleteChat">;
  piCompactionSessionStore: Pick<typeof piCompactionSessionStore, "deleteChat"> &
    Partial<Pick<typeof piCompactionSessionStore, "recordWorkspaceAttached">>;
  chatPullRequestStore?: Pick<ChatPullRequestStore, "deleteChat">;
  /** The chat's design canvas document goes with it; forks never copy it. */
  designCanvasStore?: Pick<DesignCanvasStore, "delete">;
  /** aiden-design grants: a chat's ends when design mode turns off, it moves or it is deleted. */
  designGrants?: { revokeChat(chatId: string): void };
  /** Forgets the person's "Not now" on Aiden's design mode card once they open design mode themselves. */
  designModeConsent?: { forgetDecline(chatId: string): void };
  /**
   * Runs once design mode turns on: puts the HTML pages this chat's earlier
   * replies wrote on an empty canvas. Never awaited by the switch.
   */
  designPagesOnEntry?(chat: Chat, workspaceRoot: string): Promise<unknown>;
  /** Queued visual snapshots; a deleted chat's are dropped, not captured. */
  visualSnapshots?: { cancelChat(chatId: string): void };
  /** Stops a deleted chat's background jobs and drops its followed pull requests and check. */
  followThrough?: {
    beginMove?(chatId: string): Promise<() => void> | (() => void);
    deleteChat(chatId: string): Promise<void>;
    /** The delete rolled back before its durable boundary: the retained chat's answers count again. */
    restoreChat?(chatId: string): void;
  };
  memoryStore?: { deleteSourceChat(chatId: string): Promise<number> };
  attachments?: Pick<AidenRemoteAttachmentStore, "beginChatDeletion" | "revokeChat">;
  /** Release ambient per-chat caches on chat deletion (including spending and interrupted waits). */
  releaseChatContext?: (chatId: string) => void;
  /** Invalidate workspace-scoped per-chat caches on attach without clearing spending or interrupted waits. */
  invalidateChatWorkspaceContext?: (chatId: string) => void;
  /** Remove per-chat scratch state once the chat is gone. Best effort; never throws. */
  forgetDeletedChat?: (chatId: string) => Promise<void>;
  /** Reset workspace-bound hook/ACP scratch state after attaching a chat to a new workspace. */
  resetChatWorkspaceSession?: (chatId: string) => Promise<void>;
  /** Override folder-presence check in unit tests. */
  workspaceFolderMissing?: (workspace: Workspace) => Promise<boolean>;
  /** Override managed-worktree admission check in unit tests. */
  assertManagedWorktreeAdmission?: (workspace: Workspace) => Promise<void>;
  /**
   * The Inbox stores whose entry for a deleted chat (its read marker and its
   * triage) is dropped once the chat is gone. Every delete runs through here
   * (desktop, Remote and Bot chat deletes), so no surface leaves that state
   * behind. Best effort: it never delays or fails the delete.
   */
  inboxState?: ChatInboxStateStores;
  /** After a deletion commits: lets a No workspace chat's hidden folder go with it. */
  afterChatRemoved?: (workspaceId: string) => Promise<void>;
  /** After a deletion commits: tasks that posted into the chat carry on in their own chats. */
  scheduledTasks?: { releaseOriginChat(chatId: string): Promise<unknown> };
  logError(area: string, message: string, error: unknown): void;
}

/** The Inbox stores holding a chat's read marker and its triage. */
export interface ChatInboxStateStores {
  readMarkers?: { remove(chatId: string): Promise<unknown> };
  triage?: { remove(chatId: string): Promise<unknown> };
}

/**
 * Drop a deleted chat's Inbox state: its read marker and its triage. Shared by
 * the live delete and the startup roll-forward of a delete a crash cut short,
 * so neither leaves a snooze or pin behind for a chat that no longer exists.
 * Best effort: each store is cleared on its own, a failure is logged, and the
 * returned promise never rejects.
 */
export async function forgetChatInboxState(
  stores: ChatInboxStateStores | undefined,
  chatId: string,
  logError: (area: string, message: string, error: unknown) => void,
): Promise<void> {
  await Promise.all(
    [stores?.readMarkers, stores?.triage].map((store) =>
      store
        ?.remove(chatId)
        .catch((error: unknown) =>
          logError("chats", "Could not clear the deleted chat's Inbox state.", error),
        ),
    ),
  );
}

/**
 * How a delete attempt ended. Admission reopens only when no durable tombstone
 * can remain, so without a removed chat it means the delete rolled back and the
 * chat stays in use. While a tombstone may remain, including when its status
 * could not be read, the fences stay closed for startup to roll forward.
 */
type ChatDeletionSettlement = "completed" | "rolled_back" | "roll_forward_pending";

function chatDeletionSettlement(
  admissionReleased: boolean,
  chatRemoved: boolean,
): ChatDeletionSettlement {
  if (!admissionReleased) return "roll_forward_pending";
  return chatRemoved ? "completed" : "rolled_back";
}

export function createChatApplicationService(deps: ChatApplicationDependencies) {
  const markReconciliationRequired = (owner: ChatApplicationOwner): never => {
    deps.llmClient.markAppendReconciliationRequired(owner.documentId);
    owner.onInvalidated(() => {
      deps.llmClient.clearAppendReconciliationRequired(owner.documentId);
    });
    throw new Error(appendReconciliationFailureMessage("blocked"));
  };

  return {
    list(workspaceId?: string) {
      return deps.chatStore.list(workspaceId);
    },

    listRegular(workspaceId?: string) {
      return deps.chatStore.listRegular(workspaceId);
    },

    listSummaryMetadata() {
      if (!deps.chatStore.listSummaryMetadata) {
        throw new Error("The transcript-free chat summary index is unavailable.");
      }
      return deps.chatStore.listSummaryMetadata();
    },

    async get(chatId: string) {
      let reconciliationRequired = false;
      if (deps.llmClient.isChatOwnedByInactiveRenderer(chatId)) {
        reconciliationRequired = !(await deps.llmClient.waitForChatIdle(chatId));
      }
      const imageArtifactAvailability = deps.displayImageArtifactStore.availability();
      const htmlArtifactAvailability = deps.generativeUiArtifactStore.availability();
      const imageArtifactRecoveryUnavailable =
        !imageArtifactAvailability.available || !htmlArtifactAvailability.available;
      const [chat, stagedImageArtifact, stagedHtmlArtifact] = await Promise.all([
        // The window loads stored images itself, so their bytes are not read here.
        deps.chatStore.getWithImageReferences
          ? deps.chatStore.getWithImageReferences(chatId)
          : deps.chatStore.get(chatId),
        !imageArtifactAvailability.available
          ? Promise.resolve(false)
          : deps.displayImageArtifactStore.hasPending(chatId),
        !htmlArtifactAvailability.available
          ? Promise.resolve(false)
          : deps.generativeUiArtifactStore.hasPending(chatId),
      ]);
      reconciliationRequired ||= deps.llmClient.isChatOwnedByInactiveRenderer(chatId);
      const imageArtifactRecoveryPending =
        (stagedImageArtifact || stagedHtmlArtifact) && !deps.llmClient.isChatBusy(chatId)
          ? ((stagedImageArtifact
              ? await deps.displayImageArtifactStore.hasPending(chatId)
              : false) ||
              (stagedHtmlArtifact
                ? await deps.generativeUiArtifactStore.hasPending(chatId)
                : false)) &&
            !deps.llmClient.isChatBusy(chatId)
          : false;
      return {
        chat: chatForRenderer(chat),
        imageArtifactRecoveryPending,
        imageArtifactRecoveryUnavailable,
        reconciliation: reconciliationRequired
          ? {
              chatId,
              workspaceId: persistedChatWorkspaceId(chat?.workspaceId),
            }
          : null,
      };
    },

    waitUntilIdle(chatId: string) {
      return deps.llmClient.waitForChatIdle(chatId);
    },

    /** `reportAnalytics: false` keeps `chat_created` unsent (an outside MCP app made the chat). */
    async create(
      input: ParsedPublicChatCreate,
      owner: ChatApplicationOwner,
      options?: { reportAnalytics?: boolean; startedBy?: ChatStartedByV1 },
    ) {
      if (deps.llmClient.requiresAppendReconciliation(owner.documentId)) {
        throw new Error(appendReconciliationFailureMessage("blocked"));
      }
      if (input.workspaceId === ASSISTANT_WORKSPACE_ID) {
        throw new Error("Ordinary chat creation cannot create Aiden Assistant chats.");
      }
      const mutationAdmission = deps.workspaceMutationGate.admit(input.workspaceId);
      let workspaceOperation: ReturnType<typeof admitOwnedWorkspaceOperation> | undefined;
      try {
        workspaceOperation = admitOwnedWorkspaceOperation(
          deps.workspaceOperationRegistry,
          owner,
          input.workspaceId,
        );
        const workspace = await deps.configStore.getWorkspace(input.workspaceId);
        if (!workspace) {
          throw new Error("The selected workspace is no longer available.");
        }
        const assertCurrent = () => {
          if (owner.isDestroyed()) {
            throw new Error("The renderer document is no longer active.");
          }
          if (mutationAdmission.signal.aborted || workspaceOperation?.signal.aborted) {
            throw new Error("The workspace changed before the chat was created.");
          }
          if (deps.llmClient.requiresAppendReconciliation(owner.documentId)) {
            throw new Error(appendReconciliationFailureMessage("blocked"));
          }
        };
        try {
          const chat = chatForRenderer(
            await deps.chatStore.create({
              ...input,
              ...(options?.startedBy ? { startedBy: options.startedBy } : {}),
              assertCurrent,
            }),
          );
          if (options?.reportAnalytics !== false) {
            reportAnalyticsEvent("chat_created", {
              workspace_kind: analyticsWorkspaceKind(workspace),
            });
          }
          return chat;
        } catch (error) {
          if (isChatCreateReconciliationRequiredError(error)) {
            return markReconciliationRequired(owner);
          }
          throw error;
        }
      } finally {
        workspaceOperation?.release();
        mutationAdmission.release();
      }
    },

    rename(chatId: string, title: string, options: ChatApplicationMutationOptions = {}) {
      return deps.chatStore.rename(chatId, title, async (chat) => {
        assertRenameAllowedFromChat(chat, options);
        await options.assertCurrent?.(chat);
      });
    },

    /**
     * The model picker in an open chat changes that chat only. Refused while a
     * reply runs, because the running turn records its own model when it ends.
     */
    async setModelSelection(
      chatId: string,
      providerId: string,
      model: string,
      options: ChatApplicationMutationOptions = {},
      thinkingLevel?: GenerationThinkingLevel | null,
    ) {
      if (deps.llmClient.isChatBusy(chatId)) {
        throw new Error("Finish or stop the current response before changing this chat's model.");
      }
      return chatForRenderer(
        await deps.chatStore.setChatModelSelection(
          chatId,
          providerId,
          model,
          async (chat) => {
            assertRenameAllowedFromChat(chat, options);
            await options.assertCurrent?.(chat);
            if (deps.llmClient.isChatBusy(chatId)) {
              throw new Error(
                "Finish or stop the current response before changing this chat's model.",
              );
            }
          },
          thinkingLevel,
        ),
      );
    },

    /**
     * Turn design mode on or off for one chat. It needs a project chat: one
     * whose workspace has a folder, or a No workspace chat in Aiden's own
     * folder. Turning it off is always allowed. A running reply is not
     * affected, because design mode only changes the layout.
     */
    async setDesignMode(
      chatId: string,
      enabled: boolean,
      options: ChatApplicationMutationOptions = {},
    ) {
      let turnedOn = false;
      let workspaceRoot: string | undefined;
      const updated = await deps.chatStore.setDesignMode(chatId, enabled, async (chat) => {
        assertRenameAllowedFromChat(chat, options);
        await options.assertCurrent?.(chat);
        if (!enabled) return;
        const workspace = await deps.configStore.getWorkspace(
          persistedChatWorkspaceId(chat.workspaceId),
        );
        if (!workspace || (!workspace.folderPath && workspace.noWorkspace !== true)) {
          throw new ChatStoreError("design-mode-unavailable", DESIGN_MODE_UNAVAILABLE_MESSAGE);
        }
        turnedOn = chat.designMode !== true;
        workspaceRoot = workspace.folderPath;
      });
      if (!enabled) deps.designGrants?.revokeChat(chatId);
      else deps.designModeConsent?.forgetDecline(chatId);
      if (turnedOn && workspaceRoot && deps.designPagesOnEntry) {
        void deps.designPagesOnEntry(updated, workspaceRoot).catch((error) => {
          deps.logError("design", "Could not put earlier pages on the design canvas.", error);
        });
      }
      return chatForRenderer(updated);
    },

    async moveEmptyToWorkspace(
      chatId: string,
      workspaceId: string,
      options: ChatApplicationMutationOptions = {},
    ) {
      const finishMove = deps.llmClient.beginChatWorkspaceChange(chatId);
      if (!finishMove) {
        throw new Error("Finish or stop the current response before changing workspaces.");
      }
      let finishFollowThroughMove: (() => void) | undefined;
      try {
        finishFollowThroughMove = await deps.followThrough?.beginMove?.(chatId);
        const current = await deps.chatStore.get(chatId);
        if (!current) throw new Error(`Chat ${chatId} not found`);
        if (current.botId) {
          throw new Error("Bot conversations stay in their Aiden-managed folder.");
        }
        if (!(await deps.configStore.getWorkspace(workspaceId))) {
          throw new Error(`Workspace ${workspaceId} not found.`);
        }
        const moved = await deps.chatStore.moveEmptyChatToWorkspace(
          chatId,
          workspaceId,
          async (chat) => {
            if (chat.botId) {
              throw new Error("Bot conversations stay in their Aiden-managed folder.");
            }
            await options.assertCurrent?.(chat);
          },
        );
        // A grant names the old workspace root; the canvas asks again for the new one.
        deps.designGrants?.revokeChat(chatId);
        return chatForRenderer(moved);
      } finally {
        finishFollowThroughMove?.();
        finishMove();
      }
    },

    /** Promote an ephemeral floating chat into a durable No workspace chat. */
    async promoteEphemeral(
      chatId: string,
      options: ChatApplicationMutationOptions = {},
    ): Promise<Chat> {
      if (!deps.chatStore.promoteEphemeralChat) {
        throw new Error("Promoting temporary chats is not available.");
      }
      const report = captureAnalyticsReporter();
      let wasEphemeral = false;
      const promoted = await deps.chatStore.promoteEphemeralChat(chatId, async (chat) => {
        assertRenameAllowedFromChat(chat, options);
        wasEphemeral = chat.ephemeral === true;
        await options.assertCurrent?.(chat);
      });
      if (wasEphemeral) {
        report("floating_chat_promoted", { target: "chats" });
      }
      return chatForRenderer(promoted)!;
    },

    /** Inspect files inside a No workspace / ephemeral chat's private scratch folder. */
    async inspectAttachFiles(chatId: string): Promise<InspectAttachFilesResult> {
      const chat = await deps.chatStore.get(chatId);
      if (!chat) throw new Error(`Chat ${chatId} not found`);
      const surface = chatSurface(chat);
      if (surface !== "regular" && surface !== "ephemeral") {
        throw new Error("Only regular or temporary chats can attach to a workspace.");
      }
      const oldWorkspaceId = persistedChatWorkspaceId(chat.workspaceId);
      const oldWorkspace = await deps.configStore.getWorkspace(oldWorkspaceId);
      if (!oldWorkspace || oldWorkspace.noWorkspace !== true) {
        throw new Error("Only No workspace or temporary chats can attach to a project workspace.");
      }
      if (!oldWorkspace.folderPath) {
        return { hasFiles: false, totalBytes: 0, truncated: false, entries: [] };
      }
      // On legacy installs where multiple chats share one No workspace folder,
      // never offer to copy or discard files that belong to sibling chats.
      const siblingChats = (await deps.chatStore.list(oldWorkspaceId)).some(
        (meta) => meta.id !== chatId,
      );
      if (siblingChats) {
        return { hasFiles: false, totalBytes: 0, truncated: false, entries: [] };
      }
      return inspectScratchFolderFiles(oldWorkspace.folderPath);
    },

    /**
     * Attach a No workspace or ephemeral chat in-place to a real project
     * workspace, carrying over or trashing scratch files, recording a Pi
     * context boundary, invalidating workspace-bound caches, and releasing the
     * old hidden No workspace folder.
     */
    async attachToWorkspace(
      chatId: string,
      targetWorkspaceId: string,
      options: ChatApplicationMutationOptions & {
        fileAction?: AttachFileAction;
        owner?: ChatApplicationOwner;
      } = {},
    ): Promise<AttachToWorkspaceResult<Chat>> {
      if (!deps.chatStore.attachChatToWorkspace) {
        throw new Error("Attaching chats to a workspace is not available.");
      }
      const report = captureAnalyticsReporter();
      if (targetWorkspaceId === ASSISTANT_WORKSPACE_ID) {
        throw new Error("A chat cannot attach to the Assistant workspace.");
      }
      const finishMove = deps.llmClient.beginChatWorkspaceChange(chatId);
      if (!finishMove) {
        throw new Error("Finish or stop the current response before attaching to a workspace.");
      }
      let finishFollowThroughMove: (() => void) | undefined;
      const admissions: Array<{ release(): void; signal?: AbortSignal }> = [];
      let admissionsReleased = false;
      const releaseAdmissions = () => {
        if (admissionsReleased) return;
        admissionsReleased = true;
        for (let i = admissions.length - 1; i >= 0; i -= 1) {
          admissions[i]!.release();
        }
      };
      let rollbackCopiedFiles: (() => Promise<void>) | undefined;
      try {
        finishFollowThroughMove = await deps.followThrough?.beginMove?.(chatId);
        const current = await deps.chatStore.get(chatId);
        if (!current) throw new Error(`Chat ${chatId} not found`);
        const surface = chatSurface(current);
        if (surface !== "regular" && surface !== "ephemeral") {
          throw new Error("Only regular or temporary chats can attach to a workspace.");
        }
        const oldWorkspaceId = persistedChatWorkspaceId(current.workspaceId);
        if (oldWorkspaceId === targetWorkspaceId) {
          throw new Error("This chat is already in that workspace.");
        }
        const [oldWorkspace, targetWorkspace] = await Promise.all([
          deps.configStore.getWorkspace(oldWorkspaceId),
          deps.configStore.getWorkspace(targetWorkspaceId),
        ]);
        if (!oldWorkspace || oldWorkspace.noWorkspace !== true) {
          throw new Error(
            "Only No workspace or temporary chats can attach to a project workspace.",
          );
        }
        if (!targetWorkspace) {
          throw new Error(`Workspace ${targetWorkspaceId} not found.`);
        }
        if (targetWorkspace.noWorkspace === true) {
          throw new Error("Choose a project workspace to attach this chat to.");
        }
        if (!targetWorkspace.folderPath) {
          throw new Error("The target workspace does not have a folder on disk.");
        }
        const checkMissing = deps.workspaceFolderMissing ?? defaultWorkspaceFolderMissing;
        if (await checkMissing(targetWorkspace)) {
          throw new WorkspaceFolderMissingError(targetWorkspace);
        }
        const checkWorktree =
          deps.assertManagedWorktreeAdmission ?? defaultAssertManagedWorktreeAdmission;
        await checkWorktree(targetWorkspace);

        // Admit both workspaces in deterministic ID order so concurrent mutations cannot race.
        for (const wsId of [oldWorkspaceId, targetWorkspaceId].sort()) {
          const gate = deps.workspaceMutationGate.admit(wsId);
          admissions.push(gate);
          if (options.owner) {
            const op = admitOwnedWorkspaceOperation(
              deps.workspaceOperationRegistry,
              options.owner,
              wsId,
            );
            admissions.push(op);
          }
        }
        const assertAdmitted = () => {
          if (options.owner?.isDestroyed()) {
            throw new Error("The renderer document is no longer active.");
          }
          if (admissions.some((admission) => admission.signal?.aborted)) {
            throw new Error("A workspace changed while attaching this chat.");
          }
        };
        assertAdmitted();

        const sharedLegacyScratch = (await deps.chatStore.list(oldWorkspaceId)).some(
          (meta) => meta.id !== chatId,
        );
        assertAdmitted();
        if (sharedLegacyScratch && options.fileAction === "copy") {
          throw new Error(
            "This chat shares a legacy No workspace folder with other chats, so its files cannot be copied automatically.",
          );
        }

        if (!sharedLegacyScratch && options.fileAction === undefined && oldWorkspace.folderPath) {
          const liveScratch = await inspectScratchFolderFiles(oldWorkspace.folderPath);
          assertAdmitted();
          if (liveScratch.hasFiles) {
            throw new Error(
              "Files were found in this chat's temporary folder. Choose whether to copy them to the workspace or discard them before attaching.",
            );
          }
        }

        let copiedPaths: string[] = [];
        if (!sharedLegacyScratch && options.fileAction === "copy" && oldWorkspace.folderPath) {
          const copyTx = await copyScratchFilesToWorkspaceWithRollback(
            oldWorkspace.folderPath,
            targetWorkspace.folderPath,
          );
          copiedPaths = copyTx.copiedPaths;
          rollbackCopiedFiles = copyTx.rollback;
          assertAdmitted();
        }

        let wasEphemeral = false;
        const updated = await deps.chatStore.attachChatToWorkspace(
          chatId,
          targetWorkspaceId,
          async (chat) => {
            assertAdmitted();
            const liveSurface = chatSurface(chat);
            if (liveSurface !== "regular" && liveSurface !== "ephemeral") {
              throw new Error("Only regular or temporary chats can attach to a workspace.");
            }
            if (persistedChatWorkspaceId(chat.workspaceId) !== oldWorkspaceId) {
              throw new Error("This chat's workspace changed before attaching.");
            }
            wasEphemeral = chat.ephemeral === true;
            await options.assertCurrent?.(chat);
          },
        );
        // Commit succeeded: keep copied files from here on.
        rollbackCopiedFiles = undefined;
        if (wasEphemeral) {
          report("floating_chat_promoted", { target: "workspace" });
        }

        // Record Pi context transition boundary only if the chat already has a journal.
        if (deps.piCompactionSessionStore.recordWorkspaceAttached) {
          await deps.piCompactionSessionStore
            .recordWorkspaceAttached(chatId, {
              targetWorkspaceId,
              targetWorkspaceName: targetWorkspace.name,
              targetFolderPath: targetWorkspace.folderPath,
              copiedPaths,
            })
            .catch((error: unknown) => {
              deps.logError("chats", "Could not record workspace-attached Pi boundary.", error);
            });
        }

        // Invalidate only workspace-scoped per-chat caches, grants, hooks, ACP scratch, and old memory metadata.
        // Never call `releaseChatContext` here: that clears per-chat spending and interrupted waits.
        deps.designGrants?.revokeChat(chatId);
        deps.invalidateChatWorkspaceContext?.(chatId);
        await deps.resetChatWorkspaceSession?.(chatId).catch((error: unknown) => {
          deps.logError("chats", "Could not reset workspace session after attach.", error);
        });
        await deps.memoryStore?.deleteSourceChat(chatId).catch((error: unknown) => {
          deps.logError(
            "memory",
            "Could not clear old workspace memory index after attach.",
            error,
          );
        });

        // Release workspace operation admissions BEFORE releasing the old hidden
        // workspace, otherwise `workspaceOperationRegistry.cancelAndSettle(oldWorkspaceId)`
        // would wait on this exact operation and deadlock.
        releaseAdmissions();
        await deps.afterChatRemoved?.(oldWorkspaceId).catch((error: unknown) => {
          deps.logError(
            "workspace",
            "Could not release old No workspace folder after attach.",
            error,
          );
        });

        return {
          chat: chatForRenderer(updated)!,
          copiedPaths,
          oldWorkspaceId,
        };
      } catch (error) {
        if (rollbackCopiedFiles) {
          await rollbackCopiedFiles().catch(() => undefined);
        }
        throw error;
      } finally {
        releaseAdmissions();
        finishFollowThroughMove?.();
        finishMove();
      }
    },

    /** Startup cleanup: remove any unpromoted ephemeral chats left over from a prior run/crash. */
    async sweepOrphanedEphemeralChats(): Promise<number> {
      const all = await deps.chatStore.list();
      let swept = 0;
      for (const meta of all) {
        if (chatSurface(meta) !== "ephemeral") continue;
        try {
          await this.remove(meta.id, { rejectFeatureOwned: true });
          swept += 1;
        } catch (error) {
          deps.logError("chats", `Could not sweep orphaned temporary chat ${meta.id}.`, error);
        }
      }
      return swept;
    },

    async remove(chatId: string, options: ChatApplicationMutationOptions = {}): Promise<void> {
      if (options.rejectFeatureOwned) {
        // Refuse before the deletion window opens, so a live design run never sees
        // its chat as deleting. A chat's owner never changes, so this cannot race
        // the check below.
        const target = await deps.chatStore.get(chatId);
        if (target) assertRenameAllowedFromChat(target, options);
      }
      const finishDeletion = deps.llmClient.beginChatDeletion(chatId);
      let finishAttachmentDeletion: (() => void) | undefined;
      let releaseAdmission = false;
      let chatRemoved = false;
      let rollForwardPublished = false;
      const publishRollForward = () => {
        if (rollForwardPublished) return;
        rollForwardPublished = true;
        deps.attachments?.revokeChat(chatId);
        options.onDeletionRollForward?.();
      };
      try {
        finishAttachmentDeletion = deps.attachments?.beginChatDeletion(chatId);
        const current = await deps.chatStore.get(chatId);
        if (!current) throw new Error(`Chat ${chatId} not found`);
        assertRenameAllowedFromChat(current, options);
        await options.assertCurrent?.(current);
        await deps.llmClient.cancelChat(chatId);
        deps.visualSnapshots?.cancelChat(chatId);
        await deps.followThrough?.deleteChat(chatId).catch((error: unknown) => {
          deps.logError("follow-through", "Could not stop the chat's background jobs.", error);
        });
        try {
          await deps.subagentRunStore.deleteChat(chatId);
        } catch (error) {
          // The V1/V2 dispatcher can fail after one durable tombstone commits.
          // If its status is unreadable, conservatively retain roll-forward:
          // startup may still observe that tombstone and delete the chat.
          let deletionIsPending = true;
          try {
            deletionIsPending = (await deps.subagentRunStore.pendingChatDeletions()).includes(
              chatId,
            );
          } catch (pendingError) {
            deps.logError(
              "subagents",
              "Could not inspect a failed chat deletion's durable state.",
              pendingError,
            );
          }
          if (deletionIsPending) publishRollForward();
          deps.logError("subagents", "Could not delete private subagent history.", error);
          throw new Error("Aiden could not delete this chat's subagent history.");
        }
        publishRollForward();
        await deps.toolOutputStore?.deleteByChat(chatId);
        try {
          await deps.displayImageArtifactStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete staged image artifacts.", error);
          throw new Error("Aiden could not delete this chat's staged image artifacts.");
        }
        try {
          await deps.generativeUiArtifactStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete staged HTML artifacts.", error);
          throw new Error("Aiden could not delete this chat's staged HTML artifacts.");
        }
        try {
          await deps.piRuntimeEffectStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete private Pi effect history.", error);
          throw new Error("Aiden could not delete this chat's tool-effect history.");
        }
        try {
          await deps.piCompactionSessionStore.deleteChat(chatId);
        } catch (error) {
          deps.logError("pi", "Could not delete the private compaction journal.", error);
          throw new Error("Aiden could not delete this chat's compaction history.");
        }
        try {
          await deps.memoryStore?.deleteSourceChat(chatId);
        } catch (error) {
          deps.logError("memory", "Could not delete facts sourced from this chat.", error);
          throw new Error("Aiden could not delete this chat's sourced memory.");
        }
        try {
          await deps.chatPullRequestStore?.deleteChat(chatId);
        } catch (error) {
          deps.logError("git", "Could not delete the chat's pull request links.", error);
          throw new Error("Aiden could not delete this chat's pull request links.");
        }
        deps.designGrants?.revokeChat(chatId);
        try {
          await deps.designCanvasStore?.delete(chatId);
        } catch (error) {
          deps.logError("design", "Could not delete the chat's design canvas.", error);
          throw new Error("Aiden could not delete this chat's design canvas.");
        }
        await deps.chatStore.remove(chatId, async (chat) => {
          if (!chat) throw new Error(`Chat ${chatId} not found`);
          assertRenameAllowedFromChat(chat, options);
          await options.assertCurrent?.(chat);
        });
        chatRemoved = true;
        // The chat is gone whichever surface deleted it, so its idle cache
        // warmer stops now rather than waiting for a window to leave it.
        releaseChatCacheWarmer(chatId);
        // A canvas save or grant that passed its chat check before the remove
        // committed may have landed since the first cleanup; repeat it.
        deps.designGrants?.revokeChat(chatId);
        await deps.designCanvasStore?.delete(chatId).catch((error: unknown) => {
          deps.logError("design", "Could not delete the deleted chat's design canvas.", error);
        });
        void forgetChatInboxState(deps.inboxState, chatId, deps.logError);
        await deps.scheduledTasks?.releaseOriginChat(chatId).catch((error: unknown) => {
          // A run finds the chat gone and falls back anyway; this keeps the editor truthful.
          deps.logError(
            "schedule",
            "Could not move the deleted chat's scheduled tasks to their own chats.",
            error,
          );
        });
        await deps.subagentRunStore.completeChatDeletion(chatId);
        releaseAdmission = true;
        // Scratch cleanup is best effort and must not delay the delete reply.
        void deps
          .forgetDeletedChat?.(chatId)
          .catch((error: unknown) =>
            deps.logError(
              "chats",
              "Could not remove the deleted chat's agent scratch folder.",
              error,
            ),
          );
        await deps
          .afterChatRemoved?.(persistedChatWorkspaceId(current.workspaceId))
          .catch((error: unknown) => {
            deps.logError("workspace", "Could not release the deleted chat's folder.", error);
          });
      } finally {
        if (!releaseAdmission) {
          try {
            releaseAdmission = !(await deps.subagentRunStore.pendingChatDeletions()).includes(
              chatId,
            );
          } catch (error) {
            deps.logError("subagents", "Could not inspect pending chat deletion state.", error);
          }
        }
        const settlement = chatDeletionSettlement(releaseAdmission, chatRemoved);
        // A delete that rolled back keeps the chat, so it keeps its context
        // (interrupted waits, Unavailable prompts, spending) too.
        if (settlement === "rolled_back") deps.followThrough?.restoreChat?.(chatId);
        else deps.releaseChatContext?.(chatId);
        if (settlement !== "roll_forward_pending") {
          finishAttachmentDeletion?.();
          finishDeletion();
        }
      }
    },
  };
}
