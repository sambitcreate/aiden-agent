// The person's actions on a live app frame's page (design mode v2 Phase 3c):
// Add view at width (S93), Duplicate page as variant (S95) and Move page file
// to Trash (S96), each after the pending save lands, since main reads the
// saved canvas. Main decides every path; this only sends the frame id and
// says what happened. A refusal Aiden could still carry out offers Ask
// Aiden, which queues a note on the frame for the next message and never
// sends it by itself.

import * as React from "react";
import { toast } from "../components/ui";
import { designCanvasApi, type DesignAppPageRefusal, type DesignPageFileOutcome } from "../lib/ipc";
import { isMacPlatform } from "../lib/ghostty-terminal/host-platform";
import type { DesignCanvas, DesignFrame } from "../shared/design-canvas/schema";
import type { AppViewSize } from "./app-frame-menus";

const UNSAVED = "The canvas couldn't be saved, so nothing was changed.";

type PageActionError = DesignAppPageRefusal | "unavailable" | "not-found" | "locked" | "full" | "io";

/** Why a copy or a Trash was refused, in one plain line. */
export function pageActionMessage(error: PageActionError, action: "copy" | "trash"): string {
  const verb = action === "copy" ? "copied" : "moved to the Trash";
  switch (error) {
    case "config-router":
      return `This app sets its routes in code, so its page files can't be ${verb} from here.`;
    case "dynamic":
      return action === "copy"
        ? "This page comes from a dynamic route, so copying its file would copy every page it serves."
        : "This page comes from a dynamic route, so its file serves other pages too.";
    case "layout":
      return "This page's file is also the layout of the pages under it.";
    case "no-file":
      return "No single file in the app makes this page.";
    case "several-files":
      return "More than one file makes this page, so it isn't clear which one to use.";
    case "special-files":
      return "This page's folder has its own layout or loading files, which a copy in another folder would lose.";
    case "relative-imports":
      return "This page imports files beside it, so a copy in another folder would break.";
    case "route-literal":
      return "This page's route path couldn't be updated safely in a copy.";
    case "too-many":
      return "This page already has copies up to -v9.";
    case "too-large":
      return `This page's file is too large to be ${verb} here.`;
    case "not-regular":
      return "This page's file is a link or not a regular file, so it was left alone.";
    case "truncated":
      return "This app has too many files to be sure which one makes this page.";
    case "read-only":
      return "This workspace can't change files, so nothing was changed.";
    case "locked":
      return "This frame, or a frame of its page, is locked.";
    case "full":
      return "There isn't room on this page for another frame.";
    case "not-found":
      return "This frame is no longer on the canvas.";
    case "unavailable":
      return "This isn't available for this chat right now.";
    case "io":
      return action === "copy" ? "The page's file couldn't be copied." : "The page's file couldn't be moved to the Trash.";
  }
}

/** Refusals Aiden could still carry out by editing the app: these offer Ask Aiden. */
const ASK_AIDEN: ReadonlySet<PageActionError> = new Set([
  "config-router",
  "dynamic",
  "layout",
  "no-file",
  "several-files",
  "special-files",
  "relative-imports",
  "route-literal",
  "too-many",
  "too-large",
  "not-regular",
  "truncated",
]);

/** The path a frame's page's first copy would have, for Ask Aiden's note: `/pricing?plan=pro` → `/pricing-v2`. */
export function firstVariantPath(route: string): string {
  const cut = route.search(/[?#]/u);
  let page = cut < 0 ? route : route.slice(0, cut);
  while (page.length > 1 && page.endsWith("/")) page = page.slice(0, -1);
  if (page === "/") return "/index-v2";
  return `${page.replace(/-v[2-9]$/u, "")}-v2`;
}

/** The page path a frame shows, without its query, hash or trailing slash. */
function pageOf(route: string | undefined): string {
  const value = route ?? "/";
  const cut = value.search(/[?#]/u);
  let page = cut < 0 ? value : value.slice(0, cut);
  while (page.length > 1 && page.endsWith("/")) page = page.slice(0, -1);
  return page;
}

/** What a page-file outcome says, in its own chat. */
export function pageFileMessage(outcome: DesignPageFileOutcome): string {
  if ("done" in outcome) return outcome.done === "trash" ? `Moved ${outcome.file} to the Trash.` : `Put ${outcome.file} back.`;
  if (outcome.reason === "changed") return `${outcome.file} changed since, so it was left as it is.`;
  if (outcome.reason === "exists") return `Something is already at ${outcome.file}, so it wasn't put back.`;
  return outcome.failed === "trash" ? `${outcome.file} couldn't be moved to the Trash.` : `${outcome.file} couldn't be put back.`;
}

/** How long the Trash's Undo toast waits for the canvas to show the Trash before it says ⌘Z instead. */
export const TRASH_UNDO_WAIT_MS = 5000;

export function useAppPageActions({
  chatId,
  doc,
  latestDoc,
  flush,
  undo,
  queueOnFrame,
  focusCanvas,
}: {
  chatId: string;
  doc: DesignCanvas;
  latestDoc: React.RefObject<DesignCanvas>;
  flush(): Promise<boolean>;
  undo(): void;
  queueOnFrame(frameId: string, note: string): boolean;
  /** Puts focus on the canvas; `unlessMoved` leaves focus the person moved out of the canvas. */
  focusCanvas(options?: { unlessMoved?: boolean }): void;
}): {
  addAppView(id: string, size: AppViewSize): void;
  duplicateAppPage(id: string): void;
  trashAppPage(id: string): void;
  trashing: ReadonlySet<string>;
} {
  const [trashing, setTrashing] = React.useState<ReadonlySet<string>>(() => new Set());
  /** Each Trash reply still waiting for the canvas to show its revision, by that revision (Pullfrog r4724521924): one Trash never drops another's toast. */
  const pendingTrash = React.useRef(new Map<number, { file: string; timer: ReturnType<typeof setTimeout> }>());
  const frameOf = React.useCallback((id: string): DesignFrame | undefined => latestDoc.current?.frames.find((frame) => frame.id === id), [latestDoc]);

  const refuse = React.useCallback(
    (frameId: string, error: PageActionError, action: "copy" | "trash", extra = "") => {
      const message = `${pageActionMessage(error, action)}${extra}`;
      if (!ASK_AIDEN.has(error)) {
        toast.error(message);
        return;
      }
      toast.error(message, {
        action: {
          label: "Ask Aiden",
          onClick: () => {
            const frame = frameOf(frameId);
            const note =
              action === "copy" ? `Duplicate this page as a variant named ${firstVariantPath(frame?.route ?? "/")}.` : "Move this page's file to the Trash.";
            if (queueOnFrame(frameId, note)) toast("Added a note for Aiden on this frame. It goes with your next message.");
          },
        },
      });
    },
    [frameOf, queueOnFrame],
  );

  const addAppView = React.useCallback(
    (id: string, size: AppViewSize) => {
      void (async () => {
        if (!(await flush().catch(() => false))) {
          toast.error(UNSAVED);
          return;
        }
        const result = await designCanvasApi.addDesignAppView(chatId, { frameId: id, ...size }).catch(() => ({ error: "unavailable" as const }));
        if (!("error" in result)) return;
        toast.error(
          result.error === "bad-size"
            ? "A view needs a whole width and height from 200 to 4000."
            : pageActionMessage(result.error === "full" ? "full" : result.error, "copy"),
        );
      })();
    },
    [chatId, flush],
  );

  // One action per frame at a time: a second ⌘D while the first copies would only race it.
  const busy = React.useRef(new Set<string>());
  const duplicateAppPage = React.useCallback(
    (id: string) => {
      if (busy.current.has(id) || frameOf(id)?.kind !== "app") return;
      busy.current.add(id);
      void (async () => {
        if (!(await flush().catch(() => false))) {
          toast.error(UNSAVED);
          return;
        }
        const result = await designCanvasApi.duplicateDesignAppPage(chatId, { frameId: id }).catch(() => ({ error: "io" as const }));
        if ("error" in result) {
          // Aiden removes nothing it wrote (Pullfrog r4724929189), so a refusal says where the file it left is.
          if ("kept" in result && typeof result.kept === "string") {
            toast.error(`The canvas couldn't be saved, so the copy wasn't added. It's still at ${result.kept}.`);
            return;
          }
          const empty = "empty" in result && typeof result.empty === "string" ? ` An empty file was left at ${result.empty}.` : "";
          refuse(id, result.error, "copy", empty);
          return;
        }
        toast.success(`Copied the page's file to ${result.file}.`);
      })().finally(() => busy.current.delete(id));
    },
    [chatId, flush, frameOf, refuse],
  );

  const showTrashToast = React.useCallback(
    (file: string, withUndo: boolean) => {
      const key = isMacPlatform() ? "⌘Z" : "Ctrl+Z";
      if (!withUndo) {
        toast(`Moved ${file} to the Trash. Press ${key} to undo.`);
        return;
      }
      // The canvas as it shows the Trash step: any change since (an edit, another chat's save) may be the step ⌘Z takes first.
      const shown = latestDoc.current;
      toast(`Moved ${file} to the Trash.`, {
        action: {
          label: "Undo",
          onClick: () => {
            if (latestDoc.current === shown) undo();
            else toast(`The canvas changed since the Trash. Press ${key} to undo it.`);
          },
        },
      });
    },
    [latestDoc, undo],
  );

  const trashAppPage = React.useCallback(
    (id: string) => {
      const frame = frameOf(id);
      if (busy.current.has(id) || frame?.kind !== "app") return;
      busy.current.add(id);
      // Every frame of that page dims at once; main removes them all.
      const appRoot = frame.appRoot ?? ".";
      const page = pageOf(frame.route);
      const ids = (latestDoc.current?.frames ?? [])
        .filter((entry) => entry.kind === "app" && (entry.appRoot ?? ".") === appRoot && pageOf(entry.route) === page)
        .map((entry) => entry.id);
      setTrashing((current) => new Set([...current, ...ids]));
      // Focus stays with the canvas, so ⌘Z works as soon as the Trash lands.
      focusCanvas();
      const undim = () =>
        setTrashing((current) => {
          const next = new Set(current);
          for (const entry of ids) next.delete(entry);
          return next;
        });
      void (async () => {
        if (!(await flush().catch(() => false))) {
          undim();
          toast.error(UNSAVED);
          return;
        }
        const result = await designCanvasApi.trashDesignAppPage(chatId, { frameId: id }).catch(() => ({ error: "io" as const }));
        if ("error" in result) {
          undim();
          if ("restore" in result && result.restore === "failed") {
            toast.error("The page's file is in the Trash, but the canvas couldn't change. Put the file back from the Trash.");
            return;
          }
          refuse(id, result.error, "trash");
          return;
        }
        // The frames are gone from the canvas; focus stays with it, so ⌘Z works at once, unless the person moved on.
        undim();
        focusCanvas({ unlessMoved: true });
        const shownRevision = latestDoc.current?.revision ?? -1;
        if (shownRevision >= result.revision) {
          // Only a canvas at exactly the Trash's revision took it in as its own step; a later one carried it in with another change.
          showTrashToast(result.trashed, shownRevision === result.revision);
          return;
        }
        // Undo always undoes the Trash step: it's offered only once the canvas shows that step, as its own.
        const pending = pendingTrash.current;
        const timer = setTimeout(() => {
          if (pending.get(result.revision)?.timer !== timer) return;
          pending.delete(result.revision);
          showTrashToast(result.trashed, false);
        }, TRASH_UNDO_WAIT_MS);
        pending.set(result.revision, { file: result.trashed, timer });
      })().finally(() => busy.current.delete(id));
    },
    [chatId, flush, focusCanvas, frameOf, latestDoc, refuse, showTrashToast],
  );

  React.useEffect(() => {
    const pending = pendingTrash.current;
    for (const [revision, entry] of [...pending]) {
      if (doc.revision < revision) continue;
      clearTimeout(entry.timer);
      pending.delete(revision);
      showTrashToast(entry.file, doc.revision === revision);
    }
  }, [doc.revision, showTrashToast]);

  React.useEffect(() => {
    const pending = pendingTrash.current;
    return () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);

  // What the ledger did after an undo or redo, in this chat only.
  React.useEffect(
    () =>
      designCanvasApi.onDesignPageFile((outcome) => {
        if (outcome.chatId !== chatId) return;
        if ("done" in outcome) toast(pageFileMessage(outcome));
        else toast.error(pageFileMessage(outcome));
      }),
    [chatId],
  );

  return { addAppView, duplicateAppPage, trashAppPage, trashing };
}
