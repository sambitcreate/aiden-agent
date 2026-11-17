// A wake-up the Bot set for itself, in its chat: a receipt line,
// "Wake-up at 3:10 PM · Cancel". Cancel shows only while it still waits.

import * as React from "react";
import { AlarmClock } from "lucide-react";
import { ReceiptLine } from "./receipt-line";
import { botWakeUpWhen } from "../../shared/bot-wake-ups";

export function WakeUpChip({
  fireAt,
  pending,
  onCancel,
  now = Date.now,
}: {
  fireAt: number;
  /** Still waiting to fire; `undefined` while the Bot's routines load. */
  pending: boolean | undefined;
  /** Absent where the person can't cancel from this chat. */
  onCancel?(): Promise<void>;
  now?: () => number;
}) {
  const [cancelled, setCancelled] = React.useState(false);
  const [, rerender] = React.useReducer((value: number) => value + 1, 0);
  const due = fireAt <= now();
  // Cancel goes away on its own once the wake-up's minute arrives.
  React.useEffect(() => {
    if (due) return;
    const timer = window.setTimeout(rerender, Math.min(fireAt - now() + 250, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [due, fireAt, now]);
  const when = botWakeUpWhen(fireAt, now());
  const text = cancelled ? `Wake-up ${when} (cancelled)` : `Wake-up ${when}`;
  return (
    <ReceiptLine
      icon={<AlarmClock />}
      text={text}
      data-bot-wake-up
      actions={
        onCancel && pending === true && !due && !cancelled
          ? [
              {
                label: "Cancel",
                ariaLabel: `Cancel wake-up ${when}`,
                onClick: () => {
                  // Shown at once; put back if the cancel fails (the caller says why).
                  setCancelled(true);
                  void onCancel().catch(() => setCancelled(false));
                },
              },
            ]
          : []
      }
    />
  );
}
