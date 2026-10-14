// Activity (spec §8): every step of every reply, newest reply first, grouped by
// the message or routine that started it. Red is a failure, amber a refusal,
// a stopped step stays neutral, with B's step wording; the live step shimmers
// (only with motion allowed).

import * as React from "react";
import { EmptyState } from "../../components/ui";
import { cn } from "../../lib/ui-utils";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botActivityLog, formatBotActivityWhen, type BotActivityReply } from "./bot-activity-log";
import { botStepLine, type BotRecapStep } from "./bot-activity-steps";

const TONE: Record<"normal" | "warning" | "error", string> = {
  normal: "text-secondary",
  warning: "text-support-warning",
  error: "text-red",
};

function ActivityStep({ step }: { step: BotRecapStep }) {
  const line = botStepLine(step);
  return (
    <div role="listitem" className="flex min-h-6 min-w-0 items-start py-0.5 text-small">
      <span className={cn("min-w-0 break-words", line.active && "agent-thinking-shimmer")}>
        <span className={cn("font-medium", TONE[line.tone])}>{line.text}</span>
        {line.detail ? <span className="text-tertiary"> · {line.detail}</span> : null}
      </span>
    </div>
  );
}

function ActivityReply({ reply, now }: { reply: BotActivityReply; now: number }) {
  const headingId = React.useId();
  const title = reply.routine ? `${reply.title} (routine)` : reply.title;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-1 px-1 text-small text-tertiary">
        {`${formatBotActivityWhen(reply.at, now)} · ${title}`}
      </h3>
      <div role="list" aria-label={`Steps for ${title}`} className="flex flex-col px-1">
        {reply.steps.map((step) => (
          <ActivityStep key={step.id} step={step} />
        ))}
      </div>
    </section>
  );
}

export function BotPanelActivity({
  botName,
  entries,
  running,
  loading,
  now = Date.now(),
}: {
  botName: string;
  entries: readonly BotTranscriptEntry[];
  running: boolean;
  loading: boolean;
  now?: number;
}) {
  const replies = React.useMemo(() => botActivityLog(entries, { running }), [entries, running]);
  if (loading) {
    return (
      <div role="status" aria-label="Loading activity" className="flex flex-col gap-2 px-1">
        {[0, 1, 2].map((row) => (
          <span key={row} className="h-3 w-full rounded-full bg-control motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }
  if (replies.length === 0) {
    return (
      <EmptyState
        placement="inline"
        title="No activity yet"
        description={`When ${botName} reads, searches or edits something, every step shows up here.`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {replies.map((reply) => (
        <ActivityReply key={reply.id} reply={reply} now={now} />
      ))}
    </div>
  );
}
