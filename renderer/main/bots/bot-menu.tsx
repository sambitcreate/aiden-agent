// The one Bot ••• menu (spec §10), for the chat header, sidebar rows (hover and
// right-click) and the pinned Bot: Profile, Files, Memory, Routines, Advanced,
// Pin to top/Unpin, then Delete Bot. Files, Memory and Routines open the side
// panel on that tab, beside that Bot's chat.

import * as React from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type {
  ContextMenuItem,
  ContextMenuSeparator,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../components/ui";
import { botChatPath, botChatRouteBotId } from "../../lib/bot-routes";
import type { BotDefinition } from "../../shared/bots";
import { useBotPanelActions } from "./bot-panel-context";
import { useBotSidebarPreferences } from "./use-bot-sidebar-preferences";

export type BotMenuAction = "profile" | "files" | "memory" | "routines" | "advanced" | "pin" | "delete";

// Set when the chosen item opened the side panel, so the menu's close does not
// pull focus back to the ••• button after the panel has taken it.
let openedPanel = false;

/** Pass as `onCloseAutoFocus` on the menu content: skips Radix's focus restore when the panel took focus. */
export function botMenuCloseAutoFocus(event: Event): void {
  const skip = openedPanel;
  openedPanel = false;
  if (skip) event.preventDefault();
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
  onAction,
}: {
  pinned: boolean;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  onAction(action: BotMenuAction, returnFocus?: HTMLElement | null): void;
}) {
  // Each open mounts the items afresh, so a flag left by an earlier open never carries over.
  React.useEffect(() => {
    openedPanel = false;
  }, []);
  const choose = (action: BotMenuAction) => (event: Event) => {
    const item = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    openedPanel = action === "files" || action === "memory" || action === "routines";
    onAction(action, item ? menuTrigger(item) : null);
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

/** What each menu item does for a Bot. Delete is the caller's, because it owns the confirmation. */
export function useBotMenuActions(onDelete: (bot: BotDefinition) => void) {
  const navigate = useNavigate();
  const { show } = useBotPanelActions();
  const { preferences, pin, unpin } = useBotSidebarPreferences();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chatBotId = botChatRouteBotId(pathname);
  const pinnedBotId = preferences.pinnedBotId;
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
          if (pinnedBotId === bot.id) unpin();
          else pin(bot.id);
          return;
        case "delete":
          onDelete(bot);
          return;
      }
    },
    [chatBotId, navigate, onDelete, pin, pinnedBotId, show, unpin],
  );
}
