// The canvas's Add menu: a note, a group, or a workspace page or image.

import { Plus } from "lucide-react";
import * as React from "react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui";

export type DesignAddKind = "note" | "group" | "file" | "image";

export function DesignAddMenu({
  canAddFiles,
  onAdd,
}: {
  /** False while the chat's grant loads, or when its workspace cannot be framed. */
  canAddFiles: boolean;
  onAdd(kind: DesignAddKind): void;
}) {
  // A new note takes the focus. While the menu is open it traps focus, so the
  // note is added only once the menu has closed, and the closing menu must not
  // hand focus back to the trigger.
  const pendingNote = React.useRef(false);
  const choose = (kind: DesignAddKind) => {
    if (kind === "note") pendingNote.current = true;
    else onAdd(kind);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="glass" size="small" className="nodrag">
          <Plus aria-hidden />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          if (!pendingNote.current) return;
          pendingNote.current = false;
          event.preventDefault();
          onAdd("note");
        }}
      >
        <DropdownMenuItem onSelect={() => choose("note")}>Note</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => choose("group")}>Group</DropdownMenuItem>
        <DropdownMenuItem disabled={!canAddFiles} onSelect={() => choose("file")}>
          File…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canAddFiles} onSelect={() => choose("image")}>
          Image…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
