// The one card shape a Bot chat uses for anything that needs the person:
// interrupted turns, failed replies, model problems, approvals, and connection
// requests. It matches the workspace approval card: a soft status icon, a short
// title, quiet supporting text, and actions at the trailing edge. Status lives
// in the icon's fill, never in a coloured border.

import * as React from "react";
import { Text } from "../ui";
import { cn } from "../../lib/ui-utils";

export type BotNoticeTone = "neutral" | "warning" | "red" | "green";

const TONE_CLASS: Record<BotNoticeTone, string> = {
  neutral: "bg-control text-secondary",
  warning: "bg-status-warning-surface text-status-warning",
  red: "bg-status-red-surface text-status-red",
  green: "bg-status-green-surface text-status-green",
};

export function BotNoticeCard({
  label,
  role = "group",
  icon,
  iconTone = "neutral",
  iconTile,
  title,
  children,
  actions,
  elevated = false,
  className,
}: {
  /** The card's accessible name. */
  label: string;
  role?: "group" | "alert";
  /** A lucide icon, drawn in a round tile filled with `iconTone`. */
  icon?: React.ReactNode;
  iconTone?: BotNoticeTone;
  /** A ready-made tile instead, such as a connection's app icon. */
  iconTile?: React.ReactNode;
  title: React.ReactNode;
  /** Supporting text under the title. */
  children?: React.ReactNode;
  actions?: React.ReactNode;
  /** Pending decisions above the composer float like the workspace approval card. */
  elevated?: boolean;
  className?: string;
}) {
  return (
    <section
      role={role}
      aria-label={label}
      className={cn(
        "min-w-0 rounded-card p-3",
        elevated ? "bg-popover shadow-popover" : "bg-well",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {iconTile ??
          (icon ? (
            <span
              aria-hidden="true"
              className={cn("grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4", TONE_CLASS[iconTone])}
            >
              {icon}
            </span>
          ) : null)}
        <div className="min-w-0 flex-1 pt-1">
          <Text as="p" variant="small-strong">
            {title}
          </Text>
          {children ? <div className="mt-0.5 text-small text-secondary [overflow-wrap:anywhere]">{children}</div> : null}
        </div>
      </div>
      {actions ? <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </section>
  );
}
