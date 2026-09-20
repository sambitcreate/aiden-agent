// Live account of what the agent is doing. While a turn runs the feed is a
// three-row ticker with stable row identities and quiet, opacity-only arrivals. When the turn settles it collapses to one deterministic
// summary of the work, expandable to the full trail.

import * as React from "react";
import { ChevronRight, CircleAlert } from "lucide-react";
import { Text } from "./ui";
import { ThoughtDisclosure } from "./thought-disclosure";
import {
  activityIssueCount,
  activityLine,
  activityLineText,
  summarizeActivity,
  workGroupSummary,
  type ActivityLine,
} from "../lib/agent-steps";
import { reasoningSegmentText } from "../lib/assistant-message-presentation";
import {
  isToolStep,
  type AgentStep,
  type AgentThinkingStep,
  type GenerationTimeline,
} from "../shared/generation-timeline";

const EXIT_MS = 180;
/** Rows kept in the collapsed ticker. The topmost sits under the fade mask. */
const TICKER_ROWS = 3;
const LIVE_THOUGHT_TAIL_CHARS = 80;

function toneClass(tone: ActivityLine["tone"]): string {
  if (tone === "error") return "text-red";
  if (tone === "warning") return "text-support-warning";
  return "text-secondary";
}

function compactLineCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/u, "") : Math.round(millions)}m`;
}

function LineChanges({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      className="ml-1 inline-flex whitespace-nowrap font-mono text-[0.9em] font-medium tabular-nums"
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="text-support-green">+{compactLineCount(additions)}</span>
      <span className="ml-1 text-support-red">−{compactLineCount(deletions)}</span>
    </span>
  );
}

function StepLine({ step }: { step: AgentStep }) {
  const line = activityLine(step);
  return (
    <>
      <span className={`${toneClass(line.tone)} font-medium`}>{line.verb}</span>
      {line.object ? <span className="font-normal text-tertiary"> {line.object}</span> : null}
      {isToolStep(step) && step.lineChanges ? <LineChanges {...step.lineChanges} /> : null}
    </>
  );
}

/** Live tail of an in-flight thought, normalized to one ticker line. */
function liveThoughtTail(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return undefined;
  return flat.length > LIVE_THOUGHT_TAIL_CHARS ? `…${flat.slice(-LIVE_THOUGHT_TAIL_CHARS)}` : flat;
}

/** A single fixed-height ticker row. Height must stay in step with the CSS shift. */
function TickerRow({ step, liveThoughtText }: { step: AgentStep; liveThoughtText?: string }) {
  // A pending tool step is the model still writing the call's arguments, so
  // it shimmers like any other work in progress. Approval waits do not.
  const active = !isToolStep(step)
    ? step.finishedAt === undefined
    : step.status === "pending" || step.status === "running";
  const thinkingPreview = liveThoughtText !== undefined;
  return (
    <div className="activity-feed-row flex h-6 min-w-0 items-center">
      <span
        className={`activity-feed-detail-label min-w-0 truncate text-mini text-secondary ${
          active ? "agent-thinking-shimmer" : ""
        }`}
      >
        {thinkingPreview ? (
          <>
            <span className="font-medium">Thinking</span>
            <span className="font-normal text-tertiary"> · {liveThoughtText}</span>
          </>
        ) : (
          <StepLine step={step} />
        )}
      </span>
    </div>
  );
}

function TrailRow({
  step,
  reasoning,
  streaming,
}: {
  step: AgentStep;
  reasoning?: string | null;
  streaming?: boolean;
}) {
  if (!isToolStep(step)) {
    const text = reasoningSegmentText(reasoning, step as AgentThinkingStep);
    // Segments with no exposed text keep the plain thinking milestone row.
    if (text?.trim()) {
      return (
        <ThoughtDisclosure step={step as AgentThinkingStep} text={text} streaming={streaming} />
      );
    }
  }
  return (
    <div className="flex min-h-5 min-w-0 items-start py-px" role="listitem">
      <span className="activity-feed-detail-label min-w-0 break-words text-mini text-secondary">
        <StepLine step={step} />
      </span>
    </div>
  );
}

export function ActivityFeed({
  timeline,
  reasoning,
  animate = true,
  streaming = false,
}: {
  timeline: GenerationTimeline | null;
  /** Canonical reasoning buffer; only sliced when the group has thinking steps. */
  reasoning?: string | null;
  animate?: boolean;
  /** The owning turn is still streaming, so live thoughts may preview. */
  streaming?: boolean;
}) {
  const [visible, setVisible] = React.useState(timeline);
  const [exiting, setExiting] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const autoOpenKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (timeline) {
      setVisible(timeline);
      setExiting(false);
      // The ticker already narrates a healthy run, so only an outcome the user
      // has to act on forces the full trail open.
      const attention = Boolean(timeline.claimCheck) || activityIssueCount(timeline) > 0;
      const autoOpenKey = `${timeline.generationId}:${timeline.claimCheck ? "claim" : "issue"}`;
      if (attention && autoOpenKeyRef.current !== autoOpenKey) {
        autoOpenKeyRef.current = autoOpenKey;
        setOpen(true);
      }
      return;
    }
    if (!visible) return;
    if (document.documentElement.dataset.reduceMotion === "true") {
      setVisible(null);
      setExiting(false);
      return;
    }
    setExiting(true);
    const timer = window.setTimeout(() => {
      setVisible(null);
      setExiting(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [timeline, visible]);

  if (!visible?.steps.length) return null;
  const running = visible.status === "running";
  const showTicker = running && !open;
  const rows = visible.steps.slice(-TICKER_ROWS);
  const newest = visible.steps[visible.steps.length - 1];
  const issues = activityIssueCount(visible);
  const hasThoughts = visible.steps.some((step) => !isToolStep(step));
  const openThought =
    running && newest !== undefined && !isToolStep(newest) && newest.finishedAt === undefined
      ? newest
      : undefined;
  const openThoughtText = openThought
    ? reasoningSegmentText(reasoning, openThought)?.trim()
    : undefined;
  const newestIsOpenThought = newest !== undefined && openThought === newest;
  const summaryLabel = hasThoughts ? workGroupSummary(visible) : summarizeActivity(visible);

  return (
    <>
      <details
        className="activity-feed group/activity min-w-0"
        data-presence={exiting ? "exiting" : "visible"}
        data-animate={animate ? "true" : "false"}
        data-state={open ? "open" : "closed"}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          className={`-mx-1.5 flex min-w-0 list-none gap-2 rounded-control px-1.5 py-0.5 outline-none transition-colors hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none ${
            showTicker ? "items-end" : "items-center"
          }`}
        >
          {showTicker ? (
            <div
              className="activity-feed-window min-w-0 flex-1 overflow-hidden"
              data-masked={rows.length === TICKER_ROWS ? "true" : "false"}
              role="status"
              aria-live="polite"
              aria-label={activityLineText(newest ?? visible.steps[0]!)}
            >
              <div className="activity-feed-stack flex flex-col">
                {rows.map((step) => (
                  <TickerRow
                    key={step.id}
                    step={step}
                    liveThoughtText={
                      newestIsOpenThought && step === newest
                        ? liveThoughtTail(openThoughtText)
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          ) : (
            <Text
              variant="small-strong"
              color="secondary"
              className={`activity-feed-summary-label min-w-0 flex-1 truncate ${
                running ? "agent-thinking-shimmer" : ""
              }`}
            >
              {summaryLabel}
            </Text>
          )}
          {issues ? (
            <Text variant="small-strong" className="shrink-0 text-support-warning">
              {issues === 1 ? "1 issue" : `${issues} issues`}
            </Text>
          ) : null}
          <ChevronRight
            className="agent-activity-chevron size-3.5 shrink-0 text-tertiary transition-transform group-open/activity:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-0.5 flex flex-col">
          <div className="flex flex-col" role="list">
            {visible.steps.map((step) => (
              <TrailRow
                key={step.id}
                step={step}
                reasoning={reasoning}
                streaming={streaming && running}
              />
            ))}
          </div>
          {visible.claimCheck ? (
            <div
              className="mt-1.5 flex items-start gap-2 rounded-control bg-status-warning-surface px-2.5 py-2"
              role={animate ? "alert" : "note"}
            >
              <CircleAlert
                className="mt-0.5 size-3.5 shrink-0 text-status-warning"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <Text as="span" variant="small-strong" className="block text-status-warning">
                  Success not verified
                </Text>
                <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                  A required action or check did not complete. Review the issues above before
                  relying on this response.
                </Text>
              </span>
            </div>
          ) : null}
        </div>
      </details>
      {openThoughtText && !open ? (
        <div
          className="scroll-edge-mask mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-card bg-well px-3 py-2 text-mini leading-relaxed text-secondary outline-none"
          aria-label="Thinking"
        >
          {openThoughtText}
        </div>
      ) : null}
    </>
  );
}
