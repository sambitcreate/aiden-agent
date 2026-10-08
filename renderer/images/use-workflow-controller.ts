import * as React from "react";
import { createImagesIpc } from "../lib/create-images-ipc";
import { registerLifecycleFlush, setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import { pickDefaultImageModel, type ImageModelOption } from "../shared/images/port";
import type { OutputRef } from "../shared/images/run-types";
import type { ImageNodeType, WorkflowDocV1, WorkflowViewport } from "../shared/images/schema";
import { fitNodeToMediaAspect } from "./node-dimensions-core";
import { createWorkflowNode } from "./nodes/registry";
import {
  createAutosave,
  createSession,
  documentToSave,
  sessionReducer,
  type Autosave,
  type AutosaveState,
  type EditorOp,
  type EditorSession,
  type SessionAction,
} from "./workflow-session-core";

export type SaveState = "saved" | "saving" | "unsaved" | "conflict" | "error";

function saveStateOf(state: AutosaveState): SaveState {
  if (state.conflict) return "conflict";
  if (state.error !== null) return "error";
  if (state.saving) return "saving";
  return state.dirty ? "unsaved" : "saved";
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

export function useWorkflowController(workflowId: string) {
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<EditorSession | null>(null);
  const [models, setModels] = React.useState<readonly ImageModelOption[]>([]);
  const [assetUrls, setAssetUrls] = React.useState<Record<string, string>>({});
  const [latestOutputs, setLatestOutputs] = React.useState<Record<string, OutputRef[]>>({});
  const [staleNodeIds, setStaleNodeIds] = React.useState<ReadonlySet<string>>(new Set());
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [loadKey, setLoadKey] = React.useState(0);
  const autosave = React.useRef<Autosave | null>(null);
  const loadedSession = React.useRef<EditorSession | null>(null);
  const latestSession = React.useRef<EditorSession | null>(null);
  latestSession.current = session;

  const startAutosave = React.useCallback(
    (baseRevision: number) =>
      createAutosave({
        delayMs: 800,
        baseRevision,
        save: (document, base) => createImagesIpc.save({ workflowId, baseRevision: base, document }),
        onState: (state) => {
          setSaveState(saveStateOf(state));
          setRendererLifecycleGuard({ dirty: state.dirty, saving: state.saving });
        },
      }),
    [workflowId],
  );

  React.useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    Promise.all([createImagesIpc.get(workflowId), createImagesIpc.listModels()]).then(
      ([loaded, listed]) => {
        if (cancelled) return;
        const initial = createSession(loaded.workflow);
        loadedSession.current = initial;
        autosave.current = startAutosave(loaded.workflow.revision);
        setSession(initial);
        setModels(listed.models);
        setAssetUrls(loaded.assetUrls);
        setLatestOutputs(loaded.latestOutputs);
        setStaleNodeIds(new Set(loaded.staleNodeIds));
        setSaveState("saved");
        setStatus("ready");
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(message(failure));
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
      const pending = autosave.current;
      autosave.current = null;
      if (!pending) return;
      // Leaving flushes the last edit. The close guard is released only once it is saved: an edit
      // that could not be saved keeps quit asking. The route blocker offers the choice before this.
      const settle = (saved: boolean) => {
        pending.dispose();
        if (saved) setRendererLifecycleGuard({ dirty: false, saving: false });
      };
      pending.flush().then(
        (result) => settle(result.ok),
        () => settle(false),
      );
    };
  }, [workflowId, loadKey, startAutosave]);

  // Quit and window close read the close guard; an edit still inside the autosave debounce is
  // saved first, so a quick quit after typing neither loses it nor stops on the unsaved prompt.
  React.useEffect(
    () =>
      registerLifecycleFlush(async () => {
        await autosave.current?.flush();
      }),
    [],
  );

  // Every document or viewport change after load is scheduled, including an undo
  // back to the loaded state; only the freshly loaded session itself is skipped.
  React.useEffect(() => {
    if (!session || session === loadedSession.current) return;
    autosave.current?.schedule(documentToSave(session));
  }, [session?.history.present, session?.viewport]);

  const dispatch = React.useCallback((action: SessionAction) => {
    setSession((current) => (current ? sessionReducer(current, action) : current));
  }, []);
  const apply = React.useCallback((op: EditorOp) => dispatch({ type: "op", op }), [dispatch]);
  const doc: WorkflowDocV1 | null = session?.history.present ?? null;

  const addNode = React.useCallback(
    (type: ImageNodeType) => {
      if (!doc) return;
      const offset = (doc.nodes.length % 6) * 32;
      apply({
        type: "add-node",
        node: createWorkflowNode(type, crypto.randomUUID(), { x: 160 + offset, y: 120 + offset }, pickDefaultImageModel(models)),
      });
    },
    [apply, doc, models],
  );

  const importImage = React.useCallback(
    async (nodeId: string) => {
      try {
        const result = await createImagesIpc.importImage({ source: "dialog" });
        if ("cancelled" in result) return;
        setAssetUrls((urls) => ({ ...urls, [result.assetId]: result.url }));
        const node = doc?.nodes.find((candidate) => candidate.id === nodeId);
        const dimensions = fitNodeToMediaAspect(node?.dimensions, result.width, result.height);
        apply({ type: "set-image", nodeId, assetId: result.assetId, ...(dimensions ? { dimensions } : {}) });
      } catch (failure) {
        setSession((current) => (current ? { ...current, message: message(failure) } : current));
      }
    },
    [apply, doc],
  );

  const addAssetUrls = React.useCallback((urls: Record<string, string>) => {
    setAssetUrls((current) => ({ ...current, ...urls }));
  }, []);

  /** Re-reads what each node last produced and what is out of date; called when a run settles. */
  const refreshOutputs = React.useCallback(async () => {
    try {
      const loaded = await createImagesIpc.get(workflowId);
      setLatestOutputs(loaded.latestOutputs);
      setStaleNodeIds(new Set(loaded.staleNodeIds));
      setAssetUrls((current) => ({ ...current, ...loaded.assetUrls }));
    } catch {
      // The run panel already shows the run's own result; the next load shows current outputs.
    }
  }, [workflowId]);

  /** Saves now; resolves the saved revision, or null when the document cannot be saved. */
  const flush = React.useCallback(async (): Promise<number | null> => {
    const result = await autosave.current?.flush();
    return result?.ok ? result.revision : null;
  }, []);

  /** Before leaving: true when every edit is saved (or there is nothing to save). */
  const settle = React.useCallback(async (): Promise<boolean> => {
    const pending = autosave.current;
    if (!pending) return true;
    try {
      return (await pending.flush()).ok;
    } catch {
      return false;
    }
  }, []);

  /** The user chose to drop the unsaved edits: stop saving and release the close guard. */
  const discard = React.useCallback(() => {
    autosave.current?.dispose();
    autosave.current = null;
    setRendererLifecycleGuard({ dirty: false, saving: false });
  }, []);

  /** After a conflict, the user chose their version: save it over the newer revision. */
  const keepMine = React.useCallback(async () => {
    const current = latestSession.current;
    if (!current) return;
    try {
      const loaded = await createImagesIpc.get(workflowId);
      autosave.current?.dispose();
      const next = startAutosave(loaded.workflow.revision);
      autosave.current = next;
      next.schedule(documentToSave(current));
      await next.flush();
    } catch (failure) {
      setSession((state) => (state ? { ...state, message: message(failure) } : state));
    }
  }, [startAutosave, workflowId]);

  return {
    status,
    error,
    doc,
    message: session?.message ?? null,
    canUndo: (session?.history.past.length ?? 0) > 0,
    canRedo: (session?.history.future.length ?? 0) > 0,
    saveState,
    models,
    assetUrls,
    latestOutputs,
    staleNodeIds,
    apply,
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    dismissMessage: () => dispatch({ type: "dismiss" }),
    setViewport: (viewport: WorkflowViewport) => dispatch({ type: "viewport", viewport }),
    addNode,
    importImage: (nodeId: string) => void importImage(nodeId),
    addAssetUrls,
    refreshOutputs,
    flush,
    settle,
    keepMine: () => void keepMine(),
    /** Drops the unsaved edits and opens the saved version. */
    discardAndReload: () => {
      discard();
      setLoadKey((key) => key + 1);
    },
    discard,
  };
}

export type WorkflowController = ReturnType<typeof useWorkflowController>;
