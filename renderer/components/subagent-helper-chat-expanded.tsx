import * as React from "react";
import { EnvironmentPanelContext } from "./environment-panel";
import {
  MAIN_CHAT_WAITING_TEXT,
  SubagentHelperChat,
  type SubagentHelperChatApproval,
} from "./subagent-helper-chat";
import {
  SUBAGENT_TRANSCRIPT_REFRESH_ERROR,
  subagentHelperApprovalsFor,
  subagentHelperHasActiveHelpers,
  subagentHelperIsActive,
  subagentHelperTranscriptRefetchReason,
} from "../lib/subagent-helper-chat-state";
import {
  askMainChatToRetrySubagent,
  mainChatWaitingFor,
  useSubagentHelperChatSelector,
  useSubagentHelperChatStore,
} from "../lib/subagent-helper-chat-store";
import { focusRegion } from "../lib/focus-regions";
import { subagentPanelOwnerKey } from "../lib/subagent-panel-state";
import { mergeSubagentTranscript } from "../shared/subagent-transcript";
import { useNow } from "../lib/use-now";

/** Whether this chat's helper chat fills the main pane right now. */
export function useExpandedSubagentHelperChat(chatId: string | null | undefined): boolean {
  return useSubagentHelperChatSelector((state) =>
    Boolean(chatId && state.chatId === chatId && state.expandedRunId),
  );
}

function insideOpenLayer(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[role="menu"], [role="dialog"], [role="listbox"]') !== null
  );
}

/**
 * The expanded helper chat, shown in place of the main chat's messages. Esc
 * or Back returns to the main chat and gives focus back to what opened it.
 */
export function ExpandedSubagentHelperChat({ chatId }: { chatId: string }) {
  const runId = useSubagentHelperChatSelector((state) =>
    state.chatId === chatId ? state.expandedRunId : null,
  );
  // Each helper gets its own view, so scroll and details never carry across.
  return runId ? <ExpandedHelperChatView key={runId} chatId={chatId} runId={runId} /> : null;
}

function ExpandedHelperChatView({ chatId, runId }: { chatId: string; runId: string }) {
  const store = useSubagentHelperChatStore();
  const panel = React.useContext(EnvironmentPanelContext);
  // Only this helper's slices: another helper's streamed tokens do not redraw it.
  const saved = useSubagentHelperChatSelector((state) => state.saved.get(runId));
  const live = useSubagentHelperChatSelector((state) => state.live.get(runId));
  const approvals = useSubagentHelperChatSelector((state) => state.approvals);
  const decidingApprovalId = useSubagentHelperChatSelector((state) => state.decidingApprovalId);
  const questionPending = useSubagentHelperChatSelector((state) => state.questionPending);
  const views = panel?.subagentViews;
  const run = React.useMemo(
    () => views?.find((view) => view.runId === runId)?.snapshot,
    [runId, views],
  );
  const merged = React.useMemo(() => mergeSubagentTranscript(saved, live), [live, saved]);
  const transcript = merged.transcript;
  const now = useNow(Boolean(run && subagentHelperIsActive(run.state)));
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const available = Boolean(store && run && transcript);
  const refetch = panel?.refetchSubagentTranscript;
  const refetchReason = run
    ? subagentHelperTranscriptRefetchReason(run, merged, Boolean(live))
    : null;

  // A gap in the streamed updates, or a run that moved while its updates
  // stream to another window, is read from the saved copy once per reason.
  React.useEffect(() => {
    if (refetchReason) refetch?.(runId, refetchReason);
  }, [refetch, refetchReason, runId]);

  // A helper that is gone (the chat changed or its run was dropped) closes the
  // view; focus goes back to what opened it, or to the message box.
  React.useEffect(() => {
    if (available || !store) return;
    store.collapse();
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || !focused.isConnected) focusRegion("composer");
    });
  }, [available, store]);

  React.useEffect(() => {
    // Focus once per helper, not on every update.
    if (available) headingRef.current?.focus({ preventScroll: true });
  }, [available]);

  const ownPrompts = React.useMemo(
    () => (run ? subagentHelperApprovalsFor(run, approvals, views ?? []) : []),
    [approvals, run, views],
  );
  const prompt = ownPrompts[0] ?? null;
  const approval = React.useMemo<SubagentHelperChatApproval | null>(
    () =>
      prompt && store
        ? {
            prompt,
            deciding: decidingApprovalId === prompt.approvalId,
            onDecide: (decision, options) => store.decide(prompt, decision, options),
          }
        : null,
    [decidingApprovalId, prompt, store],
  );
  const waitingKind = mainChatWaitingFor(
    { approvals, questionPending },
    new Set(ownPrompts.map((own) => own.approvalId)),
  );

  // Say once, politely, that the main chat now waits on the person. Focus stays put.
  const announce = panel?.announceSubagentDetail;
  const ownerKey = panel
    ? subagentPanelOwnerKey(panel.subagents.chatId, panel.subagents.workspaceId)
    : null;
  React.useEffect(() => {
    if (waitingKind && ownerKey) announce?.(ownerKey, MAIN_CHAT_WAITING_TEXT[waitingKind]);
  }, [announce, ownerKey, waitingKind]);

  if (!store || !panel || !run || !transcript) return null;
  const stopPending = panel.subagentStopPendingRunIds.includes(run.runId);
  const refreshFailed = run.runId in panel.subagentTranscriptRefetchFailures;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || insideOpenLayer(event.target))
          return;
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
        approval={approval}
        hasActiveHelpers={subagentHelperHasActiveHelpers(run.runId, views ?? [])}
        onStop={panel.stopSubagent}
        stopPending={stopPending}
        stopError={panel.subagentStopErrorsByRunId[run.runId] ?? null}
        onAskRetry={(text) => askMainChatToRetrySubagent(store, chatId, text)}
        expanded
        onBack={() => store.collapse()}
        waitingOnMain={waitingKind}
        onReturnToMain={() => {
          if (waitingKind) store.returnToMainWaiting(waitingKind);
        }}
        refreshError={refreshFailed ? SUBAGENT_TRANSCRIPT_REFRESH_ERROR : null}
        onRetryRefresh={() => panel.retrySubagentTranscript(run.runId)}
        now={now}
      />
    </div>
  );
}
