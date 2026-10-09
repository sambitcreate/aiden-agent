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

/** The title side of a Bot chat: back, then a name pill that opens the Profile. */
export function BotChatTitle({
  bot,
  onBack,
  onOpenProfile,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "avatar">;
  onBack(): void;
  onOpenProfile(): void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Button iconOnly variant="toolbar" size="large" aria-label="All Bots" onClick={onBack}>
        <ChevronLeft />
      </Button>
      <Button
        variant="toolbar"
        size="large"
        className="min-w-0 gap-2 pl-1.5"
        aria-label={`${bot.name} profile`}
        onClick={onOpenProfile}
      >
        <BotAvatar botId={bot.id} avatar={bot.avatar} name={bot.name} photoLoading="immediate" size="small" />
        <span className="truncate">{bot.name}</span>
      </Button>
    </span>
  );
}

/** The action side of a Bot chat: one ••• menu with Profile, Files, and Delete. */
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
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
