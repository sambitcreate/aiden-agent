import assert from "node:assert/strict";
import test from "node:test";
import { createStarterWorkflow } from "../shared/create-images/schema.js";
import {
  boundedPromptText,
  boundedCanvasPosition,
  commitEditorHistory,
  createEditorHistory,
  decideCanvasMutationCapacity,
  decideCanvasConnection,
  redoEditorHistory,
  resolveCreateImagesGraphShortcut,
  undoEditorHistory,
} from "./editor-core.js";
import {
  CREATE_IMAGES_MAX_EDGES,
  CREATE_IMAGES_MAX_NODES,
  CREATE_IMAGES_MAX_PROMPT_LENGTH,
  CREATE_IMAGES_POSITION_LIMIT,
} from "../shared/create-images/schema.js";
import {
  CREATE_IMAGES_DROP_NODE_HEIGHT,
  CREATE_IMAGES_DROP_NODE_WIDTH,
  filterSupportedCreateImagesFiles,
  hasPotentialCreateImagesFileDrag,
  INITIAL_CREATE_IMAGES_DROP_STATE,
  planCreateImagesDrop,
  reduceCreateImagesDropState,
  sanitizeCreateImagesImageLabel,
} from "./image-drop-core.js";

const workflow = () =>
  createStarterWorkflow({
    workflowId: "workflow-1",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });

test("canvas connection decisions enforce typed ports, duplicates, and cycles", () => {
  const document = workflow();
  const mismatch = decideCanvasConnection(
    document,
    {
      source: "prompt-1",
      sourcePort: "text",
      target: "output-1",
      targetPort: "images",
    },
    "candidate-1",
  );
  assert.equal(mismatch.allowed, false);
  if (!mismatch.allowed) assert.match(mismatch.message, /cannot connect/iu);
  const duplicate = decideCanvasConnection(
    document,
    {
      source: "prompt-1",
      sourcePort: "text",
      target: "generate-1",
      targetPort: "prompt",
    },
    "candidate-2",
  );
  assert.equal(duplicate.allowed, false);
  if (!duplicate.allowed) assert.match(duplicate.message, /already exists/iu);

  const prompt = structuredClone(document.nodes.find((node) => node.type === "prompt"));
  assert.ok(prompt?.type === "prompt");
  prompt.id = "prompt-2";
  document.nodes.push(prompt);
  const cardinality = decideCanvasConnection(
    document,
    {
      source: "prompt-2",
      sourcePort: "text",
      target: "generate-1",
      targetPort: "prompt",
    },
    "candidate-cardinality",
  );
  assert.equal(cardinality.allowed, false);
  if (!cardinality.allowed) assert.match(cardinality.message, /at most 1 connection/iu);

  const second = structuredClone(document.nodes.find((node) => node.type === "generate-image"));
  assert.ok(second?.type === "generate-image");
  second.id = "generate-2";
  document.nodes.push(second);
  document.edges.push({
    id: "edge-to-second",
    source: "generate-1",
    sourcePort: "images",
    target: "generate-2",
    targetPort: "references",
  });
  const cycle = decideCanvasConnection(
    document,
    {
      source: "generate-2",
      sourcePort: "images",
      target: "generate-1",
      targetPort: "references",
    },
    "candidate-cycle",
  );
  assert.equal(cycle.allowed, false);
  if (!cycle.allowed) assert.match(cycle.message, /cycle/iu);

  const selfLoop = decideCanvasConnection(
    document,
    {
      source: "generate-2",
      sourcePort: "images",
      target: "generate-2",
      targetPort: "references",
    },
    "candidate-self-loop",
  );
  assert.equal(selfLoop.allowed, false);
  if (!selfLoop.allowed) assert.match(selfLoop.message, /itself|cycle/iu);
});

test("editor history is bounded and clears redo on a new commit", () => {
  const empty = createEditorHistory(0);
  assert.strictEqual(undoEditorHistory(empty), empty);
  assert.strictEqual(redoEditorHistory(empty), empty);
  let history = empty;
  history = commitEditorHistory(history, 1, 2);
  history = commitEditorHistory(history, 2, 2);
  history = commitEditorHistory(history, 3, 2);
  assert.deepEqual(history.past, [1, 2]);
  history = undoEditorHistory(history);
  assert.equal(history.present, 2);
  history = redoEditorHistory(history);
  assert.equal(history.present, 3);
  history = undoEditorHistory(history);
  history = commitEditorHistory(history, 4, 2);
  assert.deepEqual(history.future, []);
});

test("editor mutations enforce schema capacity before allocating graph history", () => {
  assert.deepEqual(decideCanvasMutationCapacity(CREATE_IMAGES_MAX_NODES - 1, 0, 1, 0), {
    allowed: true,
  });
  assert.match(
    decideCanvasMutationCapacity(CREATE_IMAGES_MAX_NODES, 0, 1, 0).message ?? "",
    /500 nodes/u,
  );
  assert.match(
    decideCanvasMutationCapacity(0, CREATE_IMAGES_MAX_EDGES, 0, 1).message ?? "",
    /2,000 connections/u,
  );
});

test("prompt edits are bounded to the schema limit", () => {
  const value = boundedPromptText("x".repeat(CREATE_IMAGES_MAX_PROMPT_LENGTH + 1));
  assert.equal(value.length, CREATE_IMAGES_MAX_PROMPT_LENGTH);
});

test("canvas positions remain finite and inside the document schema", () => {
  assert.deepEqual(
    boundedCanvasPosition({
      x: CREATE_IMAGES_POSITION_LIMIT + 48,
      y: -CREATE_IMAGES_POSITION_LIMIT - 48,
    }),
    { x: CREATE_IMAGES_POSITION_LIMIT, y: -CREATE_IMAGES_POSITION_LIMIT },
  );
  assert.deepEqual(boundedCanvasPosition({ x: Number.POSITIVE_INFINITY, y: Number.NaN }), {
    x: 0,
    y: 0,
  });
});

test("graph shortcuts reject modifier supersets and the global dictation binding", () => {
  const shortcut = (
    key: string,
    modifiers: Partial<{
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }> = {},
  ) =>
    resolveCreateImagesGraphShortcut({
      key,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });

  assert.equal(shortcut("d"), "duplicate");
  assert.equal(shortcut("z"), "undo");
  assert.equal(shortcut("z", { shiftKey: true }), "redo");
  assert.equal(shortcut("d", { shiftKey: true }), null);
  assert.equal(shortcut("d", { altKey: true }), null);
  assert.equal(shortcut("d", { ctrlKey: true }), null);
  assert.equal(shortcut("z", { altKey: true }), null);
  assert.equal(shortcut("z", { ctrlKey: true }), null);
  assert.equal(shortcut("z", { metaKey: false }), null);
});

test("image drops accept image MIME types and extension-only native file drags", () => {
  const files = filterSupportedCreateImagesFiles([
    { name: "portrait.webp", type: "image/webp" },
    { name: "reference.heic", type: "" },
    { name: "scanner.tiff", type: "application/octet-stream" },
    { name: "notes.png", type: "application/pdf" },
    { name: "notes.txt", type: "text/plain" },
  ]);
  assert.deepEqual(
    files.map((file) => file.name),
    ["portrait.webp", "reference.heic", "scanner.tiff"],
  );
  assert.equal(
    hasPotentialCreateImagesFileDrag({
      items: [{ kind: "file", type: "image/avif" }],
      types: ["Files"],
    }),
    true,
  );
  assert.equal(
    hasPotentialCreateImagesFileDrag({
      items: [{ kind: "file", type: "application/pdf" }],
      types: ["Files"],
    }),
    false,
  );
  assert.equal(sanitizeCreateImagesImageLabel("/Users/aiden/reference.webp"), "reference.webp");
});

test("image drop state only activates for file drags and survives nested canvas targets", () => {
  let state = INITIAL_CREATE_IMAGES_DROP_STATE;
  state = reduceCreateImagesDropState(state, { type: "enter", valid: false });
  assert.deepEqual(state, INITIAL_CREATE_IMAGES_DROP_STATE);
  state = reduceCreateImagesDropState(state, {
    type: "enter",
    valid: true,
    targetNodeId: "input-1",
  });
  state = reduceCreateImagesDropState(state, { type: "enter", valid: true });
  assert.deepEqual(state, { active: true, depth: 2 });
  state = reduceCreateImagesDropState(state, {
    type: "over",
    valid: true,
    targetNodeId: "input-2",
  });
  assert.deepEqual(state, { active: true, depth: 2, targetNodeId: "input-2" });
  state = reduceCreateImagesDropState(state, { type: "leave", inside: true });
  assert.deepEqual(state, { active: true, depth: 1, targetNodeId: "input-2" });
  state = reduceCreateImagesDropState(state, { type: "leave", inside: false });
  assert.deepEqual(state, INITIAL_CREATE_IMAGES_DROP_STATE);
});

test("image drop planning is deterministic, collision-aware, and replacement-safe", () => {
  const existingNodes = [
    {
      id: "existing",
      type: "prompt" as const,
      position: { x: 0, y: 0 },
      width: CREATE_IMAGES_DROP_NODE_WIDTH,
      height: CREATE_IMAGES_DROP_NODE_HEIGHT,
    },
  ];
  const input = {
    dropPoint: { x: 144, y: 150 },
    existingNodes,
    fileCount: 3,
  } as const;
  const first = planCreateImagesDrop(input);
  const second = planCreateImagesDrop(input);
  assert.deepEqual(first, second);
  assert.equal(first.positions.length, 3);
  const overlaps = (left: { x: number; y: number }, right: { x: number; y: number }) =>
    left.x < right.x + CREATE_IMAGES_DROP_NODE_WIDTH &&
    left.x + CREATE_IMAGES_DROP_NODE_WIDTH > right.x &&
    left.y < right.y + CREATE_IMAGES_DROP_NODE_HEIGHT &&
    left.y + CREATE_IMAGES_DROP_NODE_HEIGHT > right.y;
  for (const position of first.positions) {
    assert.equal(overlaps(position, existingNodes[0]!.position), false);
  }
  for (let index = 0; index < first.positions.length; index += 1) {
    for (let other = index + 1; other < first.positions.length; other += 1) {
      assert.equal(overlaps(first.positions[index]!, first.positions[other]!), false);
    }
  }

  const replacement = planCreateImagesDrop({
    dropPoint: { x: 144, y: 150 },
    existingNodes: [
      {
        id: "input-1",
        type: "image-input",
        position: { x: 0, y: 0 },
      },
    ],
    fileCount: 2,
    targetNodeId: "input-1",
  });
  assert.equal(replacement.replacementNodeId, "input-1");
  assert.equal(replacement.positions.length, 1);
});
