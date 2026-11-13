// The receipt line (docs/plans/bot-ux-simplification.md §4.7): one quiet,
// centred line in a Bot's chat for something that already happened, with
// its trailing links. "Learned: … · Undo", "Tidied memory · Undo", "Memory
// updated · Open", "Wake-up at 3:10 PM · Cancel", "Skipped while paused:
// Morning brief · Run now", "Added: Morning brief · Every day at 8:00 AM",
// "Not added: Morning brief · Why not?". It replaces the separate learned
// lines, captions, chips and settled cards those used to be.

import * as React from "react";
import { Button, Text } from "../ui";
import { cn } from "../../lib/ui-utils";

export interface ReceiptAction {
  label: string;
  /** A fuller accessible name when the label alone is ambiguous in a long chat. */
  ariaLabel?: string;
  disabled?: boolean;
  onClick(): void;
}

export function ReceiptLine({
  icon,
  text,
  actions = [],
  className,
  ...rest
}: {
  /** A small lucide icon in the tertiary colour, or a status tick. */
  icon?: React.ReactNode;
  text: React.ReactNode;
  actions?: readonly ReceiptAction[];
  className?: string;
} & Pick<React.HTMLAttributes<HTMLDivElement>, "role" | "aria-label"> & { [data: `data-${string}`]: string | boolean | undefined }) {
  return (
    <div {...rest} className={cn("flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 py-1 text-center", className)} data-receipt-line>
      {icon ? <span aria-hidden="true" className="flex shrink-0 text-tertiary [&_svg]:size-3.5">{icon}</span> : null}
      <Text as="span" variant="small" color="tertiary" className="min-w-0 [overflow-wrap:anywhere]">
        {text}
      </Text>
      {/* Keyed by place, so a label that changes ("Run now" → "Starting…") keeps its button and focus. */}
      {actions.map((action, index) => (
        <React.Fragment key={index}>
          <Text as="span" variant="small" color="tertiary" aria-hidden="true">
            ·
          </Text>
          <Button
            variant="transparent"
            size="small"
            className="h-6 px-2"
            disabled={action.disabled}
            aria-label={action.ariaLabel}
            onClick={action.onClick}
          >
            <Text as="span" variant="small">
              {action.label}
            </Text>
          </Button>
        </React.Fragment>
      ))}
    </div>
  );
}
