// Editing words inside an entered page, on the canvas's side. The page's
// bridge does the editing and reports what changed; this decides where it
// goes. A plain text change is written into the page's file when its old
// words are found once there, and ⌘Z puts them back. A formatting change, or
// words that can't be placed, become a comment on that element queued for
// Aiden, as if the person had written it.

import * as React from "react";
import { toast } from "../components/ui";
import { designCanvasApi } from "../lib/ipc";
import {
  postToDesignPage,
  type DesignBridgeMessage,
  type DesignTextCommand,
} from "../shared/design-canvas/bridge-messages";
import type { DesignPageElement } from "../shared/design-canvas/comments";
import type { DesignCanvas } from "../shared/design-canvas/schema";
import { reverseDesignTextChanges, type DesignTextChange } from "../shared/design-canvas/text-edit";

export type PageTextEditing = { frameId: string; element: DesignPageElement };

type EditMessage = Extract<DesignBridgeMessage, { type: "edit-start" | "edit-end" }>;
type FileEdit = { frameId: string; changes: DesignTextChange[]; stamp?: string };

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The note Aiden gets for an edit it has to make: what the element was and what the person wants. */
export function pageEditNote(message: Extract<EditMessage, { type: "edit-end" }>): string {
  if (message.plain && message.changes.length > 0) {
    const lines = message.changes.map((change) => `"${squash(change.before)}" to "${squash(change.after)}"`);
    return `Change the text ${lines.join(", and ")} in this element. Keep everything else as it is.`;
  }
  return `Change this element to match my edit, keeping the rest of the page as it is.\nIt was: ${message.beforeHtml}\nMake it: ${message.afterHtml}`;
}

export function usePageTextEdits({
  chatId,
  doc,
  pageWindow,
  queueComment,
  flush,
}: {
  chatId: string;
  doc: DesignCanvas;
  /** Saves the canvas now: main finds the page's frame in the saved canvas. */
  flush(): Promise<unknown>;
  pageWindow(frameId: string): Window | null;
  /** Adds a queued comment for Aiden on an element; false when the canvas is full. */
  queueComment(frameId: string, element: DesignPageElement, note: string): boolean;
}) {
  const [editing, setEditing] = React.useState<PageTextEditing | null>(null);
  const history = React.useRef<{ undo: FileEdit[]; redo: FileEdit[] }>({ undo: [], redo: [] });
  const docRef = React.useRef(doc);
  React.useLayoutEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const fileName = (frameId: string) => {
    const frame = docRef.current.frames.find((entry) => entry.id === frameId);
    return frame?.path?.split("/").pop() ?? frame?.title ?? "the page";
  };

  const handToAiden = React.useCallback(
    (frameId: string, message: Extract<EditMessage, { type: "edit-end" }>, why: "format" | "unplaced") => {
      if (!message.element) {
        toast.error("This edit couldn't be placed. Comment on the element instead.");
        return;
      }
      if (!queueComment(frameId, message.element, pageEditNote(message))) {
        toast.error("This canvas has too many comments. Delete some to send this edit.");
        return;
      }
      toast(
        why === "format"
          ? "Aiden will make this formatting change with your next message."
          : "These words appear more than once in the file, so Aiden will make the change with your next message.",
      );
    },
    [queueComment],
  );

  const onMessage = React.useCallback(
    (frameId: string, message: EditMessage) => {
      if (message.type === "edit-start") {
        setEditing({ frameId, element: message.element });
        return;
      }
      setEditing((current) => (current?.frameId === frameId ? null : current));
      if (message.cancelled) return;
      if (!message.plain) {
        handToAiden(frameId, message, "format");
        return;
      }
      if (message.changes.length === 0) return;
      const edit: FileEdit = {
        frameId,
        changes: message.changes,
        ...(message.element?.sourcePath ? { stamp: message.element.sourcePath } : {}),
      };
      void flush()
        .catch(() => undefined)
        .then(() => designCanvasApi.editDesignText(chatId, frameId, edit.changes, edit.stamp))
        .then(
          (result) => {
            if (result.ok) {
              history.current = { undo: [...history.current.undo, edit].slice(-50), redo: [] };
              toast.success(`Saved the words to ${fileName(frameId)}.`);
            } else if (result.reason === "ambiguous" || result.reason === "not-found" || result.reason === "too-long") {
              handToAiden(frameId, message, "unplaced");
            } else if (result.reason !== "unchanged") {
              toast.error("The page's file couldn't be changed.");
            }
          },
          () => toast.error("The page's file couldn't be changed."),
        );
    },
    [chatId, flush, handToAiden],
  );

  const command = React.useCallback(
    (name: DesignTextCommand, value?: string) => {
      if (!editing) return;
      postToDesignPage(pageWindow(editing.frameId), { type: "edit-command", command: name, ...(value !== undefined ? { value } : {}) });
    },
    [editing, pageWindow],
  );

  const finish = React.useCallback(
    (cancel: boolean) => {
      if (!editing) return;
      postToDesignPage(pageWindow(editing.frameId), { type: "edit-finish", cancel });
    },
    [editing, pageWindow],
  );

  /** Writes one file edit back the other way; true when there was one to take. */
  const step = React.useCallback(
    (from: "undo" | "redo"): boolean => {
      const stack = history.current[from];
      const edit = stack[stack.length - 1];
      if (!edit) return false;
      history.current = {
        ...history.current,
        [from]: stack.slice(0, -1),
      };
      const changes = from === "undo" ? reverseDesignTextChanges(edit.changes) : edit.changes;
      void flush()
        .catch(() => undefined)
        .then(() => designCanvasApi.editDesignText(chatId, edit.frameId, changes, edit.stamp))
        .then(
          (result) => {
            if (result.ok) {
              const other = from === "undo" ? "redo" : "undo";
              history.current = { ...history.current, [other]: [...history.current[other], edit] };
              toast(from === "undo" ? `Put back the words in ${fileName(edit.frameId)}.` : `Saved the words to ${fileName(edit.frameId)} again.`);
            } else {
              toast.error("The file changed since, so those words can't be put back.");
            }
          },
          () => toast.error("The page's file couldn't be changed."),
        );
      return true;
    },
    [chatId, flush],
  );

  /** A change on the canvas comes after the file edits, so ⌘Z goes to it first. */
  const forget = React.useCallback(() => {
    if (history.current.undo.length > 0 || history.current.redo.length > 0) history.current = { undo: [], redo: [] };
  }, []);

  return {
    editing,
    onMessage,
    command,
    finish,
    undo: React.useCallback(() => step("undo"), [step]),
    redo: React.useCallback(() => step("redo"), [step]),
    forget,
  };
}
