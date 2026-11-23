import * as React from "react";
import { ArrowDownToLine, ArrowLeft, Maximize2, MoreHorizontal, Square } from "lucide-react";
import { cn } from "../lib/ui-utils";
import type { ApprovalPrompt } from "../lib/ipc";
import { resolveModelDisplay } from "../lib/model-display";
import {
  subagentDetailGrowthAction,
  subagentDetailIsAwayFromLatest,
  subagentModelDisplay,
} from "../lib/subagent-panel-state";
import {
  subagentHelperIsActive,
  subagentHelperProblem,
  subagentHelperTimeline,
  subagentHelperTone,
  subagentHelperWorkSummary,
  type SubagentHelperTone,
} from "../lib/subagent-helper-chat-state";
import { subagentRoleLabel, type SubagentRunPresentation } from "../lib/subagent-view-state";
import {
  activityTimelineFragment,
  assistantPresentationRows,
  isExtractionStep,
  isQuestionnaireStep,
  isRecordingStep,
} from "../lib/assistant-message-presentation";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import type {
  SubagentTranscriptMessageEntry,
  SubagentTranscriptV1,
} from "../shared/subagent-transcript";
import { ActivityFeed } from "./activity-feed";
import { AskUserQuestionRecap } from "./ask-user-question-recap";
import { BrowserRecordingCard } from "./browser-recording-card";
import { ChatApprovalCard, type ChatApprovalDecisionOptions } from "./chat-approval-card";
import { CopyButton } from "./copy-button";
import { SafeMessageBubble } from "./message-bubble";
import { formatSubagentElapsed } from "./subagent-detail";
import { subagentStateLabel } from "./subagent-chips";
import { WebExtractRecap } from "./web-extract-recap";
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Text,
} from "./ui";

const TONE_DOT: Record<SubagentHelperTone, string> = {
  queued: "bg-separator",
  running: "bg-status-accent motion-safe:animate-pulse",
  waiting: "bg-status-warning",
  done: "bg-status-green",
  failed: "bg-status-red",
  stopped: "bg-separator",
};

export interface SubagentHelperChatApproval {
  prompt: ApprovalPrompt;
  deciding: boolean;
  onDecide: (decision: "allow" | "deny", options?: ChatApprovalDecisionOptions) => void;
}

export interface SubagentHelperChatProps {
  run: SubagentRunSnapshot;
  transcript: SubagentTranscriptV1;
  presentation?: SubagentRunPresentation;
  /** The pending approval this helper is waiting on, answered from inside the chat. */
  approval?: SubagentHelperChatApproval | null;
  onStop?: (run: SubagentRunSnapshot) => Promise<void> | void;
  stopPending?: boolean;
  stopError?: string | null;
  /** Put a retry request in the main chat's message box without sending it. */
  onAskRetry?: (text: string) => void;
  /** The chat fills the main pane in place of the main chat's messages. */
  expanded?: boolean;
  onExpand?: (opener: HTMLElement) => void;
  onBack?: () => void;
  /**
   * Speak status changes from this view. The side panel speaks for its own
   * detail region, so only a view outside it (expanded) sets this.
   */
  announceStatus?: boolean;
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

function HelperMessage({
  runId,
  index,
  entry,
  runState,
}: {
  runId: string;
  index: number;
  entry: SubagentTranscriptMessageEntry;
  runState: SubagentRunSnapshot["state"];
}) {
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
      onStop,
      stopPending = false,
      stopError = null,
      onAskRetry,
      expanded = false,
      onExpand,
      onBack,
      announceStatus = false,
      now = Date.now(),
      className,
    },
    headingRef,
  ) {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const userNavigatedRef = React.useRef(false);
    const followGrowthRef = React.useRef(false);
    const previousRef = React.useRef<{ runId: string; revision: number } | null>(null);
    const [awayFromLatest, setAwayFromLatest] = React.useState(false);
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const [announcement, setAnnouncement] = React.useState("");
    const state = shownState(run, approval !== null);
    const tone = subagentHelperTone(state);
    const active = subagentHelperIsActive(run.state);
    const status = statusWord(state, presentation);
    const role = subagentRoleLabel(run.role);
    const endedAt = run.finishedAt ?? now;
    const modelDisplay = subagentModelDisplay(run);
    const modelLabel = resolveModelDisplay(run.modelId).label;
    const summary = React.useMemo(() => subagentHelperWorkSummary(transcript), [transcript]);
    const problem = subagentHelperProblem(run, summary);
    const canStop = run.version === 2 && run.execution === "foreground" && active && onStop;
    const stopLabel = run.version === 2 && run.depth === 1 ? "Stop subtree" : "Stop helper";
    const growthRevision = transcript.revision * 1_000_000 + run.revision;

    const previousToneRef = React.useRef(tone);
    React.useEffect(() => {
      const previous = previousToneRef.current;
      previousToneRef.current = tone;
      if (announceStatus && previous !== tone) setAnnouncement(`${run.label}: ${status}`);
    }, [announceStatus, run.label, status, tone]);

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

    const jumpToLatest = () => {
      const element = scrollRef.current;
      if (!element) return;
      const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
      element.scrollTo({ top: element.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
      userNavigatedRef.current = false;
      followGrowthRef.current = true;
      setAwayFromLatest(false);
    };

    const markUserNavigation = () => {
      userNavigatedRef.current = true;
      followGrowthRef.current = false;
    };

    const modelLine = [modelLabel, modelDisplay.effort].filter(Boolean).join(" · ");

    return (
      <article
        className={cn("relative flex h-full min-h-0 flex-col", className)}
        data-subagent-helper-chat="true"
        data-subagent-helper-state={tone}
        data-subagent-helper-expanded={expanded ? "true" : undefined}
        aria-label={`Helper chat: ${run.label}`}
      >
        <header className="flex min-w-0 shrink-0 items-start gap-2.5 px-4 pb-2 pt-3">
          <span
            aria-hidden="true"
            className={cn("mt-2 size-2 shrink-0 rounded-full", TONE_DOT[tone])}
            data-subagent-helper-dot={tone}
          />
          <span className="min-w-0 flex-1">
            <h2
              ref={headingRef}
              tabIndex={-1}
              data-subagent-detail-heading="true"
              className="break-words text-strong font-medium text-primary outline-none"
            >
              {run.label}
            </h2>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              {role ? `${role} · ` : ""}
              {status} ·{" "}
              <span className="tabular-nums">{formatSubagentElapsed(run.startedAt, endedAt)}</span>
            </Text>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="transparent"
                size="small"
                iconOnly
                aria-label={`More for ${run.label}`}
                className="shrink-0 motion-reduce:transition-none"
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => setDetailsOpen((open) => !open)}>
                {detailsOpen ? "Hide technical details" : "Technical details"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div
          ref={scrollRef}
          onScroll={updateScrollPosition}
          onWheel={markUserNavigation}
          onPointerDownCapture={markUserNavigation}
          onKeyDown={markUserNavigation}
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2"
          data-subagent-scroll-region="true"
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            {detailsOpen ? (
              <section
                aria-label="Technical details"
                className="rounded-card bg-well px-3 py-2.5"
                data-subagent-helper-details="true"
              >
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
                  <dt className="text-tertiary">Context</dt>
                  <dd className="text-secondary">
                    {run.version === 2 && run.context === "fork" ? "Copied from the chat" : "Fresh start"}
                  </dd>
                  <dt className="text-tertiary">Turns</dt>
                  <dd className="tabular-nums text-secondary">{run.turns}</dd>
                  <dt className="text-tertiary">Tokens</dt>
                  <dd className="tabular-nums text-secondary">{run.tokens}</dd>
                  <dt className="text-tertiary">Model</dt>
                  <dd className="break-words text-secondary [overflow-wrap:anywhere]">
                    {[modelDisplay.model, modelDisplay.selection].filter(Boolean).join(" · ")}
                  </dd>
                  <dt className="text-tertiary">Run ID</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate font-mono text-secondary">{run.runId}</span>
                    <CopyButton text={run.runId} label="Copy run ID" className="shrink-0" />
                  </dd>
                </dl>
              </section>
            ) : null}

            {transcript.trimmed ? (
              <Text
                as="p"
                variant="small"
                color="tertiary"
                className="text-center"
                data-subagent-helper-trimmed="true"
              >
                Older steps were removed to save space.
              </Text>
            ) : null}

            {transcript.entries.map((entry, index) =>
              entry.kind === "task" ? (
                <div key={`task-${index}`} data-subagent-helper-task="true">
                  <SafeMessageBubble imageScope={run.runId} role="user" content={entry.text} />
                </div>
              ) : (
                <div
                  key={`message-${index}`}
                  className="flex min-w-0 flex-col gap-2"
                  data-subagent-helper-message="true"
                >
                  <HelperMessage
                    runId={run.runId}
                    index={index}
                    entry={entry}
                    runState={run.state}
                  />
                </div>
              ),
            )}

            {approval ? (
              <div data-subagent-helper-approval="true">
                <ChatApprovalCard
                  pending={approval.prompt}
                  deciding={approval.deciding}
                  onDecide={approval.onDecide}
                />
              </div>
            ) : null}

            {problem ? (
              <Callout
                role="note"
                color={problem.tone === "failed" ? "red" : undefined}
                data-subagent-helper-problem={problem.tone}
              >
                <Text variant="small-strong" color={problem.tone === "failed" ? "red" : undefined}>
                  {problem.title}
                </Text>
                <Text as="p" variant="small" color="secondary" className="break-words">
                  {problem.text}
                </Text>
                {onAskRetry ? (
                  <Button
                    variant="muted"
                    size="small"
                    onClick={() => onAskRetry(problem.retryText)}
                    className="mt-3 motion-reduce:transition-none"
                  >
                    Ask main chat to retry
                  </Button>
                ) : null}
              </Callout>
            ) : null}

            {stopError ? (
              <Callout color="red" role="note" data-subagent-control-error="true">
                <Text variant="small-strong" color="red">
                  Could not stop the helper
                </Text>
                <Text as="p" variant="small" color="secondary">
                  {stopError} Try again if it is still running.
                </Text>
              </Callout>
            ) : null}
          </div>
        </div>

        {awayFromLatest ? (
          <Button
            variant="glass"
            size="small"
            className="absolute bottom-16 right-3 motion-reduce:transition-none"
            onClick={jumpToLatest}
            data-subagent-jump-latest="true"
          >
            <ArrowDownToLine aria-hidden="true" className="size-3.5" />
            Jump to latest
          </Button>
        ) : null}

        <footer
          className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-t border-separator px-3 py-2"
          data-subagent-helper-bar="true"
        >
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
              aria-label={stopPending ? `Stopping ${run.label}` : `${stopLabel} ${run.label}`}
              aria-busy={stopPending ? true : undefined}
              onClick={() => void invokeStop()}
              className="motion-reduce:transition-none"
            >
              <Square aria-hidden="true" className="size-3" />
              {stopPending ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          {!expanded && onExpand ? (
            <Button
              variant="transparent"
              size="small"
              onClick={(event) => onExpand(event.currentTarget)}
              className="motion-reduce:transition-none"
              data-subagent-helper-expand="true"
            >
              <Maximize2 aria-hidden="true" className="size-3.5" />
              Expand
            </Button>
          ) : null}
          {onBack ? (
            <Button
              variant="transparent"
              size="small"
              onClick={onBack}
              className="motion-reduce:transition-none"
              data-subagent-helper-back="true"
            >
              <ArrowLeft aria-hidden="true" className="size-3.5" />
              Back to main chat
            </Button>
          ) : null}
        </footer>

        {announceStatus ? (
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </div>
        ) : null}
      </article>
    );
  },
);
