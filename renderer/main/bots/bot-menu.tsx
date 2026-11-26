// The one Bot ••• menu (spec §10, plan §4.4), for the chat header, sidebar rows
// (hover and right-click) and the pinned Bot: Pin to top/Unpin, Pause Bot/Resume
// Bot, the bubble items (Bubble, or Open bubble and Bring back to window, or
// Bubble again for a recent one; docs/bot-bubbles.md), then Delete Bot. A Bot's settings, files, memory and routines are in its
// side panel, opened from its name.

import * as React from "react";
import { AppWindow, Ellipsis, MessageCircle, MessageCircleMore, Pause, Pin, PinOff, Play, Trash2 } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
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
import { applyBotBubbleChange, botBubblesApi, useBotBubbles } from "../../lib/bot-bubbles-api";
import { botChatRouteBotId } from "../../lib/bot-routes";
import { useOptionalShortcutLabel } from "../../lib/command-system";
import { isBotBubbled, parseBotBubbleRect, type BotBubbleRect, type BotBubbleState } from "../../shared/bot-bubbles";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { cn } from "../../lib/ui-utils";
import type { BotDefinition } from "../../shared/bots";
import { botSidebarPreferenceActions } from "./use-bot-sidebar-preferences";
import { openContextMenuFromKeyboard } from "../../lib/keyboard-context-menu";

export type BotMenuAction =
  | "pin"
  | "pause"
  | "unpause"
  | "bubble"
  | "openBubble"
  | "bringBack"
  | "delete";

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

/**
 * The chat area to shrink from, in CSS pixels: the conversation region nearest
 * `from` (the header button), else the one on screen. Undefined when there is
 * none or it has no size, and the head then simply appears.
 */
export function botChatSourceRect(from?: Element | null): BotBubbleRect | undefined {
  const selector = '[data-focus-region="chat"]';
  let region: Element | null = null;
  for (let node: Element | null = from ?? null; node && !region; node = node.parentElement) {
    region = node.matches(selector) ? node : node.querySelector(selector);
  }
  region ??= typeof document === "undefined" ? null : document.querySelector(selector);
  if (!region) return undefined;
  const { x, y, width, height } = region.getBoundingClientRect();
  return parseBotBubbleRect({ x, y, width, height }) ?? undefined;
}

/** Shrink a Bot's chat into a head. Failures show a toast; the chat stays as it is. */
export async function bubbleBot(
  bot: Pick<BotDefinition, "id" | "name">,
  sourceRect?: BotBubbleRect,
): Promise<void> {
  try {
    await applyBotBubbleChange(botBubblesApi.bubble(sourceRect ? { botId: bot.id, sourceRect } : { botId: bot.id }));
  } catch (error) {
    toast.error(userFacingErrorMessage(error, `Aiden couldn’t bubble ${bot.name}.`));
  }
}

/** Which bubble items a Bot's menu shows. */
export function botBubbleMenuItems(state: BotBubbleState, botId: string): BotMenuAction[] {
  // Bubbles turned off: heads are hidden (and come back when they are on again).
  if (state.host === "off") return [];
  return isBotBubbled(state, botId) ? ["openBubble", "bringBack"] : ["bubble"];
}

function BotBubbleItems({
  botId,
  Item,
  choose,
}: {
  botId: string;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  choose(action: BotMenuAction): () => void;
}) {
  const state = useBotBubbles();
  const shortcut = useOptionalShortcutLabel("bots.bubble");
  const items = botBubbleMenuItems(state, botId);
  if (items.length === 0) return null;
  // A Bot pushed out of the bubbles (or closed) is offered again by name.
  const recent = state.recents.includes(botId);
  return (
    <>
      {items.map((action) =>
        action === "bubble" ? (
          <Item key={action} onSelect={choose("bubble")}>
            <MessageCircle className={MENU_ICON} />
            <span className="flex-1">{recent ? "Bubble again" : "Bubble"}</span>
            {shortcut ? (
              <kbd aria-hidden="true" className="shrink-0 font-sans text-small text-tertiary">
                {shortcut}
              </kbd>
            ) : null}
          </Item>
        ) : action === "openBubble" ? (
          <Item key={action} onSelect={choose("openBubble")}>
            <MessageCircleMore className={MENU_ICON} />
            Open bubble
          </Item>
        ) : (
          <Item key={action} onSelect={choose("bringBack")}>
            <AppWindow className={MENU_ICON} />
            Bring back to window
          </Item>
        ),
      )}
    </>
  );
}

export function BotMenuItems({
  botId,
  pinned,
  paused = false,
  Item,
  Separator,
  onAction,
}: {
  /** The Bot the menu is for; without it the menu shows no bubble items. */
  botId?: string;
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
      {botId ? <BotBubbleItems botId={botId} Item={Item} choose={choose} /> : null}
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
  bot: Pick<BotDefinition, "id" | "name">;
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
            botId={bot.id}
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
            botId={bot.id}
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
  // Read at choose time, so the callback stays the same as the route changes.
  const router = useRouter();
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
        case "bubble": {
          // Shrink from the chat only when it is this Bot's chat on screen.
          const open = botChatRouteBotId(router.state.location.pathname) === bot.id;
          void bubbleBot(bot, open ? botChatSourceRect() : undefined);
          return;
        }
        case "openBubble":
          void applyBotBubbleChange(botBubblesApi.open(bot.id)).catch((error: unknown) =>
            toast.error(userFacingErrorMessage(error, `Aiden couldn’t open ${bot.name}’s bubble.`)),
          );
          return;
        case "bringBack":
          // Main closes the bubble and sends `bots:bubbles:showChat`, which opens the chat here.
          void applyBotBubbleChange(botBubblesApi.bringBack(bot.id)).catch((error: unknown) =>
            toast.error(userFacingErrorMessage(error, `Aiden couldn’t bring ${bot.name} back.`)),
          );
          return;
        case "delete":
          onDelete(bot);
          return;
      }
    },
    [onDelete, router],
  );
}
