import { Trash2, X } from "lucide-react";
import { Button } from "../ui";

export interface SelectionBarProps {
  count: number;
  /** Deletes the selected chats, through the confirmation. */
  onDelete: () => void;
  onClear: () => void;
}

/**
 * The compact bar under the chat list while two or more chats are selected:
 * the count and the actions that apply to every selected chat.
 */
export function SelectionBar({ count, onDelete, onClear }: SelectionBarProps) {
  return (
    <div
      role="group"
      aria-label="Selected chats"
      data-selection-bar=""
      className="mx-2.5 mb-2 flex shrink-0 items-center gap-1 rounded-control bg-control/50 py-1 pr-1 pl-2.5"
    >
      <span
        role="status"
        className="min-w-0 flex-1 truncate text-small text-secondary tabular-nums"
      >
        {`${count} selected`}
      </span>
      <Button variant="transparent" size="small" onClick={onDelete}>
        <Trash2 aria-hidden="true" />
        Delete
      </Button>
      <Button
        variant="transparent"
        size="small"
        iconOnly
        aria-label="Clear selection"
        aria-keyshortcuts="Escape"
        title="Clear selection"
        onClick={onClear}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
