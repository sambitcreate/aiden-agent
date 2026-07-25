// Live account of what the agent is doing. While a turn runs the feed is a
// three-row ticker: the newest line rises in from below and older lines drift
// up under a fade mask. When the turn settles it collapses to one deterministic
// summary of the work, expandable to the full trail.

import * as React from "react";
import { ChevronRight, CircleAlert } from "lucide-react";
import { Text } from "./ui";
import {
  activityIssueCount,
  activityLine,
  activityLineText,
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

function StepLine({ step }: { step: AgentStep }) {
  const line = activityLine(step);
  return (
    <>
      <span className={toneClass(line.tone)}>{line.verb}</span>
      {line.object ? <span className="text-tertiary"> {line.object}</span> : null}
    </>
  );
}

/** A single fixed-height ticker row. Height must stay in step with the CSS shift. */
function TickerRow({ step }: { step: AgentStep }) {
  const active = !isToolStep(step) ? step.finishedAt === undefined : step.status === "running";
  return (
    <div className="activity-feed-row flex h-6 min-w-0 items-center">
      <Text
        variant="small"
        color="secondary"
        className={`min-w-0 truncate ${active ? "agent-thinking-shimmer" : ""}`}
      >
        <StepLine step={step} />
      </Text>
    </div>
  );
}

function TrailRow({ step }: { step: AgentStep }) {
  return (
    <div className="flex min-h-6 min-w-0 items-start py-px" role="listitem">
      <Text variant="small" color="secondary" className="min-w-0 break-words">
        <StepLine step={step} />
      </Text>
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
  const showTicker = running && !open;
  const rows = visible.steps.slice(-TICKER_ROWS);
  const newest = visible.steps[visible.steps.length - 1];
  const issues = activityIssueCount(visible);

  return (
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
        {showTicker && newest ? (
          <div
            className="activity-feed-window min-w-0 flex-1 overflow-hidden"
            data-masked={rows.length === TICKER_ROWS ? "true" : "false"}
            role="status"
            aria-live="polite"
            aria-label={activityLineText(newest)}
          >
            <div className="activity-feed-stack flex flex-col" key={newest.id}>
              {rows.map((step) => (
                <TickerRow key={step.id} step={step} />
              ))}
            </div>
          </div>
        ) : (
          <Text
            variant="small"
            color="secondary"
            className={`min-w-0 flex-1 truncate ${running ? "agent-thinking-shimmer" : ""}`}
          >
            {summarizeActivity(visible)}
          </Text>
        )}
        {issues ? (
          <Text variant="small" className="shrink-0 text-support-warning">
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
            <TrailRow key={step.id} step={step} />
          ))}
        </div>
        {visible.claimCheck ? (
          <div
            className="mt-1.5 flex items-start gap-2 rounded-control bg-support-warning/[0.08] px-2.5 py-2"
            role={animate ? "alert" : "note"}
          >
            <CircleAlert
              className="mt-0.5 size-3.5 shrink-0 text-support-warning"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <Text as="span" variant="small-strong" className="block text-support-warning">
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
