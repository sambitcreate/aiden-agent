import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMeta, Workspace, WorkspacePermission } from "./types.js";
import {
  DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
  DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
  type DesignHandoffLinkResult,
  type DesignHandoffJournalRecordV1,
  type DesignHandoffPacketV1,
  type DesignHandoffTarget,
  type DesignHandoffTargetPreview,
  type DesignHandoffWorkspaceResult,
  designHandoffTargetPreviewDigest,
  parseDesignHandoffPacket,
  parseDesignHandoffTarget,
} from "./design-handoff-contract.js";
import {
  createDesignHandoffCoordinator,
  type BeginDesignHandoffInput,
  type DesignHandoffCoordinator,
  type DesignHandoffEffectPorts,
  type DesignHandoffRunResult,
} from "./design-handoff-coordinator.js";
import {
  DesignHandoffEffectStore,
  type DesignHandoffEffectIdentityV1,
  type DesignHandoffEffectRecordV1,
} from "./design-handoff-effect-store.js";
import type { DesignHandoffJournalPort } from "./design-handoff-journal-store.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";

interface HandoffChatOwner extends WorkspaceOperationDocumentOwner {
  documentId: string;
}

interface ResolvedHandoffChat {
  id: string;
  title: string;
  workspaceId?: string;
  botId?: string;
}

export interface DesignHandoffGitSnapshot {
  isRepo: boolean;
  branch?: string;
  committedHead?: string;
  dirty: boolean;
}

export interface ManagedDesignHandoffTargetPreview {
  kind: "managed-worktree";
  source: DesignHandoffTargetPreview;
  previewDigest: string;
  expectedCommittedHead: string;
  dirtyCheckout: boolean;
  requiredDirtyCheckoutAcknowledgement: typeof DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT | null;
}

export interface ExistingDesignHandoffTargetPreview {
  kind: "existing-workspace";
  target: DesignHandoffTargetPreview;
  previewDigest: string;
  requiredStrongWarningAcknowledgement: typeof DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT;
}

export interface DesignHandoffRecoveryView {
  operationId: string;
  stage: DesignHandoffJournalRecordV1["stage"];
  targetKind: DesignHandoffTarget["kind"];
  workspaceLabel: string;
  branchLabel: string;
  recoveryReason?: string;
  updatedAt: number;
  canResume: boolean;
  canCancel: boolean;
  linkage?: DesignHandoffLinkResult;
}

function recoveryView(record: DesignHandoffJournalRecordV1): DesignHandoffRecoveryView {
  const target = record.target.kind === "managed-worktree" ? record.target.source : record.target.target;
  const active =
    record.stage !== "recoverable" &&
    record.stage !== "rolling-back" &&
    !record.cancellationRequested;
  return {
    operationId: record.operationId,
    stage: record.stage,
    targetKind: record.target.kind,
    workspaceLabel: record.workspace?.workspaceLabel ?? target.workspaceLabel,
    branchLabel: record.workspace?.branchLabel ?? target.branchLabel,
    ...(record.recoveryReason ? { recoveryReason: record.recoveryReason } : {}),
    updatedAt: record.updatedAt,
    canResume: active,
    canCancel: active,
    ...(record.linkage ? { linkage: record.linkage } : {}),
  };
}

export interface DesignHandoffApplicationDependencies {
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(workspaceId: string): Promise<Workspace | null | undefined>;
  resolveWorkspace?(workspaceId: string): Promise<{
    workspace: Workspace;
    folderPath: string;
  }>;
  inspectGit(folderPath: string): Promise<DesignHandoffGitSnapshot>;
  createManagedWorkspace(
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    branch: string,
    name: string,
  ): Promise<Workspace>;
  setWorkspacePermission(
    workspaceId: string,
    permission: WorkspacePermission,
    assertCurrent: (workspace: Workspace) => void,
  ): Promise<Workspace>;
  removeManagedWorkspace(
    owner: WorkspaceOperationDocumentOwner,
    workspaceId: string,
    validateWorkspace: (workspace: Workspace) => void,
  ): Promise<void>;
  listChats(workspaceId: string): Promise<ChatMeta[]>;
  getChat(chatId: string): Promise<ResolvedHandoffChat | null>;
  createChat(
    input: { workspaceId: string; title: string },
    owner: HandoffChatOwner,
  ): Promise<ResolvedHandoffChat>;
  removeChat(chatId: string, assertCurrent: (chat: ResolvedHandoffChat) => void): Promise<void>;
  verifyPacket(packet: DesignHandoffPacketV1): Promise<void>;
  logError(area: string, message: string, error: unknown): void;
}

function operationDigest(operationId: string): string {
  return createHash("sha256").update(`aiden-design-handoff-v1\0${operationId}`).digest("hex");
}

function branchFor(operationId: string): string {
  return `feature/design-handoff-${operationDigest(operationId).slice(0, 20)}`;
}

function chatTitleFor(operationId: string): string {
  return `Design handoff · ${operationDigest(operationId).slice(0, 20)}`;
}

function durableOwner(operationId: string): HandoffChatOwner {
  return {
    documentId: `design-handoff:${operationDigest(operationId)}`,
    isDestroyed: () => false,
    onInvalidated: () => () => undefined,
  };
}

function safeLabel(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").normalize("NFKC").trim();
  const bounded = [...normalized].slice(0, 160).join("");
  if (
    !bounded ||
    [...bounded].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return fallback;
  if (/(?:^|\s)(?:\/\S+|~\/\S+|[A-Za-z]:\\\S*)/u.test(bounded) || /file:\/\//iu.test(bounded)) {
    return fallback;
  }
  return bounded;
}

function requireWorkspaceFolder(workspace: Workspace): string {
  if (!workspace.folderPath || workspace.permission === "none") {
    throw new Error("Authorize a local workspace before continuing this Design Project.");
  }
  return workspace.folderPath;
}

function targetPreview(
  workspace: Workspace,
  folderPath: string,
  git: DesignHandoffGitSnapshot,
): DesignHandoffTargetPreview {
  if (!git.isRepo || !git.branch)
    throw new Error("Continue in workspace requires a local Git branch.");
  return {
    workspaceId: workspace.id,
    workspaceLabel: safeLabel(workspace.name, "Workspace"),
    repositoryLabel: safeLabel(path.basename(folderPath), "Repository"),
    branchLabel: safeLabel(git.branch, "Current branch"),
  };
}

function effectIdentity(
  operationId: string,
  target: DesignHandoffTarget,
): DesignHandoffEffectIdentityV1 {
  return target.kind === "managed-worktree"
    ? {
        operationId,
        targetKind: target.kind,
        targetPreviewDigest: target.previewDigest,
        sourceWorkspaceId: target.source.workspaceId,
        branchIntent: branchFor(operationId),
      }
    : {
        operationId,
        targetKind: target.kind,
        targetPreviewDigest: target.previewDigest,
        sourceWorkspaceId: target.target.workspaceId,
      };
}

function workspaceResult(
  workspace: Workspace,
  managedByHandoff: boolean,
): DesignHandoffWorkspaceResult {
  const branch = managedByHandoff ? workspace.managedWorktree?.branch : undefined;
  if (managedByHandoff && (!workspace.managedWorktree || !branch)) {
    throw new Error("Aiden could not verify the managed handoff worktree.");
  }
  return {
    workspaceId: workspace.id,
    workspaceLabel: safeLabel(workspace.name, "Design handoff"),
    branchLabel: safeLabel(branch, "Design handoff branch"),
    managed: managedByHandoff,
    ...(managedByHandoff ? { createdFromHead: workspace.managedWorktree!.createdFromHead } : {}),
  };
}

function exactManagedWorkspace(
  workspace: Workspace,
  branch: string,
  createdFromHead: string,
): boolean {
  return (
    workspace.managedWorktree?.branch === branch &&
    workspace.managedWorktree.createdFromHead === createdFromHead
  );
}

function assertExactChat(chat: ResolvedHandoffChat, workspaceId: string): void {
  if (chat.botId || chat.workspaceId !== workspaceId) {
    throw new Error("The handoff workspace chat identity changed.");
  }
}

export function createDesignHandoffApplicationService(options: {
  journal: DesignHandoffJournalPort;
  effects: DesignHandoffEffectStore;
  dependencies: DesignHandoffApplicationDependencies;
  now?: () => number;
}) {
  const { dependencies, effects } = options;

  const inspectWorkspace = async (
    workspaceId: string,
  ): Promise<{
    workspace: Workspace;
    git: DesignHandoffGitSnapshot;
    preview: DesignHandoffTargetPreview;
  }> => {
    const resolved = dependencies.resolveWorkspace
      ? await dependencies.resolveWorkspace(workspaceId)
      : await (async () => {
          const workspace = await dependencies.getWorkspace(workspaceId);
          if (!workspace) throw new Error("The selected workspace is no longer available.");
          return { workspace, folderPath: requireWorkspaceFolder(workspace) };
        })();
    const git = await dependencies.inspectGit(resolved.folderPath);
    return {
      workspace: resolved.workspace,
      git,
      preview: targetPreview(resolved.workspace, resolved.folderPath, git),
    };
  };

  const findManagedWorkspace = async (
    branch: string,
    expectedHead: string,
  ): Promise<Workspace | null> => {
    const matches = (await dependencies.listWorkspaces()).filter((workspace) =>
      exactManagedWorkspace(workspace, branch, expectedHead),
    );
    if (matches.length > 1)
      throw new Error("The handoff operation resolved to multiple managed workspaces.");
    return matches[0] ?? null;
  };

  const findHandoffChat = async (
    workspaceId: string,
    title: string,
  ): Promise<ResolvedHandoffChat | null> => {
    const candidates = (await dependencies.listChats(workspaceId)).filter(
      (chat) => chat.title === title && !chat.botId,
    );
    if (candidates.length > 1)
      throw new Error("The handoff operation resolved to multiple workspace chats.");
    if (!candidates[0]) return null;
    const chat = await dependencies.getChat(candidates[0].id);
    if (!chat) throw new Error("The handoff chat index needs recovery before continuing.");
    return chat;
  };

  const ports: DesignHandoffEffectPorts = {
    async verifyTarget(target) {
      const parsed = parseDesignHandoffTarget(target);
      const workspaceId =
        parsed.kind === "managed-worktree" ? parsed.source.workspaceId : parsed.target.workspaceId;
      const current = await inspectWorkspace(workspaceId);
      if (parsed.kind === "managed-worktree") {
        if (!current.git.committedHead)
          throw new Error("The selected repository has no committed HEAD.");
        return parseDesignHandoffTarget({
          kind: parsed.kind,
          source: current.preview,
          previewDigest: designHandoffTargetPreviewDigest(current.preview),
          expectedCommittedHead: current.git.committedHead,
          dirtyCheckout: current.git.dirty,
          ...(current.git.dirty
            ? { dirtyCheckoutAcknowledgement: parsed.dirtyCheckoutAcknowledgement }
            : {}),
        });
      }
      return parseDesignHandoffTarget({
        kind: parsed.kind,
        target: current.preview,
        previewDigest: designHandoffTargetPreviewDigest(current.preview),
        strongWarningAcknowledgement: parsed.strongWarningAcknowledgement,
      });
    },

    async prepareWorkspace(operationId, target) {
      let state = await effects.ensure(effectIdentity(operationId, target));
      if (state.workspaceRolledBack)
        throw new Error("The handoff workspace was already rolled back.");
      if (state.workspace) {
        const current = await dependencies.getWorkspace(state.workspace.workspaceId);
        if (!current) throw new Error("The recorded handoff workspace is unavailable.");
        if (target.kind === "managed-worktree") {
          if (!exactManagedWorkspace(current, state.branchIntent!, target.expectedCommittedHead)) {
            throw new Error("The recorded managed handoff workspace changed.");
          }
        } else {
          const inspected = await inspectWorkspace(target.target.workspaceId);
          if (
            current.id !== target.target.workspaceId ||
            designHandoffTargetPreviewDigest(inspected.preview) !== target.previewDigest
          ) {
            throw new Error("The recorded existing handoff workspace changed.");
          }
        }
        return state.workspace;
      }

      if (target.kind === "existing-workspace") {
        const inspected = await inspectWorkspace(target.target.workspaceId);
        if (designHandoffTargetPreviewDigest(inspected.preview) !== target.previewDigest) {
          throw new Error("The selected workspace changed after confirmation.");
        }
        const current = inspected.workspace;
        const result: DesignHandoffWorkspaceResult = {
          workspaceId: current.id,
          workspaceLabel: target.target.workspaceLabel,
          branchLabel: target.target.branchLabel,
          managed: false,
        };
        await effects.recordWorkspace(operationId, result);
        return result;
      }

      const branch = state.branchIntent!;
      let workspace = await findManagedWorkspace(branch, target.expectedCommittedHead);
      if (!workspace) {
        state = await effects.markWorkspaceAttempted(operationId);
        workspace = await dependencies.createManagedWorkspace(
          durableOwner(operationId),
          target.source.workspaceId,
          branch,
          `Design handoff · ${operationDigest(operationId).slice(0, 20)}`,
        );
      }
      if (!exactManagedWorkspace(workspace, branch, target.expectedCommittedHead)) {
        if (workspace.managedWorktree?.branch === branch) {
          await effects.recordWorkspace(operationId, workspaceResult(workspace, true));
        }
        throw new Error(
          "The managed handoff worktree was not created from the confirmed committed HEAD.",
        );
      }
      if (workspace.permission !== "ask") {
        const workspaceId = workspace.id;
        workspace = await dependencies.setWorkspacePermission(workspace.id, "ask", (current) => {
          if (!exactManagedWorkspace(current, branch, target.expectedCommittedHead)) {
            throw new Error(
              "The managed handoff workspace changed before approval mode was installed.",
            );
          }
          if (current.id !== workspaceId)
            throw new Error("The managed handoff workspace identity changed.");
        });
      }
      const result = workspaceResult(workspace, true);
      await effects.recordWorkspace(operationId, result);
      return result;
    },

    async createChat(operationId, workspace) {
      const state = await effects.get(operationId);
      if (!state?.workspace || state.workspace.workspaceId !== workspace.workspaceId) {
        throw new Error("The handoff workspace effect is not installed.");
      }
      if (state.chatRolledBack) throw new Error("The handoff chat was already rolled back.");
      if (state.chat) {
        const current = await dependencies.getChat(state.chat.chatId);
        if (!current) throw new Error("The recorded handoff workspace chat is unavailable.");
        assertExactChat(current, workspace.workspaceId);
        return state.chat;
      }
      const title = chatTitleFor(operationId);
      await effects.setChatIntent(operationId, title);
      const discovered = await findHandoffChat(workspace.workspaceId, title);
      const chat =
        discovered ??
        (await dependencies.createChat(
          { workspaceId: workspace.workspaceId, title },
          durableOwner(operationId),
        ));
      assertExactChat(chat, workspace.workspaceId);
      const result = { chatId: chat.id, taskId: chat.id };
      await effects.recordChat(operationId, result);
      return result;
    },

    async installUntrustedContext(operationId, workspace, chat, packet) {
      const parsed = parseDesignHandoffPacket(packet);
      const state = await effects.get(operationId);
      if (
        !state?.chat ||
        state.chat.chatId !== chat.chatId ||
        state.workspace?.workspaceId !== workspace.workspaceId
      ) {
        throw new Error("The handoff chat effect is not installed.");
      }
      await dependencies.verifyPacket(parsed);
      await effects.installContext(operationId, parsed);
    },

    async publishProjectLink(operationId, packet, workspace, chat) {
      const state = await effects.get(operationId);
      if (!state?.context || JSON.stringify(state.context) !== JSON.stringify(packet)) {
        throw new Error("The handoff context is not installed.");
      }
      await dependencies.verifyPacket(packet);
      const linkage: DesignHandoffLinkResult = {
        projectId: packet.projectId,
        workspaceId: workspace.workspaceId,
        chatId: chat.chatId,
        taskId: chat.taskId,
        branchLabel: workspace.branchLabel,
      };
      return (await effects.publish(operationId, linkage)).linkage!;
    },

    async inspectPublication(operationId) {
      return (await effects.get(operationId))?.linkage ?? null;
    },

    async rollbackContext(operationId) {
      const state = await effects.get(operationId);
      if (!state || state.contextRolledBack) return { proven: true };
      if (state.linkage) return { proven: false };
      await effects.rollbackContext(operationId);
      return { proven: (await effects.get(operationId))?.context === undefined };
    },

    async rollbackChat(operationId) {
      let state = await effects.get(operationId);
      if (!state || state.chatRolledBack) return { proven: true };
      if (state.linkage) return { proven: false };
      let chat = state.chat ? await dependencies.getChat(state.chat.chatId) : null;
      if (!chat && !state.chat && state.chatTitle && state.workspace) {
        chat = await findHandoffChat(state.workspace.workspaceId, state.chatTitle);
        if (chat) {
          await effects.recordChat(operationId, { chatId: chat.id, taskId: chat.id });
          state = (await effects.get(operationId))!;
        }
      }
      if (!chat) {
        if (state.chatAttempted && !state.chat) return { proven: false };
        await effects.rollbackChat(operationId);
        return { proven: true };
      }
      assertExactChat(chat, state.workspace!.workspaceId);
      const expectedChatId = chat.id;
      const expectedWorkspaceId = state.workspace!.workspaceId;
      await dependencies.removeChat(expectedChatId, (current) => {
        if (current.id !== expectedChatId) throw new Error("The handoff chat identity changed.");
        assertExactChat(current, expectedWorkspaceId);
      });
      if (await dependencies.getChat(expectedChatId)) return { proven: false };
      await effects.rollbackChat(operationId);
      return { proven: true };
    },

    async rollbackWorkspace(operationId) {
      let state = await effects.get(operationId);
      if (!state || state.workspaceRolledBack) return { proven: true };
      if (state.linkage) return { proven: false };
      if (state.targetKind === "existing-workspace") {
        await effects.rollbackWorkspace(operationId);
        return { proven: true };
      }
      let workspace = state.workspace
        ? await dependencies.getWorkspace(state.workspace.workspaceId)
        : null;
      if (!workspace && !state.workspace && state.branchIntent) {
        const matches = (await dependencies.listWorkspaces()).filter(
          (candidate) => candidate.managedWorktree?.branch === state!.branchIntent,
        );
        if (matches.length > 1) return { proven: false };
        workspace = matches[0] ?? null;
        if (workspace?.managedWorktree) {
          await effects.recordWorkspace(operationId, workspaceResult(workspace, true));
          state = (await effects.get(operationId))!;
        }
      }
      if (!workspace) {
        if (state.workspaceAttempted && !state.workspace) return { proven: false };
        await effects.rollbackWorkspace(operationId);
        return { proven: true };
      }
      if (!workspace.managedWorktree || workspace.managedWorktree.branch !== state.branchIntent) {
        return { proven: false };
      }
      const expectedWorkspaceId = workspace.id;
      const expectedBranch = workspace.managedWorktree.branch;
      const expectedHead = workspace.managedWorktree.createdFromHead;
      await dependencies.removeManagedWorkspace(
        durableOwner(operationId),
        expectedWorkspaceId,
        (current) => {
          if (
            current.id !== expectedWorkspaceId ||
            !exactManagedWorkspace(current, expectedBranch, expectedHead)
          ) {
            throw new Error("The managed handoff workspace identity changed.");
          }
        },
      );
      if (await dependencies.getWorkspace(expectedWorkspaceId)) return { proven: false };
      await effects.rollbackWorkspace(operationId);
      return { proven: true };
    },
  };

  const coordinator: DesignHandoffCoordinator = createDesignHandoffCoordinator({
    journal: options.journal,
    effects: ports,
    now: options.now,
  });

  return {
    async initialize(): Promise<void> {
      await effects.initialize();
    },

    async previewManagedTarget(workspaceId: string): Promise<ManagedDesignHandoffTargetPreview> {
      const { git, preview } = await inspectWorkspace(workspaceId);
      if (!git.committedHead)
        throw new Error(
          "Create the repository's first commit before continuing in a managed worktree.",
        );
      return {
        kind: "managed-worktree",
        source: preview,
        previewDigest: designHandoffTargetPreviewDigest(preview),
        expectedCommittedHead: git.committedHead,
        dirtyCheckout: git.dirty,
        requiredDirtyCheckoutAcknowledgement: git.dirty
          ? DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT
          : null,
      };
    },

    async previewExistingTarget(workspaceId: string): Promise<ExistingDesignHandoffTargetPreview> {
      const { preview } = await inspectWorkspace(workspaceId);
      return {
        kind: "existing-workspace",
        target: preview,
        previewDigest: designHandoffTargetPreviewDigest(preview),
        requiredStrongWarningAcknowledgement: DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
      };
    },

    begin(input: BeginDesignHandoffInput): Promise<DesignHandoffRunResult> {
      return coordinator.begin({
        operationId: input.operationId,
        packet: parseDesignHandoffPacket(input.packet),
        target: parseDesignHandoffTarget(input.target),
      });
    },

    cancel(operationId: string): Promise<DesignHandoffRunResult> {
      return coordinator.cancel(operationId);
    },

    resume(operationId: string): Promise<DesignHandoffRunResult> {
      return coordinator.resume(operationId);
    },

    async reconcileAtStartup(): Promise<{
      results: DesignHandoffRunResult[];
      failures: Array<{ operationId: string; message: string }>;
    }> {
      const results: DesignHandoffRunResult[] = [];
      const failures: Array<{ operationId: string; message: string }> = [];
      for (const record of await options.journal.listRecoverable()) {
        try {
          results.push(await coordinator.resume(record.operationId));
        } catch (error) {
          dependencies.logError(
            "design-handoff",
            "Could not reconcile a design handoff operation.",
            error,
          );
          failures.push({
            operationId: record.operationId,
            message: "This Design handoff needs attention before it can continue.",
          });
        }
      }
      return { results, failures };
    },

    contextForChat(chatId: string): Promise<DesignHandoffPacketV1 | null> {
      return effects.contextForChat(chatId);
    },

    linksForProject(projectId: string): Promise<DesignHandoffLinkResult[]> {
      return effects.linksForProject(projectId);
    },

    async recoveriesForProject(projectId: string): Promise<DesignHandoffRecoveryView[]> {
      return (await options.journal.listRecoverable())
        .filter((record) => record.packet.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 8)
        .map(recoveryView);
    },

    getEffect(operationId: string): Promise<DesignHandoffEffectRecordV1 | null> {
      return effects.get(operationId);
    },

    createOperationId(): string {
      return `handoff:${randomUUID()}`;
    },
  };
}

export type DesignHandoffApplicationService = ReturnType<
  typeof createDesignHandoffApplicationService
>;
