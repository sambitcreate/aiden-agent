import * as React from "react";
import { ChevronRight } from "lucide-react";
import { ActivityFeed } from "../../components/activity-feed";
import { Text } from "../../components/ui";
import type { GenerationTimeline } from "../../shared/generation-timeline";

/**
 * One quiet line that holds everything a Bot did on the way to its answer:
 * tool activity and any narration before the final reply. Collapsed by
 * default; "Working…" while the reply is still running.
 */
export function BotUpdates({
  progressText,
  timeline,
  active,
}: {
  progressText: string;
  /** Tool steps only; empty or null when the Bot used no tools. */
  timeline: GenerationTimeline | null;
  active: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const regionId = React.useId();
  const hasActivity = Boolean(timeline && timeline.steps.length > 0);
  if (!progressText && !hasActivity && !active) return null;
  return (
    <div className="min-w-0" data-bot-updates>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-control px-1 py-0.5 text-small text-secondary outline-none transition-colors duration-150 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <span className={active ? "agent-thinking-shimmer" : undefined}>
          {active ? "Working…" : "Updates"}
        </span>
      </button>
      {open ? (
        <div id={regionId} role="region" aria-label="Updates" className="mt-2 space-y-2 pl-5">
          {hasActivity ? <ActivityFeed timeline={timeline} animate={active} /> : null}
          {progressText ? (
            <Text as="p" variant="small" color="secondary" className="whitespace-pre-wrap break-words">
              {progressText}
            </Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
