import * as React from "react";
import type { ApprovalPrompt } from "../../lib/ipc";
import {
  liveChatApprovals,
  liveChatVoiceApprovals,
  liveVoiceApprovalsEnabled,
  type LiveApprovalVoiceHint,
  type LiveChatApprovalDecide,
  type LiveChatApprovalsStore,
  type LiveChatVoiceApprovals,
} from "../../lib/live-chat-approvals";
import type { AidenLiveSettingsFields } from "../../shared/aiden-live-settings";

/** Mounted once for the window: runs voice approvals while settings allow it. */
export function useLiveChatVoiceApprovals(
  settings: AidenLiveSettingsFields | null | undefined,
  controller: LiveChatVoiceApprovals = liveChatVoiceApprovals,
): void {
  const enabled = liveVoiceApprovalsEnabled(settings);
  React.useEffect(() => controller.start(), [controller]);
  React.useEffect(() => controller.setEnabled(enabled), [controller, enabled]);
}

/**
 * The chat pane publishes the approvals its card shows and its own decide
 * function. Approvals still in state from the previous chat (the first render
 * after a chat switch, before the pane resets them) are never published under
 * the new chat.
 */
export function usePublishLiveChatApprovals(
  chatId: string,
  approvals: readonly ApprovalPrompt[],
  decide: LiveChatApprovalDecide,
  store: LiveChatApprovalsStore = liveChatApprovals,
): void {
  const owner = React.useMemo(() => Symbol("chat-approvals"), []);
  const decideRef = React.useRef(decide);
  decideRef.current = decide;
  const stableDecide = React.useCallback<LiveChatApprovalDecide>(
    (prompt, decision) => decideRef.current(prompt, decision),
    [],
  );
  const lastPublished = React.useRef<{ chatId: string; approvals: readonly ApprovalPrompt[] } | null>(null);
  React.useEffect(() => {
    const last = lastPublished.current;
    const carriedOver = last !== null && last.chatId !== chatId && last.approvals === approvals;
    lastPublished.current = { chatId, approvals };
    store.publish(owner, { chatId, approvals: carriedOver ? [] : approvals, decide: stableDecide });
  }, [approvals, chatId, owner, stableDecide, store]);
  React.useEffect(() => () => store.clear(owner), [owner, store]);
}

/** "voice" while Live will take allow or deny for this approval, "tap" when it needs a tap. */
export function useLiveApprovalVoiceHint(
  approvalId: string | undefined,
  controller: LiveChatVoiceApprovals = liveChatVoiceApprovals,
): LiveApprovalVoiceHint | null {
  return React.useSyncExternalStore(
    React.useCallback((listener) => controller.subscribe(listener), [controller]),
    () => controller.voiceHint(approvalId),
    () => null,
  );
}
