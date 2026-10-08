// Copy and Reply on a Bot chat message: right-click anywhere on the message,
// or the ••• button that appears on hover and on keyboard focus.

import * as React from "react";
import { Ellipsis } from "lucide-react";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "../../components/ui";

/** The text Reply puts at the start of the composer: the message as a quote. */
export function botReplyQuote(text: string): string {
  const lines = text.trim().split(/\r?\n/u);
  return `${lines.map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`;
}

async function copyMessage(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Aiden couldn’t copy that message.");
  }
}

export function BotMessageActions({
  text,
  from,
  align,
  onReply,
  children,
}: {
  text: string;
  /** Who wrote it, for the menu button's name ("You" or the Bot's name). */
  from: string;
  align: "start" | "end";
  onReply(text: string): void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={`group relative flex min-w-0 items-start gap-1 ${align === "end" ? "flex-row-reverse" : ""}`} data-bot-message>
          <div className="min-w-0 flex-1">{children}</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                iconOnly
                variant="toolbar"
                size="small"
                aria-label={`Message actions for ${from}’s message`}
                className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={align === "end" ? "end" : "start"}>
              <DropdownMenuItem onSelect={() => void copyMessage(text)}>Copy</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onReply(text)}>Reply</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copyMessage(text)}>Copy</ContextMenuItem>
        <ContextMenuItem onSelect={() => onReply(text)}>Reply</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
