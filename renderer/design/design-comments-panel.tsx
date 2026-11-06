// All comments: every comment on the canvas, filtered to Open, Sent or
// Resolved. Choosing one brings its page and pin on screen and opens it.

import { MessagesSquare } from "lucide-react";
import * as React from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "../components/ui";
import { Segmented } from "../components/ui-primitives";
import { commentLabel } from "../shared/design-canvas/comments";
import type { DesignCanvas, DesignComment } from "../shared/design-canvas/schema";
import { commentNumbers } from "./comment-geometry";

type Filter = DesignComment["state"];

const FILTERS = [
  { value: "open", label: "Open" },
  { value: "sent", label: "Sent" },
  { value: "resolved", label: "Resolved" },
] as const satisfies readonly { value: Filter; label: string }[];

const EMPTY: Record<Filter, string> = {
  open: "No open comments. Press C and click anything to comment.",
  sent: "Nothing is waiting on Aiden.",
  resolved: "No resolved comments yet.",
};

export function DesignCommentsPanel({ doc, onOpen }: { doc: DesignCanvas; onOpen(id: string): void }) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<Filter>("open");
  const numbers = React.useMemo(() => commentNumbers(doc), [doc]);
  const pages = new Map(doc.pages.map((page) => [page.id, page.name]));
  const shown = doc.comments
    .filter((comment) => comment.state === filter)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const openCount = doc.comments.filter((comment) => comment.state === "open").length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={open ? "muted" : "transparent"}
          iconOnly
          aria-label={openCount > 0 ? `All comments, ${openCount} open` : "All comments"}
          title="All comments"
        >
          <MessagesSquare />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2" aria-label="All comments">
        <Segmented value={filter} onValueChange={setFilter} options={FILTERS} aria-label="Show" className="w-full [&>*]:flex-1" />
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-small text-secondary">{EMPTY[filter]}</p>
        ) : (
          <ul className="mt-2 flex max-h-[min(24rem,60vh)] flex-col overflow-y-auto">
            {shown.map((comment) => (
              <li key={comment.id}>
                <button
                  type="button"
                  className="flex w-full min-w-0 cursor-default items-start gap-2 rounded-control px-2 py-1.5 text-left outline-none hover:bg-list-hover focus-visible:bg-list-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  onClick={() => {
                    setOpen(false);
                    onOpen(comment.id);
                  }}
                >
                  <span
                    aria-hidden
                    className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full rounded-bl-none bg-control text-small-strong text-secondary"
                  >
                    {numbers.get(comment.id)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small text-secondary">
                      {doc.pages.length > 1 ? `${pages.get(comment.pageId) ?? "Page"} · ` : ""}
                      {commentLabel(doc, comment)}
                      {comment.anchorState === "lost" ? " · Element not found" : ""}
                    </span>
                    <span className="line-clamp-2 text-regular text-primary">{comment.note}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
