import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowDocV1 } from "../../main/services/create-images/workflow-schema";
import { IMAGE_WORKFLOW_LIMITS, type WorkflowDocV1 } from "../shared/images/schema";
import { imageInputNodeForAsset } from "./node-dimensions-core";
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
  assert.deepEqual(states[states.length - 1], { dirty: true, saving: false, conflict: false, deleted: false, error: null });
  timers.fire();
  await autosave.flush();
  assert.deepEqual(saves, [["Two", 1]]);
  assert.deepEqual(states[states.length - 1], { dirty: false, saving: false, conflict: false, deleted: false, error: null });
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
  assert.deepEqual(states[states.length - 1], { dirty: true, saving: false, conflict: true, deleted: false, error: null });
});

test("a save that throws before returning a promise still settles flush, and a later save succeeds", async () => {
  const timers = fakeTimers();
  const saves: string[] = [];
  const states: AutosaveState[] = [];
  const autosave = createAutosave({
    delayMs: 800,
    baseRevision: 1,
    ...timers,
    save: (document, baseRevision) => {
      saves.push(document.title);
      if (saves.length === 1) throw new Error("The save channel is closed.");
      return Promise.resolve({ ok: true, revision: baseRevision + 1 });
    },
    onState: (state) => states.push(state),
  });
  autosave.schedule(titled("First"));
  assert.deepEqual(await autosave.flush(), { ok: false, revision: 1 });
  assert.deepEqual(states[states.length - 1], {
    dirty: true, saving: false, conflict: false, deleted: false, error: "The save channel is closed.",
  });
  autosave.schedule(titled("Second"));
  timers.fire();
  assert.deepEqual(await autosave.flush(), { ok: true, revision: 2 });
  assert.deepEqual(saves, ["First", "Second"]);
  assert.deepEqual(states[states.length - 1], { dirty: false, saving: false, conflict: false, deleted: false, error: null });
});

test("a failed save reports the server's reason, and retrying with flush saves the same edit", async () => {
  const timers = fakeTimers();
  const outcomes: SaveOutcome[] = [
    { ok: false, reason: "invalid", issues: ["An image in this workflow is no longer available."] },
    { ok: true, revision: 3 },
  ];
  const saved: string[] = [];
  const states: AutosaveState[] = [];
  const autosave = createAutosave({
    delayMs: 800,
    baseRevision: 2,
    ...timers,
    save: async (document) => {
      saved.push(document.title);
      return outcomes.shift()!;
    },
    onState: (state) => states.push(state),
  });
  autosave.schedule(titled("Mine"));
  assert.equal((await autosave.flush()).ok, false);
  assert.equal(states[states.length - 1]?.error, "An image in this workflow is no longer available.");
  assert.deepEqual(await autosave.flush(), { ok: true, revision: 3 });
  assert.deepEqual(saved, ["Mine", "Mine"]);
  assert.equal(states[states.length - 1]?.error, null);
});

test("saving a workflow that was deleted is reported as deleted, not as a conflict, and stops autosave", async () => {
  const timers = fakeTimers();
  let saves = 0;
  const states: AutosaveState[] = [];
  const autosave = createAutosave({
    delayMs: 800,
    baseRevision: 1,
    ...timers,
    save: async () => {
      saves += 1;
      return { ok: false, reason: "not-found" };
    },
    onState: (state) => states.push(state),
  });
  autosave.schedule(titled("Mine"));
  assert.deepEqual(await autosave.flush(), { ok: false, revision: 1 });
  autosave.schedule(titled("Again"));
  assert.equal(timers.size(), 0);
  assert.equal(saves, 1);
  assert.deepEqual(states[states.length - 1], { dirty: true, saving: false, conflict: false, deleted: true, error: null });
});

test("a far pan or zoom is saved inside the bounds the workflow schema accepts", () => {
  const limit = IMAGE_WORKFLOW_LIMITS.positionLimit;
  let session = sessionReducer(createSession(base), { type: "viewport", viewport: { x: -5 * limit, y: 3 * limit, zoom: 40 } });
  assert.deepEqual(documentToSave(session).viewport, { x: -limit, y: limit, zoom: IMAGE_WORKFLOW_LIMITS.maxZoom });
  session = sessionReducer(session, { type: "viewport", viewport: { x: Number.NaN, y: 12, zoom: 0.001 } });
  assert.deepEqual(documentToSave(session).viewport, { x: 0, y: 12, zoom: IMAGE_WORKFLOW_LIMITS.minZoom });
});

test("Use as Input adds an Image Input holding the image at the middle of the view, as one undo step the store accepts", () => {
  const generated = { assetId: "c".repeat(64), width: 1600, height: 900 };
  const viewport = { x: -200, y: 100, zoom: 0.5 };
  const pane = { width: 1000, height: 600 };
  const node = imageInputNodeForAsset(generated, "use-as-input", viewport, pane);
  const session = sessionReducer(createSession(base), { type: "op", op: { type: "add-node", node } });
  const added = session.history.present.nodes.find((candidate) => candidate.id === "use-as-input");
  assert.ok(added?.type === "image-input");
  assert.equal(added.data.assetId, generated.assetId);
  // The node's centre, mapped back to screen pixels, is the canvas pane's centre.
  const size = added.dimensions!;
  const screen = (flow: number, offset: number) => flow * viewport.zoom + offset;
  assert.ok(Math.abs(screen(added.position.x + size.width / 2, viewport.x) - pane.width / 2) <= 1);
  assert.ok(Math.abs(screen(added.position.y + size.height / 2, viewport.y) - pane.height / 2) <= 1);
  // Sized to the image's landscape aspect.
  assert.ok(size.height < size.width);
  // The main process's schema accepts the saved document with the generated asset in it.
  assert.equal(parseWorkflowDocV1(documentToSave(session)).ok, true);
  // One Undo removes it.
  assert.equal(sessionReducer(session, { type: "undo" }).history.present, base);
});
