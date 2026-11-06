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
// Undo and redo are saved as the frames they change, not as whole canvases,
// and taking in another writer's canvas clears the history, so neither can
// take back what was changed elsewhere.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";
import { registerLifecycleFlush, setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import type { DesignCanvas } from "../shared/design-canvas/schema";
import { changesBetween, record, redo, undo, type CanvasHistory } from "./canvas-history-core";

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
  flush(): Promise<void>;
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
  let failed = false;
  /** The canvas closed; the session lives on only while it holds edits it could not save. */
  let closed = false;
  let disposed = false;
  const guardKey = Symbol(chatId);
  /** The newest revision another writer announced. */
  let announced = 0;

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
    unsent = [];
    let retryNow = false;
    const attempt = (async () => {
      try {
        const result = await designCanvasApi.saveDesignCanvas(chatId, doc, base);
        if (result.ok) {
          server = { ...doc, revision: result.revision };
          if (local === doc) local = server;
          failed = false;
        } else if (result.reason === "conflict") {
          server = result.doc;
          history = EMPTY_HISTORY;
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

  const apply = (mutate: Mutation, before: DesignCanvas | null, nextHistory: CanvasHistory) => {
    if (!local) return;
    const next = mutate(local);
    if (next === local) return;
    if (before) history = record(nextHistory, before);
    else history = nextHistory;
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
        server = fetched;
        local = fetched;
        // Undo must not take back what was changed elsewhere.
        history = EMPTY_HISTORY;
        emit();
      },
      () => undefined,
    );
  }

  const flush = async () => {
    cancelTimer();
    while (inFlight) await inFlight;
    if (unsent.length > 0) await save();
    while (inFlight) await inFlight;
  };
  // Quit, close and reload save pending edits first, including a closed canvas's still waiting.
  const unregisterFlush = registerLifecycleFlush(flush);
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
    if (!server || update.revision <= server.revision) return;
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
    },
    () => {
      failed = true;
      emit();
    },
  );

  return {
    change(mutate, recordHistory) {
      apply(mutate, recordHistory ? local : null, history);
    },
    undo() {
      if (!local) return;
      const step = undo(history, local);
      if (!step) return;
      apply(changesBetween(local, step.doc), null, step.history);
    },
    redo() {
      if (!local) return;
      const step = redo(history, local);
      if (!step) return;
      apply(changesBetween(local, step.doc), null, step.history);
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

  return { ...state, change, undo: undoEdit, redo: redoEdit };
}
