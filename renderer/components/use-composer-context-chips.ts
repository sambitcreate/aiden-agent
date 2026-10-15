// Reads the signals behind `composerContextChips`: Git status from the
// workspace's existing poll, the repository identity (a local read, no
// network) and the chat's PR links, current PR and pending creates (the same
// queries the PR chip reads). They run only for a started chat in a readable
// repository with a remote, the only case the PR chip can appear.

import * as React from "react";
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
  remoteCanHostPullRequests,
  type ComposerContextChips,
} from "../lib/composer-context-chips";
import { chatPullRequestChipLabels } from "../lib/chat-pull-request-chip";
import type { GitInfo, Workspace } from "../lib/types";

export interface ComposerContextChipsState {
  chips: ComposerContextChips;
  /**
   * A polite notice naming the PR chip, set only when it appears after this
   * chat's PR state had already loaded (not when a qualifying chat opens).
   */
  pullRequestAnnouncement: string;
}

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
}): ComposerContextChipsState {
  const autoHide = useAutoHideComposerContext();
  const hasFolder = Boolean(workspace?.folderPath);
  const accessOff = workspace?.permission === "none";
  const gitRepo = Boolean(gitBranch);
  const remoteReadable = started && gitRepo && hasFolder && !accessOff && gitStatus?.hasRemote === true;
  const identity = useWorkspaceRepositoryIdentity(workspace?.id, remoteReadable);
  const links = useChatPullRequests(chatId, remoteReadable);
  const current = useChatCurrentPullRequest(chatId, remoteReadable);
  const pending = useChatPullRequestPending(chatId, remoteReadable);
  const views = links.data?.links ?? [];
  const linked = views.length;
  const pendingCount = pending.data?.length ?? 0;
  const currentView = current.data?.pullRequest;
  // A failed identity read leaves the host unknown, which still qualifies;
  // only wait for it so a known non-GitHub forge never flashes the chip.
  const pullRequestRemote =
    remoteReadable && !identity.isPending && remoteCanHostPullRequests(identity.data?.canonicalKey);
  const chips = composerContextChips({
    stage: started ? "started" : "draft",
    autoHide,
    hasFolder,
    accessOff,
    gitRepo,
    uncommitted: gitStatus?.uncommitted ?? 0,
    machinePicker,
    pullRequestRemote,
    pullRequest: {
      linked,
      pending: pendingCount,
      current: Boolean(currentView),
      branchCanOpen: branchCanOpenPullRequest(gitStatus),
    },
  });
  const pullRequestSettled =
    !remoteReadable || (!identity.isPending && !links.isPending && !current.isPending && !pending.isPending);
  const pullRequestLabel = currentView
    ? `Pull request #${currentView.number}`
    : chatPullRequestChipLabels({
        linked,
        open: views.filter((view) => view.state === "open").length,
        pending: pendingCount,
      }).text;
  // Previous-render tracking, updated during render (no effect round trip).
  const [seen, setSeen] = React.useState({
    chatId,
    visible: chips.pullRequest,
    settled: pullRequestSettled,
    announcement: "",
  });
  if (seen.chatId !== chatId || seen.visible !== chips.pullRequest || seen.settled !== pullRequestSettled) {
    const appeared = seen.chatId === chatId && seen.settled && !seen.visible && chips.pullRequest;
    setSeen({
      chatId,
      visible: chips.pullRequest,
      settled: pullRequestSettled,
      announcement: appeared
        ? `${pullRequestLabel} available`
        : chips.pullRequest && seen.chatId === chatId
          ? seen.announcement
          : "",
    });
  }
  return { chips, pullRequestAnnouncement: seen.announcement };
}
