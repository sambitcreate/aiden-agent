// The Create (+) menu (docs/plans/bot-ux-simplification.md §4.2): New bot and
// Templates. Both dialogs live here, so the sidebar and the empty Bots page
// open the same ones.

import * as React from "react";
import { Bot, LayoutTemplate, Plus } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";
import { BotCreateFlow } from "./bot-create-flow";
import { BotTemplatesDialog } from "./bot-templates-dialog";

const MENU_ICON = "size-4 shrink-0";

/** New bot and Templates, opened from anywhere that owns this hook's dialogs. */
export function useBotCreateDialogs(onOpenChat: (bot: BotDefinition) => void) {
  const [creating, setCreating] = React.useState(false);
  const [templates, setTemplates] = React.useState(false);
  return {
    creating,
    templates,
    newBot: () => setCreating(true),
    openTemplates: () => setTemplates(true),
    dialogs: (
      <>
        <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => onOpenChat(bot)} />
        <BotTemplatesDialog open={templates} onOpenChange={setTemplates} onOpenChat={onOpenChat} />
      </>
    ),
  };
}

/** The + button and its menu. */
export const BotCreateMenu = React.forwardRef<
  HTMLButtonElement,
  { onNewBot(): void; onTemplates(): void; variant?: "bar" | "toolbar" }
>(function BotCreateMenu({ onNewBot, onTemplates, variant = "bar" }, ref) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "bar" ? (
          <Button ref={ref} iconOnly variant="bar" size="small" aria-label="Create" title="Create">
            <Plus />
          </Button>
        ) : (
          <Button ref={ref} variant="toolbar" size="medium">
            <Plus /> Create
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onNewBot}>
          <Bot className={MENU_ICON} />
          New bot
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onTemplates}>
          <LayoutTemplate className={MENU_ICON} />
          Templates
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
