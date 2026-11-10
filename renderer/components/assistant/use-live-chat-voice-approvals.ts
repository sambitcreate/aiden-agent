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
 * function, bound to the chat it was published with: once the pane renders
 * another chat, that decide refuses, so one chat's answer path can never
 * answer another chat's approval. Approvals still in state from the previous
 * chat (the first render after a switch, before the pane resets them) are
 * never published under the next chat.
 */
export function usePublishLiveChatApprovals(
  chatId: string,
  approvals: readonly ApprovalPrompt[],
  decide: LiveChatApprovalDecide,
  store: LiveChatApprovalsStore = liveChatApprovals,
): void {
  const owner = React.useMemo(() => Symbol("chat-approvals"), []);
  const renderedChatId = React.useRef(chatId);
  renderedChatId.current = chatId;
  const lastPublished = React.useRef<{ chatId: string; approvals: readonly ApprovalPrompt[] } | null>(null);
  React.useEffect(() => {
    const last = lastPublished.current;
    const carriedOver = last !== null && last.chatId !== chatId && last.approvals === approvals;
    lastPublished.current = { chatId, approvals };
    const boundChatId = chatId;
    const bound: LiveChatApprovalDecide = async (prompt, decision) => {
      if (renderedChatId.current !== boundChatId) throw new Error("The chat on screen changed.");
      await decide(prompt, decision);
    };
    store.publish(owner, { chatId, approvals: carriedOver ? [] : approvals, decide: bound });
  }, [approvals, chatId, decide, owner, store]);
  React.useEffect(() => () => store.clear(owner), [owner, store]);
}

/** "voice" once Live has read this approval out and takes allow or deny, "tap" when it needs a tap. */
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
