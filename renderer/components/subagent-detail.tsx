import * as React from "react";
import { ArrowDownToLine, ChevronRight, Square } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  subagentDetailGrowthAction,
  subagentDetailIsAwayFromLatest,
} from "../lib/subagent-panel-state";
import type { SubagentRunPresentation } from "../lib/subagent-view-state";
import type {
  SubagentEffectActivityV1,
  SubagentMilestoneKind,
  SubagentRunSnapshot,
} from "../shared/subagent-runs";
import { Markdown } from "./markdown";
import { SubagentOrb, subagentStateLabel } from "./subagent-chips";
import { Button, Callout, ErrorBoundary, Text } from "./ui";
import { CopyButton } from "./copy-button";

export function subagentProjectionNotices(run: SubagentRunSnapshot): string[] {
  const notices = new Set(run.projectionNotices);
  return [
    notices.has("task_truncated") ? "This saved task preview was shortened." : null,
    notices.has("report_truncated") ? "This saved result was shortened." : null,
    notices.has("display_filtered")
      ? "Some text was replaced by a privacy marker in this saved inspector. This display filter does not rewrite the child's task or its report to the main thread."
      : null,
  ].filter((notice): notice is string => notice !== null);
}

export function formatSubagentElapsed(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function subagentToolAggregate(run: SubagentRunSnapshot): string {
  const toolLabel = run.tools === 1 ? "tool use" : "tool uses";
  const turnLabel = run.turns === 1 ? "turn" : "turns";
  return `${run.tools} ${toolLabel} · ${run.turns} ${turnLabel}`;
}

const SUBAGENT_MILESTONE_LABELS: Record<SubagentMilestoneKind, string> = {
  reading: "Read a workspace file",
  listing: "Listed a workspace directory",
  matching: "Matched workspace file names",
  searching: "Searched workspace text",
  inspecting: "Tool activity",
  composing: "Composed the bounded report",
};

export function subagentMilestoneLabel(milestone: SubagentMilestoneKind): string {
  return SUBAGENT_MILESTONE_LABELS[milestone];
}

export function subagentMilestoneAggregate(run: SubagentRunSnapshot): string {
  const count = run.milestones?.length ?? 0;
  return `${count} activity milestone${count === 1 ? "" : "s"}`;
}

function UnrenderableSubagentUpdate({ content }: { content: string }) {
  return (
    <Callout color="red">
      <Text variant="small-strong" color="red">
        This update could not be formatted
      </Text>
      <Text as="pre" variant="small" color="secondary" className="mt-1 whitespace-pre-wrap">
        {content}
      </Text>
    </Callout>
  );
}

export interface SubagentDetailProps {
  run: SubagentRunSnapshot;
  effectActivity?: readonly SubagentEffectActivityV1[];
  onStop?: (run: SubagentRunSnapshot) => Promise<void> | void;
  stopPending?: boolean;
  stopError?: string | null;
  presentation?: SubagentRunPresentation;
  refreshing?: boolean;
  refreshError?: string | null;
  onRetryRefresh?: () => void;
  now?: number;
  className?: string;
}

export const SubagentDetail = React.forwardRef<HTMLHeadingElement, SubagentDetailProps>(
  function SubagentDetail(
    {
      run,
      effectActivity = [],
      onStop,
      stopPending = false,
      stopError = null,
      presentation,
      refreshing = false,
      refreshError = null,
      onRetryRefresh,
      now = Date.now(),
      className,
    },
    headingRef,
  ) {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const userNavigatedRef = React.useRef(false);
    const followGrowthRef = React.useRef(false);
    const previousRunRef = React.useRef<{ runId: string; revision: number } | null>(null);
    const [awayFromLatest, setAwayFromLatest] = React.useState(false);
    const endedAt = run.finishedAt ?? now;
    const state = subagentStateLabel(run.state);
    const resultText = run.terminalMarkdown ?? run.latestText;
    const projectionNotices = subagentProjectionNotices(run);
    const active =
      run.state === "queued" ||
      run.state === "starting" ||
      run.state === "running" ||
      run.state === "needs_attention";
    const canStop = run.version === 2 && run.execution === "foreground" && active && onStop;
    const stopLabel = run.version === 2 && run.depth === 1 ? "Stop subtree" : "Stop subagent";
    const invokeControl = async () => {
      if (stopPending) return;
      if (!onStop) return;
      try {
        await onStop(run);
      } catch {
        // The owner boundary retains and presents control failures. A detail
        // instance must not create a second, selection-scoped error source.
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
      const next = { runId: run.runId, revision: run.revision };
      const action = subagentDetailGrowthAction(
        previousRunRef.current,
        next,
        userNavigatedRef.current,
      );
      previousRunRef.current = next;
      if (action === "reset") {
        userNavigatedRef.current = false;
        followGrowthRef.current = false;
        element.scrollTop = 0;
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
    }, [run.revision, run.runId, updateScrollPosition]);

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

    return (
      <article className={cn("relative flex h-full min-h-0 flex-col", className)}>
        <div
          ref={scrollRef}
          onScroll={updateScrollPosition}
          onWheel={markUserNavigation}
          onPointerDownCapture={markUserNavigation}
          onKeyDown={markUserNavigation}
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-20 pt-4"
          data-subagent-scroll-region="true"
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            <header className="flex min-w-0 items-start gap-2.5">
              <SubagentOrb
                role={run.role}
                state={run.state}
                activity={run.activity}
                className="mt-0.5"
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
                  {run.role} · {presentation?.label ?? state} ·{" "}
                  {formatSubagentElapsed(run.startedAt, endedAt)}
                </Text>
                <Text
                  as="p"
                  variant="small"
                  color="tertiary"
                  className="mt-0.5 break-words [overflow-wrap:anywhere]"
                >
                  Model: {run.modelId}
                </Text>
                {run.version === 2 ? (
                  <Text
                    as="p"
                    variant="small"
                    color="tertiary"
                    className="mt-0.5 break-words"
                    data-subagent-context={run.context}
                  >
                    {run.context === "fresh"
                      ? "Context: task only (fresh session)"
                      : "Context: bounded visible conversation text copied at launch"}
                  </Text>
                ) : null}
              </span>
            </header>

            {presentation?.state === "saving" || presentation?.state === "save_delayed" ? (
              <Callout role="note" data-subagent-presentation={presentation.state}>
                <Text variant="small-strong">
                  {presentation.state === "saving"
                    ? "Recording subagent outcome"
                    : "Outcome not yet saved"}
                </Text>
                <Text as="p" variant="small" color="secondary">
                  {state}.{" "}
                  {presentation.state === "saving"
                    ? "Aiden is waiting for this outcome to appear in conversation history."
                    : "This outcome has not appeared in conversation history yet."}
                </Text>
              </Callout>
            ) : presentation?.state === "stale_active" ? (
              <Callout role="note" data-subagent-presentation="stale_active">
                <Text variant="small-strong">No recent update</Text>
                <Text as="p" variant="small" color="secondary">
                  {presentation.label}. The child is still active; no newer activity has arrived.
                </Text>
              </Callout>
            ) : null}

            {refreshing ? (
              <Text as="p" variant="small" color="secondary" data-subagent-detail-refreshing="true">
                Refreshing saved activity…
              </Text>
            ) : refreshError ? (
              <Callout role="note" data-subagent-detail-refresh-error="true">
                <Text variant="small-strong">Showing the last available activity</Text>
                <Text as="p" variant="small" color="secondary">
                  Aiden could not refresh this saved detail. The activity below may be out of date.
                </Text>
                {onRetryRefresh ? (
                  <Button
                    variant="muted"
                    size="small"
                    radius="rounded"
                    onClick={onRetryRefresh}
                    className="mt-3 motion-reduce:transition-none"
                  >
                    Retry refresh
                  </Button>
                ) : null}
              </Callout>
            ) : null}

            {canStop ? (
              <div
                className="flex min-w-0 flex-wrap items-center gap-2"
                data-subagent-controls="true"
              >
                <Button
                  variant="muted"
                  size="small"
                  radius="rounded"
                  disabled={stopPending}
                  aria-label={stopPending ? `Stopping ${run.label}` : `${stopLabel} ${run.label}`}
                  aria-busy={stopPending ? true : undefined}
                  onClick={() => void invokeControl()}
                  className="motion-reduce:transition-none"
                >
                  <Square aria-hidden="true" className="size-3" />
                  {stopPending ? "Stopping…" : stopLabel}
                </Button>
              </div>
            ) : null}

            {stopError ? (
              <Callout color="red" role="note" data-subagent-control-error="true">
                <Text variant="small-strong" color="red">
                  Subagent action failed
                </Text>
                <Text as="p" variant="small" color="secondary">
                  {stopError} Try again if the run is still available.
                </Text>
              </Callout>
            ) : null}

            <section aria-labelledby={`subagent-task-${run.runId}`}>
              <div className="flex min-w-0 items-center gap-2">
                <Text
                  as="h3"
                  id={`subagent-task-${run.runId}`}
                  variant="small-strong"
                  color="tertiary"
                  className="min-w-0 flex-1"
                >
                  Task preview
                </Text>
                <CopyButton
                  text={run.taskPreview}
                  label={`Copy task preview for ${run.label}`}
                  className="shrink-0"
                />
              </div>
              <Text as="p" variant="regular" className="mt-1 break-words [overflow-wrap:anywhere]">
                {run.taskPreview}
              </Text>
            </section>

            {projectionNotices.length > 0 ? (
              <Callout role="note" data-subagent-projection-notice="true">
                <Text variant="small-strong">Saved view notice</Text>
                <ul className="list-disc space-y-1 pl-4 text-small text-secondary">
                  {projectionNotices.map((notice) => (
                    <li key={notice}>{notice}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            <section aria-labelledby={`subagent-activity-${run.runId}`}>
              <Text
                as="h3"
                id={`subagent-activity-${run.runId}`}
                variant="small-strong"
                color="tertiary"
              >
                Latest activity
              </Text>
              <Text as="p" variant="regular" color="secondary" className="mt-1 break-words">
                {run.activity ?? state}
              </Text>
            </section>

            {effectActivity.length > 0 ? (
              <section
                aria-labelledby={`subagent-effects-${run.runId}`}
                data-subagent-effect-activity="true"
              >
                <Text
                  as="h3"
                  id={`subagent-effects-${run.runId}`}
                  variant="small-strong"
                  color="tertiary"
                >
                  External effects
                </Text>
                <ol className="mt-1 space-y-2">
                  {effectActivity.map((effect, index) => (
                    <li
                      key={`${effect.updatedAt}:${effect.kind}:${effect.state}:${index}`}
                      data-subagent-effect-kind={effect.kind}
                      data-subagent-effect-state={effect.state}
                      className="rounded-card bg-well px-3 py-2"
                    >
                      <Text as="p" variant="small-strong">
                        {effect.label}
                      </Text>
                      <Text as="p" variant="small" color="secondary">
                        {effect.kind === "shell" ? "Command" : "Remote change"} · State:{" "}
                        {effect.state.replace(/_/gu, " ")}
                      </Text>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <details className="group/milestones rounded-card bg-well">
              <summary className="flex cursor-default list-none items-center gap-2 rounded-card px-3 py-2 outline-none transition-colors hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none motion-reduce:transition-none">
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-tertiary transition-transform duration-150 group-open/milestones:rotate-90 motion-reduce:transition-none"
                />
                <Text variant="small-strong">
                  {subagentToolAggregate(run)} · {subagentMilestoneAggregate(run)}
                </Text>
              </summary>
              <div className="space-y-2 border-t border-separator px-3 py-2">
                {run.milestones?.length ? (
                  <ol className="list-decimal space-y-1 pl-5 text-small text-secondary">
                    {run.milestones.map((milestone, index) => (
                      <li key={`${index}:${milestone}`}>{subagentMilestoneLabel(milestone)}</li>
                    ))}
                  </ol>
                ) : (
                  <Text as="p" variant="small" color="secondary">
                    No saved activity milestones.
                  </Text>
                )}
                <Text as="p" variant="small" color="secondary">
                  {run.tokens} tokens recorded. Saved details omit raw tool payloads, commands, and
                  absolute paths. Children can read ordinary source and docs as written; protected
                  credential and private-key paths are unavailable.
                </Text>
              </div>
            </details>

            {run.error ? (
              <Callout color="red" role="note">
                <Text variant="small-strong" color="red">
                  Subagent failed
                </Text>
                <Text as="p" variant="small" color="secondary">
                  {run.error}
                </Text>
              </Callout>
            ) : null}

            {run.warnings.length > 0 ? (
              <Callout role="note" className="bg-status-warning-surface">
                <Text variant="small-strong" className="text-support-warning">
                  {run.warnings.length === 1 ? "Warning" : "Warnings"}
                </Text>
                <ul className="list-disc space-y-1 pl-4 text-small text-secondary">
                  {run.warnings.map((warning, index) => (
                    <li key={`${index}:${warning}`}>{warning}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            {resultText ? (
              <section aria-labelledby={`subagent-result-${run.runId}`}>
                <div className="mb-2 flex min-w-0 items-center gap-2">
                  <Text
                    as="h3"
                    id={`subagent-result-${run.runId}`}
                    variant="small-strong"
                    color="tertiary"
                    className="min-w-0 flex-1"
                  >
                    Result
                  </Text>
                  <CopyButton
                    text={resultText}
                    label={`Copy result from ${run.label}`}
                    className="shrink-0"
                  />
                </div>
                <ErrorBoundary
                  resetKey={`${run.runId}:${run.revision}`}
                  fallback={<UnrenderableSubagentUpdate content={resultText} />}
                >
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <Markdown content={resultText} />
                  </div>
                </ErrorBoundary>
              </section>
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
      </article>
    );
  },
);
