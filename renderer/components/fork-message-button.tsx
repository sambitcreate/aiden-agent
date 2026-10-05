// Transcript hover action that forks the chat at one message. Settled replies
// offer "Fork from here"; sent prompts offer "Edit in fork". Right-clicking a
// settled message offers the same fork, "Fork with summary…", and Copy for a
// text selection inside it.

import * as React from "react";
import { Copy, GitFork, ListCollapse, SquarePen } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui";

export interface MessageForkAction {
  onFork: () => void;
  /** Fork and summarize what followed; absent when nothing follows this message. */
  onForkWithSummary?: () => void;
  /** When set, forking is unavailable right now and this explains why. */
  disabledReason?: string | null;
}

interface ForkMessageButtonProps {
  action: MessageForkAction;
  kind: "fork" | "edit";
  className?: string;
}

function forkLabel(kind: "fork" | "edit"): string {
  return kind === "fork" ? "Fork from here" : "Edit in fork";
}

export function ForkMessageButton({ action, kind, className }: ForkMessageButtonProps) {
  const label = forkLabel(kind);
  const disabledReason = action.disabledReason ?? null;
  const Icon = kind === "fork" ? GitFork : SquarePen;
  return (
    <button
      type="button"
      onClick={disabledReason ? undefined : action.onFork}
      aria-label={label}
      aria-disabled={disabledReason ? true : undefined}
      title={disabledReason ?? label}
      data-fork-action={kind}
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-1.5 py-1 text-tertiary outline-none",
        "transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none",
        "aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-tertiary aria-disabled:[&>svg]:opacity-50",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </button>
  );
}

/** The selected text when the selection lies inside `container`. */
function selectedTextWithin(container: Element): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  return container.contains(range.commonAncestorContainer) ? selection.toString() : "";
}

interface MessageForkContextMenuProps {
  action: MessageForkAction;
  kind: "fork" | "edit";
  children: React.ReactElement;
}

/** Wraps one settled message so a right-click offers its fork actions. */
export function MessageForkContextMenu({ action, kind, children }: MessageForkContextMenuProps) {
  const [selectedText, setSelectedText] = React.useState("");
  const disabled = Boolean(action.disabledReason);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => setSelectedText(selectedTextWithin(event.currentTarget))}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {selectedText ? (
          <>
            <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(selectedText)}>
              <Copy aria-hidden="true" className="size-4 text-tertiary" />
              Copy
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem disabled={disabled} onSelect={action.onFork}>
          {kind === "fork" ? (
            <GitFork aria-hidden="true" className="size-4 text-tertiary" />
          ) : (
            <SquarePen aria-hidden="true" className="size-4 text-tertiary" />
          )}
          {forkLabel(kind)}
        </ContextMenuItem>
        {action.onForkWithSummary ? (
          <ContextMenuItem disabled={disabled} onSelect={action.onForkWithSummary}>
            <ListCollapse aria-hidden="true" className="size-4 text-tertiary" />
            {kind === "fork" ? "Fork with summary…" : "Edit in fork with summary…"}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
