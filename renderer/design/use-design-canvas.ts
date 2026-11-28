// The design canvas controller: loads the chat's canvas, shows edits at once,
// saves them 800 ms after the last one with the revision they started from,
// and keeps undo history. Follows Create Images' autosave
// (renderer/images/workflow-session-core.ts) for the debounce and revisions.
//
// Edits are kept as the functions that made them until a save lands, so a
// revision conflict (the same chat edited in another window, or by Aiden) can
// take the stored canvas and replay this window's edits on top: neither
// side's change is lost. That replay happens once; a second conflict in a row
// keeps the edits on top of the newest stored canvas and reports an error
// rather than looping. A save the app cannot deliver also reports an error.
// Either way the edits wait for the next edit to try again. Leaving the canvas
// saves at once, and edits that still cannot be saved keep trying a few times
// after the canvas has closed. Until they are saved they count as unsaved work:
// quitting, closing or reloading tries them once more and then asks the person
// before discarding them, as it does for the Files editor and Create Images.
//
// Undo and redo are saved as the frames they change, not as whole canvases.
// Taking in another writer's canvas keeps the history: Aiden's canvas changes
// from one reply become one undo step (the person's own edit in between
// starts a new one), and any other writer's change is carried into every
// kept step, so undo never takes back what was changed elsewhere. A fetch or
// a save's reply can bring a reply's revision before its announcement does;
// the history is then built again when the announcement arrives, unless the
// person has made a step of their own since. A change the person made
// through main (Send to canvas placing a visual) is announced as a step of
// its own and taken in the same way, so it undoes alone. An edit the person makes
// without a step of its own (a text frame growing to fit, say) is kept out of
// an Aiden reply's step, so undoing the reply leaves it.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";
import { registerLifecycleFlush, setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import {
  shownPagePaths,
  type DesignCanvas,
  type DesignViewport,
} from "../shared/design-canvas/schema";
import {
  carryUnrecorded,
  changesBetween,
  keepUnchanged,
  record,
  redo,
  takeIn,
  undo,
  type CanvasHistory,
} from "./canvas-history-core";

export const DESIGN_CANVAS_SAVE_DELAY_MS = 800;
/** How long a closed canvas waits before each further try at edits it could not save. */
export const DESIGN_CANVAS_CLOSED_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

const MAX_UNSETTLED_CHANGES = 50;
const MAX_REVISION_LOOKBACK = 1_000;

export type DesignCanvasMutation = (doc: DesignCanvas) => DesignCanvas;
export type DesignCanvasStatus = "loading" | "ready" | "saving" | "error";

export interface DesignCanvasSyncView {
  doc: DesignCanvas | undefined;
  status: DesignCanvasStatus;
  canUndo: boolean;
  canRedo: boolean;
}

export interface DesignCanvasGuardState {
  dirty: boolean;
  saving: boolean;
}

export type DesignCanvasLifecycle = "open" | "closing" | "disposed";

export type DesignCanvasTimer =
  | { readonly kind: "debounce"; readonly delayMs: number }
  | { readonly kind: "closed_retry"; readonly delayMs: number; readonly attemptIndex: number };

export interface DesignCanvasInFlightSave {
  readonly batch: readonly DesignCanvasMutation[];
  readonly doc: DesignCanvas;
  readonly baseRevision: number;
  readonly undone: readonly string[];
  readonly replayed: boolean;
  readonly source: "open" | "close" | "flush";
}

export type DesignCanvasSavePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly save: DesignCanvasInFlightSave };

export interface DesignCanvasTakenIn {
  readonly before: DesignCanvas;
  readonly from: DesignCanvas;
  readonly to: DesignCanvas;
}

/**
 * What changed the history without a step of the person's: a stored canvas
 * taken in, an unrecorded edit, or the views pans moved to (one entry for a
 * run of pans, since only each page's last view counts).
 */
export type DesignCanvasHistoryChange =
  | { readonly takenIn: DesignCanvasTakenIn }
  | { readonly unrecorded: DesignCanvasMutation }
  | { readonly views: ReadonlyMap<string, DesignViewport> };

/**
 * The history before a take-in that may still turn out to be an Aiden reply's,
 * and every change to it since, so the history can be built again once the
 * late announcements say whose they were. The person's own step ends it.
 */
export interface DesignCanvasUnsettledHistory {
  readonly base: CanvasHistory;
  readonly changes: readonly DesignCanvasHistoryChange[];
}

export interface DesignCanvasSyncState {
  readonly lifecycle: DesignCanvasLifecycle;
  /** The last canvas the store confirmed: the base every save is made from. */
  readonly server: DesignCanvas | null;
  readonly local: DesignCanvas | null;
  /** Edits not yet confirmed, oldest first; replayed onto the stored canvas after a conflict. */
  readonly unsent: readonly DesignCanvasMutation[];
  readonly savePhase: DesignCanvasSavePhase;
  readonly timer: DesignCanvasTimer | null;
  readonly history: CanvasHistory;
  /**
   * Pages an undo took off the canvas. The save says so, and the store does not
   * remember them as removed by the person, so Aiden writing one again shows it.
   * A later edit or redo that takes a page off makes it the person's removal again.
   */
  readonly undonePages: ReadonlySet<string>;
  readonly failed: boolean;
  /** The newest revision another writer announced. */
  readonly announced: number;
  /**
   * The undo step each announced revision belongs to: the Aiden reply it came
   * from, or the person's own step made through main (Send to canvas), or
   * null when it is neither and so is carried into every step.
   */
  readonly aidenRevisions: ReadonlyMap<number, string | null>;
  readonly unsettled: DesignCanvasUnsettledHistory | null;
  /** Next index in `DESIGN_CANVAS_CLOSED_RETRY_MS` to wait after a failed closed save. */
  readonly closedRetryNextIndex: number;
  /** Whether a flush or close arrived while a save was already in flight. */
  readonly flushQueuedWhileSaving: boolean;
  /** Whether the 800 ms debounce elapsed for newer edits while a save was already in flight. */
  readonly debounceElapsedWhileSaving: boolean;
}

export type DesignCanvasSyncEvent =
  | { readonly type: "load_succeeded"; readonly doc: DesignCanvas }
  | { readonly type: "load_failed" }
  | {
      readonly type: "change";
      readonly mutate: DesignCanvasMutation;
      readonly recordHistory: boolean;
    }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "debounce_fired" }
  | { readonly type: "closed_retry_fired" }
  | { readonly type: "flush_requested" }
  | { readonly type: "save_succeeded"; readonly revision: number }
  | { readonly type: "save_conflicted"; readonly doc: DesignCanvas }
  | { readonly type: "save_refused" }
  | { readonly type: "save_failed" }
  | {
      readonly type: "announcement";
      readonly revision: number;
      readonly aidenTurn?: string;
      readonly step?: string;
    }
  | { readonly type: "refetch_succeeded"; readonly doc: DesignCanvas }
  | { readonly type: "dispose" };

export type DesignCanvasSyncEffect =
  | { readonly type: "schedule_timer"; readonly timer: DesignCanvasTimer }
  | { readonly type: "cancel_timer" }
  | {
      readonly type: "start_save";
      readonly doc: DesignCanvas;
      readonly baseRevision: number;
      readonly undone: readonly string[];
    }
  | { readonly type: "refetch" }
  | { readonly type: "unsubscribe" }
  | { readonly type: "finish" };

export interface DesignCanvasTransition {
  readonly state: DesignCanvasSyncState;
  readonly effects: readonly DesignCanvasSyncEffect[];
}

interface CanvasSync {
  change(mutate: DesignCanvasMutation, recordHistory: boolean): void;
  undo(): void;
  redo(): void;
  /** Saves what is pending now; true when nothing is left unsaved. */
  flush(): Promise<boolean>;
  dispose(): void;
}

const EMPTY_HISTORY: CanvasHistory = { past: [], future: [] };

export function createInitialDesignCanvasSyncState(): DesignCanvasSyncState {
  return {
    lifecycle: "open",
    server: null,
    local: null,
    unsent: [],
    savePhase: { kind: "idle" },
    timer: null,
    history: EMPTY_HISTORY,
    undonePages: new Set(),
    failed: false,
    announced: 0,
    aidenRevisions: new Map(),
    unsettled: null,
    closedRetryNextIndex: 0,
    flushQueuedWhileSaving: false,
    debounceElapsedWhileSaving: false,
  };
}

export function selectDesignCanvasView(state: DesignCanvasSyncState): DesignCanvasSyncView {
  return {
    doc: state.local ?? undefined,
    status:
      state.local === null
        ? state.failed
          ? "error"
          : "loading"
        : state.failed
          ? "error"
          : state.unsent.length > 0 || state.savePhase.kind === "saving"
            ? "saving"
            : "ready",
    canUndo: state.history.past.length > 0,
    canRedo: state.history.future.length > 0,
  };
}

export function selectDesignCanvasGuard(state: DesignCanvasSyncState): DesignCanvasGuardState {
  if (state.lifecycle === "disposed") return { dirty: false, saving: false };
  return {
    dirty: state.unsent.length > 0,
    saving: state.savePhase.kind === "saving",
  };
}

export function isDesignCanvasFlushComplete(state: DesignCanvasSyncState): boolean {
  // A refused canvas is not kept as unsent edits, so `failed` says it too.
  return state.local !== null && state.unsent.length === 0 && !state.failed;
}

/**
 * The view each page moved to, when `after` differs from `before` only in
 * where its pages are looked at (a pan or zoom); otherwise null.
 */
function viewsMoved(before: DesignCanvas, after: DesignCanvas): Map<string, DesignViewport> | null {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof DesignCanvas)[]);
  for (const key of keys) {
    if (key !== "pages" && before[key] !== after[key]) return null;
  }
  if (before.pages.length !== after.pages.length) return null;
  const views = new Map<string, DesignViewport>();
  for (const [index, page] of before.pages.entries()) {
    const other = after.pages[index]!;
    if (page.id !== other.id || page.name !== other.name) return null;
    if (page.viewport !== other.viewport) views.set(page.id, other.viewport);
  }
  return views;
}

function withViews(doc: DesignCanvas, views: ReadonlyMap<string, DesignViewport>): DesignCanvas {
  return {
    ...doc,
    pages: doc.pages.map((page) =>
      views.has(page.id) ? { ...page, viewport: views.get(page.id)! } : page,
    ),
  };
}

/** The one Aiden reply that made every revision after `from` up to `to`, if one did. */
function aidenTurnBetween(
  aidenRevisions: ReadonlyMap<number, string | null>,
  from: number,
  to: number,
): string | undefined {
  if (to <= from || to - from > MAX_REVISION_LOOKBACK) return undefined;
  const turn = aidenRevisions.get(to);
  if (typeof turn !== "string") return undefined;
  for (let revision = from + 1; revision < to; revision += 1) {
    if (aidenRevisions.get(revision) !== turn) return undefined;
  }
  return turn;
}

/**
 * Whether the revisions after `from` up to `to` may still turn out to be one
 * reply's: some are not announced yet, and every announced one is that reply's.
 * A fetch or a save's reply can bring a revision before its announcement does.
 */
function mayBeOneReply(
  aidenRevisions: ReadonlyMap<number, string | null>,
  from: number,
  to: number,
): boolean {
  if (to <= from || to - from > MAX_REVISION_LOOKBACK) return false;
  let turn: string | undefined;
  let unknown = false;
  for (let revision = from + 1; revision <= to; revision += 1) {
    const seen = aidenRevisions.get(revision);
    if (seen === undefined) unknown = true;
    else if (seen === null || (turn !== undefined && seen !== turn)) return false;
    else turn = seen;
  }
  return unknown;
}

function historyAfter(
  base: CanvasHistory,
  changes: readonly DesignCanvasHistoryChange[],
  aidenRevisions: ReadonlyMap<number, string | null>,
): CanvasHistory {
  return changes.reduce((built, change) => {
    if ("unrecorded" in change) return carryUnrecorded(built, change.unrecorded);
    if ("views" in change) return carryUnrecorded(built, (doc) => withViews(doc, change.views));
    const { from, to } = change.takenIn;
    return takeIn(built, {
      ...change.takenIn,
      aidenTurn: aidenTurnBetween(aidenRevisions, from.revision, to.revision),
    });
  }, base);
}

function appendUnsettledChange(
  unsettled: DesignCanvasUnsettledHistory | null,
  change: DesignCanvasHistoryChange,
): DesignCanvasUnsettledHistory | null {
  if (!unsettled || unsettled.changes.length >= MAX_UNSETTLED_CHANGES) return null;
  return { base: unsettled.base, changes: [...unsettled.changes, change] };
}

function settleUnsettledIfKnown(
  unsettled: DesignCanvasUnsettledHistory | null,
  aidenRevisions: ReadonlyMap<number, string | null>,
): DesignCanvasUnsettledHistory | null {
  if (!unsettled) return null;
  const open = unsettled.changes.some(
    (change) =>
      "takenIn" in change &&
      mayBeOneReply(aidenRevisions, change.takenIn.from.revision, change.takenIn.to.revision),
  );
  return open ? unsettled : null;
}

/** Forgets announcements nothing can ask about any more. */
function forgetOldRevisions(
  aidenRevisions: ReadonlyMap<number, string | null>,
  unsettled: DesignCanvasUnsettledHistory | null,
  server: DesignCanvas | null,
): ReadonlyMap<number, string | null> {
  const first = unsettled?.changes.find((change) => "takenIn" in change);
  const floor =
    first && "takenIn" in first ? first.takenIn.from.revision : (server?.revision ?? -1);
  let hasOld = false;
  for (const revision of aidenRevisions.keys()) {
    if (revision <= floor) {
      hasOld = true;
      break;
    }
  }
  if (!hasOld) return aidenRevisions;
  const kept = new Map<number, string | null>();
  for (const [revision, value] of aidenRevisions) {
    if (revision > floor) kept.set(revision, value);
  }
  return kept;
}

/**
 * A page an undo took off that is shown again (a redo, Aiden, another window)
 * is no longer undone: if it is taken off later, that removal is someone's own.
 */
function pruneShownUndonePages(
  undonePages: ReadonlySet<string>,
  local: DesignCanvas | null,
): ReadonlySet<string> {
  if (undonePages.size === 0 || !local) return undonePages;
  const shown = shownPagePaths(local);
  let changed = false;
  for (const page of undonePages) {
    if (shown.has(page)) {
      changed = true;
      break;
    }
  }
  if (!changed) return undonePages;
  const next = new Set<string>();
  for (const page of undonePages) {
    if (!shown.has(page)) next.add(page);
  }
  return next;
}

/** Tracks the pages an edit takes off: `undone` notes them, any other edit forgets them. */
function updateUndonePagesForEdit(
  undonePages: ReadonlySet<string>,
  before: DesignCanvas,
  after: DesignCanvas,
  undone: boolean,
): ReadonlySet<string> {
  const shown = shownPagePaths(after);
  let next: Set<string> | null = null;
  for (const page of shownPagePaths(before)) {
    if (shown.has(page)) continue;
    if (undone) {
      if (!undonePages.has(page)) {
        next ??= new Set(undonePages);
        next.add(page);
      }
    } else if (undonePages.has(page)) {
      next ??= new Set(undonePages);
      next.delete(page);
    }
  }
  return pruneShownUndonePages(next ?? undonePages, after);
}

function replayMutations(base: DesignCanvas, edits: readonly DesignCanvasMutation[]): DesignCanvas {
  return edits.reduce((doc, edit) => edit(doc), base);
}

/** Moves the stored canvas on to `stored`, keeping the history. */
function takeInStored(
  state: DesignCanvasSyncState,
  stored: DesignCanvas,
  before: DesignCanvas,
): {
  server: DesignCanvas;
  history: CanvasHistory;
  unsettled: DesignCanvasUnsettledHistory | null;
  aidenRevisions: ReadonlyMap<number, string | null>;
} {
  const from = state.server!;
  const to = keepUnchanged(from, stored);
  const change: DesignCanvasTakenIn = { before, from, to };
  let unsettled = state.unsettled;
  if (!unsettled && mayBeOneReply(state.aidenRevisions, from.revision, to.revision)) {
    unsettled = { base: state.history, changes: [] };
  }
  if (unsettled) unsettled = appendUnsettledChange(unsettled, { takenIn: change });
  const history = takeIn(state.history, {
    ...change,
    aidenTurn: aidenTurnBetween(state.aidenRevisions, from.revision, to.revision),
  });
  unsettled = settleUnsettledIfKnown(unsettled, state.aidenRevisions);
  const aidenRevisions = forgetOldRevisions(state.aidenRevisions, unsettled, to);
  return { server: to, history, unsettled, aidenRevisions };
}

function startSaveTransition(
  state: DesignCanvasSyncState,
  options: { replayed: boolean; source: "open" | "close" | "flush"; clearFlushQueue: boolean },
  effects: DesignCanvasSyncEffect[],
): DesignCanvasSyncState {
  if (
    !state.server ||
    !state.local ||
    state.unsent.length === 0 ||
    state.savePhase.kind === "saving"
  ) {
    return state;
  }
  const batch = state.unsent;
  const doc = state.local;
  const baseRevision = state.server.revision;
  const shown = shownPagePaths(doc);
  const undone = [...state.undonePages].filter((page) => !shown.has(page));
  let timer = state.timer;
  if (timer !== null) {
    timer = null;
    effects.push({ type: "cancel_timer" });
  }
  effects.push({ type: "start_save", doc, baseRevision, undone });
  return {
    ...state,
    unsent: [],
    timer,
    flushQueuedWhileSaving: options.clearFlushQueue ? false : state.flushQueuedWhileSaving,
    debounceElapsedWhileSaving: false,
    savePhase: {
      kind: "saving",
      save: {
        batch,
        doc,
        baseRevision,
        undone,
        replayed: options.replayed,
        source: options.source,
      },
    },
  };
}

function scheduleClosedRetryIfRemaining(
  state: DesignCanvasSyncState,
  effects: DesignCanvasSyncEffect[],
): DesignCanvasSyncState {
  if (state.lifecycle !== "closing" || state.unsent.length === 0) return state;
  if (state.closedRetryNextIndex >= DESIGN_CANVAS_CLOSED_RETRY_MS.length) {
    return state;
  }
  const attemptIndex = state.closedRetryNextIndex;
  const delayMs = DESIGN_CANVAS_CLOSED_RETRY_MS[attemptIndex]!;
  const timer: DesignCanvasTimer = { kind: "closed_retry", delayMs, attemptIndex };
  effects.push({ type: "schedule_timer", timer });
  return {
    ...state,
    timer,
    closedRetryNextIndex: attemptIndex + 1,
  };
}

function finishClosedSession(
  state: DesignCanvasSyncState,
  effects: DesignCanvasSyncEffect[],
): DesignCanvasSyncState {
  if (state.lifecycle === "disposed") return state;
  if (state.timer !== null) effects.push({ type: "cancel_timer" });
  effects.push({ type: "finish" });
  return {
    ...state,
    lifecycle: "disposed",
    timer: null,
    flushQueuedWhileSaving: false,
    debounceElapsedWhileSaving: false,
  };
}

function applyLocalEdit(
  state: DesignCanvasSyncState,
  mutate: DesignCanvasMutation,
  step: (() => CanvasHistory) | null,
  undone: boolean,
): DesignCanvasTransition {
  if (state.lifecycle !== "open" || !state.local) return { state, effects: [] };
  const before = state.local;
  const next = mutate(before);
  if (next === before) return { state, effects: [] };

  let history: CanvasHistory;
  let unsettled = state.unsettled;
  if (step) {
    history = step();
    // The person's own step is built on what they saw; a late announcement no longer changes it.
    unsettled = null;
  } else {
    history = carryUnrecorded(state.history, mutate);
    if (unsettled) {
      const views = viewsMoved(before, next);
      const last = unsettled.changes[unsettled.changes.length - 1];
      // A run of pans is one change, so a long pan cannot use up the changes a late announcement rebuilds from.
      if (views && last && "views" in last) {
        const merged = new Map(last.views);
        for (const [page, view] of views) merged.set(page, view);
        unsettled = {
          base: unsettled.base,
          changes: [...unsettled.changes.slice(0, -1), { views: merged }],
        };
      } else {
        unsettled = appendUnsettledChange(unsettled, views ? { views } : { unrecorded: mutate });
      }
    }
  }

  const undonePages = updateUndonePagesForEdit(state.undonePages, before, next, undone);
  const timer: DesignCanvasTimer = { kind: "debounce", delayMs: DESIGN_CANVAS_SAVE_DELAY_MS };
  return {
    state: {
      ...state,
      local: next,
      unsent: [...state.unsent, mutate],
      history,
      unsettled,
      undonePages,
      timer,
      debounceElapsedWhileSaving: false,
    },
    effects: [{ type: "schedule_timer", timer }],
  };
}

/**
 * Pure transition reducer for the design canvas sync and mutation queue lifecycle.
 * Owns initial load, 800 ms debounced saves, conflict replay, unsettled late-announcement
 * history rebuilds, closed retry backoff (`[2_000, 5_000, 15_000, 30_000]`), and disposal.
 */
export function reduceDesignCanvasSync(
  state: DesignCanvasSyncState,
  event: DesignCanvasSyncEvent,
): DesignCanvasTransition {
  switch (event.type) {
    case "load_succeeded": {
      if (state.lifecycle !== "open") return { state, effects: [] };
      const effects: DesignCanvasSyncEffect[] = [];
      if (state.announced > event.doc.revision) effects.push({ type: "refetch" });
      return {
        state: {
          ...state,
          server: event.doc,
          local: event.doc,
          undonePages: pruneShownUndonePages(state.undonePages, event.doc),
        },
        effects,
      };
    }

    case "load_failed": {
      if (state.lifecycle !== "open") return { state, effects: [] };
      return { state: { ...state, failed: true }, effects: [] };
    }

    case "change": {
      if (state.lifecycle !== "open" || !state.local) return { state, effects: [] };
      const before = state.local;
      return applyLocalEdit(
        state,
        event.mutate,
        event.recordHistory ? () => record(state.history, before) : null,
        false,
      );
    }

    case "undo": {
      if (state.lifecycle !== "open" || !state.local) return { state, effects: [] };
      const step = undo(state.history, state.local);
      if (!step) return { state, effects: [] };
      return applyLocalEdit(state, changesBetween(state.local, step.doc), () => step.history, true);
    }

    case "redo": {
      if (state.lifecycle !== "open" || !state.local) return { state, effects: [] };
      const step = redo(state.history, state.local);
      if (!step) return { state, effects: [] };
      return applyLocalEdit(
        state,
        changesBetween(state.local, step.doc),
        () => step.history,
        false,
      );
    }

    case "debounce_fired": {
      if (state.lifecycle !== "open" || state.timer?.kind !== "debounce")
        return { state, effects: [] };
      const cleared: DesignCanvasSyncState = { ...state, timer: null };
      if (cleared.savePhase.kind === "saving") {
        if (cleared.unsent.length > 0 && cleared.server && cleared.local) {
          return { state: { ...cleared, debounceElapsedWhileSaving: true }, effects: [] };
        }
        return { state: cleared, effects: [] };
      }
      if (cleared.unsent.length === 0 || !cleared.server || !cleared.local) {
        return { state: cleared, effects: [] };
      }
      const effects: DesignCanvasSyncEffect[] = [];
      const next = startSaveTransition(
        cleared,
        { replayed: false, source: "open", clearFlushQueue: false },
        effects,
      );
      return { state: next, effects };
    }

    case "closed_retry_fired": {
      if (state.lifecycle !== "closing" || state.timer?.kind !== "closed_retry")
        return { state, effects: [] };
      const cleared: DesignCanvasSyncState = { ...state, timer: null };
      if (
        cleared.savePhase.kind === "saving" ||
        cleared.unsent.length === 0 ||
        !cleared.server ||
        !cleared.local
      ) {
        return { state: cleared, effects: [] };
      }
      const effects: DesignCanvasSyncEffect[] = [];
      const next = startSaveTransition(
        cleared,
        { replayed: false, source: "close", clearFlushQueue: false },
        effects,
      );
      return { state: next, effects };
    }

    case "flush_requested": {
      if (state.lifecycle === "disposed") return { state, effects: [] };
      const effects: DesignCanvasSyncEffect[] = [];
      let next = state;
      if (next.timer !== null) {
        next = { ...next, timer: null };
        effects.push({ type: "cancel_timer" });
      }
      if (next.savePhase.kind === "saving") {
        return {
          state: { ...next, flushQueuedWhileSaving: true, debounceElapsedWhileSaving: false },
          effects,
        };
      }
      if (next.unsent.length > 0 && next.server && next.local) {
        next = startSaveTransition(
          next,
          { replayed: false, source: "flush", clearFlushQueue: true },
          effects,
        );
      } else if (next.debounceElapsedWhileSaving) {
        next = { ...next, debounceElapsedWhileSaving: false };
      }
      return { state: next, effects };
    }

    case "save_succeeded": {
      if (state.savePhase.kind !== "saving") return { state, effects: [] };
      const { save } = state.savePhase;
      const nextUndone = new Set(state.undonePages);
      for (const page of save.undone) nextUndone.delete(page);
      const nextServer: DesignCanvas = { ...save.doc, revision: event.revision };
      const nextLocal = state.local === save.doc ? nextServer : state.local;
      const effects: DesignCanvasSyncEffect[] = [];
      let next: DesignCanvasSyncState = {
        ...state,
        server: nextServer,
        local: nextLocal,
        undonePages: pruneShownUndonePages(nextUndone, nextLocal),
        failed: false,
        savePhase: { kind: "idle" },
      };

      if (next.lifecycle === "closing" && next.unsent.length === 0) {
        return { state: finishClosedSession(next, effects), effects };
      }

      if (next.unsent.length > 0) {
        if (next.flushQueuedWhileSaving || next.lifecycle === "closing") {
          const source = next.lifecycle === "closing" ? "close" : "flush";
          next = startSaveTransition(
            next,
            { replayed: false, source, clearFlushQueue: true },
            effects,
          );
          return { state: next, effects };
        }
        if (next.lifecycle === "open" && next.debounceElapsedWhileSaving) {
          next = startSaveTransition(
            next,
            { replayed: false, source: "open", clearFlushQueue: false },
            effects,
          );
          return { state: next, effects };
        }
        if (next.lifecycle === "open" && next.timer === null) {
          const timer: DesignCanvasTimer = {
            kind: "debounce",
            delayMs: DESIGN_CANVAS_SAVE_DELAY_MS,
          };
          next = { ...next, timer };
          effects.push({ type: "schedule_timer", timer });
        }
        return { state: next, effects };
      }

      next = { ...next, flushQueuedWhileSaving: false, debounceElapsedWhileSaving: false };
      // Another writer saved while this save was on its way.
      if (
        next.lifecycle === "open" &&
        next.timer === null &&
        next.announced > nextServer.revision
      ) {
        effects.push({ type: "refetch" });
      }
      return { state: next, effects };
    }

    case "save_conflicted": {
      if (state.savePhase.kind !== "saving" || !state.server) return { state, effects: [] };
      const { save } = state.savePhase;
      const taken = takeInStored(state, event.doc, state.local ?? save.doc);
      const nextUnsent = [...save.batch, ...state.unsent];
      const nextLocal = replayMutations(taken.server, nextUnsent);
      const effects: DesignCanvasSyncEffect[] = [];
      let next: DesignCanvasSyncState = {
        ...state,
        server: taken.server,
        local: nextLocal,
        history: taken.history,
        unsettled: taken.unsettled,
        aidenRevisions: taken.aidenRevisions,
        undonePages: pruneShownUndonePages(state.undonePages, nextLocal),
        unsent: nextUnsent,
        savePhase: { kind: "idle" },
      };

      if (!save.replayed) {
        next = startSaveTransition(
          next,
          { replayed: true, source: save.source, clearFlushQueue: false },
          effects,
        );
        return { state: next, effects };
      }

      // Conflicted again straight after a replay: keep the edits on the newest canvas,
      // report it, and leave the next try to the next edit (or closed retry) instead of looping.
      next = { ...next, failed: true };
      if (next.flushQueuedWhileSaving) {
        const source = next.lifecycle === "closing" ? "close" : "flush";
        next = startSaveTransition(
          next,
          { replayed: false, source, clearFlushQueue: true },
          effects,
        );
        return { state: next, effects };
      }
      if (next.lifecycle === "open" && next.debounceElapsedWhileSaving) {
        next = startSaveTransition(
          next,
          { replayed: false, source: "open", clearFlushQueue: false },
          effects,
        );
        return { state: next, effects };
      }
      next = { ...next, flushQueuedWhileSaving: false, debounceElapsedWhileSaving: false };
      if (next.lifecycle === "closing") {
        next = scheduleClosedRetryIfRemaining(next, effects);
      }
      return { state: next, effects };
    }

    case "save_refused": {
      if (state.savePhase.kind !== "saving") return { state, effects: [] };
      const effects: DesignCanvasSyncEffect[] = [];
      // The store refused the canvas itself; retrying the same edits cannot help,
      // but newer edits queued after the refused batch started still need their attempt.
      let next: DesignCanvasSyncState = {
        ...state,
        failed: true,
        savePhase: { kind: "idle" },
      };
      if (next.unsent.length > 0) {
        if (next.flushQueuedWhileSaving || next.lifecycle === "closing") {
          const source = next.lifecycle === "closing" ? "close" : "flush";
          next = startSaveTransition(
            next,
            { replayed: false, source, clearFlushQueue: true },
            effects,
          );
          return { state: next, effects };
        }
        if (next.lifecycle === "open" && next.debounceElapsedWhileSaving) {
          next = startSaveTransition(
            next,
            { replayed: false, source: "open", clearFlushQueue: false },
            effects,
          );
          return { state: next, effects };
        }
        return {
          state: { ...next, flushQueuedWhileSaving: false, debounceElapsedWhileSaving: false },
          effects,
        };
      }
      next = { ...next, flushQueuedWhileSaving: false, debounceElapsedWhileSaving: false };
      if (next.lifecycle === "closing") {
        return { state: finishClosedSession(next, effects), effects };
      }
      return { state: next, effects };
    }

    case "save_failed": {
      if (state.savePhase.kind !== "saving") return { state, effects: [] };
      const { save } = state.savePhase;
      const effects: DesignCanvasSyncEffect[] = [];
      let next: DesignCanvasSyncState = {
        ...state,
        unsent: [...save.batch, ...state.unsent],
        failed: true,
        savePhase: { kind: "idle" },
      };
      if (next.flushQueuedWhileSaving) {
        const source = next.lifecycle === "closing" ? "close" : "flush";
        next = startSaveTransition(
          next,
          { replayed: false, source, clearFlushQueue: true },
          effects,
        );
        return { state: next, effects };
      }
      if (next.lifecycle === "open" && next.debounceElapsedWhileSaving) {
        next = startSaveTransition(
          next,
          { replayed: false, source: "open", clearFlushQueue: false },
          effects,
        );
        return { state: next, effects };
      }
      if (next.lifecycle === "closing") {
        next = { ...next, flushQueuedWhileSaving: false, debounceElapsedWhileSaving: false };
        next = scheduleClosedRetryIfRemaining(next, effects);
        return { state: next, effects };
      }
      // After a failure while open, the edits wait for the next edit or explicit flush.
      return {
        state: { ...next, flushQueuedWhileSaving: false, debounceElapsedWhileSaving: false },
        effects,
      };
    }

    case "announcement": {
      if (state.lifecycle !== "open") return { state, effects: [] };
      const announced = Math.max(state.announced, event.revision);
      const step =
        typeof event.aidenTurn === "string"
          ? event.aidenTurn
          : typeof event.step === "string"
            ? `person:${event.step}`
            : null;
      const nextRevisions = new Map(state.aidenRevisions);
      nextRevisions.set(event.revision, step);

      if (state.server && event.revision <= state.server.revision) {
        // A canvas already taken in, announced late: now it may be known to be one reply's.
        let history = state.history;
        let unsettled = state.unsettled;
        if (unsettled) {
          history = historyAfter(unsettled.base, unsettled.changes, nextRevisions);
          unsettled = settleUnsettledIfKnown(unsettled, nextRevisions);
        }
        return {
          state: {
            ...state,
            announced,
            history,
            unsettled,
            aidenRevisions: forgetOldRevisions(nextRevisions, unsettled, state.server),
          },
          effects: [],
        };
      }

      const next: DesignCanvasSyncState = {
        ...state,
        announced,
        aidenRevisions: nextRevisions,
      };
      if (!next.server) return { state: next, effects: [] };
      // A pending edit saves first: its conflict brings the newer canvas with it,
      // and a save already on its way fetches it when it lands.
      if (next.unsent.length > 0 || next.savePhase.kind === "saving" || next.timer !== null) {
        return { state: next, effects: [] };
      }
      return { state: next, effects: [{ type: "refetch" }] };
    }

    case "refetch_succeeded": {
      if (
        state.lifecycle !== "open" ||
        !state.server ||
        event.doc.revision <= state.server.revision ||
        state.unsent.length > 0 ||
        state.savePhase.kind === "saving"
      ) {
        return { state, effects: [] };
      }
      const taken = takeInStored(state, event.doc, state.local ?? state.server);
      const effects: DesignCanvasSyncEffect[] = [];
      if (state.announced > event.doc.revision) effects.push({ type: "refetch" });
      return {
        state: {
          ...state,
          server: taken.server,
          local: taken.server,
          history: taken.history,
          unsettled: taken.unsettled,
          aidenRevisions: taken.aidenRevisions,
          undonePages: pruneShownUndonePages(state.undonePages, taken.server),
        },
        effects,
      };
    }

    case "dispose": {
      if (state.lifecycle !== "open") return { state, effects: [] };
      const effects: DesignCanvasSyncEffect[] = [{ type: "unsubscribe" }];
      let next: DesignCanvasSyncState = { ...state, lifecycle: "closing" };
      if (next.timer !== null) {
        next = { ...next, timer: null };
        effects.push({ type: "cancel_timer" });
      }
      if (next.savePhase.kind === "saving") {
        return {
          state: { ...next, flushQueuedWhileSaving: true, debounceElapsedWhileSaving: false },
          effects,
        };
      }
      if (next.unsent.length === 0 || !next.server || !next.local) {
        return { state: finishClosedSession(next, effects), effects };
      }
      // Leaving the canvas saves what is pending now, not after the debounce.
      next = startSaveTransition(
        next,
        { replayed: false, source: "close", clearFlushQueue: true },
        effects,
      );
      return { state: next, effects };
    }
  }
}

/** Each canvas session's unsaved work; the app's close guard sees them as one "design" source. */
const guardStates = new Map<symbol, DesignCanvasGuardState>();
function publishDesignGuard() {
  const states = [...guardStates.values()];
  setRendererLifecycleGuard(
    { dirty: states.some((state) => state.dirty), saving: states.some((state) => state.saving) },
    { source: "design" },
  );
}

function viewsEqual(a: DesignCanvasSyncView, b: DesignCanvasSyncView): boolean {
  return (
    a.doc === b.doc && a.status === b.status && a.canUndo === b.canUndo && a.canRedo === b.canRedo
  );
}

function createCanvasSync(
  chatId: string,
  publish: (state: DesignCanvasSyncView) => void,
): CanvasSync {
  let state = createInitialDesignCanvasSyncState();
  let lastView = selectDesignCanvasView(state);
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  let inFlightPromise: Promise<void> | null = null;
  const guardKey = Symbol(chatId);

  const reportGuard = () => {
    const before = guardStates.get(guardKey);
    const next = selectDesignCanvasGuard(state);
    if (before?.dirty === next.dirty && before.saving === next.saving) return;
    if (next.dirty || next.saving) guardStates.set(guardKey, next);
    else guardStates.delete(guardKey);
    publishDesignGuard();
  };

  const clearScheduledTimer = () => {
    if (timerHandle === null) return;
    clearTimeout(timerHandle);
    timerHandle = null;
  };

  const scheduleTimer = (timer: DesignCanvasTimer) => {
    clearScheduledTimer();
    timerHandle = setTimeout(() => {
      timerHandle = null;
      dispatch(
        timer.kind === "debounce" ? { type: "debounce_fired" } : { type: "closed_retry_fired" },
      );
    }, timer.delayMs);
  };

  const startRefetch = () => {
    void designCanvasApi.getDesignCanvas(chatId).then(
      (fetched) => dispatch({ type: "refetch_succeeded", doc: fetched }),
      () => undefined,
    );
  };

  const startSave = (doc: DesignCanvas, baseRevision: number, undone: readonly string[]) => {
    let current: Promise<void> | null = null;
    current = (async () => {
      let event: DesignCanvasSyncEvent;
      try {
        const result = await designCanvasApi.saveDesignCanvas(
          chatId,
          doc,
          baseRevision,
          ...(undone.length > 0 ? [{ undone: [...undone] }] : []),
        );
        if (result.ok) event = { type: "save_succeeded", revision: result.revision };
        else if (result.reason === "conflict") event = { type: "save_conflicted", doc: result.doc };
        else event = { type: "save_refused" };
      } catch {
        event = { type: "save_failed" };
      }
      dispatch(event);
      if (inFlightPromise === current) inFlightPromise = null;
    })();
    inFlightPromise = current;
  };

  // Quit, close and reload save pending edits first, including a closed canvas's still waiting.
  const flush = async (): Promise<boolean> => {
    dispatch({ type: "flush_requested" });
    while (inFlightPromise) await inFlightPromise;
    return isDesignCanvasFlushComplete(state);
  };

  const unregisterFlush = registerLifecycleFlush(async () => {
    await flush();
  });

  let unsubscribed = false;
  let unsubscribe = () => {};

  const runEffect = (effect: DesignCanvasSyncEffect) => {
    switch (effect.type) {
      case "schedule_timer":
        scheduleTimer(effect.timer);
        break;
      case "cancel_timer":
        clearScheduledTimer();
        break;
      case "start_save":
        startSave(effect.doc, effect.baseRevision, effect.undone);
        break;
      case "refetch":
        startRefetch();
        break;
      case "unsubscribe":
        if (!unsubscribed) {
          unsubscribed = true;
          unsubscribe();
        }
        break;
      case "finish":
        clearScheduledTimer();
        unregisterFlush();
        guardStates.delete(guardKey);
        publishDesignGuard();
        break;
    }
  };

  const dispatch = (event: DesignCanvasSyncEvent) => {
    const transition = reduceDesignCanvasSync(state, event);
    state = transition.state;
    reportGuard();
    if (state.lifecycle !== "disposed") {
      const nextView = selectDesignCanvasView(state);
      if (!viewsEqual(lastView, nextView)) {
        lastView = nextView;
        publish(nextView);
      }
    }
    for (const effect of transition.effects) {
      runEffect(effect);
    }
  };

  unsubscribe = designCanvasApi.onDesignCanvasUpdated((update) => {
    if (update.chatId !== chatId) return;
    dispatch({
      type: "announcement",
      revision: update.revision,
      aidenTurn: update.aidenTurn,
      step: update.step,
    });
  });

  void designCanvasApi.getDesignCanvas(chatId).then(
    (loaded) => dispatch({ type: "load_succeeded", doc: loaded }),
    () => dispatch({ type: "load_failed" }),
  );

  return {
    change(mutate, recordHistory) {
      dispatch({ type: "change", mutate, recordHistory });
    },
    undo() {
      dispatch({ type: "undo" });
    },
    redo() {
      dispatch({ type: "redo" });
    },
    flush,
    dispose() {
      dispatch({ type: "dispose" });
    },
  };
}

export function useDesignCanvas(chatId: string): {
  doc: DesignCanvas | undefined;
  status: DesignCanvasStatus;
  change(mutate: DesignCanvasMutation, opts?: { record?: boolean }): void;
  undo(): void;
  redo(): void;
  /**
   * Saves what is pending now, so main reads the canvas as the person sees it.
   * False when edits are still unsaved: main's copy is older than the screen.
   */
  flush(): Promise<boolean>;
  canUndo: boolean;
  canRedo: boolean;
} {
  const [state, setState] = React.useState<DesignCanvasSyncView>({
    doc: undefined,
    status: "loading",
    canUndo: false,
    canRedo: false,
  });
  const sync = React.useRef<CanvasSync | null>(null);

  React.useEffect(() => {
    let mounted = true;
    setState({ doc: undefined, status: "loading", canUndo: false, canRedo: false });
    const current = createCanvasSync(chatId, (next) => {
      if (mounted) setState(next);
    });
    sync.current = current;
    return () => {
      mounted = false;
      if (sync.current === current) sync.current = null;
      current.dispose();
    };
  }, [chatId]);

  const change = React.useCallback((mutate: DesignCanvasMutation, opts?: { record?: boolean }) => {
    sync.current?.change(mutate, opts?.record !== false);
  }, []);
  const undoEdit = React.useCallback(() => sync.current?.undo(), []);
  const redoEdit = React.useCallback(() => sync.current?.redo(), []);
  /** Saves what is pending now, so main reads the canvas as the person sees it. */
  const flush = React.useCallback(async () => (sync.current ? sync.current.flush() : false), []);

  return { ...state, change, undo: undoEdit, redo: redoEdit, flush };
}
