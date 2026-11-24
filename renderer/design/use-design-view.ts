// One chat's view of its workspace canvas: the page on screen, where the
// person looks on each page, and the canvas's size. The shared canvas
// document holds none of this, so a pan, a zoom or a page switch never saves
// the document and is never an undo step.
//
// Main keeps the view (`DesignCanvasViews`, persisted per workspace), so the
// renderer keeps no copy of its own. On mount the canvas reads it with
// `designCanvas:view:get`, then reports every change, 250 ms after the last
// one, with the newest `focusId` it has seen: Aiden's page changes carry one,
// and main ignores a report that has not seen the newest. Unmounting sends the
// pending report first, then `{ mounted: false }`.
//
// Each report also says whether the person can see the canvas now: not while
// the stacked layout shows the Chat pane, nor while the window's document is
// hidden. Main keeps a live app's dev server only for a visible canvas.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";
import type { DesignCanvas, DesignViewport } from "../shared/design-canvas/schema";
import { DESIGN_FRESH_VIEWPORT } from "../shared/design-canvas/view";
import { useDesignPane } from "./design-pane";

export const DESIGN_VIEW_REPORT_DELAY_MS = 250;

type Size = { w: number; h: number };

export interface DesignViewHandle {
  /** False until main's kept view has been read; the canvas waits for it. */
  loaded: boolean;
  /** The page on screen: the view's page while it exists, else the chat's own page, else an earlier or the first page. */
  pageId: string;
  /** Where the person looks at that page. */
  viewport: DesignViewport;
  /** The person shows another page; it opens where they last left it. */
  showPage(pageId: string): void;
  /** The person panned or zoomed the page on screen. */
  moved(viewport: DesignViewport): void;
  /** The canvas's size on screen. */
  setSize(size: Size): void;
  /**
   * Aiden showed a page (`designCanvas:focus`). Its `pageId` is applied even
   * when the canvas does not fit the frames, unless a newer page change was
   * already seen; its `focusId` is echoed in every later report.
   */
  applyFocus(focus: { pageId?: string; focusId?: number }): void;
}

type State = {
  loaded: boolean;
  pageId: string | undefined;
  /**
   * Pages shown before this one, newest first. When the page on screen goes
   * and the chat has no page of its own that exists, the canvas goes back to
   * the newest of these, so undoing a page's creation returns to where the
   * person was.
   */
  earlier: readonly string[];
  viewports: Readonly<Record<string, DesignViewport>>;
};

const EMPTY: State = { loaded: false, pageId: undefined, earlier: [], viewports: {} };
const MAX_EARLIER = 16;

/** `state` showing `pageId`, the page it showed before kept as the first to go back to. */
function showing(state: State, pageId: string): State {
  if (state.pageId === pageId) return state;
  const earlier = state.pageId === undefined ? state.earlier : [state.pageId, ...state.earlier.filter((id) => id !== state.pageId)];
  return { ...state, pageId, earlier: earlier.filter((id) => id !== pageId).slice(0, MAX_EARLIER) };
}

/**
 * The page on screen: the view's own while it exists, else the chat's own
 * page (`chatPages`), else the newest earlier page that exists, else the
 * first. Main resolves a turn's page in the same order (`designTurnPages`).
 */
function shownPageId(doc: DesignCanvas, state: State, chatId: string): string {
  const exists = (id: string | undefined): id is string => id !== undefined && doc.pages.some((page) => page.id === id);
  if (exists(state.pageId)) return state.pageId;
  const claim = Object.prototype.hasOwnProperty.call(doc.chatPages, chatId) ? doc.chatPages[chatId] : undefined;
  if (exists(claim)) return claim;
  return state.earlier.find(exists) ?? doc.pages[0]!.id;
}

export function useDesignView(workspaceId: string, chatId: string, doc: DesignCanvas | undefined): DesignViewHandle {
  const [state, setState] = React.useState<State>(EMPTY);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  /** The newest Aiden page change seen, from main's kept view or a focus request. */
  const focusId = React.useRef(0);
  const size = React.useRef<Size | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const docRef = React.useRef(doc);
  docRef.current = doc;
  const { stacked, pane } = useDesignPane();
  // Only the pane: main adds whether the window is shown, since macOS can report an occluded window's document hidden.
  const visible = !stacked || pane === "canvas";
  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;

  /** Sends the view as it is now, if the canvas knows its page. */
  const send = React.useCallback(() => {
    const current = stateRef.current;
    const shown = docRef.current;
    if (!current.loaded || !shown) return;
    const pageId = shownPageId(shown, current, chatId);
    const view = {
      pageId,
      viewport: current.viewports[pageId] ?? DESIGN_FRESH_VIEWPORT,
      ...(size.current ? { size: size.current } : {}),
    };
    void designCanvasApi
      .reportDesignCanvasView(chatId, { workspaceId, view, focusId: focusId.current, visible: visibleRef.current })
      .catch(() => undefined);
  }, [chatId, workspaceId]);
  const schedule = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      send();
    }, DESIGN_VIEW_REPORT_DELAY_MS);
  }, [send]);

  React.useEffect(() => {
    let cancelled = false;
    focusId.current = 0;
    setState(EMPTY);
    void designCanvasApi.getDesignCanvasView(chatId).then(
      (kept) => {
        if (cancelled) return;
        // A focus applied while this read was on its way wins unless main has seen a newer page change.
        const applied = focusId.current;
        focusId.current = Math.max(applied, kept?.focusId ?? 0);
        setState((current) => {
          const viewports = { ...(kept?.viewports ?? {}), ...current.viewports };
          const keptWins = kept !== null && (current.pageId === undefined || kept.focusId > applied);
          if (kept && keptWins && viewports[kept.pageId] === undefined) viewports[kept.pageId] = kept.viewport;
          const next = { ...current, loaded: true, viewports };
          return keptWins ? showing(next, kept.pageId) : next;
        });
      },
      () => {
        // Without main's view the canvas opens on the first page, at the fresh viewport.
        if (!cancelled) setState((current) => ({ ...current, loaded: true }));
      },
    );
    return () => {
      cancelled = true;
      // The last change counts before the canvas says it closed, so switching chats keeps the page.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        send();
      }
      void designCanvasApi.reportDesignCanvasView(chatId, { mounted: false }).catch(() => undefined);
    };
  }, [chatId, workspaceId, send]);

  const hasDoc = doc !== undefined;

  const showPage = React.useCallback(
    (pageId: string) => {
      setState((current) => showing(current, pageId));
      schedule();
    },
    [schedule],
  );
  const moved = React.useCallback(
    (viewport: DesignViewport) => {
      const shown = docRef.current;
      if (!shown) return;
      setState((current) => {
        const pageId = shownPageId(shown, current, chatId);
        const before = current.viewports[pageId];
        if (before && before.x === viewport.x && before.y === viewport.y && before.zoom === viewport.zoom) return current;
        return { ...current, viewports: { ...current.viewports, [pageId]: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } } };
      });
      schedule();
    },
    [schedule, chatId],
  );
  const setSize = React.useCallback(
    (next: Size) => {
      if (size.current?.w === next.w && size.current.h === next.h) return;
      size.current = next.w >= 1 && next.h >= 1 ? { w: next.w, h: next.h } : null;
      schedule();
    },
    [schedule],
  );
  const applyFocus = React.useCallback(
    (focus: { pageId?: string; focusId?: number }) => {
      if (focus.focusId !== undefined) {
        if (focus.focusId < focusId.current) return;
        focusId.current = focus.focusId;
      }
      const pageId = focus.pageId;
      if (pageId !== undefined) setState((current) => showing(current, pageId));
      // Main already holds Aiden's page; the report says this canvas applied it.
      schedule();
    },
    [schedule],
  );

  const pageId = doc ? shownPageId(doc, state, chatId) : (state.pageId ?? "");
  // Once loaded, main hears the canvas is open and what it shows, and again
  // whenever the page on screen changes (a fallback, or the view's page coming
  // back), or the canvas is shown or hidden, so its kept view and presence
  // match the screen.
  React.useEffect(() => {
    if (state.loaded && hasDoc) schedule();
  }, [state.loaded, hasDoc, pageId, visible, schedule]);
  return {
    loaded: state.loaded,
    pageId,
    viewport: state.viewports[pageId] ?? DESIGN_FRESH_VIEWPORT,
    showPage,
    moved,
    setSize,
    applyFocus,
  };
}
