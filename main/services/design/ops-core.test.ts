import assert from "node:assert/strict";
import test from "node:test";
import type { DesignProjectManifestV1, DesignProjectOp, DesignRunRequest } from "../../../renderer/shared/design/types.js";
import { createDesignProjectManifest } from "./manifest-core.js";
import { applyDesignProjectOp, assertDesignProjectIdle, unreadableDesignDeletePreview } from "./ops-core.js";
import {
  DesignStoreError,
  acceptDesignArtifact,
  beginDesignRun,
  designProjectBytes,
  finishDesignRun,
  planDesignRun,
  reconcileDesignManifest,
  type DesignRunOutcome,
} from "./store-core.js";
import { check } from "./test-support.js";

const KIB = 1024;
const MODEL = { providerId: "openrouter", model: "model-a" };
let sequence = 0;

/** Every op's output must satisfy the store invariants, and a refused op must leave its input alone. */
function op(manifest: DesignProjectManifestV1, operation: DesignProjectOp, now: number) {
  const before = structuredClone(manifest);
  try {
    const result = applyDesignProjectOp(manifest, operation, now);
    check(result.manifest);
    assert.equal(result.manifest.revision, manifest.revision + 1, "one compare-and-set bump");
    return result;
  } finally {
    assert.deepEqual(manifest, before, "the input manifest is never mutated");
  }
}

const expectStoreError = (code: DesignStoreError["code"], message: RegExp) => (error: unknown) =>
  error instanceof DesignStoreError && error.code === code && message.test(error.message);

const project = () => createDesignProjectManifest({ id: "project-1", chatId: "chat-1", title: "Checkout", now: 1_000 });
const explore = (count: 2 | 3 | 4): DesignRunRequest => ({ op: "explore", count, creativeRange: "balanced", aspects: [] });

function run(
  manifest: DesignProjectManifestV1,
  runId: string,
  request: DesignRunRequest,
  titles: readonly string[],
  outcome: DesignRunOutcome | "running" = "completed",
): DesignProjectManifestV1 {
  const plan = planDesignRun(manifest, request);
  let next = beginDesignRun(manifest, { runId, turnId: `turn-${runId}`, request, plan, directionSetId: `set-${runId}`, now: 2_000 });
  for (const title of titles) {
    sequence += 1;
    next = acceptDesignArtifact(
      next,
      { runId, toolCallId: `call-${sequence}`, title, bytes: 4 * KIB, sha256: "c".repeat(64), model: MODEL },
      { revisionId: `rev-${sequence}`, screenId: `screen-${sequence}`, nodeId: `node-${sequence}` },
      { otherProjectsBytes: 0 },
      3_000,
    ).manifest;
  }
  return check(outcome === "running" ? next : finishDesignRun(next, runId, outcome, 4_000)!);
}

const screenByTitle = (manifest: DesignProjectManifestV1, title: string) =>
  Object.values(manifest.screens).find((screen) => screen.title === title)!;

test("rename and layout changes bump the revision once and reject unknown nodes", () => {
  const base = run(project(), "run-1", explore(2), ["Calm", "Bold"]);
  const renamed = op(base, { op: "rename", title: "Checkout v2" }, 5_000).manifest;
  assert.equal(renamed.title, "Checkout v2");
  assert.equal(renamed.revision, base.revision + 1);
  const node = base.canvas.nodes[0]!;
  const moved = op(
    base,
    { op: "setLayout", viewport: { x: 5, y: 6, zoom: 0.75 }, nodes: [{ id: node.id, x: 900, y: 40 }] },
    5_000,
  ).manifest;
  assert.deepEqual(moved.canvas.nodes.find((candidate) => candidate.id === node.id), { ...node, x: 900, y: 40 });
  assert.deepEqual(moved.canvas.viewport, { x: 5, y: 6, zoom: 0.75 });
  assert.throws(
    () => op(base, { op: "setLayout", viewport: base.canvas.viewport, nodes: [{ id: "node-404", x: 0, y: 0 }] }, 5_000),
    /no longer exists/u,
  );
});

test("only a published revision of the same Screen can become current", () => {
  let manifest = run(project(), "run-1", explore(2), ["Home", "Alt"]);
  const home = screenByTitle(manifest, "Home");
  const published = home.activeRevisionId;
  manifest = run(manifest, "run-2", { op: "refine", screenId: home.id, baseRevisionId: published }, ["Home"], "running");
  const draft = manifest.runs["run-2"]!.revisionIds[0]!;
  assert.throws(
    () => op(manifest, { op: "setActiveRevision", screenId: home.id, revisionId: draft }, 5_000),
    /still being generated/u,
  );
  const alt = screenByTitle(manifest, "Alt");
  assert.throws(
    () => op(manifest, { op: "setActiveRevision", screenId: home.id, revisionId: alt.activeRevisionId }, 5_000),
    /does not belong/u,
  );
  // Stopped after its one refinement landed: the run reached its cap, so it is published and current.
  const stopped = finishDesignRun(manifest, "run-2", "cancelled", 6_000)!;
  assert.equal(stopped.runs["run-2"]!.status, "complete");
  assert.equal(stopped.screens[home.id]!.activeRevisionId, draft);
  const restored = op(stopped, { op: "setActiveRevision", screenId: home.id, revisionId: published }, 7_000).manifest;
  assert.equal(restored.screens[home.id]!.activeRevisionId, published);
});

test("archiving a direction set never frees quota; deleting a Screen does", () => {
  const manifest = run(project(), "run-1", explore(3), ["A", "B", "C"]);
  const set = Object.values(manifest.directionSets)[0]!;
  const archived = op(manifest, { op: "archiveDirectionSet", directionSetId: set.id, archived: true }, 5_000).manifest;
  assert.equal(archived.directionSets[set.id]!.archived, true);
  assert.equal(designProjectBytes(archived), designProjectBytes(manifest));
  const victim = set.screenIds[1]!;
  const chosen = op(archived, { op: "chooseDirection", directionSetId: set.id, screenId: victim }, 6_000).manifest;
  const result = op(chosen, { op: "deleteScreen", screenId: victim }, 7_000);
  assert.deepEqual(result.deletedRevisionIds, manifest.screens[victim]!.revisionIds);
  assert.equal(designProjectBytes(result.manifest), designProjectBytes(manifest) - 4 * KIB);
  const after = result.manifest.directionSets[set.id]!;
  assert.deepEqual(after.screenIds, [set.screenIds[0], set.screenIds[2]]);
  assert.equal(after.chosenScreenId, undefined);
  assert.equal(result.manifest.canvas.nodes.some((node) => node.screenId === victim), false);
  assert.equal(result.manifest.runs["run-1"]!.revisionIds.length, 2);
  assert.throws(
    () => op(manifest, { op: "chooseDirection", directionSetId: set.id, screenId: "screen-404" }, 5_000),
    /not part of this direction set/u,
  );
});

test("a Screen holding a running run's draft cannot be deleted", () => {
  const manifest = run(project(), "run-1", explore(2), ["Live"], "running");
  const live = screenByTitle(manifest, "Live");
  assert.throws(
    () => op(manifest, { op: "deleteScreen", screenId: live.id }, 5_000),
    /Wait for the design run/u,
  );
});

test("Discard archives an interrupted Explore's set without deleting or freeing anything, once", () => {
  const running = run(project(), "run-1", explore(3), ["One", "Two"], "running");
  const files = new Map(Object.values(running.revisions).map((revision) => [revision.id, revision.bytes]));
  const restarted = reconcileDesignManifest(running, files, 9_000).manifest;
  assert.equal(restarted.runs["run-1"]!.status, "partial");
  const discarded = op(restarted, { op: "settleRun", runId: "run-1", decision: "discard" }, 10_000);
  assert.deepEqual(discarded.deletedRevisionIds, []);
  assert.deepEqual(Object.keys(discarded.manifest.screens).sort(), Object.keys(restarted.screens).sort());
  assert.equal(designProjectBytes(discarded.manifest), designProjectBytes(restarted), "archive never frees quota");
  assert.equal(discarded.manifest.directionSets[restarted.runs["run-1"]!.directionSetId!]!.archived, true);
  assert.throws(
    () => op(discarded.manifest, { op: "settleRun", runId: "run-1", decision: "discard" }, 11_000),
    /was discarded/u,
  );
  const complete = run(project(), "run-9", explore(2), ["X", "Y"]);
  assert.throws(
    () => op(complete, { op: "settleRun", runId: "run-9", decision: "discard" }, 5_000),
    /already exists/u,
  );
});


test("the deleteScreen refusal is a busy error that changes nothing, and covers a running Refine's target", () => {
  const settled = run(project(), "run-1", explore(2), ["Home", "Alt"]);
  const home = screenByTitle(settled, "Home");
  const refining = run(settled, "run-2", { op: "refine", screenId: home.id, baseRevisionId: home.activeRevisionId }, [], "running");
  assert.throws(
    () => op(refining, { op: "deleteScreen", screenId: home.id }, 5_000),
    expectStoreError("busy", /Wait for the design run/u),
  );
  const alt = screenByTitle(refining, "Alt");
  assert.deepEqual(op(refining, { op: "deleteScreen", screenId: alt.id }, 5_000).deletedRevisionIds, alt.revisionIds);
  assert.throws(
    () => op(settled, { op: "deleteScreen", screenId: "screen-404" }, 5_000),
    expectStoreError("invalid", /no longer exists/u),
  );
});

test("deleting the last Screen of a set drops the set, and a deleted Screen frees its quota", () => {
  const manifest = run(project(), "run-1", explore(2), ["Only"], "cancelled");
  const set = Object.values(manifest.directionSets)[0]!;
  const only = screenByTitle(manifest, "Only");
  const result = op(manifest, { op: "deleteScreen", screenId: only.id }, 5_000);
  assert.deepEqual(result.manifest.directionSets, {});
  assert.equal(result.manifest.runs["run-1"], undefined);
  assert.equal(designProjectBytes(result.manifest), 0);
  assert.equal(manifest.directionSets[set.id]!.screenIds.length, 1);
});

test("rename and frame changes apply to the named target only", () => {
  const manifest = run(project(), "run-1", explore(2), ["Home", "Alt"]);
  const home = screenByTitle(manifest, "Home");
  const framed = op(manifest, { op: "setScreenFrame", screenId: home.id, frame: { preset: "phone", width: 390, height: 844 } }, 5_000).manifest;
  assert.deepEqual(framed.screens[home.id]!.frame, { preset: "phone", width: 390, height: 844 });
  assert.deepEqual(framed.screens[screenByTitle(manifest, "Alt").id]!.frame, manifest.screens[screenByTitle(manifest, "Alt").id]!.frame);
  assert.throws(
    () => op(manifest, { op: "setScreenFrame", screenId: "screen-404", frame: home.frame }, 5_000),
    expectStoreError("invalid", /no longer exists/u),
  );
});

test("ids named like object members are unknown, not inherited", () => {
  const manifest = run(project(), "run-1", explore(2), ["Home", "Alt"]);
  const set = Object.values(manifest.directionSets)[0]!;
  for (const id of ["constructor", "__proto__", "toString"]) {
    assert.throws(() => op(manifest, { op: "deleteScreen", screenId: id }, 5_000), /no longer exists/u);
    assert.throws(() => op(manifest, { op: "setScreenFrame", screenId: id, frame: manifest.screens[set.screenIds[0]!]!.frame }, 5_000), /no longer exists/u);
    assert.throws(() => op(manifest, { op: "archiveDirectionSet", directionSetId: id, archived: true }, 5_000), /no longer exists/u);
    assert.throws(() => op(manifest, { op: "chooseDirection", directionSetId: id, screenId: set.screenIds[0]! }, 5_000), /not part of/u);
    assert.throws(() => op(manifest, { op: "setActiveRevision", screenId: set.screenIds[0]!, revisionId: id }, 5_000), /does not belong/u);
    assert.throws(() => op(manifest, { op: "settleRun", runId: id, decision: "discard" }, 5_000), /Only an Explore run/u);
  }
});

test("a project that is being deleted accepts no operation", () => {
  const manifest = { ...project(), state: "deleting" as const };
  assert.throws(
    () => applyDesignProjectOp(manifest, { op: "rename", title: "Nope" }, 5_000),
    expectStoreError("not_found", /being deleted/u),
  );
});

test("Discard refuses a run that is still rendering or a set that was resumed past it", () => {
  const live = run(project(), "run-1", explore(3), ["One"], "running");
  assert.throws(
    () => op(live, { op: "settleRun", runId: "run-1", decision: "discard" }, 5_000),
    expectStoreError("invalid", /Wait for the design run/u),
  );
  const stopped = finishDesignRun(live, "run-1", "cancelled", 6_000)!;
  const resumed = run(stopped, "run-2", { ...explore(3), resumeRunId: "run-1" } as DesignRunRequest, ["Two"], "cancelled");
  assert.throws(
    () => op(resumed, { op: "settleRun", runId: "run-1", decision: "discard" }, 7_000),
    expectStoreError("invalid", /newest run/u),
  );
  const discarded = op(resumed, { op: "settleRun", runId: "run-2", decision: "discard" }, 7_000).manifest;
  assert.equal(Object.values(discarded.directionSets)[0]!.archived, true);
});

test("a project with a running run can be neither deleted nor duplicated; an idle or interrupted one can", () => {
  const live = run(project(), "run-1", explore(2), ["Live"], "running");
  for (const action of ["delete", "duplicate"] as const) {
    assert.throws(() => assertDesignProjectIdle(live, action), expectStoreError("busy", new RegExp(`${action} this project`, "u")));
  }
  const stopped = finishDesignRun(live, "run-1", "cancelled", 6_000)!;
  assert.doesNotThrow(() => assertDesignProjectIdle(stopped, "delete"));
  const restarted = reconcileDesignManifest(live, new Map(Object.values(live.revisions).map((r) => [r.id, r.bytes])), 9_000).manifest;
  assert.doesNotThrow(() => assertDesignProjectIdle(restarted, "duplicate"));
});

test("an unreadable project's delete preview says its contents are unknown", () => {
  assert.deepEqual(unreadableDesignDeletePreview(), { screens: 0, revisions: 0, bytes: 0, references: 0, unreadable: true });
});
