import * as React from "react";
import { EnvironmentPanelContext } from "./environment-panel";
import { SubagentHelperChat } from "./subagent-helper-chat";
import { subagentHelperIsActive } from "../lib/subagent-helper-chat-state";
import {
  askMainChatToRetrySubagent,
  subagentHelperChatApproval,
  subagentHelperChatTranscript,
  useSubagentHelperChatState,
  useSubagentHelperChatStore,
} from "../lib/subagent-helper-chat-store";
import { useNow } from "../lib/use-now";

/** Whether this chat's helper chat fills the main pane right now. */
export function useExpandedSubagentHelperChat(chatId: string | null | undefined): boolean {
  const state = useSubagentHelperChatState();
  return Boolean(chatId && state.chatId === chatId && state.expandedRunId);
}

function insideOpenLayer(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="menu"], [role="dialog"], [role="listbox"]') !== null
  );
}

/**
 * The expanded helper chat, shown in place of the main chat's messages. Esc
 * or Back returns to the main chat and gives focus back to what opened it.
 */
export function ExpandedSubagentHelperChat({ chatId }: { chatId: string }) {
  const store = useSubagentHelperChatStore();
  const state = useSubagentHelperChatState();
  const panel = React.useContext(EnvironmentPanelContext);
  const runId = state.chatId === chatId ? state.expandedRunId : null;
  const views = panel?.subagentViews;
  const run = React.useMemo(
    () => (runId ? views?.find((view) => view.runId === runId)?.snapshot : undefined),
    [runId, views],
  );
  const activeRuns = React.useMemo(() => views?.filter((view) => !view.terminal) ?? [], [views]);
  const merged = runId ? subagentHelperChatTranscript(state, runId) : null;
  const transcript = merged?.transcript ?? null;
  const now = useNow(Boolean(run && subagentHelperIsActive(run.state)));
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const available = Boolean(store && run && transcript);

  // A helper that is gone (the chat changed or its run was dropped) closes the view.
  React.useEffect(() => {
    if (runId && !available) store?.collapse({ restoreFocus: false });
  }, [available, runId, store]);

  React.useEffect(() => {
    // Focus once per helper, not on every update.
    if (available) headingRef.current?.focus({ preventScroll: true });
  }, [runId, available]);

  if (!store || !panel || !run || !transcript) return null;
  const stopPending = panel.subagentStopPendingRunIds.includes(run.runId);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || insideOpenLayer(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        store.collapse();
      }}
    >
      <SubagentHelperChat
        ref={headingRef}
        className="min-h-0 flex-1"
        run={run}
        transcript={transcript}
        presentation={stopPending ? { state: "stopping", label: "Stopping…" } : undefined}
        approval={subagentHelperChatApproval(store, state, run, activeRuns)}
        onStop={panel.stopSubagent}
        stopPending={stopPending}
        stopError={panel.subagentStopErrorsByRunId[run.runId] ?? null}
        onAskRetry={(text) => askMainChatToRetrySubagent(store, chatId, text)}
        expanded
        onBack={() => store.collapse()}
        announceStatus
        now={now}
      />
    </div>
  );
}
