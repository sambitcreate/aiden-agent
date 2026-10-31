import * as React from "react";
import { GitFork } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  SidebarListItem,
} from "../ui";
import { ChatRowStatus } from "../chat-row-status";
import { RemoteHostMarker } from "../sidebar-remote";
import { SidebarOverflowMenu } from "./sidebar-overflow-menu";
import { openContextMenuFromKeyboard } from "../../lib/keyboard-context-menu";
import { cn } from "../../lib/ui-utils";
import type { ChatRowState } from "../../shared/chat-row-state";

/**
 * Builds a row's actions once for both surfaces that show them: the
 * right-click context menu and the ••• dropdown. Each call gets that
 * surface's item and separator components.
 */
export type ChatRowMenu = (
  Item: typeof DropdownMenuItem | typeof ContextMenuItem,
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator,
) => React.ReactNode;

/**
 * How the row lays out its slots. Only the one-line sidebar row exists today;
 * the Inbox's two-line row (meta and trailing status on line 1, title on
 * line 2) joins this union and reuses every other prop unchanged.
 */
export type ChatRowLayout = "standard";

export interface ChatRowStatusProps {
  state: ChatRowState;
  /** Unseen output. Ignored while the row is the open chat. */
  unread: boolean;
  /** The newest output is a failed turn; shown only while unread. */
  failed?: boolean;
}

export interface ChatRowProps {
  /** The plain chat title, used for the accessible names of the row's controls. */
  title: string;
  /** Rich title content, such as an animated title reveal. Defaults to `title`. */
  titleContent?: React.ReactNode;
  status: ChatRowStatusProps;
  /** The open chat. It never shows unread: the person is reading it. */
  selected?: boolean;
  indented?: boolean;
  layout?: ChatRowLayout;
  /** A leading icon, such as a progress spinner. */
  icon?: React.ReactNode;
  /** Extra busy work beyond a Working run (for example a rename in flight). */
  busy?: boolean;
  /** The source chat's label when this chat is a fork. */
  forkedFrom?: string;
  /** The chat lives on a paired host: shows its marker and mutes last-known rows. */
  remote?: { hostLabel: string; stale: boolean };
  /** Context glyphs (workspace, pull requests) shown before the status. */
  context?: React.ReactNode;
  /** The ⌘-number hint, shown only while shortcuts are revealed. */
  shortcutHint?: string;
  /** While the person holds the shortcut modifier: show hints, hide the ••• button. */
  shortcutsRevealed?: boolean;
  ariaKeyShortcuts?: string;
  /** The row's actions. Without it the row has no context menu and no ••• button. */
  menu?: ChatRowMenu;
  onOpen: () => void;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}

const OVERFLOW_TRIGGER_CLASS =
  "pointer-events-none absolute right-1.5 top-1/2 size-7 -translate-y-1/2 text-tertiary opacity-0 transition-opacity duration-(--motion-duration) ease-standard group-hover/chat-row:pointer-events-auto group-hover/chat-row:opacity-100 group-focus-within/chat-row:pointer-events-auto group-focus-within/chat-row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 motion-reduce:transition-none";

/**
 * One chat in a sidebar list, local or on a paired host: title, status pill,
 * context glyphs, shortcut hint and the row's actions.
 */
export function ChatRow({
  title,
  titleContent = title,
  status,
  selected = false,
  indented = false,
  layout = "standard",
  icon,
  busy = false,
  forkedFrom,
  remote,
  context,
  shortcutHint,
  shortcutsRevealed = false,
  ariaKeyShortcuts,
  menu,
  onOpen,
  onPointerEnter,
  onFocus,
}: ChatRowProps) {
  const overflowShown = Boolean(menu) && !shortcutsRevealed;
  const displayedTitle = remote?.stale ? (
    <span className="text-secondary">{titleContent}</span>
  ) : (
    titleContent
  );
  const item = (
    <SidebarListItem
      data-roving-item
      data-chat-row-layout={layout}
      data-remote-chat={remote ? (remote.stale ? "stale" : "live") : undefined}
      className={cn(
        indented && "pl-8",
        // Room for the ••• button while it shows, including while its menu is open.
        overflowShown &&
          "group-hover/chat-row:pr-10 group-focus-within/chat-row:pr-10 group-has-[[aria-haspopup=menu][data-state=open]]/chat-row:pr-10",
      )}
      icon={icon}
      aria-busy={busy || status.state === "working"}
      aria-description={forkedFrom}
      data-forked={forkedFrom ? "true" : undefined}
      title={
        forkedFrom ? (
          <span className="flex min-w-0 items-center gap-1.5" title={forkedFrom}>
            <GitFork aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
            <span className="min-w-0 truncate">{displayedTitle}</span>
          </span>
        ) : (
          displayedTitle
        )
      }
      trailing={
        <span
          className={cn(
            "flex items-center gap-1 transition-opacity duration-(--motion-duration) ease-standard motion-reduce:transition-none",
            // The ••• button takes this spot while the row is hovered or focused.
            overflowShown &&
              "group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0 group-has-[[aria-haspopup=menu][data-state=open]]/chat-row:opacity-0",
          )}
        >
          {shortcutsRevealed && shortcutHint ? (
            <kbd
              aria-hidden="true"
              data-chat-shortcut-hint="true"
              className="inline-flex h-5 min-w-8 items-center justify-center rounded-pill bg-control px-1.5 font-sans text-mini font-medium tabular-nums text-tertiary"
            >
              {shortcutHint}
            </kbd>
          ) : null}
          {context}
          {remote ? <RemoteHostMarker hostLabel={remote.hostLabel} stale={remote.stale} /> : null}
          <ChatRowStatus
            state={status.state}
            unread={status.unread && !selected}
            failed={status.failed === true}
          />
        </span>
      }
      aria-keyshortcuts={ariaKeyShortcuts}
      selected={selected}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      onClick={onOpen}
    />
  );

  return (
    <div data-roving-row className="group/chat-row relative">
      {menu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild onKeyDown={openContextMenuFromKeyboard}>
            {item}
          </ContextMenuTrigger>
          <ContextMenuContent>{menu(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
        </ContextMenu>
      ) : (
        item
      )}
      {menu && overflowShown ? (
        <SidebarOverflowMenu
          ariaLabel={`More for ${title}`}
          triggerClassName={OVERFLOW_TRIGGER_CLASS}
          contentClassName="w-56"
        >
          {menu(DropdownMenuItem, DropdownMenuSeparator)}
        </SidebarOverflowMenu>
      ) : null}
    </div>
  );
}
