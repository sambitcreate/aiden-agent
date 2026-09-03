import assert from "node:assert/strict";
import test from "node:test";
import {
  beginDesignFlowSelectionSync,
  clearDesignSelectionLayer,
  consumeDesignFlowSelectionReport,
  createDesignWorkbenchSelectionState,
  designPrimaryScreenRevision,
  designPrimaryScreenSelection,
  designScreenIsPreviewingHistory,
  designSelectionContextOrder,
  designSelectionEscapeLayer,
  designSelectionTurnTargets,
  designWorkbenchSelectionKey,
  MAX_DESIGN_WORKBENCH_SELECTIONS,
  orderDesignContextItems,
  reduceDesignWorkbenchSelection,
  sameDesignSelectedNodeIds,
  sameDesignWorkbenchSelectionState,
  type DesignReferenceSelection,
  type DesignScreenSelection,
  type DesignWorkbenchSelection,
} from "./design-selection.js";
import type { DesignElementSelectionV1 } from "./design-workspace.js";

function revision(id: string) {
  return { mediaId: `design:${id}`, artifactId: id.repeat(64).slice(0, 64) };
}

function screen(id: string): DesignScreenSelection {
  return {
    kind: "screen",
    nodeId: `node:${id}`,
    lineageId: `lineage:${id}`,
    activeRevision: revision(id),
  };
}

function reference(id: string): DesignReferenceSelection {
  return { kind: "reference", nodeId: `node:reference:${id}`, assetId: `asset:${id}` };
}

const ELEMENT: DesignElementSelectionV1 = {
  version: 1,
  tagName: "button",
  label: "Save",
  selector: '[data-aiden-id="save"]',
  elementId: "save",
};

test("selection identity is stable per underlying object kind", () => {
  assert.equal(designWorkbenchSelectionKey(screen("a")), "screen:lineage:a");
  assert.equal(designWorkbenchSelectionKey(reference("a")), "reference:asset:a");
  assert.equal(
    designWorkbenchSelectionKey({
      kind: "connected-preview",
      nodeId: "node:connected",
      previewId: "preview:app",
    }),
    "connected-preview:preview:app",
  );
});

test("equivalent selection projections are detected before React Flow feedback", () => {
  const first = createDesignWorkbenchSelectionState([reference("a"), screen("b")], "canvas");
  const equivalent = createDesignWorkbenchSelectionState([reference("a"), screen("b")], "canvas");
  assert.equal(sameDesignWorkbenchSelectionState(first, equivalent), true);
  assert.equal(
    sameDesignWorkbenchSelectionState(
      first,
      createDesignWorkbenchSelectionState([screen("b"), reference("a")], "canvas"),
    ),
    false,
  );
});

test("controlled canvas reports are ignored when selected node identities did not change", () => {
  const state = createDesignWorkbenchSelectionState([reference("a"), screen("b")], "history");
  assert.equal(sameDesignSelectedNodeIds(state, ["node:b", "node:reference:a"]), true);
  assert.equal(sameDesignSelectedNodeIds(state, ["node:b"]), false);
  assert.equal(sameDesignSelectedNodeIds(state, []), false);
});

test("controlled selection synchronization ignores one stale report without blocking later input", () => {
  let pending = beginDesignFlowSelectionSync([], ["reference-node"]);
  const stale = consumeDesignFlowSelectionReport(pending, []);
  assert.equal(stale.ignore, true);
  assert.equal(stale.pending, null);

  pending = beginDesignFlowSelectionSync([], ["reference-node"]);
  const competingUserSelection = consumeDesignFlowSelectionReport(pending, ["screen-node"]);
  assert.equal(competingUserSelection.ignore, false);
  assert.equal(competingUserSelection.pending, null);

  const acknowledged = consumeDesignFlowSelectionReport(
    beginDesignFlowSelectionSync([], ["reference-node"]),
    ["reference-node"],
  );
  assert.equal(acknowledged.ignore, true);
  assert.equal(acknowledged.pending, null);
});

test("composer projection preserves alternating Screen, image, and connected-source order", () => {
  const items = [
    { id: "target:design:b" },
    { id: "source:selection:one" },
    { id: "image:node:reference:a" },
    { id: "image:node:reference:c" },
  ];
  assert.deepEqual(
    orderDesignContextItems(items, [
      "image:node:reference:a",
      "target:design:b",
      "image:node:reference:c",
      "source",
    ]).map(({ id }) => id),
    ["image:node:reference:a", "target:design:b", "image:node:reference:c", "source:selection:one"],
  );
});

test("connected preview wins over generated context when normalizing an impossible mixed state", () => {
  const state = createDesignWorkbenchSelectionState([
    reference("a"),
    { ...screen("b"), previewRevision: revision("h") },
    { kind: "connected-preview", nodeId: "node:source", previewId: "preview:source" },
  ]);
  assert.deepEqual(designSelectionContextOrder(state), ["source"]);
});

test("replace de-duplicates deterministically, keeps newest five, and chooses primary Screen", () => {
  const selections: DesignWorkbenchSelection[] = [
    screen("a"),
    reference("one"),
    screen("b"),
    reference("two"),
    screen("c"),
    reference("three"),
    { ...screen("b"), nodeId: "node:b:new" },
  ];
  const state = reduceDesignWorkbenchSelection(createDesignWorkbenchSelectionState(), {
    type: "replace",
    selections,
    source: "canvas",
  });

  assert.equal(state.selections.length, MAX_DESIGN_WORKBENCH_SELECTIONS);
  assert.deepEqual(state.selections.map(designWorkbenchSelectionKey), [
    "reference:asset:one",
    "reference:asset:two",
    "screen:lineage:c",
    "reference:asset:three",
    "screen:lineage:b",
  ]);
  assert.equal(state.primaryKey, "screen:lineage:b");
  assert.equal(state.primaryScreenKey, "screen:lineage:b");
  assert.equal(designPrimaryScreenSelection(state)?.nodeId, "node:b:new");
});

test("additive selection moves an existing object to newest and evicts the oldest", () => {
  let state = createDesignWorkbenchSelectionState([
    screen("a"),
    screen("b"),
    screen("c"),
    reference("one"),
    reference("two"),
  ]);
  state = reduceDesignWorkbenchSelection(state, {
    type: "select",
    selection: screen("a"),
    additive: true,
    source: "screen-navigator",
  });
  assert.deepEqual(state.selections.map(designWorkbenchSelectionKey), [
    "screen:lineage:b",
    "screen:lineage:c",
    "reference:asset:one",
    "reference:asset:two",
    "screen:lineage:a",
  ]);

  state = reduceDesignWorkbenchSelection(state, {
    type: "select",
    selection: reference("three"),
    additive: true,
    source: "canvas",
  });
  assert.deepEqual(state.selections.map(designWorkbenchSelectionKey), [
    "screen:lineage:c",
    "reference:asset:one",
    "reference:asset:two",
    "screen:lineage:a",
    "reference:asset:three",
  ]);
  assert.equal(state.primaryKey, "reference:asset:three");
  assert.equal(state.primaryScreenKey, "screen:lineage:a");
  assert.equal(state.lastSource, "canvas");
});

test("non-additive reference and connected-preview selection cannot retain Screen context", () => {
  const selectedReference = reduceDesignWorkbenchSelection(
    createDesignWorkbenchSelectionState([screen("a")]),
    {
      type: "select",
      selection: reference("one"),
      additive: false,
      source: "canvas",
    },
  );
  assert.equal(designPrimaryScreenSelection(selectedReference), undefined);

  const connected = reduceDesignWorkbenchSelection(selectedReference, {
    type: "select",
    selection: {
      kind: "connected-preview",
      nodeId: "node:connected",
      previewId: "preview:app",
    },
    additive: false,
    source: "canvas",
  });
  assert.deepEqual(connected.selections, [
    { kind: "connected-preview", nodeId: "node:connected", previewId: "preview:app" },
  ]);
  assert.equal(designSelectionTurnTargets(connected).length, 0);
});

test("connected preview and generated context stay mutually exclusive for truthful generation", () => {
  const generated = createDesignWorkbenchSelectionState([screen("a"), reference("b")], "canvas");
  const connected = reduceDesignWorkbenchSelection(generated, {
    type: "select",
    selection: {
      kind: "connected-preview",
      nodeId: "node:connected",
      previewId: "preview:connected",
    },
    additive: true,
    source: "canvas",
  });
  assert.deepEqual(
    connected.selections.map(({ kind }) => kind),
    ["connected-preview"],
  );

  const backToGenerated = reduceDesignWorkbenchSelection(connected, {
    type: "select",
    selection: screen("c"),
    additive: true,
    source: "canvas",
  });
  assert.deepEqual(
    backToGenerated.selections.map(({ kind }) => kind),
    ["screen"],
  );
});

test("historical preview is explicit, ephemeral, and does not replace active revision", () => {
  const current = screen("a");
  const historical = revision("b");
  let state = createDesignWorkbenchSelectionState([current], "canvas");
  state = reduceDesignWorkbenchSelection(state, {
    type: "preview-screen-revision",
    lineageId: current.lineageId,
    revision: historical,
    source: "history",
  });

  const selected = designPrimaryScreenSelection(state)!;
  assert.deepEqual(selected.activeRevision, current.activeRevision);
  assert.deepEqual(selected.previewRevision, historical);
  assert.equal(designScreenIsPreviewingHistory(selected), true);
  assert.deepEqual(designPrimaryScreenRevision(state), { ...historical, mode: "historical" });
  assert.deepEqual(designSelectionTurnTargets(state), [historical]);

  state = reduceDesignWorkbenchSelection(state, {
    type: "clear-screen-preview",
    lineageId: current.lineageId,
    source: "history",
  });
  assert.deepEqual(designPrimaryScreenRevision(state), {
    ...current.activeRevision,
    mode: "current",
  });
});

test("previewing the active revision normalizes to current rather than fake history", () => {
  const current = screen("a");
  const state = reduceDesignWorkbenchSelection(createDesignWorkbenchSelectionState([current]), {
    type: "preview-screen-revision",
    lineageId: current.lineageId,
    revision: { ...current.activeRevision },
    source: "history",
  });
  assert.equal(designPrimaryScreenSelection(state)?.previewRevision, undefined);
  assert.equal(designPrimaryScreenRevision(state)?.mode, "current");
});

test("element selection requires the exact displayed revision and is cloned into prompt targets", () => {
  const current = screen("a");
  const initial = createDesignWorkbenchSelectionState([current]);
  const rejected = reduceDesignWorkbenchSelection(initial, {
    type: "select-screen-element",
    lineageId: current.lineageId,
    revision: revision("b"),
    selection: ELEMENT,
    source: "inspector",
  });
  assert.equal(rejected, initial);

  const selected = reduceDesignWorkbenchSelection(initial, {
    type: "select-screen-element",
    lineageId: current.lineageId,
    revision: current.activeRevision,
    selection: ELEMENT,
    source: "canvas",
  });
  assert.deepEqual(designSelectionTurnTargets(selected), [
    { ...current.activeRevision, selection: ELEMENT },
  ]);
  assert.notEqual(designSelectionTurnTargets(selected)[0]?.selection, ELEMENT);
});

test("active revision synchronization clears stale element context but preserves explicit history", () => {
  const current = screen("a");
  let state = reduceDesignWorkbenchSelection(createDesignWorkbenchSelectionState([current]), {
    type: "select-screen-element",
    lineageId: current.lineageId,
    revision: current.activeRevision,
    selection: ELEMENT,
    source: "canvas",
  });
  state = reduceDesignWorkbenchSelection(state, {
    type: "sync-screen-active-revision",
    lineageId: current.lineageId,
    revision: revision("b"),
  });
  assert.equal(designPrimaryScreenSelection(state)?.element, undefined);
  assert.deepEqual(designPrimaryScreenRevision(state), { ...revision("b"), mode: "current" });

  state = reduceDesignWorkbenchSelection(state, {
    type: "preview-screen-revision",
    lineageId: current.lineageId,
    revision: revision("c"),
    source: "history",
  });
  state = reduceDesignWorkbenchSelection(state, {
    type: "sync-screen-active-revision",
    lineageId: current.lineageId,
    revision: revision("d"),
  });
  assert.deepEqual(designPrimaryScreenRevision(state), { ...revision("c"), mode: "historical" });
  assert.deepEqual(designPrimaryScreenSelection(state)?.activeRevision, revision("d"));

  state = reduceDesignWorkbenchSelection(state, {
    type: "sync-screen-active-revision",
    lineageId: current.lineageId,
    revision: revision("c"),
  });
  assert.equal(designPrimaryScreenSelection(state)?.previewRevision, undefined);
  assert.deepEqual(designPrimaryScreenRevision(state), { ...revision("c"), mode: "current" });
});

test("Escape clears element, history, multi-selection, and final selection one layer at a time", () => {
  const selectedScreen: DesignScreenSelection = {
    ...screen("a"),
    previewRevision: revision("b"),
    element: { revision: revision("b"), selection: ELEMENT },
  };
  let state = createDesignWorkbenchSelectionState(
    [reference("one"), selectedScreen, reference("two")],
    "history",
  );

  assert.equal(designSelectionEscapeLayer(state), "element");
  state = clearDesignSelectionLayer(state);
  assert.equal(designSelectionEscapeLayer(state), "historical-preview");
  assert.equal(designPrimaryScreenSelection(state)?.element, undefined);

  state = clearDesignSelectionLayer(state);
  assert.equal(designSelectionEscapeLayer(state), "multiple");
  assert.equal(designPrimaryScreenSelection(state)?.previewRevision, undefined);

  state = clearDesignSelectionLayer(state);
  assert.equal(designSelectionEscapeLayer(state), "selection");
  assert.deepEqual(state.selections.map(designWorkbenchSelectionKey), ["reference:asset:two"]);

  state = clearDesignSelectionLayer(state);
  assert.equal(designSelectionEscapeLayer(state), "none");
  assert.deepEqual(state.selections, []);
  assert.equal(clearDesignSelectionLayer(state), state);
});

test("removing primary selection falls back deterministically and removes orphaned elements", () => {
  let state = createDesignWorkbenchSelectionState([
    { ...screen("a"), element: { revision: revision("a"), selection: ELEMENT } },
    reference("one"),
  ]);
  state = reduceDesignWorkbenchSelection(state, {
    type: "remove",
    key: "reference:asset:one",
    source: "composer",
  });
  assert.equal(state.primaryKey, "screen:lineage:a");
  assert.equal(state.primaryScreenKey, "screen:lineage:a");
  assert.ok(designPrimaryScreenSelection(state)?.element);

  state = reduceDesignWorkbenchSelection(state, {
    type: "remove",
    key: "screen:lineage:a",
    source: "composer",
  });
  assert.deepEqual(state.selections, []);
  assert.equal(state.primaryKey, null);
  assert.equal(state.primaryScreenKey, null);
});
