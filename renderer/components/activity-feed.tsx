// Live account of what the agent is doing. While a turn runs the feed is a
// three-row ticker with stable row identities and quiet, opacity-only arrivals. When the turn settles it collapses to one deterministic
// summary of the work, expandable to the full trail.

import * as React from "react";
import { ChevronRight, CircleAlert } from "lucide-react";
import { Text } from "./ui";
import {
  activityIssueCount,
  activityLine,
  activityLineText,
  isCompactContextOnly,
  summarizeActivity,
  type ActivityLine,
} from "../lib/agent-steps";
import { isToolStep, type AgentStep, type GenerationTimeline } from "../shared/generation-timeline";

const EXIT_MS = 180;
/** Rows kept in the collapsed ticker. The topmost sits under the fade mask. */
const TICKER_ROWS = 3;

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
      {isToolStep(step) && step.producedFile ? (
        <span className="ml-2 rounded-control bg-list-hover px-2 py-0.5 text-mini text-secondary" title={step.producedFile.relativePath}>
          File {step.producedFile.operation} · {step.producedFile.relativePath.split("/").pop()}
        </span>
      ) : null}
    </>
  );
}

/** A single fixed-height ticker row. Height must stay in step with the CSS shift. */
function TickerRow({ step }: { step: AgentStep }) {
  // A pending tool step is the model still writing the call's arguments, so
  // it shimmers like any other work in progress. Approval waits do not.
  const active = !isToolStep(step)
    ? step.finishedAt === undefined
    : step.status === "pending" || step.status === "running";
  return (
    <div className="activity-feed-row flex h-6 min-w-0 items-center">
      <span
        className={`activity-feed-detail-label min-w-0 truncate text-mini text-secondary ${
          active ? "agent-thinking-shimmer" : ""
        }`}
      >
        <StepLine step={step} />
      </span>
    </div>
  );
}

function TrailRow({ step }: { step: AgentStep }) {
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
  animate = true,
}: {
  timeline: GenerationTimeline | null;
  animate?: boolean;
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
  const issues = activityIssueCount(visible);
  const compactOnly = isCompactContextOnly(visible.steps);
  // A healthy lone compaction is fully told by its own line in the header, so a
  // trail would only repeat it. A claim check still needs the disclosure body.
  const stepInHeader = compactOnly && issues === 0;
  const disclosure = !stepInHeader || Boolean(visible.claimCheck);
  const showTicker = running && (!open || !disclosure);
  const rows = visible.steps.slice(-TICKER_ROWS);
  const newest = visible.steps[visible.steps.length - 1];
  const presence = exiting ? "exiting" : "visible";
  const header = (
    <>
      {showTicker && newest ? (
        <div
          className="activity-feed-window min-w-0 flex-1 overflow-hidden"
          data-masked={rows.length === TICKER_ROWS ? "true" : "false"}
          role="status"
          aria-live="polite"
          aria-label={activityLineText(newest)}
        >
          <div className="activity-feed-stack flex flex-col">
            {rows.map((step) => (
              <TickerRow key={step.id} step={step} />
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
          {stepInHeader && newest ? (
            <StepLine step={newest} />
          ) : (
            summarizeActivity(visible)
          )}
        </Text>
      )}
      {issues ? (
        <Text variant="small-strong" className="shrink-0 text-support-warning">
          {issues === 1 ? "1 issue" : `${issues} issues`}
        </Text>
      ) : null}
    </>
  );

  if (!disclosure) {
    return (
      <div
        className="activity-feed min-w-0"
        data-presence={presence}
        data-animate={animate ? "true" : "false"}
        data-state="closed"
      >
        <div
          className={`-mx-1.5 flex min-w-0 gap-2 rounded-control px-1.5 py-0.5 ${
            showTicker ? "items-end" : "items-center"
          }`}
        >
          {header}
        </div>
      </div>
    );
  }

  return (
    <details
      className="activity-feed group/activity min-w-0"
      data-presence={presence}
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
        {header}
        <ChevronRight
          className="agent-activity-chevron size-3.5 shrink-0 text-tertiary transition-transform group-open/activity:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-0.5 flex flex-col">
        {stepInHeader ? null : (
          <div className="flex flex-col" role="list">
            {visible.steps.map((step) => (
              <TrailRow key={step.id} step={step} />
            ))}
          </div>
        )}
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
                A required action or check did not complete. Review the issues above before relying
                on this response.
              </Text>
            </span>
          </div>
        ) : null}
      </div>
    </details>
  );
}
