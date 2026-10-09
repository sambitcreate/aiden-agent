import { ChevronLeft, Ellipsis } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";

/** Back to the Bots list, in the chat toolbar's leading slot. */
export function BotChatBackButton({ onBack }: { onBack(): void }) {
  return (
    <Button iconOnly variant="toolbar" size="large" aria-label="All Bots" onClick={onBack}>
      <ChevronLeft />
    </Button>
  );
}

/** The chat toolbar's title: the Bot's avatar and name, which open its Profile. */
export function BotChatNamePill({
  bot,
  onOpenProfile,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "avatar">;
  onOpenProfile(): void;
}) {
  return (
    <Button
      variant="transparent"
      size="large"
      className="-ml-2 max-w-full min-w-0 gap-2 pl-1.5 pr-3"
      aria-label={`${bot.name} profile`}
      onClick={onOpenProfile}
    >
      <BotAvatar botId={bot.id} avatar={bot.avatar} name={bot.name} photoLoading="immediate" size="small" />
      <span className="truncate text-strong font-medium">{bot.name}</span>
    </Button>
  );
}

/** The action side of a Bot chat: one ••• menu with Profile, Files, and Delete Bot. */
export function BotChatActions({
  bot,
  onOpenProfile,
  onOpenFiles,
  onDelete,
}: {
  bot: Pick<BotDefinition, "name">;
  onOpenProfile(): void;
  onOpenFiles?(): void;
  onDelete(): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button iconOnly variant="toolbar" size="large" aria-label={`More for ${bot.name}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpenProfile}>Profile</DropdownMenuItem>
        {onOpenFiles ? <DropdownMenuItem onSelect={onOpenFiles}>Files</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem color="status-red" onSelect={onDelete}>
          Delete Bot
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
