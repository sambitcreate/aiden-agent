import * as React from "react";
import { ArrowDownToLine, Square } from "lucide-react";
import { cn } from "../lib/ui-utils";
import { useSubagentScrollFollow } from "../lib/use-subagent-scroll-follow";
import { SUBAGENT_HELPER_TONE_DOT, subagentHelperTone } from "../lib/subagent-helper-chat-state";
import { subagentModelLine, useSubagentModelCatalog } from "../lib/subagent-model-name";
import { subagentRoleLabel, type SubagentRunPresentation } from "../lib/subagent-view-state";
import {
  subagentPendingQuestion,
  type SubagentEffectActivityV1,
  type SubagentMilestoneKind,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import {
  subagentContextIsApproachingLimit,
  subagentContextUsageLabels,
  type SubagentContextUsageV1,
} from "../shared/subagent-context-usage";
import { Markdown } from "./markdown";
import { subagentStateLabel } from "./subagent-chips";
import { Button, Callout, ErrorBoundary, Text } from "./ui";
import { CopyButton } from "./copy-button";

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

const SUBAGENT_MILESTONE_LABELS: Record<SubagentMilestoneKind, string> = {
  reading: "Read a file",
  listing: "Looked in a folder",
  matching: "Found files by name",
  searching: "Searched the files",
  inspecting: "Used a tool",
  composing: "Wrote its report",
};

/**
 * What a step says in a helper's list of what it did. `inProgress` marks the
 * newest step of a helper that is still working: its report is still being written.
 */
export function subagentMilestoneLabel(
  milestone: SubagentMilestoneKind,
  options: { inProgress?: boolean } = {},
): string {
  if (milestone === "composing" && options.inProgress) return "Writing its report";
  return SUBAGENT_MILESTONE_LABELS[milestone];
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

function subagentContextSummary(usage: SubagentContextUsageV1): string {
  const labels = subagentContextUsageLabels(usage);
  return `Context window: ${labels.amount} (${labels.percent})`;
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
  /**
   * What could not be read: a saved message's run detail, or a helper's
   * saved conversation (the helper chat's own wording, so both read alike).
   */
  refreshErrorKind?: "detail" | "conversation";
  onRetryRefresh?: () => void;
  now?: number;
  /** Live context reading; supplied only while the run is active. */
  contextUsage?: SubagentContextUsageV1;
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
      refreshErrorKind = "detail",
      onRetryRefresh,
      now = Date.now(),
      contextUsage,
    },
    headingRef,
  ) {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const endedAt = run.finishedAt ?? now;
    const state = subagentStateLabel(run.state);
    const modelLine = subagentModelLine(run, useSubagentModelCatalog());
    const role = subagentRoleLabel(run.role);
    const tone = subagentHelperTone(run.state);
    const pendingQuestion = subagentPendingQuestion(run);
    const resultText = run.terminalMarkdown ?? run.latestText;
    const milestones = run.milestones ?? [];
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
    const {
      awayFromLatest,
      updateScrollPosition,
      markUserNavigation,
      jumpToLatest: jumpScrollToLatest,
    } = useSubagentScrollFollow({
      scrollRef,
      runId: run.runId,
      revision: run.revision,
      onReset: "top",
    });

    const jumpToLatest = () => {
      const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
      jumpScrollToLatest(reduceMotion ? "auto" : "smooth");
    };

    const staleActive = presentation?.state === "stale_active";
    const stopButton = canStop ? (
      <Button
        variant="muted"
        size="small"
        disabled={stopPending}
        aria-label={stopPending ? `Stopping ${run.label}` : `${stopLabel} ${run.label}`}
        aria-busy={stopPending ? true : undefined}
        onClick={() => void invokeControl()}
        className="motion-reduce:transition-none"
      >
        <Square aria-hidden="true" className="size-3" />
        {stopPending ? "Stopping…" : stopLabel}
      </Button>
    ) : null;

    return (
      <article className="relative flex h-full min-h-0 flex-col">
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
              <span
                aria-hidden="true"
                className={cn("mt-2 size-2 shrink-0 rounded-full", SUBAGENT_HELPER_TONE_DOT[tone])}
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
                  {presentation?.label ?? state} ·{" "}
                  <span className="tabular-nums">{formatSubagentElapsed(run.startedAt, endedAt)}</span>
                </Text>
                <Text
                  as="p"
                  variant="small"
                  color="tertiary"
                  className="mt-0.5 break-words [overflow-wrap:anywhere]"
                  data-subagent-detail-model="true"
                >
                  {modelLine}
                </Text>
                {contextUsage ? (
                  <Text
                    as="p"
                    variant="small"
                    color="tertiary"
                    className={cn(
                      "mt-0.5 tabular-nums",
                      subagentContextIsApproachingLimit(contextUsage) && "text-support-warning",
                    )}
                    data-subagent-detail-context-usage="true"
                  >
                    {subagentContextSummary(contextUsage)}
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
                {stopButton ? (
                  <div className="mt-3 flex min-w-0" data-subagent-controls="true">
                    {stopButton}
                  </div>
                ) : null}
              </Callout>
            ) : null}

            {refreshing ? (
              <Text as="p" variant="small" color="secondary" data-subagent-detail-refreshing="true">
                Refreshing saved activity…
              </Text>
            ) : refreshError && refreshErrorKind === "conversation" ? (
              <Callout role="note" data-subagent-helper-refresh-error="true">
                <Text as="p" variant="small" color="secondary">
                  Couldn't load this helper's conversation. What's shown may be out of date.
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
                    onClick={onRetryRefresh}
                    className="mt-3 motion-reduce:transition-none"
                  >
                    Retry refresh
                  </Button>
                ) : null}
              </Callout>
            ) : null}

            {stopButton && !staleActive ? (
              <div
                className="flex min-w-0 flex-wrap items-center gap-2"
                data-subagent-controls="true"
              >
                {stopButton}
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
                  What it was asked
                </Text>
                <CopyButton
                  text={run.taskPreview}
                  label={`Copy what ${run.label} was asked`}
                  className="shrink-0"
                />
              </div>
              <Text as="p" variant="regular" className="mt-1 break-words [overflow-wrap:anywhere]">
                {run.taskPreview}
              </Text>
            </section>

            {active || pendingQuestion ? (
              <section aria-labelledby={`subagent-activity-${run.runId}`}>
                <Text
                  as="h3"
                  id={`subagent-activity-${run.runId}`}
                  variant="small-strong"
                  color="tertiary"
                >
                  {pendingQuestion ? "Waiting on" : "Latest activity"}
                </Text>
                <Text as="p" variant="regular" color="secondary" className="mt-1 break-words">
                  {run.activity ?? state}
                </Text>
              </section>
            ) : null}

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

            {milestones.length ? (
              <section aria-labelledby={`subagent-did-${run.runId}`} data-subagent-did="true">
                <Text
                  as="h3"
                  id={`subagent-did-${run.runId}`}
                  variant="small-strong"
                  color="tertiary"
                >
                  What it did
                </Text>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-small text-secondary">
                  {milestones.map((milestone, index) => (
                    <li key={`${index}:${milestone}`}>
                      {subagentMilestoneLabel(milestone, {
                        inProgress: active && index === milestones.length - 1,
                      })}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

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
                    <Markdown content={resultText} imageScope={run.runId} />
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
