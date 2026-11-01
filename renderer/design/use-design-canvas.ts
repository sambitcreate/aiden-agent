// The design canvas controller: loads the chat's canvas, shows edits at once,
// saves them 800 ms after the last one with the revision they started from,
// and keeps undo history. Follows Create Images' autosave
// (renderer/images/workflow-session-core.ts) for the debounce and revisions.
//
// Edits are kept as the functions that made them until a save lands, so a
// revision conflict (the same chat edited in another window, or by Aiden) can
// take the stored canvas and replay this window's edits on top: neither
// side's change is lost. That replay happens once; a second conflict in a row
// shows the stored canvas and reports an error rather than looping.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";
import { registerLifecycleFlush } from "../lib/lifecycle-guard";
import type { DesignCanvasV1 } from "../shared/design-canvas/schema";
import { record, redo, undo, type CanvasHistory } from "./canvas-history-core";

export const DESIGN_CANVAS_SAVE_DELAY_MS = 800;

type Mutation = (doc: DesignCanvasV1) => DesignCanvasV1;
export type DesignCanvasStatus = "loading" | "ready" | "saving" | "error";

interface SyncState {
  doc: DesignCanvasV1 | undefined;
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

function createCanvasSync(chatId: string, publish: (state: SyncState) => void): CanvasSync {
  /** The last canvas the store confirmed: the base every save is made from. */
  let server: DesignCanvasV1 | null = null;
  let local: DesignCanvasV1 | null = null;
  /** Edits not yet confirmed, oldest first; replayed onto the stored canvas after a conflict. */
  let unsent: Mutation[] = [];
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let history = EMPTY_HISTORY;
  let failed = false;
  let disposed = false;

  const emit = () => {
    if (disposed) return;
    publish({
      doc: local ?? undefined,
      status: local === null ? (failed ? "error" : "loading") : failed ? "error" : unsent.length > 0 || inFlight ? "saving" : "ready",
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });
  };
  const replay = (base: DesignCanvasV1, edits: Mutation[]) => edits.reduce((doc, edit) => edit(doc), base);
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
          if (replayed) {
            // Conflicted again straight after a replay: show what is stored, keep only newer edits.
            local = replay(server, unsent);
            failed = true;
          } else {
            unsent = [...batch, ...unsent];
            local = replay(server, unsent);
            retryNow = true;
          }
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
    if (unsent.length > 0 && timer === null && !disposed) schedule();
  };

  const apply = (mutate: Mutation, before: DesignCanvasV1 | null, nextHistory: CanvasHistory) => {
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

  const unsubscribe = designCanvasApi.onDesignCanvasUpdated((update) => {
    if (update.chatId !== chatId || !server || update.revision <= server.revision) return;
    // A pending edit saves first; its conflict brings the newer canvas with it.
    if (unsent.length > 0 || inFlight || timer !== null) return;
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
      apply(() => step.doc, null, step.history);
    },
    redo() {
      if (!local) return;
      const step = redo(history, local);
      if (!step) return;
      apply(() => step.doc, null, step.history);
    },
    async flush() {
      cancelTimer();
      while (inFlight) await inFlight;
      if (unsent.length > 0) await save();
      while (inFlight) await inFlight;
    },
    dispose() {
      unsubscribe();
      // Leaving the canvas saves what is pending now, not after the debounce.
      void this.flush().finally(() => {
        disposed = true;
        cancelTimer();
      });
    },
  };
}

export function useDesignCanvas(chatId: string): {
  doc: DesignCanvasV1 | undefined;
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
    const unregister = registerLifecycleFlush(() => current.flush());
    return () => {
      mounted = false;
      unregister();
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
