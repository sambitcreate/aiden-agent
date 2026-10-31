import type * as React from "react";
import { Ellipsis, PanelRightClose, PanelRightOpen } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui";
import { useShortcutBinding, useShortcutLabel } from "../../lib/command-system";
import { ariaKeyShortcut } from "../../shared/keybindings";
import type { BotDefinition } from "../../shared/bots";
import { BotMenuItems, useBotMenuFocusGuard, type BotMenuAction } from "./bot-menu";
import { BOT_PANEL_ID, useBotPanel } from "./bot-panel-context";

/** The chat toolbar's title: the Bot's avatar and name, which open its Profile. */
export function BotChatNamePill({
  bot,
  onOpenProfile,
  working = false,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "avatar">;
  onOpenProfile(): void;
  /** The Bot is in a running turn: its face glances. */
  working?: boolean;
}) {
  return (
    <Button
      variant="bar"
      size="medium"
      // The heading clips overflow for the ellipsis, so the focus ring is drawn inside.
      style={{ "--keyboard-focus-offset": "-2px" } as React.CSSProperties}
      className="max-w-full min-w-0 shrink gap-1.5 pl-0.5 pr-2 text-primary"
      aria-label={`${bot.name} profile`}
      onClick={onOpenProfile}
    >
      <BotAvatar botId={bot.id} avatar={bot.avatar} name={bot.name} photoLoading="immediate" size="small" working={working} />
      <span className="truncate text-strong font-medium">{bot.name}</span>
    </Button>
  );
}

/** The action side of a Bot chat: the shared Bot ••• menu (spec §10). */
export function BotChatActions({
  bot,
  pinned,
  paused = false,
  onAction,
}: {
  bot: Pick<BotDefinition, "name">;
  pinned: boolean;
  /** The person paused this Bot: the menu offers Resume Bot. */
  paused?: boolean;
  onAction(action: BotMenuAction, returnFocus?: HTMLElement | null): void;
}) {
  const focusGuard = useBotMenuFocusGuard();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button iconOnly variant="bar" size="small" aria-label={`More for ${bot.name}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={focusGuard.onCloseAutoFocus}>
        <BotMenuItems
          pinned={pinned}
          paused={paused}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
          focusGuard={focusGuard}
          onAction={onAction}
        />
      </DropdownMenuContent>
    </DropdownMenu>
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
