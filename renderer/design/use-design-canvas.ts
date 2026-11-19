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
// person has made a step of their own since. An edit the person makes
// without a step of its own (a text frame growing to fit, say) is kept out of
// an Aiden reply's step, so undoing the reply leaves it.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";
import { registerLifecycleFlush, setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import { shownPagePaths, type DesignCanvas } from "../shared/design-canvas/schema";
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

type Mutation = (doc: DesignCanvas) => DesignCanvas;
export type DesignCanvasStatus = "loading" | "ready" | "saving" | "error";

interface SyncState {
  doc: DesignCanvas | undefined;
  status: DesignCanvasStatus;
  canUndo: boolean;
  canRedo: boolean;
}

interface CanvasSync {
  change(mutate: Mutation, recordHistory: boolean): void;
  undo(): void;
  redo(): void;
  /** Saves what is pending now; true when nothing is left unsaved. */
  flush(): Promise<boolean>;
  dispose(): void;
}

const EMPTY_HISTORY: CanvasHistory = { past: [], future: [] };

/** Each canvas session's unsaved work; the app's close guard sees them as one "design" source. */
const guardStates = new Map<symbol, { dirty: boolean; saving: boolean }>();
function publishDesignGuard() {
  const states = [...guardStates.values()];
  setRendererLifecycleGuard(
    { dirty: states.some((state) => state.dirty), saving: states.some((state) => state.saving) },
    { source: "design" },
  );
}

function createCanvasSync(chatId: string, publish: (state: SyncState) => void): CanvasSync {
  /** The last canvas the store confirmed: the base every save is made from. */
  let server: DesignCanvas | null = null;
  let local: DesignCanvas | null = null;
  /** Edits not yet confirmed, oldest first; replayed onto the stored canvas after a conflict. */
  let unsent: Mutation[] = [];
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let history = EMPTY_HISTORY;
  /**
   * Pages an undo took off the canvas. The save says so, and the store does not
   * remember them as removed by the person, so Aiden writing one again shows it.
   * A later edit or redo that takes a page off makes it the person's removal again.
   */
  const undonePages = new Set<string>();
  /** Tracks the pages `edit` takes off: `undone` notes them, any other edit forgets them. */
  const notePagesTakenOff = (before: DesignCanvas | null, undone: boolean) => {
    if (!before || !local || local === before) return;
    const shown = shownPagePaths(local);
    for (const page of shownPagePaths(before)) {
      if (shown.has(page)) continue;
      if (undone) undonePages.add(page);
      else undonePages.delete(page);
    }
  };
  let failed = false;
  /** The canvas closed; the session lives on only while it holds edits it could not save. */
  let closed = false;
  let disposed = false;
  const guardKey = Symbol(chatId);
  /** The newest revision another writer announced. */
  let announced = 0;
  /** The Aiden reply each announced revision came from, or null when it came from no reply. */
  const aidenRevisions = new Map<number, string | null>();
  /** The one Aiden reply that made every revision after `from` up to `to`, if one did. */
  const aidenTurnBetween = (from: number, to: number): string | undefined => {
    if (to <= from || to - from > 1_000) return undefined;
    const turn = aidenRevisions.get(to);
    if (typeof turn !== "string") return undefined;
    for (let revision = from + 1; revision < to; revision += 1) {
      if (aidenRevisions.get(revision) !== turn) return undefined;
    }
    return turn;
  };
  /**
   * Whether the revisions after `from` up to `to` may still turn out to be one
   * reply's: some are not announced yet, and every announced one is that reply's.
   * A fetch or a save's reply can bring a revision before its announcement does.
   */
  const mayBeOneReply = (from: number, to: number): boolean => {
    if (to <= from || to - from > 1_000) return false;
    let turn: string | undefined;
    let unknown = false;
    for (let revision = from + 1; revision <= to; revision += 1) {
      const seen = aidenRevisions.get(revision);
      if (seen === undefined) unknown = true;
      else if (seen === null || (turn !== undefined && seen !== turn)) return false;
      else turn = seen;
    }
    return unknown;
  };
  type TakenIn = { before: DesignCanvas; from: DesignCanvas; to: DesignCanvas };
  /** What changed the history without a step of the person's: a stored canvas taken in, or an unrecorded edit. */
  type HistoryChange = { takenIn: TakenIn } | { unrecorded: Mutation };
  /**
   * The history before a take-in that may still turn out to be an Aiden reply's,
   * and every change to it since, so the history can be built again once the
   * late announcements say whose they were. The person's own step ends it.
   */
  let unsettled: { base: CanvasHistory; changes: HistoryChange[] } | null = null;
  const historyAfter = (base: CanvasHistory, changes: readonly HistoryChange[]) =>
    changes.reduce((built, change) => {
      if ("unrecorded" in change) return carryUnrecorded(built, change.unrecorded);
      const { from, to } = change.takenIn;
      return takeIn(built, { ...change.takenIn, aidenTurn: aidenTurnBetween(from.revision, to.revision) });
    }, base);
  const noteChange = (change: HistoryChange) => {
    if (unsettled && unsettled.changes.length < 50) unsettled.changes.push(change);
    else unsettled = null;
  };
  /** Forgets announcements nothing can ask about any more. */
  const forgetOldRevisions = () => {
    const first = unsettled?.changes.find((change) => "takenIn" in change);
    const floor = first && "takenIn" in first ? first.takenIn.from.revision : (server?.revision ?? -1);
    for (const revision of aidenRevisions.keys()) {
      if (revision <= floor) aidenRevisions.delete(revision);
    }
  };
  const settleIfKnown = () => {
    const open = unsettled?.changes.some(
      (change) => "takenIn" in change && mayBeOneReply(change.takenIn.from.revision, change.takenIn.to.revision),
    );
    if (!open) unsettled = null;
  };
  /** Moves the stored canvas on to `stored`, keeping the history. Returns the canvas to build on. */
  const takeInStored = (stored: DesignCanvas, before: DesignCanvas): DesignCanvas => {
    const from = server!;
    const to = keepUnchanged(from, stored);
    const change: TakenIn = { before, from, to };
    if (!unsettled && mayBeOneReply(from.revision, to.revision)) unsettled = { base: history, changes: [] };
    if (unsettled) noteChange({ takenIn: change });
    history = takeIn(history, { ...change, aidenTurn: aidenTurnBetween(from.revision, to.revision) });
    server = to;
    settleIfKnown();
    forgetOldRevisions();
    return to;
  };

  const reportGuard = () => {
    const before = guardStates.get(guardKey);
    const next = { dirty: unsent.length > 0, saving: inFlight !== null };
    if (before?.dirty === next.dirty && before.saving === next.saving) return;
    if (next.dirty || next.saving) guardStates.set(guardKey, next);
    else guardStates.delete(guardKey);
    publishDesignGuard();
  };
  const emit = () => {
    reportGuard();
    if (disposed) return;
    publish({
      doc: local ?? undefined,
      status: local === null ? (failed ? "error" : "loading") : failed ? "error" : unsent.length > 0 || inFlight ? "saving" : "ready",
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });
  };
  const replay = (base: DesignCanvas, edits: Mutation[]) => edits.reduce((doc, edit) => edit(doc), base);
  const cancelTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, DESIGN_CANVAS_SAVE_DELAY_MS);
  };

  const save = async (replayed = false): Promise<void> => {
    while (inFlight) await inFlight;
    if (!server || !local || unsent.length === 0) return;
    const batch = unsent;
    const doc = local;
    const base = server.revision;
    const shown = shownPagePaths(doc);
    const undone = [...undonePages].filter((page) => !shown.has(page));
    unsent = [];
    let retryNow = false;
    const attempt = (async () => {
      try {
        const result = await designCanvasApi.saveDesignCanvas(chatId, doc, base, ...(undone.length > 0 ? [{ undone }] : []));
        if (result.ok) {
          for (const page of undone) undonePages.delete(page);
          server = { ...doc, revision: result.revision };
          if (local === doc) local = server;
          failed = false;
        } else if (result.reason === "conflict") {
          takeInStored(result.doc, local ?? doc);
          unsent = [...batch, ...unsent];
          local = replay(server, unsent);
          // Conflicted again straight after a replay: keep the edits on the newest canvas,
          // report it, and leave the next try to the next edit instead of looping.
          if (replayed) failed = true;
          else retryNow = true;
        } else {
          // The store refused the canvas itself; retrying the same edits cannot help.
          failed = true;
        }
      } catch {
        unsent = [...batch, ...unsent];
        failed = true;
      }
    })();
    inFlight = attempt;
    emit();
    await attempt;
    inFlight = null;
    emit();
    if (retryNow) return save(true);
    if (closed && unsent.length === 0) finish();
    // After a failure the edits wait for the next one, so an error the app cannot get past does not loop.
    if (unsent.length > 0 && timer === null && !disposed && !failed) schedule();
    // Another writer saved while this save was on its way.
    if (unsent.length === 0 && timer === null && server && announced > server.revision) refetch();
  };

  /** Shows and saves `mutate`; `step` is the history after it, or null when it makes no step of its own. */
  const apply = (mutate: Mutation, step: (() => CanvasHistory) | null) => {
    if (!local) return;
    const next = mutate(local);
    if (next === local) return;
    if (step) {
      history = step();
      // The person's own step is built on what they saw; a late announcement no longer changes it.
      unsettled = null;
    } else {
      history = carryUnrecorded(history, mutate);
      if (unsettled) noteChange({ unrecorded: mutate });
    }
    local = next;
    unsent.push(mutate);
    emit();
    schedule();
  };

  function refetch() {
    void designCanvasApi.getDesignCanvas(chatId).then(
      (fetched) => {
        if (disposed || !server || fetched.revision <= server.revision) return;
        if (unsent.length > 0 || inFlight) return;
        local = takeInStored(fetched, local ?? server);
        emit();
        if (announced > fetched.revision) refetch();
      },
      () => undefined,
    );
  }

  const flush = async (): Promise<boolean> => {
    cancelTimer();
    while (inFlight) await inFlight;
    if (unsent.length > 0) await save();
    while (inFlight) await inFlight;
    // A refused canvas is not kept as unsent edits, so the failure says it too.
    return local !== null && unsent.length === 0 && !failed;
  };
  // Quit, close and reload save pending edits first, including a closed canvas's still waiting.
  const unregisterFlush = registerLifecycleFlush(async () => {
    await flush();
  });
  function finish() {
    if (disposed) return;
    disposed = true;
    cancelTimer();
    unregisterFlush();
    guardStates.delete(guardKey);
    publishDesignGuard();
  }

  const unsubscribe = designCanvasApi.onDesignCanvasUpdated((update) => {
    if (update.chatId !== chatId) return;
    announced = Math.max(announced, update.revision);
    aidenRevisions.set(update.revision, typeof update.aidenTurn === "string" ? update.aidenTurn : null);
    if (server && update.revision <= server.revision) {
      // A canvas already taken in, announced late: now it may be known to be one reply's.
      if (unsettled) {
        history = historyAfter(unsettled.base, unsettled.changes);
        settleIfKnown();
        emit();
      }
      forgetOldRevisions();
      return;
    }
    if (!server) return;
    // A pending edit saves first: its conflict brings the newer canvas with it,
    // and a save already on its way fetches it when it lands.
    if (unsent.length > 0 || inFlight || timer !== null) return;
    refetch();
  });

  void designCanvasApi.getDesignCanvas(chatId).then(
    (loaded) => {
      if (disposed) return;
      server = loaded;
      local = loaded;
      emit();
      if (announced > loaded.revision) refetch();
    },
    () => {
      failed = true;
      emit();
    },
  );

  return {
    change(mutate, recordHistory) {
      const before = local;
      apply(mutate, recordHistory && before ? () => record(history, before) : null);
      notePagesTakenOff(before, false);
    },
    undo() {
      if (!local) return;
      const before = local;
      const step = undo(history, local);
      if (!step) return;
      apply(changesBetween(local, step.doc), () => step.history);
      notePagesTakenOff(before, true);
    },
    redo() {
      if (!local) return;
      const before = local;
      const step = redo(history, local);
      if (!step) return;
      apply(changesBetween(local, step.doc), () => step.history);
      notePagesTakenOff(before, false);
    },
    flush,
    dispose() {
      unsubscribe();
      closed = true;
      // Leaving the canvas saves what is pending now, not after the debounce. Edits the
      // app could not save try again a few times; after that they stay unsaved work,
      // tried again by the next quit, close or reload, until saved or discarded there.
      void (async () => {
        for (const delay of [...DESIGN_CANVAS_CLOSED_RETRY_MS, null]) {
          await flush().catch(() => undefined);
          if (unsent.length === 0 || delay === null) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (unsent.length === 0) finish();
      })();
    },
  };
}

export function useDesignCanvas(chatId: string): {
  doc: DesignCanvas | undefined;
  status: DesignCanvasStatus;
  change(mutate: Mutation, opts?: { record?: boolean }): void;
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
  const [state, setState] = React.useState<SyncState>({
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

  const change = React.useCallback((mutate: Mutation, opts?: { record?: boolean }) => {
    sync.current?.change(mutate, opts?.record !== false);
  }, []);
  const undoEdit = React.useCallback(() => sync.current?.undo(), []);
  const redoEdit = React.useCallback(() => sync.current?.redo(), []);
  /** Saves what is pending now, so main reads the canvas as the person sees it. */
  const flush = React.useCallback(async () => (sync.current ? sync.current.flush() : false), []);

  return { ...state, change, undo: undoEdit, redo: redoEdit, flush };
}
