// Pure editor state for one workflow: graph edits with bounded history, and a
// debounced autosave with one save in flight and optimistic revisions.
import type {
  ImageModelRef,
  WorkflowDocV1,
  WorkflowNode,
  WorkflowNodeDimensions,
  WorkflowPosition,
  WorkflowViewport,
} from "../shared/images/schema";
import {
  boundedCanvasPosition,
  boundedPromptText,
  commitEditorHistory,
  createEditorHistory,
  decideCanvasConnection,
  decideCanvasMutationCapacity,
  redoEditorHistory,
  undoEditorHistory,
  type EditorHistory,
} from "./editor-core";

export type EditorOp =
  | { type: "add-node"; node: WorkflowNode }
  | { type: "move-nodes"; positions: readonly { id: string; position: WorkflowPosition }[] }
  | { type: "remove"; nodeIds: readonly string[]; edgeIds: readonly string[] }
  | { type: "connect"; edgeId: string; source: string; sourcePort: string; target: string; targetPort: string }
  | { type: "set-prompt"; nodeId: string; text: string }
  | { type: "set-model"; nodeId: string; model: ImageModelRef }
  | { type: "set-image"; nodeId: string; assetId: string; dimensions?: WorkflowNodeDimensions }
  | { type: "set-title"; title: string };

type OpResult = { ok: true; doc: WorkflowDocV1 } | { ok: false; message: string };

function replaceNode(doc: WorkflowDocV1, nodeId: string, update: (node: WorkflowNode) => WorkflowNode | null): OpResult {
  const index = doc.nodes.findIndex((node) => node.id === nodeId);
  const next = index < 0 ? null : update(doc.nodes[index]!);
  if (!next) return { ok: false, message: "That node is no longer available." };
  const nodes = [...doc.nodes];
  nodes[index] = next;
  return { ok: true, doc: { ...doc, nodes } };
}

export function applyEditorOp(doc: WorkflowDocV1, op: EditorOp): OpResult {
  switch (op.type) {
    case "add-node": {
      const capacity = decideCanvasMutationCapacity(doc.nodes.length, doc.edges.length, 1, 0);
      if (!capacity.allowed) return { ok: false, message: capacity.message! };
      return { ok: true, doc: { ...doc, nodes: [...doc.nodes, { ...op.node, position: boundedCanvasPosition(op.node.position) }] } };
    }
    case "move-nodes": {
      const moved = new Map(op.positions.map((entry) => [entry.id, boundedCanvasPosition(entry.position)]));
      return { ok: true, doc: { ...doc, nodes: doc.nodes.map((node) => (moved.has(node.id) ? { ...node, position: moved.get(node.id)! } : node)) } };
    }
    case "remove": {
      const nodes = new Set(op.nodeIds);
      const edges = new Set(op.edgeIds);
      return {
        ok: true,
        doc: {
          ...doc,
          nodes: doc.nodes.filter((node) => !nodes.has(node.id)),
          edges: doc.edges.filter((edge) => !edges.has(edge.id) && !nodes.has(edge.source) && !nodes.has(edge.target)),
        },
      };
    }
    case "connect": {
      const decision = decideCanvasConnection(doc, op, op.edgeId);
      return decision.allowed ? { ok: true, doc: { ...doc, edges: [...doc.edges, decision.edge] } } : { ok: false, message: decision.message };
    }
    case "set-prompt":
      return replaceNode(doc, op.nodeId, (node) => (node.type === "prompt" ? { ...node, data: { text: boundedPromptText(op.text) } } : null));
    case "set-model":
      return replaceNode(doc, op.nodeId, (node) =>
        node.type === "generate-image" ? { ...node, data: { ...node.data, model: { ...op.model } } } : null,
      );
    case "set-image":
      return replaceNode(doc, op.nodeId, (node) =>
        node.type === "image-input"
          ? { ...node, data: { ...node.data, assetId: op.assetId }, ...(op.dimensions ? { dimensions: op.dimensions } : {}) }
          : null,
      );
    case "set-title": {
      const title = op.title.slice(0, 120);
      return title.trim() ? { ok: true, doc: { ...doc, title } } : { ok: false, message: "Give the workflow a name." };
    }
  }
}

export interface EditorSession {
  history: EditorHistory<WorkflowDocV1>;
  viewport?: WorkflowViewport;
  message: string | null;
  /** Consecutive typing in one prompt coalesces into a single undo step. */
  lastEdit: string | null;
}

export type SessionAction =
  | { type: "op"; op: EditorOp }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "viewport"; viewport: WorkflowViewport }
  | { type: "dismiss" };

export function createSession(doc: WorkflowDocV1): EditorSession {
  return { history: createEditorHistory(doc), ...(doc.viewport ? { viewport: doc.viewport } : {}), message: null, lastEdit: null };
}

export function sessionReducer(state: EditorSession, action: SessionAction): EditorSession {
  switch (action.type) {
    case "op": {
      const result = applyEditorOp(state.history.present, action.op);
      if (!result.ok) return { ...state, message: result.message };
      const edit = action.op.type === "set-prompt" ? `prompt:${action.op.nodeId}` : null;
      const coalesce = edit !== null && edit === state.lastEdit;
      const history = coalesce ? { ...state.history, present: result.doc } : commitEditorHistory(state.history, result.doc);
      return { ...state, history, message: null, lastEdit: edit };
    }
    case "undo":
      return { ...state, history: undoEditorHistory(state.history), message: null, lastEdit: null };
    case "redo":
      return { ...state, history: redoEditorHistory(state.history), message: null, lastEdit: null };
    case "viewport":
      return { ...state, viewport: action.viewport };
    case "dismiss":
      return { ...state, message: null };
  }
}

export function documentToSave(state: EditorSession): WorkflowDocV1 {
  return { ...state.history.present, ...(state.viewport ? { viewport: state.viewport } : {}) };
}

export type SaveOutcome =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict" | "invalid" | "not-found"; issues?: string[] };

export interface AutosaveState {
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string | null;
}

export interface Autosave {
  schedule(doc: WorkflowDocV1): void;
  flush(): Promise<{ ok: boolean; revision: number }>;
  dispose(): void;
}

export function createAutosave(options: {
  delayMs: number;
  baseRevision: number;
  save(document: WorkflowDocV1, baseRevision: number): Promise<SaveOutcome>;
  onState(state: AutosaveState): void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Autosave {
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let base = options.baseRevision;
  let pending: WorkflowDocV1 | null = null;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let state: AutosaveState = { dirty: false, saving: false, conflict: false, error: null };
  const publish = (patch: Partial<AutosaveState>) => {
    state = { ...state, ...patch };
    options.onState(state);
  };
  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const saveOnce = async (): Promise<void> => {
    while (inFlight) await inFlight;
    if (!pending || state.conflict || disposed) return;
    const document = pending;
    pending = null;
    publish({ saving: true });
    const attempt = (async () => {
      try {
        const result = await options.save({ ...document, revision: base }, base);
        if (result.ok) {
          base = result.revision;
          publish({ error: null });
        } else {
          // Keep the edit: closing now must still warn that it is unsaved.
          pending ??= document;
          if (result.reason === "invalid") publish({ error: result.issues?.[0] ?? "This workflow could not be saved." });
          else publish({ conflict: true });
        }
      } catch (error) {
        pending ??= document;
        publish({ error: error instanceof Error ? error.message : "Saving failed." });
      } finally {
        inFlight = null;
        publish({ saving: false, dirty: pending !== null });
      }
    })();
    inFlight = attempt;
    await attempt;
  };

  return {
    schedule(document) {
      if (state.conflict || disposed) return;
      pending = document;
      publish({ dirty: true });
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        void saveOnce();
      }, options.delayMs);
    },
    async flush() {
      cancelTimer();
      while (pending && !state.conflict && !disposed) {
        await saveOnce();
        if (state.error !== null && pending) break; // a failing transport must not spin
      }
      while (inFlight) await inFlight;
      return { ok: !state.conflict && !state.dirty && state.error === null, revision: base };
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
