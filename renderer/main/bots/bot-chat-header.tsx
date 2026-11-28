import type * as React from "react";
import { Ellipsis, MessageCircle, PanelRightClose, PanelRightOpen } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import type { BotAvatarState } from "../../shared/bot-sprite";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui";
import { useBotBubbles } from "../../lib/bot-bubbles-api";
import { useShortcutBinding, useShortcutLabel } from "../../lib/command-system";
import { isBotBubbled } from "../../shared/bot-bubbles";
import { ariaKeyShortcut } from "../../shared/keybindings";
import type { BotDefinition } from "../../shared/bots";
import { BotMenuItems, botChatSourceRect, bubbleBot, type BotMenuAction } from "./bot-menu";
import { BOT_PANEL_ID, useBotPanel } from "./bot-panel-context";

/** The chat toolbar's title: the Bot's avatar and name, which open its settings in the side panel. */
export function BotChatNamePill({
  bot,
  onOpenProfile,
  avatarState = "idle",
}: {
  bot: Pick<BotDefinition, "id" | "name" | "avatar">;
  /** Opens the side panel on the Advanced tab. */
  onOpenProfile(): void;
  /**
   * The face's live pose (`useBotAvatarState`): it acts out the running turn and its done or
   * error moment. At idle the face is a static sprite, with no blink.
   */
  avatarState?: BotAvatarState;
}) {
  return (
    <Button
      variant="bar"
      size="medium"
      // The heading clips overflow for the ellipsis, so the focus ring is drawn inside.
      style={{ "--keyboard-focus-offset": "-2px" } as React.CSSProperties}
      className="max-w-full min-w-0 shrink gap-1.5 pl-0.5 pr-2 text-primary"
      aria-label={`${bot.name} settings`}
      aria-controls={BOT_PANEL_ID}
      onClick={onOpenProfile}
    >
      <BotAvatar
        botId={bot.id}
        avatar={bot.avatar}
        name={bot.name}
        photoLoading="immediate"
        size="small"
        state={avatarState === "idle" ? undefined : avatarState}
      />
      <span className="truncate text-strong font-medium">{bot.name}</span>
    </Button>
  );
}

/**
 * Shrinks this Bot's chat into a floating head (docs/bot-bubbles.md). Hidden
 * when bubbles are off, and while the Bot is bubbled (the chat shows the
 * "in a bubble" card then).
 */
export function BotBubbleButton({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
  const bubbles = useBotBubbles();
  if (bubbles.host === "off" || isBotBubbled(bubbles, bot.id)) return null;
  return (
    <Button
      iconOnly
      variant="bar"
      size="small"
      aria-label={`Bubble ${bot.name}`}
      title="Bubble"
      onClick={(event) => void bubbleBot(bot, botChatSourceRect(event.currentTarget))}
    >
      <MessageCircle />
    </Button>
  );
}

/** The action side of a Bot chat: the bubble button and the shared Bot ••• menu (spec §10). */
export function BotChatActions({
  bot,
  pinned,
  paused = false,
  onAction,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  pinned: boolean;
  /** The person paused this Bot: the menu offers Resume Bot. */
  paused?: boolean;
  onAction(action: BotMenuAction): void;
}) {
  return (
    <>
      <BotBubbleButton bot={bot} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button iconOnly variant="bar" size="small" aria-label={`More for ${bot.name}`}>
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

/** Shows and hides the Bot side panel; `environment.toggle` does the same from the keyboard. */
export function BotPanelToggle() {
  const panel = useBotPanel();
  const shortcut = useShortcutLabel("environment.toggle");
  const binding = useShortcutBinding("environment.toggle");
  return (
    <Button
      iconOnly
      variant="bar"
      size="small"
      onClick={panel.toggle}
      aria-label={panel.open ? "Hide panel" : "Show panel"}
      aria-pressed={panel.open}
      aria-controls={BOT_PANEL_ID}
      aria-keyshortcuts={ariaKeyShortcut(binding)}
      title={`Toggle panel (${shortcut})`}
      data-bot-panel-toggle
    >
      {panel.open ? <PanelRightClose /> : <PanelRightOpen />}
    </Button>
  );
}
