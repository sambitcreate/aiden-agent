// ⌘F in a conversation: a small bar over the transcript's top right. ↩ (or
// ⌘G) goes to the next match and ⇧↩ (or ⇧⌘G) to the previous one, Esc closes
// it and puts focus back where it was. Matches follow the transcript as
// replies stream in.

import * as React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button, Input } from "./ui";
import { useCommandHandler } from "../lib/command-system";
import {
  chatFindStatus,
  clearChatMatches,
  findChatMatches,
  paintChatMatches,
} from "../lib/chat-find";

const REFRESH_DELAY_MS = 120;

function transcriptOf(element: HTMLElement | null): HTMLElement | null {
  return element?.closest("[data-scroll-area]")?.querySelector<HTMLElement>("[data-scroll-content]") ?? null;
}

function revealMatch(range: Range | undefined): void {
  const element = range?.startContainer.parentElement;
  element?.scrollIntoView?.({ block: "center" });
}

export function ChatFindBar({ request, onClose }: { request: number; onClose(): void }) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Esc gives focus back to whatever had it when ⌘F opened the bar.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const [query, setQuery] = React.useState("");
  const [matches, setMatches] = React.useState<Range[]>([]);
  const [current, setCurrent] = React.useState(0);

  React.useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !barRef.current?.contains(active)) returnFocusRef.current = active;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [request]);

  // Search now, and again whenever the transcript changes under the query.
  React.useEffect(() => {
    const transcript = transcriptOf(barRef.current);
    if (!transcript) return;
    const search = (reveal: boolean) => {
      const found = findChatMatches(transcript, query);
      setMatches(found);
      if (reveal) {
        setCurrent(0);
        revealMatch(found[0]);
      } else {
        setCurrent((index) => Math.min(index, Math.max(found.length - 1, 0)));
      }
    };
    search(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => search(false), REFRESH_DELAY_MS);
    });
    observer.observe(transcript, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [query]);

  React.useEffect(() => paintChatMatches(matches, current), [current, matches]);
  React.useEffect(() => clearChatMatches, []);

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (current + direction + matches.length) % matches.length;
    setCurrent(next);
    revealMatch(matches[next]);
  };
  const close = () => {
    const target = returnFocusRef.current;
    onClose();
    if (target?.isConnected) target.focus({ preventScroll: true });
  };

  return (
    <div
      ref={barRef}
      role="search"
      aria-label="Find in chat"
      data-chat-find-skip
      className="flex items-center gap-1 rounded-card bg-popover p-1 shadow-popover"
    >
      <Input
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-label="Find in chat"
        placeholder="Find in chat"
        className="h-7 w-48"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey) && !event.altKey) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span
        role="status"
        aria-live="polite"
        className="min-w-16 px-1 text-center text-small tabular-nums text-secondary"
      >
        {query.trim() ? chatFindStatus(matches.length, current) : ""}
      </span>
      <Button
        iconOnly
        variant="transparent"
        size="small"
        aria-label="Previous match"
        aria-keyshortcuts="Shift+Enter"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        iconOnly
        variant="transparent"
        size="small"
        aria-label="Next match"
        aria-keyshortcuts="Enter"
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDown />
      </Button>
      <Button
        iconOnly
        variant="transparent"
        size="small"
        aria-label="Close find"
        aria-keyshortcuts="Escape"
        onClick={close}
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * ⌘F for the conversation on screen. Returns the bar to pass as the
 * transcript ScrollArea's `overlay`; `scopeKey` (the chat) closes it on change.
 */
export function useChatFind(scopeKey: string, enabled = true): React.ReactNode {
  const [state, setState] = React.useState<{ scope: string; request: number } | null>(null);
  useCommandHandler(
    "chat.find",
    () => setState((open) => ({ scope: scopeKey, request: (open?.request ?? 0) + 1 })),
    enabled,
  );
  if (!enabled || state?.scope !== scopeKey) return null;
  return <ChatFindBar request={state.request} onClose={() => setState(null)} />;
}
