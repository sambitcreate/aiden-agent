import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SidebarListItem } from "../ui";

export interface RowGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  expanded: boolean;
  /** The group's own glyph, shown after the disclosure chevron. */
  icon: React.ReactNode;
  title: React.ReactNode;
  /** Names the group in the header's Expand or Collapse label. */
  accessibleName: string;
  onToggle: () => void;
  /** Trailing header actions, such as New chat and the ••• menu. */
  actions?: React.ReactNode;
  /** The drop-position line shown while another group is dragged over this one. */
  dropIndicator?: React.ReactNode;
  /** Drag handlers for the header row. */
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
  /** The group's rows, rendered only while expanded. */
  children?: React.ReactNode;
}

/** A disclosure group in the sidebar outline: a header that expands to its chat rows. */
export function RowGroup({
  expanded,
  icon,
  title,
  accessibleName,
  onToggle,
  actions,
  dropIndicator,
  dragProps,
  children,
  ...groupProps
}: RowGroupProps) {
  return (
    <div data-roving-group className="group/workspace relative" {...groupProps}>
      {dropIndicator}
      <div data-roving-row className="flex min-w-0 items-center gap-0.5" {...dragProps}>
        <SidebarListItem
          data-roving-item
          className="min-w-0 flex-1"
          icon={
            <span className="flex items-center gap-1.5">
              {expanded ? <ChevronDown /> : <ChevronRight />}
              {icon}
            </span>
          }
          title={title}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${accessibleName}`}
          aria-expanded={expanded}
          onClick={onToggle}
        />
        {actions}
      </div>
      {expanded ? <div className="flex flex-col gap-0.5">{children}</div> : null}
    </div>
  );
}
