import * as React from "react";
import { FileText, Folder, X } from "lucide-react";
import { cn } from "../lib/ui-utils";
import { revealInList } from "../lib/reveal-in-list";
import { useDebouncedAnnouncement } from "../lib/use-debounced-announcement";
import type { ComposerMention, MentionCandidate } from "../lib/composer-mentions";
import { MatchText } from "./match-text";

export const COMPOSER_MENTION_PICKER_ID = "composer-mention-picker";

/** The option id for a candidate's row; ids stay valid IDREFs whatever the path holds. */
export function mentionOptionId(index: number): string {
  return `${COMPOSER_MENTION_PICKER_ID}-option-${index}`;
}

/** The `@` picker over the composer: a listbox the textarea owns through aria-activedescendant. */
export function ComposerMentionPicker({
  candidates,
  activeIndex,
  loading,
  error,
  onActiveIndexChange,
  onPick,
}: {
  candidates: readonly MentionCandidate[];
  activeIndex: number;
  loading: boolean;
  error: boolean;
  onActiveIndexChange: (index: number) => void;
  onPick: (candidate: MentionCandidate) => void;
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const count = candidates.length;
  const [announcement] = useDebouncedAnnouncement(
    error
      ? "Files couldn't be listed."
      : loading
        ? "Loading files."
        : count === 0
          ? "No matching files."
          : `${count} file${count === 1 ? "" : "s"}.`,
    180,
  );

  React.useEffect(() => {
    const row = count > 0 ? document.getElementById(mentionOptionId(activeIndex)) : null;
    // Scrolls only the list: the composer and the chat around it stay put.
    if (row) revealInList(row, listRef.current);
  }, [activeIndex, count]);

  const status = error
    ? "Files couldn't be listed."
    : loading && count === 0
      ? "Loading files…"
      : count === 0
        ? "No files match."
        : null;

  return (
    <div
      className="composer-slash-palette absolute inset-x-3 bottom-full z-40 mb-2 origin-bottom overflow-hidden rounded-dialog bg-popover/98 shadow-popover backdrop-blur-xl"
      data-composer-mention-picker
      data-browser-occluder
      // Shares the slash palette's enter motion; it closes at once.
      data-presence="visible"
    >
      <div
        ref={listRef}
        id={COMPOSER_MENTION_PICKER_ID}
        role="listbox"
        aria-label="Workspace files"
        className="max-h-[min(20rem,48vh)] overflow-y-auto overscroll-contain p-2"
      >
        {status ? (
          <div role="status" className="min-h-9 px-2.5 py-2 text-small text-secondary">
            {status}
          </div>
        ) : (
          candidates.map((candidate, index) => {
            const { entry } = candidate;
            const selected = index === activeIndex;
            const Icon = entry.kind === "directory" ? Folder : FileText;
            return (
              <div
                id={mentionOptionId(index)}
                key={entry.path}
                role="option"
                aria-selected={selected}
                data-selected={selected || undefined}
                onPointerMove={() => onActiveIndexChange(index)}
                // Keeps focus (and the caret) in the textarea.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onPick(candidate)}
                className={cn(
                  "flex min-h-9 cursor-default items-center gap-2 rounded-menu px-2.5 py-1 outline-none transition-colors duration-100",
                  selected ? "bg-control" : "hover:bg-list-hover",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-tertiary", selected && "text-secondary")} />
                <span className="shrink-0 truncate text-regular text-primary">
                  <MatchText text={entry.name} ranges={candidate.ranges} />
                </span>
                {entry.parentPath ? (
                  <span className="min-w-0 truncate text-small text-tertiary">{entry.parentPath}</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

/**
 * Picked mentions as chips above the text. Each is one unit: its remove
 * button, or Backspace at the start of the text, takes the whole chip.
 */
export function ComposerMentionChips({
  mentions,
  disabled,
  onRemove,
}: {
  mentions: readonly ComposerMention[];
  disabled: boolean;
  onRemove: (path: string) => void;
}) {
  if (mentions.length === 0) return null;
  return (
    <ul aria-label="Mentioned files" className="mb-1.5 flex flex-wrap gap-2 px-1.5">
      {mentions.map((mention) => {
        const name = mention.path.split("/").filter(Boolean).pop() ?? mention.path;
        const Icon = mention.kind === "directory" ? Folder : FileText;
        return (
          <li
            key={mention.path}
            data-composer-mention={mention.path}
            title={mention.path}
            className="flex min-h-10 min-w-0 max-w-full items-center gap-1.5 rounded-control bg-status-accent-surface pl-2 pr-0 text-small text-primary"
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-accent-text" />
            <span className="max-w-[14rem] truncate font-medium">@{name}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(mention.path)}
              aria-label={`Remove mention ${mention.path}`}
              className="grid size-10 shrink-0 place-items-center rounded-control text-tertiary transition-colors hover:bg-list-hover hover:text-primary focus-visible:bg-list-selection focus-visible:text-primary"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
