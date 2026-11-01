// New worktree for a phone's first message (contract revision 49).
//
// A phone has no branch menu, so the worktree starts where a desktop draft's
// would by default (`resolveWorktreeDefaults`) and is named from the message.
// It goes through the desktop's first-message coordinator with a key per
// chat, so a retry finds the worktree an earlier attempt made instead of
// making another. Every refusal is a fixed sentence: Remote errors never
// carry a path or Git's own output.

import {
  resolveWorktreeDefaults,
  type FirstMessageWorktreeInfo,
  type FirstMessageWorktreeRequest,
} from "../../renderer/shared/worktree-on-send.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  FirstMessageWorktreeError,
  FirstMessageWorktreeSettingsChangedError,
  type FirstMessageWorktreeRecord,
} from "./first-message-worktree.js";
import { InsufficientDiskSpaceError, WorktreeCapacityUnavailableError } from "./managed-worktree-capacity.js";
import type { GitBranches, Workspace } from "./types.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";

export interface AidenRemoteNewWorktreeDependencies {
  getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  branches(folderPath: string): Promise<GitBranches>;
  ensure(
    request: FirstMessageWorktreeRequest,
    seed: string,
    owner: WorkspaceOperationDocumentOwner,
  ): Promise<FirstMessageWorktreeInfo>;
  owner(deviceId: string): WorkspaceOperationDocumentOwner;
  /** The coordinator's record for a key. */
  record(key: string): Promise<FirstMessageWorktreeRecord | undefined>;
}

/** The coordinator key for a phone chat's worktree; one worktree per chat. */
export function phoneChatWorktreeKey(chatId: string): string {
  return `phone-chat:${chatId}`;
}

function refusal(message: string, code: "git_capability_denied" | "workspace_unavailable" = "git_capability_denied") {
  return new AidenRemoteServiceError(code, message, 409);
}

function remoteFailure(error: unknown, baseRef: string): AidenRemoteServiceError {
  const cause = error instanceof FirstMessageWorktreeError ? error.cause : error;
  if (cause instanceof InsufficientDiskSpaceError) {
    return refusal("There isn't enough free disk space on your Mac for a new worktree. Free some space, then try again.");
  }
  if (cause instanceof WorktreeCapacityUnavailableError) {
    return refusal("Your Mac couldn't check its free disk space for a new worktree. Check its storage, then try again.");
  }
  if (error instanceof FirstMessageWorktreeError && error.phase === "fetching") {
    return refusal(`Aiden couldn't fetch ${baseRef} from its remote on your Mac. Check the Mac's network, then try again.`);
  }
  return refusal("Aiden couldn't make the worktree on your Mac. Try again, or send without New worktree.");
}

export function createAidenRemoteNewWorktrees(dependencies: AidenRemoteNewWorktreeDependencies) {
  return {
    /**
     * The branch of the worktree an earlier New worktree made for this chat,
     * when the chat's workspace is that worktree: the coordinator's record
     * names it and the saved workspace carries the same branch and ownership
     * token. A record still `pending` counts once its workspace was saved (the
     * last ledger write can fail after the save). Any other worktree, even a
     * managed one, is not this chat's setup.
     */
    async worktreeBranch(chatId: string, workspaceId: string): Promise<string | undefined> {
      const record = await dependencies.record(phoneChatWorktreeKey(chatId));
      if (!record || record.state === "failed" || record.workspaceId !== workspaceId) return undefined;
      const managed = (await dependencies.getWorkspace(workspaceId))?.managedWorktree;
      return managed && managed.branch === record.branch && managed.ownershipToken === record.ownershipToken
        ? managed.branch
        : undefined;
    },
    async create(
      deviceId: string,
      sourceWorkspaceId: string,
      text: string,
      chatId: string,
    ): Promise<{ workspaceId: string; branch: string }> {
      const workspace = await dependencies.getWorkspace(sourceWorkspaceId);
      if (!workspace?.folderPath || workspace.scratch) {
        throw refusal("This chat's workspace has no folder, so it can't have a worktree.", "workspace_unavailable");
      }
      if (workspace.permission === "none") {
        throw refusal("This workspace has no folder access, so Aiden can't make a worktree in it.", "workspace_unavailable");
      }
      if (workspace.managedWorktree) {
        throw refusal("This chat is already in a worktree.");
      }
      let branches: GitBranches;
      try {
        branches = await dependencies.branches(workspace.folderPath);
      } catch {
        throw refusal("Aiden couldn't read this workspace's Git branches on your Mac. Try again.");
      }
      if (!branches.isRepo) throw refusal("This workspace isn't a Git repository, so it can't have a worktree.");
      const base = resolveWorktreeDefaults(branches);
      if (!base) throw refusal("This repository has no commits yet, so it can't have a worktree.");
      const owner = dependencies.owner(deviceId);
      const request: FirstMessageWorktreeRequest = {
        sourceWorkspaceId,
        baseRef: base.baseRef,
        fromOrigin: base.fromOrigin,
        idempotencyKey: phoneChatWorktreeKey(chatId),
      };
      let info: FirstMessageWorktreeInfo;
      try {
        info = await dependencies.ensure(request, text, owner);
      } catch (error) {
        if (!(error instanceof FirstMessageWorktreeSettingsChangedError)) throw remoteFailure(error, base.baseRef);
        // The repository's default moved since an earlier attempt made this
        // chat's worktree: use that worktree rather than make a second one.
        const earlier = error.worktree;
        try {
          info = await dependencies.ensure(
            {
              ...request,
              baseRef: earlier.baseRef,
              fromOrigin: earlier.fromOrigin,
              ...(earlier.requestedBranchName === undefined ? {} : { branchName: earlier.requestedBranchName }),
            },
            text,
            owner,
          );
        } catch (retryError) {
          throw remoteFailure(retryError, earlier.baseRef);
        }
      }
      return { workspaceId: info.workspaceId, branch: info.branch };
    },
  };
}
