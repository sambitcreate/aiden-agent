// The tray above the composer while design comments wait to go to Aiden:
// how many there are, Send, and a list to open or take any of them out.
// Queued comments also go with the next message the person sends.

import { ChevronDown, MessageCircle, X } from "lucide-react";
import * as React from "react";
import { Button } from "../components/ui";
import { cn } from "../lib/ui-utils";
import type { DesignCommentTray as Tray } from "./comment-tray-store";

export function DesignCommentTray({
  tray,
  disabled,
  onSend,
}: {
  tray: Tray;
  /** Sending is not possible right now (a send is on its way, say). */
  disabled: boolean;
  onSend(): void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const count = tray.comments.length;
  const title = `${count} ${count === 1 ? "comment" : "comments"} for Aiden`;
  return (
    <section aria-label="Design comments for Aiden" className="relative z-0 mx-3 mb-1.5 rounded-button bg-popover p-1 shadow-control">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="transparent"
          size="small"
          aria-expanded={expanded}
          aria-controls={listId}
          className="min-w-0 flex-1 justify-start"
          onClick={() => setExpanded((current) => !current)}
        >
          <MessageCircle aria-hidden className="text-secondary" />
          <span className="min-w-0 truncate">{title}</span>
          <ChevronDown
            aria-hidden
            className={cn("text-secondary transition-transform duration-(--motion-duration) motion-reduce:transition-none", expanded && "rotate-180")}
          />
        </Button>
        <Button variant="accent" size="small" disabled={disabled} onClick={onSend}>
          Send
        </Button>
      </div>
      {expanded ? (
        <ul id={listId} className="mt-1 flex max-h-48 flex-col overflow-y-auto">
          {tray.comments.map((comment) => (
            <li key={comment.id} className="group flex min-w-0 items-center gap-1 rounded-control hover:bg-list-hover">
              <button
                type="button"
                className="min-w-0 flex-1 cursor-default rounded-control px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                onClick={() => tray.open(comment.id)}
              >
                <span className="block truncate text-small text-secondary">{comment.label}</span>
                <span className="block truncate text-regular text-primary">{comment.note}</span>
              </button>
              <Button
                variant="transparent"
                size="small"
                iconOnly
                aria-label={`Keep "${comment.note}" as a comment`}
                title="Take out of the tray"
                onClick={() => tray.remove(comment.id)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
