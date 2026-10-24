// One collapsed account of a turn's steps (spec §6). Summary: closed. Detailed:
// open while the turn runs (its last three steps, the active one shimmering)
// and folded when the reply lands. A manual open or close sticks. Tones reuse
// the activity feed's tokens; red is a failure, amber a refusal, and a step the
// person stopped stays neutral.

import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { BotChatActivityLevel } from "../../shared/bots";
import type { WorkDetailsMode } from "../../shared/appearance";
import {
  botRecapHeader,
  botRecapIssues,
  botStepLine,
  mergeBotSteps,
  type BotRecapStep,
} from "./bot-activity-steps";

const LIVE_ROWS = 3;

function toneClass(tone: "normal" | "warning" | "error"): string {
  if (tone === "error") return "text-red";
  if (tone === "warning") return "text-support-warning";
  return "text-secondary";
}

const STEP_ROW_SIZE = {
  /** The in-chat recap. */
  mini: "min-h-5 py-px text-mini",
  /** The side panel's Activity log. */
  small: "min-h-6 py-0.5 text-small",
} as const;

/** One step as a list item, in B's wording and tones; the live step shimmers (only with motion allowed). */
export function BotStepRow({ step, size = "mini" }: { step: BotRecapStep; size?: keyof typeof STEP_ROW_SIZE }) {
  const line = botStepLine(step);
  return (
    <div role="listitem" className={`flex min-w-0 items-start ${STEP_ROW_SIZE[size]}`}>
      <span className={`min-w-0 break-words ${line.active ? "agent-thinking-shimmer" : ""}`}>
        <span className={`${toneClass(line.tone)} font-medium`}>{line.text}</span>
        {line.detail ? <span className="text-tertiary"> · {line.detail}</span> : null}
      </span>
    </div>
  );
}

export function BotActivityRecap({
  steps,
  durationMs,
  live,
  level,
  mode = "standard",
  retainDetails = false,
}: {
  steps: readonly BotRecapStep[];
  durationMs: number;
  live: boolean;
  level: BotChatActivityLevel;
  mode?: WorkDetailsMode;
  retainDetails?: boolean;
}) {
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const regionId = React.useId();
  const automaticOpen = level === "detailed" && mode !== "compact" && (live || retainDetails || mode === "verbose");
  const open = choice ?? automaticOpen;
  const issues = botRecapIssues(steps);
  const header = botRecapHeader(steps, durationMs, live);
  const issueText = issues.failed ? (issues.failed === 1 ? "1 issue" : `${issues.failed} issues`) : "";
  const blockedText = issues.blocked ? `${issues.blocked} blocked` : "";
  const name = [header, issueText, blockedText].filter(Boolean).join(" · ");
  const shown = choice === true || mode === "verbose" || mode === "detailed"
    ? mergeBotSteps(steps)
    : live || retainDetails ? steps.slice(-LIVE_ROWS) : mergeBotSteps(steps);
  return (
    <div className="min-w-0" data-bot-recap={live ? "live" : "done"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={name}
        onClick={() => setChoice(!open)}
        className="flex max-w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-small text-secondary outline-none transition-colors duration-150 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <span className={`min-w-0 truncate ${live ? "agent-thinking-shimmer" : ""}`}>{header}</span>
        {issueText ? <span className="shrink-0 text-red">{issueText}</span> : null}
        {blockedText ? <span className="shrink-0 text-support-warning">{blockedText}</span> : null}
      </button>
      {open ? (
        <div id={regionId} role="list" aria-label="Steps" className="mt-1 flex flex-col pl-6">
          {shown.map((step) => (
            <BotStepRow key={step.id} step={step} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
