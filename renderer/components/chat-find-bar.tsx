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

function scrollportOf(transcript: HTMLElement | null): HTMLElement | null {
  return transcript?.parentElement ?? null;
}

function scrolls(element: HTMLElement, axis: "x" | "y"): boolean {
  const overflow = getComputedStyle(element)[axis === "y" ? "overflowY" : "overflowX"];
  const room = axis === "y" ? element.scrollHeight > element.clientHeight : element.scrollWidth > element.clientWidth;
  return room && (overflow === "auto" || overflow === "scroll");
}

/**
 * Centre the match itself, not its element: one text node can be a whole
 * code block, taller than the conversation. Inner scrollers (a wide code
 * block) move first, then each one out to the conversation's scrollport.
 */
function revealMatch(range: Range | undefined, scrollport: HTMLElement | null): void {
  if (!range || typeof range.getBoundingClientRect !== "function") return;
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    const scrollY = scrolls(element, "y");
    const scrollX = scrolls(element, "x");
    if (scrollY || scrollX) {
      const match = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      element.scrollBy({
        top: scrollY ? match.top - box.top - (box.height - match.height) / 2 : 0,
        left: scrollX ? match.left - box.left - (box.width - match.width) / 2 : 0,
      });
    }
    if (element === scrollport) return;
  }
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
        revealMatch(found[0], scrollportOf(transcript));
      } else {
        setCurrent((index) => Math.min(index, Math.max(found.length - 1, 0)));
      }
    };
    search(true);
    // At most one refresh pending: a reply streaming faster than the delay
    // still refreshes every REFRESH_DELAY_MS rather than only when it pauses.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        search(false);
      }, REFRESH_DELAY_MS);
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
    revealMatch(matches[next], scrollportOf(transcriptOf(barRef.current)));
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
      // Esc closes from any control in the bar, not only the search field.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
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
          if (event.key === "Enter") {
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
  // Leaving the chat forgets the bar, so coming back doesn't reopen it.
  if (state && state.scope !== scopeKey) setState(null);
  if (!enabled || state?.scope !== scopeKey) return null;
  return <ChatFindBar request={state.request} onClose={() => setState(null)} />;
}
