import * as React from "react";
import { Check, CheckCheck, CircleAlert, GitFork, Loader2, MessageCircleQuestion, ShieldAlert, Unplug } from "lucide-react";
import {
  Button,
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
import { Tooltip } from "../ui-primitives";
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
 * How the row lays out its slots: the one-line sidebar row, or the Inbox's
 * compact two-line row (meta and trailing status on line 1, title on line 2),
 * which reuses every other prop unchanged and reads its extra parts from `inbox`.
 */
export type ChatRowLayout = "standard" | "inbox";

export type ChatRowInboxTone = "warning" | "danger" | "working" | "quiet";

export interface ChatRowInboxAction {
  kind: "mark_read" | "acknowledge";
  onSelect: () => void;
}

/** The Inbox row's parts. Used only with `layout="inbox"`. */
export interface ChatRowInbox {
  /** Line 1: `project`, or `project · host` when paired hosts exist. */
  meta: string;
  status: {
    /** "Approval", "Working 4m", or an age such as "2h". */
    label: string;
    tone: ChatRowInboxTone;
    /** How long a Needs you row has waited. */
    wait?: string;
    /** Which Needs you reason, for the status icon. */
    needsYou?: "approval" | "question" | "failed" | "interrupted" | "unavailable";
  };
  /** The tooltip and `aria-description`: the request, question or failure. */
  description?: string;
  unread?: boolean;
  /** Held in place during a freeze after it left, or its host is offline. */
  dimmed?: boolean;
  /** The one hover icon. Needs you rows other than Failed get none. */
  action?: ChatRowInboxAction;
}

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
  /** The Inbox row's parts, with `layout="inbox"`. */
  inbox?: ChatRowInbox;
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
  inbox,
  onOpen,
  onPointerEnter,
  onFocus,
}: ChatRowProps) {
  if (layout === "inbox" && inbox) {
    return (
      <InboxChatRow
        title={title}
        titleContent={titleContent}
        inbox={inbox}
        selected={selected}
        busy={busy || status.state === "working"}
        shortcutHint={shortcutHint}
        shortcutsRevealed={shortcutsRevealed}
        ariaKeyShortcuts={ariaKeyShortcuts}
        menu={menu}
        onOpen={onOpen}
        onPointerEnter={onPointerEnter}
        onFocus={onFocus}
      />
    );
  }
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

const INBOX_ACTION_LABELS: Readonly<Record<ChatRowInboxAction["kind"], string>> = {
  mark_read: "Mark read",
  acknowledge: "Acknowledge",
};


function InboxStatusIcon({ status }: { status: ChatRowInbox["status"] }) {
  const className = "size-3 shrink-0";
  if (status.tone === "working") {
    // Only the icon dims; the text keeps its contrast.
    return <Loader2 aria-hidden="true" className={cn(className, "animate-[spin_1.5s_linear_infinite] opacity-60")} />;
  }
  switch (status.needsYou) {
    case "approval":
      return <ShieldAlert aria-hidden="true" className={className} />;
    case "question":
      return <MessageCircleQuestion aria-hidden="true" className={className} />;
    case "failed":
      return <CircleAlert aria-hidden="true" className={className} />;
    case "interrupted":
    case "unavailable":
      return <Unplug aria-hidden="true" className={className} />;
    default:
      return null;
  }
}

/** Line 1's trailing status: a soft pill in Needs you, plain text elsewhere. */
function InboxRowStatus({ status }: { status: ChatRowInbox["status"] }) {
  if (status.tone === "warning" || status.tone === "danger") {
    return (
      <span className="flex shrink-0 items-center gap-1" data-inbox-status={status.needsYou}>
        <span
          className={cn(
            "inline-flex h-4 items-center gap-0.5 rounded-pill px-1.5 font-medium",
            status.tone === "danger"
              ? "bg-status-red-surface text-status-red"
              : "bg-status-warning-surface text-status-warning",
          )}
        >
          <InboxStatusIcon status={status} />
          {status.label}
        </span>
        {status.wait ? <span className="tabular-nums">{status.wait}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums" data-inbox-status={status.tone}>
      <InboxStatusIcon status={status} />
      {status.label}
    </span>
  );
}

function InboxChatRow({
  title,
  titleContent,
  inbox,
  selected,
  busy,
  shortcutHint,
  shortcutsRevealed,
  ariaKeyShortcuts,
  menu,
  onOpen,
  onPointerEnter,
  onFocus,
}: {
  title: string;
  titleContent: React.ReactNode;
  inbox: ChatRowInbox;
  selected: boolean;
  busy: boolean;
  shortcutHint?: string;
  shortcutsRevealed: boolean;
  ariaKeyShortcuts?: string;
  menu?: ChatRowMenu;
  onOpen: () => void;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  const overflowShown = Boolean(menu) && !shortcutsRevealed;
  const action = shortcutsRevealed ? undefined : inbox.action;
  // Room on the right for whichever hover controls the row has.
  const hoverControls = (overflowShown ? 1 : 0) + (action ? 1 : 0);
  const item = (
    <SidebarListItem
      data-roving-item
      data-chat-row-layout="inbox"
      data-inbox-dimmed={inbox.dimmed ? "true" : undefined}
      className={cn(
        "min-h-0 items-stretch py-1.5",
        inbox.dimmed && "opacity-55",
        hoverControls === 1 &&
          "group-hover/chat-row:pr-10 group-focus-within/chat-row:pr-10 group-has-[[aria-haspopup=menu][data-state=open]]/chat-row:pr-10",
        hoverControls === 2 &&
          "group-hover/chat-row:pr-17 group-focus-within/chat-row:pr-17 group-has-[[aria-haspopup=menu][data-state=open]]/chat-row:pr-17",
      )}
      aria-busy={busy}
      aria-description={inbox.description}
      aria-keyshortcuts={ariaKeyShortcuts}
      selected={selected}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      onClick={onOpen}
      title={
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex h-4 min-w-0 items-center gap-1.5 text-small text-quaternary">
            <span className="min-w-0 flex-1 truncate">{inbox.meta}</span>
            {shortcutsRevealed && shortcutHint ? (
              <kbd
                aria-hidden="true"
                data-chat-shortcut-hint="true"
                className="inline-flex h-4 min-w-7 items-center justify-center rounded-pill bg-control px-1 font-sans text-mini font-medium tabular-nums text-tertiary"
              >
                {shortcutHint}
              </kbd>
            ) : (
              <InboxRowStatus status={inbox.status} />
            )}
          </span>
          <span
            className={cn(
              "block truncate text-[calc(var(--ui-font-size)-1px)] leading-4 text-primary",
              inbox.unread && "font-medium",
            )}
            data-chat-unread={inbox.unread ? "true" : undefined}
          >
            {titleContent}
          </span>
        </span>
      }
    />
  );
  // The tooltip's trigger wraps the context menu's, so both reach the one button.
  const withTooltip = (trigger: React.ReactElement) =>
    inbox.description ? <Tooltip content={inbox.description}>{trigger}</Tooltip> : trigger;
  const row = menu ? (
    <ContextMenu>
      {withTooltip(
        <ContextMenuTrigger asChild onKeyDown={openContextMenuFromKeyboard}>
          {item}
        </ContextMenuTrigger>,
      )}
      <ContextMenuContent>{menu(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
    </ContextMenu>
  ) : (
    withTooltip(item)
  );
  return (
    <div data-roving-row className="group/chat-row relative">
      {row}
      {action ? (
        <Button
          variant="transparent"
          size="small"
          iconOnly
          aria-label={`${INBOX_ACTION_LABELS[action.kind]}: ${title}`}
          title={INBOX_ACTION_LABELS[action.kind]}
          data-inbox-action={action.kind}
          className={cn(OVERFLOW_TRIGGER_CLASS, overflowShown && "right-9")}
          onClick={(event) => {
            event.stopPropagation();
            action.onSelect();
          }}
        >
          {action.kind === "acknowledge" ? <Check aria-hidden="true" /> : <CheckCheck aria-hidden="true" />}
        </Button>
      ) : null}
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
