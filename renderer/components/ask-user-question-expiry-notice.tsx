import * as React from "react";
import { Clock } from "lucide-react";
import { Button, Callout, Text } from "./ui";

/** Remaining time at which the countdown is announced once to assistive tech. */
export const ASK_USER_QUESTION_ANNOUNCE_MS = 30_000;

function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Quiet countdown while an ask_user_question still has a deadline. It owns its
 * own one-second tick so the chat pane does not re-render every second, and it
 * announces once when about 30 seconds remain rather than on every tick.
 */
export function AskUserQuestionCountdown({
  expiresAt,
  initialNow,
}: {
  expiresAt: string;
  /** Clock seed for deterministic rendering; defaults to the current time. */
  initialNow?: number;
}) {
  const deadline = Date.parse(expiresAt);
  const [now, setNow] = React.useState(() => initialNow ?? Date.now());
  React.useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  if (!Number.isFinite(deadline)) return null;
  const remaining = Math.max(0, deadline - now);
  if (remaining === 0) return null;
  const announce = remaining <= ASK_USER_QUESTION_ANNOUNCE_MS;
  return (
    <div className="aiden-dock-inset chat-content-column flex justify-end pb-1">
      <Text variant="small" color="tertiary" className="flex items-center gap-1.5 tabular-nums">
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        <span aria-hidden="true">Aiden continues on its own in {formatRemaining(remaining)}</span>
      </Text>
      <span role="status" className="sr-only">
        {announce ? "Less than 30 seconds left to answer before Aiden continues on its own." : ""}
      </span>
    </div>
  );
}

/**
 * Shown when an ask_user_question deadline passed. Kept separate from the
 * questionnaire card so the card's own layout stays independent of timing.
 *
 * - `expired`: the card is still open, but the agent already moved on; an
 *   answer submitted now becomes a follow-up offer instead.
 * - `late-answer`: the user answered after the deadline; offer to send the
 *   answer as a normal follow-up message, or discard it.
 */
export type AskUserQuestionExpiryNoticeProps =
  | { state: "expired" }
  | {
      state: "late-answer";
      sending?: boolean;
      /** True while a response is streaming, so the follow-up is queued. */
      queued?: boolean;
      onSend(): void;
      onDiscard(): void;
    };

export function AskUserQuestionExpiryNotice(props: AskUserQuestionExpiryNoticeProps) {
  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <Callout role="status" aria-label={props.state === "expired" ? "Question expired" : "Late answer"}>
        <p className="flex items-start gap-2 text-small text-secondary">
          <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {props.state === "expired"
              ? "This question expired, so Aiden continued with its best judgement. You can still answer, and Aiden will offer to send it as a follow-up message."
              : `Your answer arrived after the question expired. Send it as a follow-up so Aiden can adjust${props.queued ? " once the current response finishes" : ""}.`}
          </span>
        </p>
        {props.state === "late-answer" ? (
          <div className="mt-1 flex justify-end gap-1.5">
            <Button
              variant="transparent"
              size="small"
              disabled={props.sending}
              onClick={props.onDiscard}
            >
              Discard
            </Button>
            <Button variant="accent" size="small" disabled={props.sending} onClick={props.onSend}>
              {props.sending ? "Sending…" : props.queued ? "Queue follow-up" : "Send as follow-up"}
            </Button>
          </div>
        ) : null}
      </Callout>
    </div>
  );
}
