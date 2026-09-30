import { Clock } from "lucide-react";
import { Button, Callout } from "./ui";

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
