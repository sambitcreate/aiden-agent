import * as React from "react";
import { ArrowDownToLine, ArrowLeft, Maximize2, MoreHorizontal, Square, X } from "lucide-react";
import { cn } from "../lib/ui-utils";
import type { ApprovalPrompt } from "../lib/ipc";
import { prefersReducedMotion } from "../lib/appearance-runtime";
import { pauseWhenUnseen } from "../lib/offscreen-pause";
import type { MainChatWaitingKind } from "../lib/subagent-helper-chat-store";
import {
  subagentDetailGrowthAction,
  subagentDetailIsAwayFromLatest,
  subagentModelDisplay,
} from "../lib/subagent-panel-state";
import {
  SUBAGENT_HELPER_TONE_DOT,
  subagentHelperBlocks,
  subagentHelperIsActive,
  subagentHelperProblem,
  subagentHelperTimeline,
  subagentHelperTone,
  subagentHelperWorkSummary,
} from "../lib/subagent-helper-chat-state";
import {
  subagentModelLine,
  subagentModelName,
  useSubagentModelCatalog,
} from "../lib/subagent-model-name";
import { subagentRoleLabel, type SubagentRunPresentation } from "../lib/subagent-view-state";
import {
  activityTimelineFragment,
  assistantPresentationRows,
  isExtractionStep,
  isQuestionnaireStep,
  isRecordingStep,
} from "../lib/assistant-message-presentation";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  subagentContextIsApproachingLimit,
  subagentContextUsageLabels,
  type SubagentContextUsageV1,
} from "../shared/subagent-context-usage";
import type {
  SubagentTranscriptMessageEntry,
  SubagentTranscriptV1,
} from "../shared/subagent-transcript";
import { ActivityFeed } from "./activity-feed";
import { AidenActivityMark } from "./aiden-activity-mark";
import { AskUserQuestionRecap } from "./ask-user-question-recap";
import { BrowserRecordingCard } from "./browser-recording-card";
import { ChatApprovalCard, type ChatApprovalDecisionOptions } from "./chat-approval-card";
import { CopyButton } from "./copy-button";
import { SafeMessageBubble } from "./message-bubble";
import { formatSubagentElapsed } from "./subagent-detail";
import { subagentActivityMark, subagentStateLabel } from "./subagent-chips";
import { WebExtractRecap } from "./web-extract-recap";
import { Button, Callout, Text } from "./ui";
import { Tooltip } from "./ui-primitives";

/** The main chat column's insets, so the expanded chat lines up with the composer. */
const EXPANDED_COLUMN = "aiden-dock-inset chat-content-column";
/**
 * The expanded header, bar and footer reserve the same scrollbar gutter as the
 * scrolling body, so a classic scrollbar does not shift the body's text
 * against them.
 */
const EXPANDED_FRAME = "overflow-hidden [scrollbar-gutter:stable]";

export interface SubagentHelperChatApproval {
  prompt: ApprovalPrompt;
  deciding: boolean;
  onDecide: (decision: "allow" | "deny", options?: ChatApprovalDecisionOptions) => void;
  /** Requests the main chat shows before this one; its card shows one at a time. */
  ahead?: number;
}

export interface SubagentHelperChatProps {
  run: SubagentRunSnapshot;
  transcript: SubagentTranscriptV1;
  presentation?: SubagentRunPresentation;
  /**
   * The pending approval this helper is waiting on. The main chat's card is the
   * one to answer; the expanded chat, which covers that card, shows it in full,
   * and the side panel shows a short row that points to it.
   */
  approval?: SubagentHelperChatApproval | null;
  /** Side panel only: move focus to the main chat's approval card. */
  onFocusMainApproval?: () => void;
  onStop?: (run: SubagentRunSnapshot) => Promise<void> | void;
  stopPending?: boolean;
  stopError?: string | null;
  /** Put a retry request in the main chat's message box without sending it. */
  onAskRetry?: (text: string) => void;
  /** The chat fills the main pane in place of the main chat's messages. */
  expanded?: boolean;
  onExpand?: (opener: HTMLElement) => void;
  /** Expanded only: return to the main chat. */
  onBack?: () => void;
  /** Side panel only: close the panel. */
  onClose?: () => void;
  /** What the main chat waits on that this chat cannot answer, or null. */
  waitingOnMain?: MainChatWaitingKind | null;
  /** Return to the main chat and put focus on what waits there. */
  onReturnToMain?: () => void;
  /** Helpers this one started are still active, so Stop stops them too. */
  hasActiveHelpers?: boolean;
  /** The saved copy could not be refreshed; what is shown may be out of date. */
  refreshError?: string | null;
  onRetryRefresh?: () => void;
  /** Live context reading; supplied only while the run is active. */
  contextUsage?: SubagentContextUsageV1;
  now?: number;
  className?: string;
}

/**
 * A helper asking to write stays running in its record; while that question is
 * shown inside this chat, the chat says what the helper is waiting on.
 */
function shownState(run: SubagentRunSnapshot, waitingOnApproval: boolean): SubagentRunSnapshot["state"] {
  return waitingOnApproval && subagentHelperIsActive(run.state) ? "needs_attention" : run.state;
}

function statusWord(
  state: SubagentRunSnapshot["state"],
  presentation: SubagentRunPresentation | undefined,
) {
  return presentation?.state === "stopping" ? presentation.label : subagentStateLabel(state);
}

/** What the waiting bar says, and what is announced once when it appears. */
export const MAIN_CHAT_WAITING_TEXT: Record<MainChatWaitingKind, string> = {
  approval: "The main chat needs your approval.",
  question: "The main chat has a question for you.",
};

/**
 * The side panel's approval row; the main card shows queued requests one at a
 * time. The header already says the helper is waiting on you.
 */
function subagentHelperCompactApprovalText(ahead: number): string {
  if (ahead <= 0) return "Needs your approval in the main chat.";
  return `Needs your approval in the main chat, after ${ahead} other ${ahead === 1 ? "request" : "requests"}.`;
}

interface HelperMessageProps {
  runId: string;
  index: number;
  entry: SubagentTranscriptMessageEntry;
  runState: SubagentRunSnapshot["state"];
}

function HelperMessageView({ runId, index, entry, runState }: HelperMessageProps) {
  const timeline = subagentHelperTimeline(runId, index, entry, runState);
  const running = timeline.status === "running";
  const rows = assistantPresentationRows(entry.text, timeline);
  if (!rows) {
    const activity = timeline.steps.length
      ? activityTimelineFragment(
          timeline,
          timeline.steps.filter((step) => !isQuestionnaireStep(step)),
        )
      : null;
    return (
      <>
        <ActivityFeed timeline={activity} animate={running} />
        {timeline.steps.filter(isExtractionStep).map((step) => (
          <WebExtractRecap key={`extraction-${step.id}`} recap={step.extraction} />
        ))}
        {timeline.steps.filter(isRecordingStep).map((step) => (
          <BrowserRecordingCard key={`recording-${step.id}`} recording={step.recording} />
        ))}
        {timeline.steps.filter(isQuestionnaireStep).map((step) => (
          <AskUserQuestionRecap key={`questionnaire-${step.id}`} recap={step.questionnaire} />
        ))}
        {entry.text.trim() ? (
          <SafeMessageBubble
            imageScope={runId}
            role="assistant"
            content={entry.text}
            showCopy={false}
          />
        ) : null}
      </>
    );
  }
  return (
    <>
      {rows.map((row, rowIndex) => {
        if (row.kind === "reasoning") return null;
        if (row.kind === "questionnaire") {
          return <AskUserQuestionRecap key={row.key} recap={row.step.questionnaire} />;
        }
        if (row.kind === "extraction") {
          return <WebExtractRecap key={row.key} recap={row.step.extraction} />;
        }
        if (row.kind === "recording") {
          return <BrowserRecordingCard key={row.key} recording={row.step.recording} />;
        }
        if (row.kind === "activity") {
          return (
            <ActivityFeed
              key={row.key}
              timeline={activityTimelineFragment(timeline, row.steps)}
              animate={running}
            />
          );
        }
        return (
          <SafeMessageBubble
            key={row.key}
            imageScope={runId}
            role="assistant"
            content={row.content}
            textClosed={rowIndex < rows.length - 1}
            showCopy={false}
          />
        );
      })}
    </>
  );
}

/**
 * A finished message never changes, so a streamed token in the newest message
 * does not redraw the ones before it.
 */
function sameHelperMessage(previous: HelperMessageProps, next: HelperMessageProps): boolean {
  if (previous.runId !== next.runId || previous.index !== next.index) return false;
  const before = previous.entry;
  const after = next.entry;
  if (
    before.finishedAt !== undefined &&
    before.finishedAt === after.finishedAt &&
    before.text === after.text &&
    before.steps.length === after.steps.length
  ) {
    return true;
  }
  return before === after && previous.runState === next.runState;
}

const HelperMessage = React.memo(HelperMessageView, sameHelperMessage);

/**
 * One helper's own conversation: what it was asked, what it said and the
 * steps it took, in the main chat's message style.
 */
export const SubagentHelperChat = React.forwardRef<HTMLHeadingElement, SubagentHelperChatProps>(
  function SubagentHelperChat(
    {
      run,
      transcript,
      presentation,
      approval = null,
      onFocusMainApproval,
      onStop,
      stopPending = false,
      stopError = null,
      onAskRetry,
      expanded = false,
      onExpand,
      onBack,
      onClose,
      waitingOnMain = null,
      onReturnToMain,
      hasActiveHelpers = false,
      refreshError = null,
      onRetryRefresh,
      contextUsage,
      now = Date.now(),
      className,
    },
    headingRef,
  ) {
    const headingId = React.useId();
    const detailsId = React.useId();
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const detailsRef = React.useRef<HTMLElement | null>(null);
    const userNavigatedRef = React.useRef(false);
    const followGrowthRef = React.useRef(false);
    const previousRef = React.useRef<{ runId: string; revision: number } | null>(null);
    const [awayFromLatest, setAwayFromLatest] = React.useState(false);
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const state = shownState(run, approval !== null);
    const tone = subagentHelperTone(state);
    const active = subagentHelperIsActive(run.state);
    const status = statusWord(state, presentation);
    const role = subagentRoleLabel(run.role);
    const endedAt = run.finishedAt ?? now;
    const modelDisplay = subagentModelDisplay(run);
    const catalog = useSubagentModelCatalog();
    const modelLine = subagentModelLine(run, catalog);
    const modelName = subagentModelName(run, catalog);
    const summary = React.useMemo(() => subagentHelperWorkSummary(transcript), [transcript]);
    const blocks = React.useMemo(() => subagentHelperBlocks(transcript), [transcript]);
    const problem = subagentHelperProblem(run, summary, { trimmed: transcript.trimmed });
    const canStop = run.version === 2 && run.execution === "foreground" && active && onStop;
    const stopText = hasActiveHelpers ? "Stop all" : "Stop";
    const working = !approval && (run.state === "running" || run.state === "queued" || run.state === "starting");
    const growthRevision = transcript.revision * 1_000_000 + run.revision;

    const invokeStop = async () => {
      if (stopPending || !onStop) return;
      try {
        await onStop(run);
      } catch {
        // The owner keeps and shows stop failures through stopError.
      }
    };

    const updateScrollPosition = React.useCallback(() => {
      const element = scrollRef.current;
      if (!element) return;
      const away = subagentDetailIsAwayFromLatest(
        element.scrollHeight,
        element.clientHeight,
        element.scrollTop,
      );
      if (!away && userNavigatedRef.current) {
        userNavigatedRef.current = false;
        followGrowthRef.current = true;
      }
      setAwayFromLatest(userNavigatedRef.current && away);
    }, []);

    React.useLayoutEffect(() => {
      const element = scrollRef.current;
      if (!element || typeof window === "undefined") return;
      const next = { runId: run.runId, revision: growthRevision };
      const action = subagentDetailGrowthAction(previousRef.current, next, userNavigatedRef.current);
      const first = previousRef.current === null;
      previousRef.current = next;
      if (action === "reset" || first) {
        // A helper opens at its latest message, like the main chat.
        userNavigatedRef.current = false;
        followGrowthRef.current = true;
        element.scrollTop = element.scrollHeight;
        setAwayFromLatest(false);
      } else if (action === "follow") {
        followGrowthRef.current = true;
        element.scrollTop = element.scrollHeight;
        setAwayFromLatest(false);
      } else {
        updateScrollPosition();
      }
      const frame = window.requestAnimationFrame(updateScrollPosition);
      return () => window.cancelAnimationFrame(frame);
    }, [growthRevision, run.runId, updateScrollPosition]);

    React.useEffect(() => {
      const element = scrollRef.current;
      if (!element || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        if (followGrowthRef.current && !userNavigatedRef.current) {
          element.scrollTop = element.scrollHeight;
          setAwayFromLatest(false);
          return;
        }
        updateScrollPosition();
      });
      observer.observe(element);
      if (element.firstElementChild) observer.observe(element.firstElementChild);
      return () => observer.disconnect();
    }, [updateScrollPosition]);

    const markUserNavigation = () => {
      userNavigatedRef.current = true;
      followGrowthRef.current = false;
    };

    const jumpToLatest = () => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTo({
        top: element.scrollHeight,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      userNavigatedRef.current = false;
      followGrowthRef.current = true;
      setAwayFromLatest(false);
    };

    // Opened details sit at the top of the conversation: bring them into view
    // and move focus there, so opening them visibly does something.
    React.useEffect(() => {
      if (!detailsOpen) return;
      const section = detailsRef.current;
      if (!section) return;
      section.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      section.focus({ preventScroll: true });
    }, [detailsOpen]);

    const toggleDetails = () => {
      if (!detailsOpen) markUserNavigation();
      setDetailsOpen((open) => !open);
    };

    const column = expanded ? EXPANDED_COLUMN : "px-4";
    const frame = expanded ? EXPANDED_FRAME : undefined;

    return (
      <article
        className={cn("relative flex h-full min-h-0 flex-col", className)}
        data-subagent-helper-chat="true"
        data-subagent-helper-state={tone}
        data-subagent-helper-expanded={expanded ? "true" : undefined}
        aria-labelledby={headingId}
      >
        <header className={cn("shrink-0", frame)}>
          <div className={cn("flex min-w-0 items-start gap-2.5 pb-2 pt-3", column)}>
          <span
            aria-hidden="true"
            className={cn("mt-2 size-2 shrink-0 rounded-full", SUBAGENT_HELPER_TONE_DOT[tone])}
            data-subagent-helper-dot={tone}
          />
          <span className="min-w-0 flex-1">
            <h2
              ref={headingRef}
              id={headingId}
              tabIndex={-1}
              data-subagent-detail-heading="true"
              className="break-words rounded-sm text-strong font-medium text-primary outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              {run.label}
            </h2>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              {role ? `${role} · ` : ""}
              {status} ·{" "}
              <span className="tabular-nums">{formatSubagentElapsed(run.startedAt, endedAt)}</span>
            </Text>
          </span>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label="Technical details"
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? detailsId : undefined}
            onClick={toggleDetails}
            className="shrink-0 motion-reduce:transition-none"
            data-subagent-helper-details-toggle="true"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
          </div>
        </header>

        {waitingOnMain && onReturnToMain ? (
          <div className={cn("shrink-0", frame)}>
          <div className={cn("pb-2", column)}>
            <Callout
              role="note"
              className="flex-row items-center justify-between gap-3 bg-status-warning-surface px-3 py-2 text-small"
              data-subagent-helper-main-waiting={waitingOnMain}
            >
              <Text as="p" variant="small" className="min-w-0 text-status-warning">
                {MAIN_CHAT_WAITING_TEXT[waitingOnMain]}
              </Text>
              <Button
                variant="transparent"
                size="small"
                onClick={onReturnToMain}
                className="shrink-0 motion-reduce:transition-none"
              >
                {waitingOnMain === "approval" ? "Go to approval" : "Answer question"}
              </Button>
            </Callout>
          </div>
          </div>
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={updateScrollPosition}
            onWheel={markUserNavigation}
            onPointerDownCapture={markUserNavigation}
            onKeyDown={markUserNavigation}
            className="min-h-0 flex-1 overflow-y-auto pb-6 pt-2"
            data-subagent-scroll-region="true"
          >
            <div className={cn("flex w-full flex-col gap-4", expanded ? EXPANDED_COLUMN : "mx-auto max-w-2xl px-4")}>
              {detailsOpen ? (
                <section
                  ref={detailsRef}
                  id={detailsId}
                  tabIndex={-1}
                  aria-label="Technical details"
                  className="rounded-card bg-well px-3 py-2.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  data-subagent-helper-details="true"
                >
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
                    <dt className="text-tertiary">Context</dt>
                    <dd className="text-secondary">
                      {run.version === 2 && run.context === "fork"
                        ? "Started with this chat's context"
                        : "Started fresh"}
                    </dd>
                    {contextUsage ? (
                      <>
                        <dt className="text-tertiary">Context window</dt>
                        <dd
                          className={cn(
                            "tabular-nums text-secondary",
                            subagentContextIsApproachingLimit(contextUsage) && "text-support-warning",
                          )}
                          data-subagent-helper-context-usage="true"
                        >
                          {(() => {
                            const labels = subagentContextUsageLabels(contextUsage);
                            return `${labels.amount} (${labels.percent})`;
                          })()}
                        </dd>
                      </>
                    ) : null}
                    <dt className="text-tertiary">Turns</dt>
                    <dd className="tabular-nums text-secondary">{run.turns}</dd>
                    <dt className="text-tertiary">Tokens</dt>
                    <dd className="tabular-nums text-secondary">{run.tokens.toLocaleString()}</dd>
                    <dt className="text-tertiary">Model</dt>
                    <dd className="break-words text-secondary">{modelName}</dd>
                    {modelDisplay.selection ? (
                      <>
                        <dt className="text-tertiary">Model choice</dt>
                        <dd className="text-secondary">{modelDisplay.selection}</dd>
                      </>
                    ) : null}
                    <dt className="text-tertiary">Model ID</dt>
                    <dd className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate font-mono text-secondary" title={modelDisplay.model}>
                        {modelDisplay.model}
                      </span>
                      <CopyButton text={modelDisplay.model} label="Copy model ID" className="shrink-0" />
                    </dd>
                    <dt className="text-tertiary">Run ID</dt>
                    <dd className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate font-mono text-secondary">{run.runId}</span>
                      <CopyButton text={run.runId} label="Copy run ID" className="shrink-0" />
                    </dd>
                  </dl>
                </section>
              ) : null}

              {refreshError ? (
                <Callout role="note" data-subagent-helper-refresh-error="true">
                  <Text as="p" variant="small" color="secondary">
                    Couldn't load the latest steps. What's shown may be out of date.
                  </Text>
                  {onRetryRefresh ? (
                    <Button
                      variant="muted"
                      size="small"
                      onClick={onRetryRefresh}
                      className="mt-2 w-fit self-start motion-reduce:transition-none"
                    >
                      Try again
                    </Button>
                  ) : null}
                </Callout>
              ) : null}

              {transcript.trimmed ? (
                <Text
                  as="p"
                  variant="small"
                  color="tertiary"
                  className="text-center"
                  data-subagent-helper-trimmed="true"
                >
                  Earlier steps aren't shown to save space.
                </Text>
              ) : null}

              {blocks.map((block) =>
                block.kind === "task" ? (
                  <div key={block.key} data-subagent-helper-task="true">
                    <SafeMessageBubble imageScope={run.runId} role="user" content={block.text} />
                  </div>
                ) : (
                  <div
                    key={block.key}
                    className="flex min-w-0 flex-col gap-2"
                    data-subagent-helper-message="true"
                  >
                    <HelperMessage
                      runId={run.runId}
                      index={block.index}
                      entry={block.entry}
                      runState={run.state}
                    />
                  </div>
                ),
              )}

              {working ? (
                // The main chat's working line: the same mark and shimmer, which
                // Reduce Motion and an off-screen pane both hold still.
                <div
                  className="flex h-6 w-fit max-w-full items-center gap-2"
                  data-subagent-helper-working="true"
                >
                  <AidenActivityMark
                    mark={subagentActivityMark(run.state, run.role, run.activity)}
                    size={20}
                    className="shrink-0 text-primary"
                  />
                  <Text
                    variant="small"
                    color="secondary"
                    ref={pauseWhenUnseen}
                    className="agent-thinking-shimmer min-w-0 truncate"
                  >
                    {run.state === "running" ? "Working…" : "Starting…"}
                  </Text>
                </div>
              ) : null}

              {approval && expanded ? (
                <div data-subagent-helper-approval="full">
                  <ChatApprovalCard
                    pending={approval.prompt}
                    deciding={approval.deciding}
                    onDecide={approval.onDecide}
                    keyboardShortcuts
                  />
                </div>
              ) : approval ? (
                <div
                  className="flex min-w-0 items-center justify-between gap-3 rounded-card bg-status-warning-surface px-3 py-2 text-small"
                  data-subagent-helper-approval="compact"
                >
                  <Text as="p" variant="small" className="min-w-0 text-status-warning">
                    {subagentHelperCompactApprovalText(approval.ahead ?? 0)}
                  </Text>
                  {onFocusMainApproval ? (
                    <Button
                      variant="transparent"
                      size="small"
                      onClick={onFocusMainApproval}
                      className="shrink-0 motion-reduce:transition-none"
                    >
                      {/* Queued behind others, the main chat shows someone else's request first. */}
                      {(approval.ahead ?? 0) > 0 ? "Go to main chat" : "Go to approval"}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {problem ? (
                <Callout
                  role="note"
                  color={problem.tone === "failed" ? "red" : undefined}
                  className="text-small"
                  data-subagent-helper-problem={problem.tone}
                >
                  <Text as="p" variant="small" color="secondary" className="break-words">
                    {problem.text}
                  </Text>
                  {onAskRetry ? (
                    <Button
                      variant="muted"
                      size="small"
                      onClick={() => onAskRetry(problem.retryText)}
                      className="mt-2 w-fit self-start motion-reduce:transition-none"
                    >
                      Ask the main chat to retry
                    </Button>
                  ) : null}
                </Callout>
              ) : null}

              {stopError ? (
                <Callout color="red" role="note" data-subagent-control-error="true">
                  <Text as="p" variant="small" color="secondary">
                    Couldn't stop this helper. {stopError} Try again if it's still running.
                  </Text>
                </Callout>
              ) : null}
            </div>
          </div>

          {awayFromLatest ? (
            <Button
              variant="glass"
              size="small"
              className="absolute bottom-3 right-3 motion-reduce:transition-none"
              onClick={jumpToLatest}
              data-subagent-jump-latest="true"
            >
              <ArrowDownToLine aria-hidden="true" className="size-3.5" />
              Jump to latest
            </Button>
          ) : null}
        </div>

        <footer className={cn("shrink-0 border-t border-separator", frame)} data-subagent-helper-bar="true">
          <div className={cn("flex min-w-0 items-center gap-2 py-2", column)}>
            <Text
              as="p"
              variant="small"
              color="secondary"
              className="min-w-0 flex-1 truncate"
              title={modelLine}
              data-subagent-helper-model="true"
            >
              {modelLine}
            </Text>
            {canStop ? (
              <Button
                variant="muted"
                size="small"
                disabled={stopPending}
                aria-label={stopPending ? `Stopping ${run.label}` : `${stopText} ${run.label}`}
                aria-busy={stopPending ? true : undefined}
                onClick={() => void invokeStop()}
                className="shrink-0 motion-reduce:transition-none"
              >
                <Square aria-hidden="true" className="size-3" />
                {stopPending ? "Stopping…" : stopText}
              </Button>
            ) : null}
            {!expanded && onExpand ? (
              <Button
                variant="transparent"
                size="small"
                onClick={(event) => onExpand(event.currentTarget)}
                className="shrink-0 motion-reduce:transition-none"
                data-subagent-helper-expand={run.runId}
              >
                <Maximize2 aria-hidden="true" className="size-3.5" />
                Expand
              </Button>
            ) : null}
            {expanded && onBack ? (
              // Esc also goes back; the hint says so, since this sits far from where Back usually is.
              <Tooltip content="Back to main chat (Esc)">
                <Button
                  variant="transparent"
                  size="small"
                  onClick={onBack}
                  aria-keyshortcuts="Escape"
                  className="shrink-0 motion-reduce:transition-none"
                  data-subagent-helper-back="true"
                >
                  <ArrowLeft aria-hidden="true" className="size-3.5" />
                  Back to main chat
                </Button>
              </Tooltip>
            ) : null}
            {!expanded && onClose ? (
              <Button
                variant="transparent"
                size="small"
                onClick={onClose}
                className="shrink-0 motion-reduce:transition-none"
                data-subagent-helper-close="true"
              >
                <X aria-hidden="true" className="size-3.5" />
                Close
              </Button>
            ) : null}
          </div>
        </footer>
      </article>
    );
  },
);
