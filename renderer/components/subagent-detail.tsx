import * as React from "react";
import { ArrowDownToLine, ChevronRight, Square } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  subagentDetailGrowthAction,
  subagentDetailIsAwayFromLatest,
} from "../lib/subagent-panel-state";
import type {
  SubagentEffectActivityV1,
  SubagentMilestoneKind,
  SubagentRunSnapshot,
} from "../shared/subagent-runs";
import { Markdown } from "./markdown";
import { SubagentOrb, subagentStateLabel } from "./subagent-chips";
import { Button, Callout, ErrorBoundary, Text } from "./ui";

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
  now?: number;
  className?: string;
}

export const SubagentDetail = React.forwardRef<HTMLHeadingElement, SubagentDetailProps>(
  function SubagentDetail(
    { run, effectActivity = [], onStop, now = Date.now(), className },
    headingRef,
  ) {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const userNavigatedRef = React.useRef(false);
    const followGrowthRef = React.useRef(false);
    const previousRunRef = React.useRef<{ runId: string; revision: number } | null>(null);
    const [awayFromLatest, setAwayFromLatest] = React.useState(false);
    const [controlPending, setControlPending] = React.useState<"stop" | null>(null);
    const [controlError, setControlError] = React.useState<string | null>(null);
    const endedAt = run.finishedAt ?? now;
    const state = subagentStateLabel(run.state);
    const active =
      run.state === "queued" ||
      run.state === "starting" ||
      run.state === "running" ||
      run.state === "needs_attention";
    const canStop = run.version === 2 && run.execution === "foreground" && active && onStop;
    const stopLabel = run.version === 2 && run.depth === 1 ? "Stop subtree" : "Stop subagent";
    const invokeControl = async () => {
      if (controlPending) return;
      if (!onStop) return;
      setControlPending("stop");
      setControlError(null);
      try {
        await onStop(run);
      } catch (error) {
        setControlError(
          error instanceof Error ? error.message : "Aiden could not stop this subagent.",
        );
      } finally {
        setControlPending(null);
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
                  {run.role} · {state} · {formatSubagentElapsed(run.startedAt, endedAt)}
                </Text>
                <Text as="p" variant="small" color="tertiary" className="mt-0.5 break-words">
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
                    {run.context === "fresh" ? "Fresh context" : "Forked conversation"}
                  </Text>
                ) : null}
              </span>
            </header>

            {canStop ? (
              <div
                className="flex min-w-0 flex-wrap items-center gap-2"
                data-subagent-controls="true"
              >
                <Button
                  variant="muted"
                  size="small"
                  radius="rounded"
                  disabled={controlPending !== null}
                  aria-label={`${stopLabel} ${run.label}`}
                  onClick={() => void invokeControl()}
                  className="motion-reduce:transition-none"
                >
                  <Square aria-hidden="true" className="size-3" />
                  {controlPending === "stop" ? "Stopping…" : stopLabel}
                </Button>
              </div>
            ) : null}

            {controlError ? (
              <Callout color="red" role="alert" data-subagent-control-error="true">
                <Text variant="small-strong" color="red">
                  Subagent action failed
                </Text>
                <Text as="p" variant="small" color="secondary">
                  {controlError} Try again if the run is still available.
                </Text>
              </Callout>
            ) : null}

            <section aria-labelledby={`subagent-task-${run.runId}`}>
              <Text
                as="h3"
                id={`subagent-task-${run.runId}`}
                variant="small-strong"
                color="tertiary"
              >
                Task
              </Text>
              <Text as="p" variant="regular" className="mt-1 break-words">
                {run.taskPreview}
              </Text>
            </section>

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
                        {effect.kind === "shell" ? "Command" : "Remote change"} · State: {effect.state.replace(/_/gu, " ")}
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
                  {run.tokens} tokens recorded. Tool arguments, results, commands, and paths stay
                  private.
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
              <Callout role="note" className="border border-support-warning/25">
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

            {run.terminalMarkdown ? (
              <section aria-labelledby={`subagent-result-${run.runId}`}>
                <Text
                  as="h3"
                  id={`subagent-result-${run.runId}`}
                  variant="small-strong"
                  color="tertiary"
                  className="mb-2"
                >
                  Result
                </Text>
                <ErrorBoundary
                  resetKey={`${run.runId}:${run.revision}`}
                  fallback={<UnrenderableSubagentUpdate content={run.terminalMarkdown} />}
                >
                  <Markdown content={run.terminalMarkdown} />
                </ErrorBoundary>
              </section>
            ) : run.latestText ? (
              <section aria-labelledby={`subagent-result-${run.runId}`}>
                <Text
                  as="h3"
                  id={`subagent-result-${run.runId}`}
                  variant="small-strong"
                  color="tertiary"
                >
                  Result
                </Text>
                <ErrorBoundary
                  resetKey={`${run.runId}:${run.revision}:latest`}
                  fallback={<UnrenderableSubagentUpdate content={run.latestText} />}
                >
                  <Markdown content={run.latestText} />
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
