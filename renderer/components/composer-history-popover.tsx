import * as React from "react";
import { CornerDownRight, History, Paperclip } from "lucide-react";
import { cn } from "../lib/ui-utils";
import { revealInList } from "../lib/reveal-in-list";
import { useDebouncedAnnouncement } from "../lib/use-debounced-announcement";
import { usePresence } from "../lib/use-presence";
import { clippedUnicode } from "../shared/unicode-prefix";
import type { ComposerHistoryEntry, ComposerHistoryReplyStatus } from "../lib/composer-history";

export const COMPOSER_HISTORY_POPOVER_ID = "composer-history-popover";

/** Stable option id for a history row; safe as an ARIA IDREF. */
export function historyOptionId(index: number): string {
  return `${COMPOSER_HISTORY_POPOVER_ID}-option-${index}`;
}

interface ComposerHistoryPopoverProps {
  entries: readonly ComposerHistoryEntry[];
  activeIndex: number;
  /** Whether the highlighted entry can be forked right now (⌥↩ / Alt+Enter). */
  canForkActive?: boolean;
  /** Shortcut label for committing the highlighted prompt (`↩` on macOS, `Enter` elsewhere). */
  useShortcutLabel?: string;
  /** Shortcut label for Edit in fork (`⌥↩` on macOS, `Alt+Enter` elsewhere). */
  forkShortcutLabel?: string;
  onSelect: (entry: ComposerHistoryEntry) => void;
  presenceState?: "visible" | "exiting";
  /** The popover root, so presence waits for its exit animation. */
  presenceRef?: React.Ref<HTMLDivElement>;
}

export function ComposerHistoryPopoverPresence({
  present,
  immediate = false,
  children,
}: {
  present: boolean;
  immediate?: boolean;
  children: React.ReactElement<ComposerHistoryPopoverProps> | null;
}) {
  const lastContentRef = React.useRef(children);
  const ref = React.useRef<HTMLDivElement>(null);
  const { rendered, exiting } = usePresence(present, ref);
  React.useLayoutEffect(() => {
    if (present && children) lastContentRef.current = children;
  }, [children, present]);

  if (!rendered || (!present && immediate)) return null;
  const content = present ? children : lastContentRef.current;
  return content
    ? React.cloneElement(content, { presenceState: exiting ? "exiting" : "visible", presenceRef: ref })
    : null;
}

function replyStatusLabel(status: ComposerHistoryReplyStatus): string {
  switch (status) {
    case "answered":
      return "Previous reply";
    case "failed":
      return "Reply failed";
    case "blocked":
      return "Blocked by hook";
    case "stopped":
      return "Reply stopped";
    case "none":
      return "No reply";
    case "pending":
      return "Waiting for reply…";
  }
}

function formatHistoryTime(createdAt: number | undefined): string | null {
  if (createdAt === undefined || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  try {
    return new Date(createdAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

/**
 * Floating history tray above the composer: lists past sent messages (oldest
 * at top, newest at bottom near the input) and shows the paired assistant
 * reply for the highlighted message. Textarea keeps focus and owns the listbox
 * through aria-controls and aria-activedescendant.
 */
export function ComposerHistoryPopover({
  entries,
  activeIndex,
  canForkActive = false,
  useShortcutLabel = "↩",
  forkShortcutLabel = "⌥↩",
  onSelect,
  presenceState = "visible",
  presenceRef,
}: ComposerHistoryPopoverProps) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const activeEntry = activeIndex >= 0 ? entries[activeIndex] : undefined;
  const count = entries.length;

  const statusText = activeEntry ? replyStatusLabel(activeEntry.replyStatus) : "";
  // Base announcements on selection identity + prompt + status, not live replyPreview text,
  // so streaming tokens on the active turn never spam the screen reader live region.
  const [announcement] = useDebouncedAnnouncement(
    activeEntry
      ? `Message ${activeIndex + 1} of ${count}: ${clippedUnicode(activeEntry.promptPreview, 100)}. ${statusText}.`
      : "",
    180,
  );

  React.useEffect(() => {
    const row = activeIndex >= 0 ? document.getElementById(historyOptionId(activeIndex)) : null;
    // Scrolls only the history list: the composer and conversation stay put.
    if (row) revealInList(row, listRef.current);
  }, [activeIndex, count]);

  return (
    <div
      ref={presenceRef}
      // Keeps focus (and the caret) in the textarea when dragging the scrollbar or clicking the reply footer.
      onPointerDown={(event) => event.preventDefault()}
      className="composer-slash-palette absolute inset-x-3 bottom-full z-40 mb-2 origin-bottom overflow-hidden rounded-dialog bg-popover/98 shadow-popover backdrop-blur-xl"
      data-composer-history-popover
      data-browser-occluder
      data-presence={presenceState}
      aria-hidden={presenceState === "exiting" ? "true" : undefined}
    >
      <div
        ref={listRef}
        id={COMPOSER_HISTORY_POPOVER_ID}
        role="listbox"
        aria-label="Message history"
        className="max-h-[min(15rem,34vh)] overflow-y-auto overscroll-contain p-1.5 [mask-image:linear-gradient(to_bottom,transparent_0,black_0.35rem,black_calc(100%_-_0.35rem),transparent_100%)]"
      >
        {entries.map((entry, index) => {
          const selected = index === activeIndex;
          const timeLabel = formatHistoryTime(entry.createdAt);
          return (
            <div
              id={historyOptionId(index)}
              key={entry.id}
              role="option"
              aria-selected={selected}
              data-selected={selected || undefined}
              onClick={() => onSelect(entry)}
              className={cn(
                "flex min-h-9 cursor-default items-center gap-2 rounded-menu px-2.5 py-1.5 outline-none transition-colors duration-100",
                selected ? "bg-control" : "hover:bg-list-hover",
              )}
            >
              <History
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 text-tertiary transition-colors duration-100",
                  selected && "text-secondary",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-regular text-primary">
                {entry.promptPreview}
              </span>
              {entry.attachmentCount ? (
                <span
                  aria-hidden="true"
                  className="inline-flex shrink-0 items-center gap-0.5 text-mini text-tertiary tabular-nums"
                >
                  <Paperclip className="size-3" />
                  {entry.attachmentCount}
                </span>
              ) : null}
              {timeLabel ? (
                <span className="shrink-0 text-mini text-tertiary tabular-nums">
                  {timeLabel}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {activeEntry ? (
        <div
          data-composer-history-reply
          className="border-t border-separator bg-input px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-mini text-tertiary">
              <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate font-medium">{statusText}</span>
              {count > 1 ? (
                <span className="shrink-0 tabular-nums">
                  · {activeIndex + 1} of {count}
                </span>
              ) : null}
            </span>
            <span
              aria-hidden="true"
              className="shrink-0 text-mini text-tertiary max-[520px]:hidden"
            >
              {canForkActive
                ? `↑↓ browse · ${useShortcutLabel} use · ${forkShortcutLabel} edit in fork · Esc close`
                : `↑↓ browse · ${useShortcutLabel} use · Esc close`}
            </span>
          </div>
          {activeEntry.replyPreview ? (
            <p className="mt-1 line-clamp-3 text-small text-secondary [overflow-wrap:anywhere]">
              {activeEntry.replyPreview}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
