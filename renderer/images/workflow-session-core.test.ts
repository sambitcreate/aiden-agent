import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDocV1 } from "../shared/images/schema";
import {
  applyEditorOp,
  createAutosave,
  createSession,
  documentToSave,
  sessionReducer,
  type AutosaveState,
  type SaveOutcome,
} from "./workflow-session-core";

const at = { x: 0, y: 0 };
const base: WorkflowDocV1 = {
  schemaVersion: 1, id: "wf", title: "T", revision: 1, createdAt: 0, updatedAt: 0, settings: { concurrency: 2 },
  nodes: [
    { id: "p", type: "prompt", position: at, data: { text: "" } },
    { id: "g", type: "generate-image", position: at, data: { count: 1 } },
    { id: "o", type: "output", position: at, data: {} },
  ],
  edges: [{ id: "e1", source: "g", sourcePort: "images", target: "o", targetPort: "images" }],
};

test("an edit that would break the graph is refused and the document is unchanged", () => {
  const session = sessionReducer(createSession(base), {
    type: "op",
    op: { type: "connect", edgeId: "bad", source: "p", sourcePort: "text", target: "g", targetPort: "references" },
  });
  assert.equal(session.history.present, base);
  assert.match(session.message ?? "", /cannot connect/u);
  assert.equal(sessionReducer(session, { type: "dismiss" }).message, null);
});

test("removing a node removes its connections", () => {
  const result = applyEditorOp(base, { type: "remove", nodeIds: ["g"], edgeIds: [] });
  assert.ok(result.ok);
  assert.deepEqual(result.doc.nodes.map((node) => node.id), ["p", "o"]);
  assert.deepEqual(result.doc.edges, []);
});

test("typing in one prompt is one undo step, and the viewport is never undone", () => {
  let session = createSession(base);
  session = sessionReducer(session, { type: "op", op: { type: "set-prompt", nodeId: "p", text: "A" } });
  session = sessionReducer(session, { type: "op", op: { type: "set-prompt", nodeId: "p", text: "A red bicycle" } });
  session = sessionReducer(session, { type: "viewport", viewport: { x: 10, y: 20, zoom: 2 } });
  assert.deepEqual(documentToSave(session).viewport, { x: 10, y: 20, zoom: 2 });
  assert.equal(session.history.past.length, 1);
  session = sessionReducer(session, { type: "undo" });
  assert.deepEqual(session.history.present.nodes[0]?.data, { text: "" });
  assert.deepEqual(session.viewport, { x: 10, y: 20, zoom: 2 });
  session = sessionReducer(session, { type: "redo" });
  assert.deepEqual(session.history.present.nodes[0]?.data, { text: "A red bicycle" });
});

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (callback: () => void) => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    size: () => pending.size,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

const titled = (title: string): WorkflowDocV1 => ({ ...base, title });

test("autosave collapses quick edits into one save of the newest document", async () => {
  const timers = fakeTimers();
  const saves: Array<[string, number]> = [];
  const states: AutosaveState[] = [];
  const autosave = createAutosave({
    delayMs: 800,
    baseRevision: 1,
    ...timers,
    save: async (document, baseRevision) => {
      saves.push([document.title, baseRevision]);
      return { ok: true, revision: baseRevision + 1 };
    },
    onState: (state) => states.push(state),
  });
  autosave.schedule(titled("One"));
  autosave.schedule(titled("Two"));
  assert.equal(timers.size(), 1);
  assert.deepEqual(states[states.length - 1], { dirty: true, saving: false, conflict: false, error: null });
  timers.fire();
  await autosave.flush();
  assert.deepEqual(saves, [["Two", 1]]);
  assert.deepEqual(states[states.length - 1], { dirty: false, saving: false, conflict: false, error: null });
});

test("flush waits for the save in flight, then saves the newest edit on the returned revision", async () => {
  const timers = fakeTimers();
  const first = deferred<SaveOutcome>();
  const saves: Array<[string, number]> = [];
  const autosave = createAutosave({
    delayMs: 800,
    baseRevision: 4,
    ...timers,
    save: (document, baseRevision) => {
      saves.push([document.title, baseRevision]);
      return saves.length === 1 ? first.promise : Promise.resolve({ ok: true, revision: baseRevision + 1 });
    },
    onState: () => undefined,
  });
  autosave.schedule(titled("A"));
  timers.fire();
  autosave.schedule(titled("B"));
  const flushed = autosave.flush();
  first.resolve({ ok: true, revision: 5 });
  assert.deepEqual(await flushed, { ok: true, revision: 6 });
  assert.deepEqual(saves, [["A", 4], ["B", 5]]);
  assert.equal(timers.size(), 0);
});

test("a conflict stops autosave, keeps the edit unsaved and is reported", async () => {
  const timers = fakeTimers();
  let saves = 0;
  const states: AutosaveState[] = [];
  const autosave = createAutosave({
    delayMs: 800,
    baseRevision: 1,
    ...timers,
    save: async () => {
      saves += 1;
      return { ok: false, reason: "conflict" };
    },
    onState: (state) => states.push(state),
  });
  autosave.schedule(titled("Mine"));
  assert.deepEqual(await autosave.flush(), { ok: false, revision: 1 });
  autosave.schedule(titled("Again"));
  assert.equal(timers.size(), 0);
  assert.equal(saves, 1);
  assert.deepEqual(states[states.length - 1], { dirty: true, saving: false, conflict: true, error: null });
});
