// Reads the signals behind `composerContextChips`: Git status from the
// workspace's existing poll, the repository identity (a local read, no
// network) and the chat's PR links, current PR and pending creates (the same
// queries the PR chip reads). They run only for a started chat in a readable
// repository with a remote, the only case the PR chip can appear.

import { useAutoHideComposerContext } from "./composer-context-bar";
import {
  useChatCurrentPullRequest,
  useChatPullRequestPending,
  useChatPullRequests,
  useWorkspaceRepositoryIdentity,
} from "../lib/queries";
import {
  branchCanOpenPullRequest,
  composerContextChips,
  isWellKnownGitHubRepository,
  type ComposerContextChips,
} from "../lib/composer-context-chips";
import type { GitInfo, Workspace } from "../lib/types";

export function useComposerContextChips({
  chatId,
  started,
  workspace,
  gitBranch,
  gitStatus,
  machinePicker,
}: {
  chatId: string;
  started: boolean;
  workspace?: Workspace;
  gitBranch?: string;
  gitStatus?: GitInfo;
  machinePicker: boolean;
}): ComposerContextChips {
  const autoHide = useAutoHideComposerContext();
  const hasFolder = Boolean(workspace?.folderPath);
  const accessOff = workspace?.permission === "none";
  const gitRepo = Boolean(gitBranch);
  const remoteReadable = started && gitRepo && hasFolder && !accessOff && gitStatus?.hasRemote === true;
  const identity = useWorkspaceRepositoryIdentity(workspace?.id, remoteReadable);
  const links = useChatPullRequests(chatId, remoteReadable);
  const current = useChatCurrentPullRequest(chatId, remoteReadable);
  const pending = useChatPullRequestPending(chatId, remoteReadable);
  const linked = links.data?.links.length ?? 0;
  const pendingCount = pending.data?.length ?? 0;
  const hasCurrent = Boolean(current.data?.pullRequest);
  // GitHub Enterprise Server hosts are only known from the chat's own PR state.
  const githubRemote =
    isWellKnownGitHubRepository(identity.data?.canonicalKey) || linked > 0 || pendingCount > 0 || hasCurrent;
  return composerContextChips({
    stage: started ? "started" : "draft",
    autoHide,
    hasFolder,
    accessOff,
    gitRepo,
    uncommitted: gitStatus?.uncommitted ?? 0,
    machinePicker,
    githubRemote,
    pullRequest: {
      linked,
      pending: pendingCount,
      current: hasCurrent,
      branchCanOpen: branchCanOpenPullRequest(gitStatus),
    },
  });
}
