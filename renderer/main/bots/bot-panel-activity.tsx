// Activity (spec §8): every step of every reply, newest reply first, grouped by
// the message or routine that started it. Steps use the in-chat recap's row:
// red is a failure, amber a refusal, a stopped step stays neutral, and the live
// step shimmers (only with motion allowed).

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button, Callout, EmptyState, Text } from "../../components/ui";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botActivityLog, formatBotActivityWhen, type BotActivityReply } from "./bot-activity-log";
import { BotStepRow } from "./bot-activity-recap";

function ActivityReply({ reply, now }: { reply: BotActivityReply; now: number }) {
  const headingId = React.useId();
  const title = reply.routine ? `${reply.title} (routine)` : reply.title;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-1 px-1 text-small text-tertiary">
        {`${formatBotActivityWhen(reply.at, now)} · ${title}`}
      </h2>
      <div role="list" aria-label={`Steps for ${title}`} className="flex flex-col px-1">
        {reply.steps.map((step) => (
          <BotStepRow key={step.id} step={step} size="small" />
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
  failed = false,
  onRetry,
  now = Date.now(),
}: {
  botName: string;
  entries: readonly BotTranscriptEntry[];
  running: boolean;
  loading: boolean;
  /** The conversation couldn't be read and there is nothing to show yet. */
  failed?: boolean;
  onRetry?(): void;
  now?: number;
}) {
  const replies = React.useMemo(() => botActivityLog(entries, { running }), [entries, running]);
  if (failed) {
    return (
      <Callout color="red" role="alert" className="flex-row items-center justify-between gap-3">
        <Text variant="small" color="red">
          {`Aiden couldn’t load ${botName}’s activity.`}
        </Text>
        {onRetry ? (
          <Button size="small" variant="filled" onClick={onRetry}>
            <RotateCcw /> Try again
          </Button>
        ) : null}
      </Callout>
    );
  }
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
