// The one calm line a working Bot shows (spec §5, §6, §14): an activity mark
// and a word, a hover/focus peek at the current step on the Mac, elapsed time
// and Stop after 20 seconds, and a still-going note after 2 minutes. Screen
// readers hear it through `BotStatusAnnouncer`, a live region the chat keeps
// mounted while the line comes and goes, at most once every 2 seconds.

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

const SILENT: BotAnnouncement = { text: "", at: Number.NEGATIVE_INFINITY };

/** Clearing is immediate and keeps the last announcement's time, so the gap still holds after it. */
function settleAnnouncement(shown: BotAnnouncement, text: string, now: number): { shown: BotAnnouncement; retryInMs?: number } {
  if (text === "") return { shown: shown.text === "" ? shown : { text: "", at: shown.at } };
  return nextBotAnnouncement(shown, text, now);
}

/**
 * The text screen readers hear: the newest wording, at most once per gap.
 * A change inside the gap keeps the last text until a timer releases the newest.
 * The first commit is always empty, so a live region mounted with the text still announces it.
 */
function useAnnouncement(text: string): string {
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => setArmed(true), []);
  const wanted = armed ? text : "";
  const [shown, setShown] = React.useState<BotAnnouncement>(SILENT);
  if (shown.text !== wanted) {
    const next = settleAnnouncement(shown, wanted, Date.now());
    if (next.shown !== shown) setShown(next.shown);
  }
  React.useEffect(() => {
    if (shown.text === wanted) return;
    const wait = settleAnnouncement(shown, wanted, Date.now()).retryInMs ?? 0;
    const timer = setTimeout(() => setShown({ text: wanted, at: Date.now() }), wait);
    return () => clearTimeout(timer);
  }, [wanted, shown]);
  return shown.text;
}

/** What the line says to a screen reader: the word, plus the step on the Mac with Follows the work. */
export function botStatusSpeech(activity: BotLiveActivity, wording: BotChatActivityWording): string {
  const display = botActivityDisplay(activity.phase, wording, activity.app);
  const detail = wording === "follows" && display.phase !== "thinking" ? activity.step?.detail : undefined;
  return detail ? `${display.word}, ${detail}` : display.word;
}

/**
 * The status line's live region. Keep it mounted for the whole chat and pass ""
 * while no line shows: a region that mounts together with its text may stay silent.
 */
export function BotStatusAnnouncer({ text }: { text: string }) {
  const announced = useAnnouncement(text);
  return (
    <div role="status" className="sr-only" data-bot-status-announcement>
      {announced}
    </div>
  );
}

export function BotStatusLine({
  activity,
  wording,
  now: fixedNow,
  onStop,
  onLayoutChange,
}: {
  activity: BotLiveActivity;
  wording: BotChatActivityWording;
  /** A fixed clock (tests and previews); otherwise the line ticks each second. */
  now?: number;
  /** Shown as Stop once the turn has run for 20 seconds. */
  onStop?(): void;
  /** Reports which optional parts are showing, so a pinned scroll view can follow the height change. */
  onLayoutChange?(key: string): void;
}) {
  const display = botActivityDisplay(activity.phase, wording, activity.app);
  const now = useClock(fixedNow);
  const detail = wording === "follows" && display.phase !== "thinking" ? activity.step?.detail : undefined;
  const elapsed = botElapsedLabel(activity.startedAt, now);
  // Waiting on the person, or already stopping: "I'll message you when it's done" would mislead.
  const stillGoing =
    now - activity.startedAt >= BOT_STILL_GOING_AFTER_MS && display.phase !== "waiting" && display.phase !== "stopping";
  const layoutKey = `${elapsed ? "e" : ""}${stillGoing ? "s" : ""}`;
  React.useEffect(() => {
    onLayoutChange?.(layoutKey);
    return () => onLayoutChange?.("");
  }, [layoutKey, onLayoutChange]);
  const stoppable = Boolean(elapsed && onStop) && activity.phase !== "stopping";
  const shimmer = display.phase !== "waiting" && display.phase !== "stopping";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <div
          role="group"
          aria-label={botStatusSpeech(activity, wording)}
          tabIndex={wording === "follows" ? 0 : undefined}
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
        {stoppable ? (
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
