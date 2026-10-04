import * as React from "react";
import { BellDot, ListTree, Rows3 } from "lucide-react";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "./ui";
import {
  SIDEBAR_CHAT_SORTS,
  SIDEBAR_PROJECT_SORTS,
  SIDEBAR_VIEWS,
  type SidebarChatSort,
  type SidebarProjectSort,
  type SidebarView,
} from "../lib/sidebar-organization";

export interface SidebarOrganizeMenuItemsProps {
  view: SidebarView;
  chatSort: SidebarChatSort;
  projectSort: SidebarProjectSort;
  onViewChange: (view: SidebarView) => void;
  onChatSortChange: (sort: SidebarChatSort) => void;
  onProjectSortChange: (sort: SidebarProjectSort) => void;
}

const ICON_CLASS = "size-4 text-secondary group-data-[highlighted]:text-accent-foreground";

function pick<T extends string>(values: readonly T[], onChange: (value: T) => void) {
  return (value: string) => {
    if ((values as readonly string[]).includes(value)) onChange(value as T);
  };
}

/**
 * Contents of the Organize sidebar menu. Each choice is a labelled radio group;
 * sort groups appear only for the views they affect.
 */
export function SidebarOrganizeMenuItems({
  view,
  chatSort,
  projectSort,
  onViewChange,
  onChatSortChange,
  onProjectSortChange,
}: SidebarOrganizeMenuItemsProps) {
  const id = React.useId();
  return (
    <>
      <DropdownMenuLabel id={`${id}-view`}>View</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-labelledby={`${id}-view`}
        value={view}
        onValueChange={pick(SIDEBAR_VIEWS, onViewChange)}
      >
        <DropdownMenuRadioItem value="projects">
          <ListTree className={ICON_CLASS} aria-hidden="true" />
          Workspaces
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="recent">
          <Rows3 className={ICON_CLASS} aria-hidden="true" />
          Recent
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="attention">
          <BellDot className={ICON_CLASS} aria-hidden="true" />
          Needs attention
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {view !== "attention" ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel id={`${id}-chat-sort`}>Sort chats</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-labelledby={`${id}-chat-sort`}
            value={chatSort}
            onValueChange={pick(SIDEBAR_CHAT_SORTS, onChatSortChange)}
          >
            <DropdownMenuRadioItem value="last_activity">Last activity</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="created">Created</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </>
      ) : null}
      {view === "projects" ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel id={`${id}-project-sort`}>Sort workspaces</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-labelledby={`${id}-project-sort`}
            value={projectSort}
            onValueChange={pick(SIDEBAR_PROJECT_SORTS, onProjectSortChange)}
          >
            <DropdownMenuRadioItem value="last_activity">Last activity</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="created">Created</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="manual">Manual</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </>
      ) : null}
    </>
  );
}
