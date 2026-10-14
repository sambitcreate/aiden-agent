// The one calm line a working Bot shows (spec §5, §6, §14): an activity mark
// and a word, a hover/focus peek at the current step on the Mac, elapsed time
// and Stop after 20 seconds, and a still-going note after 2 minutes. The
// accessible name changes at most once every 2 seconds.

import * as React from "react";
import { Square } from "lucide-react";
import { AidenActivityMark } from "../../components/aiden-activity-mark";
import { Button, Text } from "../../components/ui";
import {
  BOT_STILL_GOING_AFTER_MS,
  botActivityDisplay,
  botElapsedLabel,
  nextBotAnnouncement,
  type BotAnnouncement,
} from "../../shared/bot-activity";
import type { BotLiveActivity } from "../../shared/bot-live";
import type { BotChatActivityWording } from "../../shared/bots";

function useClock(fixed: number | undefined): number {
  const [now, setNow] = React.useState(() => fixed ?? Date.now());
  React.useEffect(() => {
    if (fixed !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}

/** The text screen readers hear: the newest wording, at most once per gap. */
function useAnnouncement(text: string): string {
  const [shown, setShown] = React.useState<BotAnnouncement>(() => ({ text, at: Date.now() }));
  React.useEffect(() => {
    const next = nextBotAnnouncement(shown, text, Date.now());
    if (next.shown !== shown) setShown(next.shown);
    if (next.retryInMs === undefined) return;
    const timer = window.setTimeout(() => setShown({ text, at: Date.now() }), next.retryInMs);
    return () => window.clearTimeout(timer);
  }, [text, shown]);
  return shown.text;
}

export function BotStatusLine({
  activity,
  wording,
  now: fixedNow,
  onStop,
}: {
  activity: BotLiveActivity;
  wording: BotChatActivityWording;
  /** A fixed clock (tests and previews); otherwise the line ticks each second. */
  now?: number;
  /** Shown as Stop once the turn has run for 20 seconds. */
  onStop?(): void;
}) {
  const display = botActivityDisplay(activity.phase, wording, activity.app);
  const now = useClock(fixedNow);
  const detail = wording === "follows" && display.phase !== "thinking" ? activity.step?.detail : undefined;
  const elapsed = botElapsedLabel(activity.startedAt, now);
  const stillGoing = now - activity.startedAt >= BOT_STILL_GOING_AFTER_MS;
  const announced = useAnnouncement(detail ? `${display.word}, ${detail}` : display.word);
  const shimmer = display.phase !== "waiting" && display.phase !== "stopping";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <div
          role="status"
          aria-label={announced}
          tabIndex={detail ? 0 : undefined}
          data-bot-status-phase={display.phase}
          className="group/status flex h-6 min-w-0 max-w-full items-center gap-2 rounded-control outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <AidenActivityMark mark={display.mark} size={20} className="shrink-0 text-primary" />
          <span aria-hidden="true" className="flex min-w-0 items-center gap-1 text-small text-secondary">
            <span className={`shrink-0 ${shimmer ? "agent-thinking-shimmer" : ""}`}>{display.word}</span>
            {detail ? (
              <span className="hidden min-w-0 truncate text-tertiary group-hover/status:inline group-focus-visible/status:inline">
                · {detail}
              </span>
            ) : null}
            {elapsed ? <span className="shrink-0 tabular-nums text-tertiary">· {elapsed}</span> : null}
          </span>
        </div>
        {elapsed && onStop ? (
          <Button variant="transparent" size="small" onClick={onStop}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : null}
      </div>
      {stillGoing ? (
        <Text as="p" variant="small" color="tertiary" role="note" className="py-1 text-center">
          Still going. I'll message you when it's done.
        </Text>
      ) : null}
    </div>
  );
}
