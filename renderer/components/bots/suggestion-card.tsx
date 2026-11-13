// The suggestion card (docs/plans/bot-ux-simplification.md §4.7): something
// the Bot offers to add for the person, a routine, a skill or a lesson, with
// Not now and Add. Once answered it settles to a receipt line. Only one
// suggestion is shown in full per chat; an earlier one still waiting folds to
// a quiet line with Show.

import * as React from "react";
import { Lightbulb } from "lucide-react";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import { ReceiptLine } from "./receipt-line";

export function SuggestionCard({
  label,
  icon,
  title,
  children,
  busy,
  adding,
  onAdd,
  onNotNow,
}: {
  /** The card's accessible name. */
  label: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  /** An answer is on its way: both buttons wait. */
  busy: boolean;
  /** It is the Add that is on its way. */
  adding: boolean;
  onAdd(): void;
  onNotNow(): void;
}) {
  return (
    <BotNoticeCard
      label={label}
      icon={icon}
      title={title}
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy} onClick={onNotNow}>
            Not now
          </Button>
          <Button variant="accent" size="small" disabled={busy} onClick={onAdd}>
            {adding ? "Adding…" : "Add"}
          </Button>
        </>
      }
    >
      {children}
    </BotNoticeCard>
  );
}

/** An earlier suggestion still waiting while a newer one is on show. */
export function FoldedSuggestion({ label, onShow }: { label: string; onShow(): void }) {
  return (
    <ReceiptLine
      icon={<Lightbulb />}
      text={`Waiting: ${label}`}
      actions={[{ label: "Show", ariaLabel: `Show ${label}`, onClick: onShow }]}
      data-folded-suggestion
    />
  );
}
