// The design canvas's toolbar, at its top left: the page picker, the Select,
// Hand and Comment tools, a sticky note, and the Add menu for groups,
// workspace pages and images. Drawing tools join it in later slices.

import { ChevronDown, Hand, MessageCircle, MousePointer2, Plus, StickyNote } from "lucide-react";
import * as React from "react";
import { CANVAS_TOOL_SHORTCUTS, type CanvasTool } from "../canvas/canvas-keymap-core";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "../components/ui";
import { canAddPage } from "../shared/design-canvas/pages";
import { DesignCommentsPanel } from "./design-comments-panel";
import { activeDesignPage, DESIGN_CANVAS_LIMITS, type DesignCanvas } from "../shared/design-canvas/schema";

export type DesignAddKind = "note" | "group" | "file" | "image";

export type DesignPageAction =
  | { type: "show"; id: string }
  | { type: "add" }
  | { type: "rename"; id: string; name: string }
  | { type: "duplicate"; id: string }
  | { type: "delete"; id: string }
  | { type: "move"; id: string; step: -1 | 1 };

export const DESIGN_NOTE_SHORTCUT = "N";
export const DESIGN_COMMENT_SHORTCUT = "C";

const TOOLS = [
  { tool: "select", label: "Select", Icon: MousePointer2 },
  { tool: "hand", label: "Hand", Icon: Hand },
] as const satisfies readonly { tool: CanvasTool; label: string; Icon: typeof Hand }[];

export function DesignToolbar({
  doc,
  tool,
  onToolChange,
  commenting,
  onComment,
  onOpenComment,
  canAddFiles,
  onAdd,
  onPage,
}: {
  doc: DesignCanvas;
  tool: CanvasTool;
  onToolChange(tool: CanvasTool): void;
  /** The comment tool is on; it replaces the Select tool while it is. */
  commenting: boolean;
  onComment(): void;
  /** Brings a comment on screen and opens it. */
  onOpenComment(id: string): void;
  /** False while the chat's grant loads, or when its workspace cannot be framed. */
  canAddFiles: boolean;
  onAdd(kind: DesignAddKind): void;
  onPage(action: DesignPageAction): void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className="glass-surface nodrag flex max-w-full items-center gap-0.5 overflow-x-auto rounded-button p-1 shadow-control"
    >
      <DesignPageMenu doc={doc} onPage={onPage} />
      <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
      {TOOLS.map(({ tool: item, label, Icon }) => {
        const shortcut = CANVAS_TOOL_SHORTCUTS[item];
        const on = tool === item && !commenting;
        return (
          <Button
            key={item}
            variant={on ? "muted" : "transparent"}
            iconOnly
            aria-label={label}
            aria-pressed={on}
            aria-keyshortcuts={shortcut}
            title={`${label} (${shortcut})`}
            onClick={() => onToolChange(item)}
          >
            <Icon />
          </Button>
        );
      })}
      <Button
        variant={commenting ? "muted" : "transparent"}
        iconOnly
        aria-label="Comment"
        aria-pressed={commenting}
        aria-keyshortcuts={DESIGN_COMMENT_SHORTCUT}
        title={`Comment (${DESIGN_COMMENT_SHORTCUT})`}
        onClick={onComment}
      >
        <MessageCircle />
      </Button>
      <DesignCommentsPanel doc={doc} onOpen={onOpenComment} />
      <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
      <Button
        variant="transparent"
        iconOnly
        aria-label="Note"
        aria-keyshortcuts={DESIGN_NOTE_SHORTCUT}
        title={`Note (${DESIGN_NOTE_SHORTCUT})`}
        onClick={() => onAdd("note")}
      >
        <StickyNote />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="transparent" iconOnly aria-label="Add" title="Add">
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onAdd("group")}>Group</DropdownMenuItem>
          <DropdownMenuItem disabled={!canAddFiles} onSelect={() => onAdd("file")}>
            File…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canAddFiles} onSelect={() => onAdd("image")}>
            Image…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The page picker: every page, and what can be done to the one on screen. */
function DesignPageMenu({ doc, onPage }: { doc: DesignCanvas; onPage(action: DesignPageAction): void }) {
  const page = activeDesignPage(doc);
  const at = doc.pages.indexOf(page);
  const [renaming, setRenaming] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  // Rename opens its dialog once the menu has closed, so the menu does not take focus back from it.
  const pendingRename = React.useRef(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            variant="transparent"
            size="small"
            aria-label={`Page: ${page.name}`}
            className="max-w-48 shrink-0"
          >
            <span className="min-w-0 truncate">{page.name}</span>
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(28rem,70vh)] min-w-56"
          onCloseAutoFocus={(event) => {
            if (!pendingRename.current) return;
            pendingRename.current = false;
            event.preventDefault();
            setRenaming(true);
          }}
        >
          <DropdownMenuLabel>Pages</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={page.id} onValueChange={(id) => onPage({ type: "show", id })}>
            {doc.pages.map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                <span className="min-w-0 truncate">{entry.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canAddPage(doc)} onSelect={() => onPage({ type: "add" })}>
            New page
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              pendingRename.current = true;
            }}
          >
            Rename page…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canAddPage(doc)} onSelect={() => onPage({ type: "duplicate", id: page.id })}>
            Duplicate page
          </DropdownMenuItem>
          <DropdownMenuItem disabled={at <= 0} onSelect={() => onPage({ type: "move", id: page.id, step: -1 })}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={at >= doc.pages.length - 1}
            onSelect={() => onPage({ type: "move", id: page.id, step: 1 })}
          >
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            color="red"
            disabled={doc.pages.length <= 1}
            onSelect={() => onPage({ type: "delete", id: page.id })}
          >
            Delete page
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? (
        <RenamePageDialog
          name={page.name}
          onClose={() => setRenaming(false)}
          onRename={(name) => onPage({ type: "rename", id: page.id, name })}
          returnFocus={() => trigger.current}
        />
      ) : null}
    </>
  );
}

function RenamePageDialog({
  name,
  onClose,
  onRename,
  returnFocus,
}: {
  name: string;
  onClose(): void;
  onRename(name: string): void;
  returnFocus(): HTMLElement | null;
}) {
  const [value, setValue] = React.useState(name);
  const clean = value.trim();
  const save = () => {
    if (!clean) return;
    if (clean !== name) onRename(clean);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rename page"
      confirmLabel="Rename"
      confirmDisabled={!clean}
      onConfirm={save}
      submitOnEnter
      returnFocus={returnFocus}
    >
      <Input
        aria-label="Page name"
        value={value}
        maxLength={DESIGN_CANVAS_LIMITS.pageNameChars}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
      />
    </Dialog>
  );
}
