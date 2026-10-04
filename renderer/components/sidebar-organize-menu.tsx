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
  SIDEBAR_PROJECT_GROUPINGS,
  SIDEBAR_PROJECT_SORTS,
  SIDEBAR_VIEWS,
  type SidebarChatSort,
  type SidebarMachineFilter,
  type SidebarProjectGrouping,
  type SidebarProjectSort,
  type SidebarView,
} from "../lib/sidebar-organization";
import { LOCAL_MACHINE_LABEL } from "../lib/sidebar-remote-groups";

/** Machine choices; only offered while at least one paired host is enabled. */
export interface SidebarMachineMenuOptions {
  hosts: readonly { id: string; label: string }[];
  filter: SidebarMachineFilter;
  grouping: SidebarProjectGrouping;
  onFilterChange: (filter: SidebarMachineFilter) => void;
  onGroupingChange: (grouping: SidebarProjectGrouping) => void;
}

export interface SidebarOrganizeMenuItemsProps {
  view: SidebarView;
  chatSort: SidebarChatSort;
  projectSort: SidebarProjectSort;
  onViewChange: (view: SidebarView) => void;
  onChatSortChange: (sort: SidebarChatSort) => void;
  onProjectSortChange: (sort: SidebarProjectSort) => void;
  machines?: SidebarMachineMenuOptions;
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
  machines,
}: SidebarOrganizeMenuItemsProps) {
  const id = React.useId();
  const showMachines = machines !== undefined && machines.hosts.length > 0;
  const machineFilters: SidebarMachineFilter[] = showMachines
    ? ["all", "local", ...machines.hosts.map((host) => `host:${host.id}` as const)]
    : [];
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
      {showMachines ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel id={`${id}-machines`}>Machines</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-labelledby={`${id}-machines`}
            value={machines.filter}
            onValueChange={pick(machineFilters, machines.onFilterChange)}
          >
            <DropdownMenuRadioItem value="all">All machines</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="local">{LOCAL_MACHINE_LABEL}</DropdownMenuRadioItem>
            {machines.hosts.map((host) => (
              <DropdownMenuRadioItem key={host.id} value={`host:${host.id}`}>
                <span className="min-w-0 truncate">{host.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {view === "projects" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel id={`${id}-grouping`}>Group across machines</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                aria-labelledby={`${id}-grouping`}
                value={machines.grouping}
                onValueChange={pick(SIDEBAR_PROJECT_GROUPINGS, machines.onGroupingChange)}
              >
                <DropdownMenuRadioItem value="separate">Keep separate</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="repository">Same repository</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="repository_path">
                  Same repository and path
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
