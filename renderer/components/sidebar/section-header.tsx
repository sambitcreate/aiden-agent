import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface SectionHeaderProps {
  label: string;
  /** How many rows the section holds, shown after the label. */
  count?: number;
  /** A chip beside the label, such as the active machine filter. */
  accessory?: React.ReactNode;
  /** Trailing controls, such as the Organize menu. */
  actions?: React.ReactNode;
  /** Makes the label a disclosure button for the section's rows. */
  collapse?: { expanded: boolean; onToggle: () => void };
}

/** A sidebar section's heading row: label, optional count and collapse control, then actions. */
export function SectionHeader({ label, count, accessory, actions, collapse }: SectionHeaderProps) {
  const countBadge =
    count === undefined ? null : (
      <span className="tabular-nums text-quaternary">{count}</span>
    );
  const heading = collapse ? (
    <button
      type="button"
      aria-expanded={collapse.expanded}
      onClick={collapse.onToggle}
      className="flex min-w-0 items-center gap-1 rounded-control text-left"
    >
      {collapse.expanded ? (
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
      {countBadge}
    </button>
  ) : (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">{label}</span>
      {countBadge}
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-2">
      {accessory ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{heading}</span>
          {accessory}
        </span>
      ) : (
        heading
      )}
      {actions ?? null}
    </div>
  );
}
