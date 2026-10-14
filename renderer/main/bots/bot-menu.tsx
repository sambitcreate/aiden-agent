// The one Bot ••• menu (spec §10), for the chat header, sidebar rows (hover and
// right-click) and the pinned Bot: Profile, Files, Memory, Routines, Advanced,
// Pin to top/Unpin, then Delete Bot. Files, Memory and Routines open the side
// panel on that tab, beside that Bot's chat.

import * as React from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui";
import { botChatPath, botChatRouteBotId } from "../../lib/bot-routes";
import { cn } from "../../lib/ui-utils";
import type { BotDefinition } from "../../shared/bots";
import { useBotPanelActions } from "./bot-panel-context";
import { botSidebarPreferenceActions } from "./use-bot-sidebar-preferences";

export type BotMenuAction = "profile" | "files" | "memory" | "routines" | "advanced" | "pin" | "delete";

const PANEL_ACTIONS: ReadonlySet<BotMenuAction> = new Set(["files", "memory", "routines"]);

/**
 * One menu's focus hand-off. When its chosen item opened the side panel, the
 * menu's close leaves focus with the panel instead of pulling it back to the
 * trigger. Each menu owns one, so a choice in one menu never affects another.
 */
export interface BotMenuFocusGuard {
  /** Pass as the menu content's `onCloseAutoFocus`. */
  onCloseAutoFocus(event: Event): void;
  /** The chosen action ran and opened the panel. */
  panelOpened(): void;
  /** A new choice starts clean. */
  reset(): void;
}

export function useBotMenuFocusGuard(): BotMenuFocusGuard {
  const opened = React.useRef(false);
  return React.useMemo(
    () => ({
      onCloseAutoFocus: (event: Event) => {
        const skip = opened.current;
        opened.current = false;
        if (skip) event.preventDefault();
      },
      panelOpened: () => {
        opened.current = true;
      },
      reset: () => {
        opened.current = false;
      },
    }),
    [],
  );
}

/** The ••• button a menu item belongs to, which the panel returns focus to when it closes. */
function menuTrigger(item: HTMLElement): HTMLElement | null {
  const id = item.closest('[role="menu"]')?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id) : null;
}

export function BotMenuItems({
  pinned,
  Item,
  Separator,
  focusGuard,
  returnFocus,
  onAction,
}: {
  pinned: boolean;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  /** The guard whose `onCloseAutoFocus` is on this menu's content. */
  focusGuard: BotMenuFocusGuard;
  /** Where the panel returns focus when the menu has no labelled trigger, such as a row's right-click menu. */
  returnFocus?: () => HTMLElement | null;
  onAction(action: BotMenuAction, returnFocus?: HTMLElement | null): void;
}) {
  // Each open mounts the items afresh, so a flag left by an earlier open never carries over.
  React.useEffect(() => focusGuard.reset(), [focusGuard]);
  const choose = (action: BotMenuAction) => (event: Event) => {
    const item = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    focusGuard.reset();
    onAction(action, (item ? menuTrigger(item) : null) ?? returnFocus?.() ?? null);
    // Only an action that ran keeps focus off the trigger; one that threw leaves Radix to restore it.
    if (PANEL_ACTIONS.has(action)) focusGuard.panelOpened();
  };
  return (
    <>
      <Item onSelect={choose("profile")}>Profile</Item>
      <Item onSelect={choose("files")}>Files</Item>
      <Item onSelect={choose("memory")}>Memory</Item>
      <Item onSelect={choose("routines")}>Routines</Item>
      <Item onSelect={choose("advanced")}>Advanced</Item>
      <Item onSelect={choose("pin")}>{pinned ? "Unpin" : "Pin to top"}</Item>
      <Separator />
      <Item color="status-red" onSelect={choose("delete")}>
        Delete Bot
      </Item>
    </>
  );
}

/**
 * A Bot row's right-click menu and its hover ••• button, with the same items.
 * The row is `children` (the right-click target); `rowRef` points at it, so a
 * panel opened from the right-click menu hands focus back to the row.
 */
export function BotRowMenus({
  bot,
  pinned,
  rowRef,
  moreClassName,
  onAction,
  children,
}: {
  bot: Pick<BotDefinition, "name">;
  pinned: boolean;
  rowRef: React.RefObject<HTMLElement | null>;
  moreClassName?: string;
  onAction(action: BotMenuAction, returnFocus?: HTMLElement | null): void;
  children: React.ReactElement;
}) {
  const contextGuard = useBotMenuFocusGuard();
  const moreGuard = useBotMenuFocusGuard();
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={contextGuard.onCloseAutoFocus}>
          <BotMenuItems
            pinned={pinned}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            focusGuard={contextGuard}
            returnFocus={() => rowRef.current}
            onAction={onAction}
          />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            iconOnly
            variant="transparent"
            size="small"
            aria-label={`More for ${bot.name}`}
            className={cn(
              "absolute opacity-0 transition-opacity duration-(--motion-duration) ease-standard group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none",
              moreClassName,
            )}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={moreGuard.onCloseAutoFocus}>
          <BotMenuItems
            pinned={pinned}
            Item={DropdownMenuItem}
            Separator={DropdownMenuSeparator}
            focusGuard={moreGuard}
            onAction={onAction}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** What each menu item does for a Bot. Delete is the caller's, because it owns the confirmation. */
export function useBotMenuActions(onDelete: (bot: BotDefinition) => void) {
  const navigate = useNavigate();
  const { show } = useBotPanelActions();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chatBotId = botChatRouteBotId(pathname);
  return React.useCallback(
    (bot: BotDefinition, action: BotMenuAction, returnFocus?: HTMLElement | null) => {
      switch (action) {
        case "profile":
          void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
          return;
        case "advanced":
          void navigate({ to: "/bots/$botId", params: { botId: bot.id }, search: { page: "advanced" } });
          return;
        case "files":
        case "memory":
        case "routines":
          show(action, { returnFocus });
          if (chatBotId !== bot.id) void navigate(botChatPath(bot.id));
          return;
        case "pin":
          botSidebarPreferenceActions.togglePin(bot.id);
          return;
        case "delete":
          onDelete(bot);
          return;
      }
    },
    [chatBotId, navigate, onDelete, show],
  );
}
