import assert from "node:assert/strict";
import test from "node:test";
import {
  isDesignId,
  parseDesignContextChips,
  parseDesignProjectOp,
  parseDesignRunRequest,
  parseDesignTitle,
} from "./ops-parse.js";

test("every DS-1 project operation parses from its exact shape", () => {
  const ops = [
    { op: "rename", title: "Checkout" },
    { op: "setLayout", viewport: { x: 10, y: -20, zoom: 0.5 }, nodes: [{ id: "node-1", x: 0, y: 40 }] },
    { op: "setActiveRevision", screenId: "screen-1", revisionId: "rev-1" },
    { op: "setScreenFrame", screenId: "screen-1", frame: { preset: "phone", width: 390, height: 844 } },
    { op: "setScreenFrame", screenId: "screen-1", frame: { preset: "custom", width: 1280, height: 720 } },
    { op: "chooseDirection", directionSetId: "set-1", screenId: "screen-1" },
    { op: "archiveDirectionSet", directionSetId: "set-1", archived: true },
    { op: "deleteScreen", screenId: "screen-1" },
    { op: "settleRun", runId: "run-1", decision: "discard" },
  ];
  for (const op of ops) assert.deepEqual(parseDesignProjectOp(op), op, op.op);
  assert.deepEqual(parseDesignProjectOp({ op: "rename", title: "  Checkout  " }), {
    op: "rename",
    title: "Checkout",
  });
});

test("operations with extra keys, unsafe ids or out-of-range geometry are rejected", () => {
  for (const op of [
    { op: "rename", title: "   " },
    { op: "rename", title: "x".repeat(121) },
    { op: "rename", title: "Home\u0007" },
    { op: "rename", title: "Home", extra: true },
    { op: "deleteScreen", screenId: "../escape" },
    { op: "setActiveRevision", screenId: "screen-1" },
    { op: "setScreenFrame", screenId: "screen-1", frame: { preset: "phone", width: 400, height: 844 } },
    { op: "setScreenFrame", screenId: "screen-1", frame: { preset: "custom", width: 100, height: 720 } },
    { op: "setLayout", viewport: { x: 0, y: 0, zoom: 0 }, nodes: [] },
    {
      op: "setLayout",
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: "n", x: 0, y: 0 }, { id: "n", x: 1, y: 1 }],
    },
    { op: "archiveDirectionSet", directionSetId: "set-1", archived: "yes" },
    { op: "settleRun", runId: "run-1", decision: "retry" },
    // Accepted designs are published when a run ends, so there is nothing left to keep.
    { op: "settleRun", runId: "run-1", decision: "keep" },
    // DS-2 and DS-3 add these variants; DS-1a never accepts them.
    { op: "applyDesignLanguage", snapshot: {} },
    { op: "removeReference", assetId: "a".repeat(64) },
    null,
    [],
    "rename",
  ]) {
    assert.equal(parseDesignProjectOp(op), undefined, JSON.stringify(op));
  }
});

test("run requests accept Explore 2–4 with unique aspects and exact Refine targets", () => {
  const explore = { op: "explore", count: 3, creativeRange: "balanced", aspects: ["layout", "color"] };
  assert.deepEqual(parseDesignRunRequest(explore), explore);
  const resume = {
    op: "explore",
    count: 2,
    creativeRange: "bold",
    aspects: [],
    baseRevisionId: "rev-1",
    resumeRunId: "run-1",
  };
  assert.deepEqual(parseDesignRunRequest(resume), resume);
  const refine = { op: "refine", screenId: "screen-1", baseRevisionId: "rev-1" };
  assert.deepEqual(parseDesignRunRequest(refine), refine);
  for (const request of [
    { ...explore, count: 5 },
    { ...explore, count: 1 },
    { ...explore, aspects: ["layout", "layout"] },
    { ...explore, aspects: ["motion"] },
    { ...explore, creativeRange: "wild" },
    { ...explore, resumeRunId: "../run-1" },
    { ...explore, retryRunId: "run-1" },
    { op: "refine", screenId: "screen-1" },
    { ...refine, count: 1 },
    { op: "remix" },
  ]) {
    assert.equal(parseDesignRunRequest(request), undefined, JSON.stringify(request));
  }
});

test("context chips are bounded to five targets of at most 2 KiB each", () => {
  const element = { tagName: "button", label: "Sign up", selector: "main > button.primary" };
  const chips = [
    { kind: "screen", screenId: "s1", revisionId: "r1" },
    { kind: "element", screenId: "s1", revisionId: "r1", element },
  ];
  assert.deepEqual(parseDesignContextChips(chips), chips);
  assert.deepEqual(parseDesignContextChips([]), []);
  const six = Array.from({ length: 6 }, () => ({ kind: "screen", screenId: "s1", revisionId: "r1" }));
  assert.equal(parseDesignContextChips(six), undefined);
  // Every field is within its own bound, but the UTF-8 total exceeds 2 KiB.
  const heavy = { ...element, text: "🎨".repeat(250), selector: "é".repeat(512) };
  assert.equal(
    parseDesignContextChips([{ kind: "element", screenId: "s1", revisionId: "r1", element: heavy }]),
    undefined,
  );
  assert.equal(
    parseDesignContextChips([
      { kind: "element", screenId: "s1", revisionId: "r1", element: { ...element, tagName: "Button" } },
    ]),
    undefined,
  );
});

test("design ids and titles reject path syntax and control characters", () => {
  assert.equal(isDesignId("2f0c8a4e-6c1d-4f7b-9a55-0d4c1e1f9b11"), true);
  for (const id of ["", "../x", "a/b", ".hidden", "x".repeat(65), 42]) {
    assert.equal(isDesignId(id), false, String(id));
  }
  assert.equal(parseDesignTitle("Landing page"), "Landing page");
  assert.equal(parseDesignTitle("tab\there"), undefined);
});
