// The one Bot ••• menu (spec §10, plan §4.4), for the chat header, sidebar rows
// (hover and right-click) and the pinned Bot: Pin to top/Unpin, Pause Bot/Resume
// Bot, then Delete Bot. A Bot's settings, files, memory and routines are in its
// side panel, opened from its name.

import * as React from "react";
import { Ellipsis, Pause, Pin, PinOff, Play, Trash2 } from "lucide-react";
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
  toast,
} from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { cn } from "../../lib/ui-utils";
import type { BotDefinition } from "../../shared/bots";
import { botSidebarPreferenceActions } from "./use-bot-sidebar-preferences";
import { openContextMenuFromKeyboard } from "../../lib/keyboard-context-menu";

export type BotMenuAction = "pin" | "pause" | "unpause" | "delete";

/** Leading icons, as in the app's other menus. */
const MENU_ICON = "size-4 shrink-0";

/**
 * Pause the Bot (its running turn stops where it is and nothing new runs) or
 * lift the pause. The Bot's state reaches every window through `bots:changed`.
 */
export async function setBotPaused(bot: Pick<BotDefinition, "id" | "name">, paused: boolean): Promise<void> {
  try {
    if (paused) await botsApi.pause(bot.id);
    else await botsApi.unpause(bot.id);
  } catch (error) {
    toast.error(
      userFacingErrorMessage(error, paused ? `Aiden couldn’t pause ${bot.name}.` : `Aiden couldn’t resume ${bot.name}.`),
    );
  }
}

export function BotMenuItems({
  pinned,
  paused = false,
  Item,
  Separator,
  onAction,
}: {
  pinned: boolean;
  /** The person paused this Bot: the item offers Resume instead of Pause. */
  paused?: boolean;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  onAction(action: BotMenuAction): void;
}) {
  const choose = (action: BotMenuAction) => () => onAction(action);
  return (
    <>
      <Item onSelect={choose("pin")}>
        {pinned ? <PinOff className={MENU_ICON} /> : <Pin className={MENU_ICON} />}
        {pinned ? "Unpin" : "Pin to top"}
      </Item>
      <Item onSelect={choose(paused ? "unpause" : "pause")}>
        {paused ? <Play className={MENU_ICON} /> : <Pause className={MENU_ICON} />}
        {paused ? "Resume Bot" : "Pause Bot"}
      </Item>
      <Separator />
      <Item color="status-red" onSelect={choose("delete")}>
        <Trash2 className={MENU_ICON} />
        Delete Bot
      </Item>
    </>
  );
}

/**
 * A Bot row's right-click menu and its hover ••• button, with the same items.
 * The row is `children` (the right-click target).
 */
export function BotRowMenus({
  bot,
  pinned,
  paused = false,
  moreClassName,
  onAction,
  children,
}: {
  bot: Pick<BotDefinition, "name">;
  pinned: boolean;
  paused?: boolean;
  moreClassName?: string;
  onAction(action: BotMenuAction): void;
  children: React.ReactElement;
}) {
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild onKeyDown={openContextMenuFromKeyboard}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <BotMenuItems
            pinned={pinned}
            paused={paused}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
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
        <DropdownMenuContent align="end">
          <BotMenuItems
            pinned={pinned}
            paused={paused}
            Item={DropdownMenuItem}
            Separator={DropdownMenuSeparator}
            onAction={onAction}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** What each menu item does for a Bot. Delete is the caller's, because it owns the confirmation. */
export function useBotMenuActions(onDelete: (bot: BotDefinition) => void) {
  return React.useCallback(
    (bot: BotDefinition, action: BotMenuAction) => {
      switch (action) {
        case "pin":
          botSidebarPreferenceActions.togglePin(bot.id);
          return;
        case "pause":
        case "unpause":
          void setBotPaused(bot, action === "pause");
          return;
        case "delete":
          onDelete(bot);
          return;
      }
    },
    [onDelete],
  );
}
