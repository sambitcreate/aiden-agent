import assert from "node:assert/strict";
import test from "node:test";
import type { DesignProjectManifestV1, DesignRunRequest } from "../../../renderer/shared/design/types.js";
import { MAX_DESIGN_PROJECT_BYTES } from "../../../renderer/shared/design/limits.js";
import { designDirectionTitleKey, designResumeOffer } from "../../../renderer/shared/design/resume.js";
import { createDesignProjectManifest, parseDesignProjectManifestV1 } from "./manifest-core.js";
import {
  DesignStoreError,
  acceptDesignArtifact,
  beginDesignRun,
  designDeletePreview,
  designProjectBytes,
  designProjectSummary,
  finishDesignRun,
  markDesignRevisionMissing,
  touchDesignManifest,
  orphanRevisionIds,
  planDesignRun,
  removeDesignScreen,
  revisionIdForToolCall,
  reconcileDesignManifest,
  type DesignArtifactAcceptance,
  type DesignStorageTotals,
} from "./store-core.js";

const KIB = 1024;
const MODEL = { providerId: "openrouter", model: "model-a" };
const NO_OTHERS = { otherProjectsBytes: 0 };
let sequence = 0;

const project = () => createDesignProjectManifest({ id: "project-1", chatId: "chat-1", title: "Checkout", now: 1_000 });
const explore = (count: 2 | 3 | 4, extra: Partial<Extract<DesignRunRequest, { op: "explore" }>> = {}): DesignRunRequest => ({
  op: "explore", count, creativeRange: "balanced", aspects: ["layout"], ...extra,
});
const refine = (screenId: string, baseRevisionId: string): DesignRunRequest => ({ op: "refine", screenId, baseRevisionId });

/**
 * Every manifest a transition produces must be one the DS-1a.2 parser accepts
 * unchanged, and must satisfy the invariants the parser leaves to the store.
 */
function check(manifest: DesignProjectManifestV1): DesignProjectManifestV1 {
  assert.deepEqual(parseDesignProjectManifestV1(JSON.parse(JSON.stringify(manifest))), manifest, "re-parses unchanged");
  let declared = 0;
  for (const revision of Object.values(manifest.revisions)) declared += revision.bytes;
  assert.ok(declared <= MAX_DESIGN_PROJECT_BYTES, "project bytes within the quota");
  for (const set of Object.values(manifest.directionSets)) {
    assert.ok(set.screenIds.length <= set.requestedCount, "a set never exceeds its requested count");
    const filling = Object.values(manifest.runs).some((run) => run.directionSetId === set.id && run.status === "running");
    assert.ok(set.screenIds.length > 0 || filling, "an empty set exists only while its run is running");
  }
  for (const run of Object.values(manifest.runs)) {
    if (run.status === "partial") {
      assert.ok(run.revisionIds.length >= 1 && run.endReason !== undefined, "a partial run has a design and a reason");
    }
    if (run.status === "complete") assert.ok(run.revisionIds.length >= 1, "a complete run has a design");
  }
  return manifest;
}

function ids() {
  sequence += 1;
  return { revisionId: `rev-${sequence}`, screenId: `screen-${sequence}`, nodeId: `node-${sequence}` };
}

function artifactInput(runId: string, title: string, bytes = 2 * KIB): DesignArtifactAcceptance {
  sequence += 1;
  return { runId, toolCallId: `call-${sequence}`, title, bytes, sha256: "b".repeat(64), model: MODEL };
}

function startRun(manifest: DesignProjectManifestV1, runId: string, request: DesignRunRequest) {
  const plan = planDesignRun(manifest, request);
  return {
    plan,
    manifest: check(
      beginDesignRun(manifest, { runId, turnId: `turn-${runId}`, request, plan, directionSetId: `set-${runId}`, now: 2_000 }),
    ),
  };
}

function settle(manifest: DesignProjectManifestV1, runId: string, outcome: "completed" | "cancelled" | "failed", now: number) {
  const ended = finishDesignRun(manifest, runId, outcome, now);
  return ended && check(ended);
}

function reconcile(manifest: DesignProjectManifestV1, files: ReadonlyMap<string, number>, now: number) {
  const result = reconcileDesignManifest(manifest, files, now);
  check(result.manifest);
  return result;
}

function accept(manifest: DesignProjectManifestV1, runId: string, title: string, bytes?: number) {
  return check(acceptDesignArtifact(manifest, artifactInput(runId, title, bytes), ids(), NO_OTHERS, 3_000).manifest);
}

/** A published Screen with the given revision sizes, written directly for quota fixtures. */
function seedScreen(manifest: DesignProjectManifestV1, screenId: string, sizes: readonly number[]): DesignProjectManifestV1 {
  const next = structuredClone(manifest);
  const revisionIds = sizes.map((_, index) => `${screenId}-rev-${index}`);
  sizes.forEach((bytes, index) => {
    const id = revisionIds[index]!;
    next.revisions[id] = {
      id, screenId, runId: `seed-${screenId}`, toolCallId: `seed-${id}`, title: screenId, bytes,
      sha256: "a".repeat(64), state: "published", createdAt: 1, model: MODEL,
    };
  });
  next.screens[screenId] = {
    id: screenId, title: screenId, frame: { preset: "desktop", width: 1440, height: 1024 },
    revisionIds, activeRevisionId: revisionIds[revisionIds.length - 1]!, createdAt: 1,
  };
  next.canvas.nodes.push({ id: `node-${screenId}`, kind: "screen", screenId, x: next.canvas.nodes.length * 1600, y: 0 });
  return next;
}

test("Explore turns each accepted design into its own Screen inside one direction set", () => {
  let { manifest } = startRun(project(), "run-1", explore(3));
  for (const title of ["Calm", "Bold", "Dense"]) manifest = accept(manifest, "run-1", title);
  manifest = settle(manifest, "run-1", "completed", 4_000)!;
  const run = manifest.runs["run-1"]!;
  assert.equal(run.status, "complete");
  const set = Object.values(manifest.directionSets).find((candidate) => candidate.runId === "run-1")!;
  assert.deepEqual(set.screenIds.map((id) => manifest.screens[id]!.title), ["Calm", "Bold", "Dense"]);
  assert.ok(run.revisionIds.every((id) => manifest.revisions[id]!.state === "published"));
  const nodes = set.screenIds.map((id) => manifest.canvas.nodes.find((node) => node.screenId === id)!);
  for (let index = 1; index < nodes.length; index += 1) {
    assert.ok(nodes[index]!.x >= nodes[index - 1]!.x + 1440, "directions sit side by side without overlapping");
  }
  assert.equal(new Set(nodes.map((node) => node.y)).size, 1);
});

test("Refine adds an immutable revision that becomes current only when the run publishes", () => {
  let { manifest } = startRun(project(), "run-1", explore(2));
  manifest = settle(accept(accept(manifest, "run-1", "Home"), "run-1", "Alt"), "run-1", "completed", 4_000)!;
  const screen = Object.values(manifest.screens).find((candidate) => candidate.title === "Home")!;
  const base = screen.activeRevisionId;
  const baseRecord = structuredClone(manifest.revisions[base]);
  manifest = startRun(manifest, "run-2", refine(screen.id, base)).manifest;
  manifest = accept(manifest, "run-2", "Home");
  const refined = manifest.runs["run-2"]!.revisionIds[0]!;
  assert.equal(manifest.screens[screen.id]!.activeRevisionId, base, "a draft never replaces the current design");
  manifest = settle(manifest, "run-2", "completed", 5_000)!;
  assert.equal(manifest.screens[screen.id]!.activeRevisionId, refined);
  assert.equal(manifest.revisions[refined]!.parentRevisionId, base);
  assert.deepEqual(manifest.revisions[base], baseRecord);
  assert.equal(Object.keys(manifest.screens).length, 2, "Refine never creates a Screen");
});

test("Stop, provider failure and restart publish accepted designs as partial with their end reason", () => {
  const { manifest: started } = startRun(project(), "run-1", explore(3));
  const manifest = accept(started, "run-1", "One");
  const draft = manifest.runs["run-1"]!.revisionIds[0]!;
  assert.equal(manifest.revisions[draft]!.state, "draft", "a running run's design is a draft");
  for (const [outcome, endReason] of [["cancelled", "stopped"], ["failed", "provider_failed"]] as const) {
    const ended = settle(manifest, "run-1", outcome, 4_000)!;
    assert.deepEqual([ended.runs["run-1"]!.status, ended.runs["run-1"]!.endReason], ["partial", endReason], outcome);
    assert.equal(ended.revisions[draft]!.state, "published", outcome);
  }
  const files = new Map(Object.values(manifest.revisions).map((revision) => [revision.id, revision.bytes]));
  const restarted = reconcile(manifest, files, 9_000);
  assert.equal(restarted.changed, true);
  const run = restarted.manifest.runs["run-1"]!;
  assert.deepEqual([run.status, run.endReason], ["partial", "interrupted"]);
  assert.equal(restarted.manifest.revisions[draft]!.state, "published");
  const set = restarted.manifest.directionSets[run.directionSetId!]!;
  assert.deepEqual([set.screenIds.length, set.requestedCount], [1, 3], "k/N stays visible");
  assert.equal(designProjectSummary(restarted.manifest).health, "interrupted");
});

test("a short run is partial, and a run that ends with nothing accepted keeps no direction set", () => {
  const { manifest } = startRun(project(), "run-1", explore(3));
  const short = settle(accept(manifest, "run-1", "Only"), "run-1", "completed", 4_000)!;
  assert.deepEqual([short.runs["run-1"]!.status, short.runs["run-1"]!.endReason], ["partial", "short"]);
  const empty = startRun(project(), "run-2", explore(2)).manifest;
  for (const [outcome, status] of [["cancelled", "cancelled"], ["failed", "failed"], ["completed", "failed"]] as const) {
    const ended = settle(empty, "run-2", outcome, 4_000)!;
    assert.equal(ended.runs["run-2"]!.status, status, outcome);
    assert.equal(ended.runs["run-2"]!.endReason, undefined, outcome);
    assert.deepEqual(ended.directionSets, {}, outcome);
  }
  const restarted = reconcile(empty, new Map(), 9_000).manifest;
  assert.equal(restarted.runs["run-2"]!.status, "interrupted");
  assert.deepEqual(restarted.directionSets, {});
  assert.equal(designProjectSummary(restarted).health, "ok");
  const failed = settle(empty, "run-2", "failed", 4_000)!;
  assert.equal(settle(failed, "run-2", "completed", 5_000), undefined, "a settled run never settles twice");
});

test("Resume caps a new run at the missing directions and completes the original set", () => {
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = settle(accept(manifest, "run-1", "First"), "run-1", "cancelled", 4_000)!;
  assert.equal(manifest.runs["run-1"]!.status, "partial");
  const resumed = startRun(manifest, "run-2", explore(3, { resumeRunId: "run-1" }));
  assert.equal(resumed.plan.cap, 2);
  assert.deepEqual(resumed.plan.existingTitles, ["First"]);
  assert.deepEqual(resumed.plan.model, MODEL, "a Resume defaults to the set's model");
  manifest = accept(accept(resumed.manifest, "run-2", "Second"), "run-2", "Third");
  manifest = settle(manifest, "run-2", "completed", 5_000)!;
  assert.equal(manifest.runs["run-2"]!.status, "complete");
  const sets = Object.values(manifest.directionSets);
  assert.equal(sets.length, 1, "a Resume fills the original set and creates none");
  assert.deepEqual(sets[0]!.screenIds.map((id) => manifest.screens[id]!.title), ["First", "Second", "Third"]);
  assert.throws(() => planDesignRun(manifest, explore(3, { resumeRunId: "run-2" })), /already exists/u);
});

test("Resume is offered only for the newest run of a kept, incomplete set with the same request", () => {
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = settle(accept(manifest, "run-1", "First"), "run-1", "failed", 4_000)!;
  manifest = startRun(manifest, "run-2", explore(3, { resumeRunId: "run-1" })).manifest;
  manifest = settle(manifest, "run-2", "cancelled", 5_000)!;
  assert.equal(manifest.runs["run-2"]!.status, "cancelled", "a Resume stopped before rendering anything");
  assert.equal(Object.keys(manifest.directionSets).length, 1, "it keeps the set it resumed");
  assert.throws(() => planDesignRun(manifest, explore(3, { resumeRunId: "run-1" })), /newest run/u);
  assert.throws(
    () => planDesignRun(manifest, explore(3, { resumeRunId: "run-2", creativeRange: "bold" })),
    /repeats the request/u,
  );
  assert.equal(planDesignRun(manifest, explore(3, { resumeRunId: "run-2" })).cap, 2);
  const discarded = structuredClone(manifest);
  for (const set of Object.values(discarded.directionSets)) set.archived = true;
  assert.throws(() => planDesignRun(discarded, explore(3, { resumeRunId: "run-2" })), /discarded/u);
  const running = startRun(manifest, "run-3", explore(3, { resumeRunId: "run-2" })).manifest;
  assert.throws(
    () => planDesignRun(running, explore(3, { resumeRunId: "run-3" })),
    (error: unknown) => error instanceof DesignStoreError && error.code === "busy",
  );
});

test("a direction whose title repeats one in its set is refused, ignoring case and whitespace", () => {
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = settle(accept(manifest, "run-1", "Calm Dawn"), "run-1", "cancelled", 4_000)!;
  manifest = startRun(manifest, "run-2", explore(3, { resumeRunId: "run-1" })).manifest;
  const before = structuredClone(manifest);
  assert.throws(
    () => acceptDesignArtifact(manifest, artifactInput("run-2", " calm  DAWN"), ids(), NO_OTHERS, 3_000),
    (error: unknown) => error instanceof DesignStoreError && error.code === "invalid" && /already exists/u.test(error.message),
  );
  assert.deepEqual(manifest, before);
  assert.equal(accept(manifest, "run-2", "Night").runs["run-2"]!.revisionIds.length, 1);
});

test("only one run may be in progress per project", () => {
  const { manifest } = startRun(project(), "run-1", explore(2));
  assert.throws(
    () => planDesignRun(manifest, explore(2)),
    (error: unknown) => error instanceof DesignStoreError && error.code === "busy",
  );
});

test("each project quota is a clear error and leaves the manifest unchanged", () => {
  const expectQuota = (manifest: DesignProjectManifestV1, act: () => unknown, pattern: RegExp) => {
    const before = structuredClone(manifest);
    assert.throws(
      act,
      (error: unknown) => error instanceof DesignStoreError && error.code === "quota" && pattern.test(error.message),
    );
    assert.deepEqual(manifest, before);
  };
  const tryAccept = (
    manifest: DesignProjectManifestV1,
    runId: string,
    title: string,
    bytes?: number,
    totals: DesignStorageTotals = NO_OTHERS,
  ) =>
    () => acceptDesignArtifact(manifest, artifactInput(runId, title, bytes), ids(), totals, 3_000);

  const fresh = startRun(project(), "run-size", explore(2)).manifest;
  expectQuota(fresh, tryAccept(fresh, "run-size", "Huge", 256 * KIB + 1), /256 KiB/u);

  let full = project();
  for (let index = 0; index < 64; index += 1) full = seedScreen(full, `s${index}`, [KIB]);
  full = startRun(full, "run-screens", explore(2)).manifest;
  expectQuota(full, tryAccept(full, "run-screens", "One more"), /64-Screen/u);

  let deep = seedScreen(project(), "deep", Array.from({ length: 100 }, () => KIB));
  deep = startRun(deep, "run-deep", refine("deep", "deep-rev-99")).manifest;
  expectQuota(deep, tryAccept(deep, "run-deep", "deep"), /100-revision/u);

  let wide = project();
  for (const [screenId, count] of [["a", 100], ["b", 100], ["c", 100], ["d", 99], ["e", 1]] as const) {
    wide = seedScreen(wide, screenId, Array.from({ length: count }, () => KIB));
  }
  wide = startRun(wide, "run-wide", refine("e", "e-rev-0")).manifest;
  expectQuota(wide, tryAccept(wide, "run-wide", "e"), /400-revision/u);

  let heavy = seedScreen(project(), "a", Array.from({ length: 100 }, () => 256 * KIB));
  heavy = seedScreen(heavy, "b", Array.from({ length: 100 }, () => 256 * KIB));
  heavy = seedScreen(heavy, "c", [...Array.from({ length: 55 }, () => 256 * KIB), 156 * KIB]);
  heavy = startRun(heavy, "run-heavy", refine("c", "c-rev-55")).manifest;
  expectQuota(heavy, tryAccept(heavy, "run-heavy", "c", 200 * KIB), /64 MiB/u);

  const shared = startRun(project(), "run-total", explore(2)).manifest;
  expectQuota(
    shared,
    tryAccept(shared, "run-total", "Any", 2 * KIB, {
      otherProjectsBytes: 2 * 1024 * 1024 * 1024 - KIB,
      largestOtherProjectTitle: "Old landing page",
    }),
    /"Old landing page"/u,
  );
});

test("restart marks vanished or resized files missing and lists unreferenced files", () => {
  let { manifest } = startRun(project(), "run-1", explore(2));
  manifest = settle(accept(accept(manifest, "run-1", "A"), "run-1", "B"), "run-1", "completed", 4_000)!;
  const [first, second] = manifest.runs["run-1"]!.revisionIds as [string, string];
  const files = new Map([[second, manifest.revisions[second]!.bytes + 1], ["stray", 10]]);
  const { manifest: reconciled, changed } = reconcile(manifest, files, 9_000);
  assert.equal(changed, true);
  assert.equal(reconciled.revisions[first]!.state, "missing");
  assert.equal(reconciled.revisions[second]!.state, "missing");
  assert.equal(reconciled.revision, manifest.revision + 1);
  assert.deepEqual(orphanRevisionIds(reconciled, files), ["stray"]);
  const intact = new Map(Object.values(manifest.revisions).map((revision) => [revision.id, revision.bytes]));
  assert.equal(reconcile(manifest, intact, 9_000).changed, false);
});

const expectStoreError = (code: string, pattern: RegExp) => (error: unknown) =>
  error instanceof DesignStoreError && error.code === code && pattern.test(error.message);

const screenByTitle = (manifest: DesignProjectManifestV1, title: string) =>
  Object.values(manifest.screens).find((screen) => screen.title === title)!;

/** A finished Explore with the given titles, from a fresh project. */
function exploredProject(titles: string[], count: 2 | 3 | 4 = 3, outcome: "completed" | "cancelled" = "completed") {
  let manifest = startRun(project(), "run-1", explore(count)).manifest;
  for (const title of titles) manifest = accept(manifest, "run-1", title);
  return settle(manifest, "run-1", outcome, 4_000)!;
}

test("every transition leaves a manifest the parser accepts, through replace, Refine, Resume, delete and restart", () => {
  // Explore with a replaced draft, then a Refine whose draft is replaced too.
  let manifest = startRun(project(), "run-1", explore(3)).manifest;
  manifest = accept(manifest, "run-1", "Calm");
  const draft = manifest.runs["run-1"]!.revisionIds[0]!;
  const replaced = acceptDesignArtifact(
    manifest,
    { ...artifactInput("run-1", "Calmer"), replacesRevisionId: draft },
    ids(),
    NO_OTHERS,
    3_100,
  );
  assert.deepEqual(replaced.deletedRevisionIds, [draft]);
  manifest = check(replaced.manifest);
  assert.equal(Object.keys(manifest.screens).length, 1, "a replacement never adds a Screen");
  assert.equal(screenByTitle(manifest, "Calmer").revisionIds.length, 1);
  manifest = accept(accept(manifest, "run-1", "Bold"), "run-1", "Dense");
  manifest = settle(manifest, "run-1", "completed", 4_000)!;

  const calmer = screenByTitle(manifest, "Calmer");
  manifest = startRun(manifest, "run-2", refine(calmer.id, calmer.activeRevisionId)).manifest;
  manifest = accept(manifest, "run-2", "Calmer");
  const refineDraft = manifest.runs["run-2"]!.revisionIds[0]!;
  manifest = check(
    acceptDesignArtifact(
      manifest,
      { ...artifactInput("run-2", "Calmer"), replacesRevisionId: refineDraft },
      ids(),
      NO_OTHERS,
      3_200,
    ).manifest,
  );
  assert.equal(manifest.screens[calmer.id]!.revisionIds.length, 2, "the replaced draft left no stray revision");
  manifest = settle(manifest, "run-2", "completed", 5_000)!;

  // A stopped Explore, resumed, then losing Screens one at a time.
  manifest = startRun(manifest, "run-3", explore(4)).manifest;
  manifest = settle(accept(manifest, "run-3", "Quiet"), "run-3", "cancelled", 6_000)!;
  manifest = startRun(manifest, "run-4", explore(4, { resumeRunId: "run-3" })).manifest;
  manifest = settle(accept(accept(manifest, "run-4", "Loud"), "run-4", "Warm"), "run-4", "failed", 7_000)!;
  for (const title of ["Quiet", "Loud", "Warm"]) {
    const clone = structuredClone(manifest);
    removeDesignScreen(clone, screenByTitle(manifest, title).id);
    manifest = check(touchedClone(clone));
  }
  assert.equal(Object.keys(manifest.directionSets).length, 1, "the first set keeps its Screens");

  // Restart: a running Explore with one draft, and a missing file.
  manifest = startRun(manifest, "run-5", explore(2)).manifest;
  manifest = accept(manifest, "run-5", "Late");
  const files = new Map(Object.values(manifest.revisions).map((revision) => [revision.id, revision.bytes]));
  files.delete(manifest.runs["run-2"]!.revisionIds[0]!);
  const restarted = reconcile(manifest, files, 9_000);
  assert.equal(restarted.changed, true);
  manifest = check(restarted.manifest);
  manifest = check(markDesignRevisionMissing(manifest, manifest.runs["run-5"]!.revisionIds[0]!, 9_500));
  assert.equal(manifest.runs["run-5"]!.status, "partial");
});

/** Stand-in for the store's write step: the caller owns a clone, mutates it, then bumps the revision. */
function touchedClone(manifest: DesignProjectManifestV1): DesignProjectManifestV1 {
  manifest.revision += 1;
  return manifest;
}

test("deleting the last Screen of a direction set drops the set and the runs that left nothing", () => {
  const manifest = exploredProject(["Calm", "Bold"], 2);
  const [calm, bold] = ["Calm", "Bold"].map((title) => screenByTitle(manifest, title));

  const one = structuredClone(manifest);
  assert.deepEqual(removeDesignScreen(one, calm!.id), [calm!.revisionIds[0]!]);
  check(one);
  assert.deepEqual(Object.values(one.directionSets).map((set) => set.screenIds), [[bold!.id]]);
  assert.equal(one.runs["run-1"]!.status, "complete", "a run that still has a design keeps its status");

  const both = structuredClone(one);
  removeDesignScreen(both, bold!.id);
  check(both);
  assert.deepEqual(both.directionSets, {}, "no empty set lingers");
  assert.deepEqual(both.runs, {}, "a complete run cannot be left without a design");
  assert.deepEqual([both.screens, both.revisions, both.canvas.nodes], [{}, {}, []]);

  assert.deepEqual(removeDesignScreen(structuredClone(manifest), "constructor"), [], "an inherited name is not a Screen");
});

test("deleting Screens never strands a Resume, a Refine run or another run's set", () => {
  // Original run keeps one direction, its Resume adds one; deleting the Resume's Screen keeps the set.
  let manifest = exploredProject(["First"], 3, "cancelled");
  manifest = startRun(manifest, "run-2", explore(3, { resumeRunId: "run-1" })).manifest;
  manifest = settle(accept(manifest, "run-2", "Second"), "run-2", "cancelled", 5_000)!;
  const resumed = structuredClone(manifest);
  removeDesignScreen(resumed, screenByTitle(manifest, "Second").id);
  check(resumed);
  assert.equal(resumed.runs["run-2"], undefined);
  const offer = designResumeOffer(resumed, "run-1");
  assert.deepEqual(offer.ok && offer.cap, 2, "the original run is the newest again and can be resumed");

  // A Refine run goes with its Screen.
  const first = screenByTitle(manifest, "First");
  let refined = startRun(manifest, "run-3", refine(first.id, first.activeRevisionId)).manifest;
  refined = settle(accept(refined, "run-3", "First"), "run-3", "completed", 6_000)!;
  const removed = structuredClone(refined);
  removeDesignScreen(removed, first.id);
  check(removed);
  assert.deepEqual(Object.keys(removed.runs), ["run-2"]);

  // A set an in-progress run is still filling is not dropped by an unrelated deletion.
  const running = startRun(exploredProject(["Solo"], 2), "run-9", explore(2)).manifest;
  const other = structuredClone(running);
  removeDesignScreen(other, screenByTitle(running, "Solo").id);
  check(other);
  assert.deepEqual(Object.keys(other.directionSets), ["set-run-9"], "only the finished set was dropped");
});

test("a run renders at most its cap, and a direction set holds at most its requested count", () => {
  let { manifest } = startRun(project(), "run-1", explore(2));
  manifest = accept(accept(manifest, "run-1", "One"), "run-1", "Two");
  assert.throws(
    () => acceptDesignArtifact(manifest, artifactInput("run-1", "Three"), ids(), NO_OTHERS, 3_000),
    expectStoreError("invalid", /at most 2 designs/u),
  );

  const first = exploredProject(["Solo"], 3, "cancelled");
  const resumed = startRun(first, "run-2", explore(3, { resumeRunId: "run-1" })).manifest;
  const squeezed = structuredClone(resumed);
  squeezed.directionSets["set-run-1"]!.requestedCount = 2; // the run's cap (2) now outruns the set (1 free)
  assert.throws(
    () => acceptDesignArtifact(accept(squeezed, "run-2", "Next"), artifactInput("run-2", "Extra"), ids(), NO_OTHERS, 3_000),
    expectStoreError("invalid", /already holds its 2 directions/u),
  );

  const refineBase = exploredProject(["Home"], 2);
  const screen = screenByTitle(refineBase, "Home");
  const refining = accept(startRun(refineBase, "run-2", refine(screen.id, screen.activeRevisionId)).manifest, "run-2", "Home");
  assert.throws(
    () => acceptDesignArtifact(refining, artifactInput("run-2", "Home"), ids(), NO_OTHERS, 3_000),
    expectStoreError("invalid", /at most 1 design\./u),
  );
});

test("replacing a draft keeps directions distinct and only replaces drafts of the same run", () => {
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = accept(accept(manifest, "run-1", "Calm"), "run-1", "Bold");
  const calmDraft = screenByTitle(manifest, "Calm").revisionIds[0]!;
  assert.throws(
    () =>
      acceptDesignArtifact(
        manifest,
        { ...artifactInput("run-1", "BOLD"), replacesRevisionId: calmDraft },
        ids(),
        NO_OTHERS,
        3_000,
      ),
    expectStoreError("invalid", /already exists/u),
  );
  // Keeping its own title while changing the file is not a duplicate of itself.
  const same = acceptDesignArtifact(
    manifest,
    { ...artifactInput("run-1", "calm"), replacesRevisionId: calmDraft },
    ids(),
    NO_OTHERS,
    3_000,
  );
  assert.equal(check(same.manifest).screens[screenByTitle(manifest, "Calm").id]!.title, "calm");
  for (const replacesRevisionId of ["nope", "constructor"]) {
    assert.throws(
      () =>
        acceptDesignArtifact(manifest, { ...artifactInput("run-1", "X"), replacesRevisionId }, ids(), NO_OTHERS, 3_000),
      expectStoreError("invalid", /draft from this run/u),
    );
  }
  const published = settle(manifest, "run-1", "completed", 4_000)!;
  assert.throws(
    () => acceptDesignArtifact(published, artifactInput("run-1", "Late"), ids(), NO_OTHERS, 5_000),
    expectStoreError("invalid", /no longer accepting/u),
  );
});

test("unusable titles, checksums and reused ids are refused before anything is written", () => {
  const { manifest } = startRun(project(), "run-1", explore(3));
  const first = accept(manifest, "run-1", "Real");
  const taken = first.runs["run-1"]!.revisionIds[0]!;
  const before = structuredClone(first);
  const refuse = (input: DesignArtifactAcceptance, id = ids()) =>
    assert.throws(() => acceptDesignArtifact(first, input, id, NO_OTHERS, 3_000), expectStoreError("invalid", /./u));
  refuse({ ...artifactInput("run-1", "bad\u0007title") });
  refuse({ ...artifactInput("run-1", "   ") });
  refuse({ ...artifactInput("run-1", "ok"), sha256: "XYZ" });
  refuse(artifactInput("run-1", "ok"), { ...ids(), revisionId: taken });
  refuse(artifactInput("run-1", "ok"), { ...ids(), screenId: screenByTitle(first, "Real").id });
  refuse(artifactInput("run-1", "ok"), { ...ids(), nodeId: first.canvas.nodes[0]!.id });
  assert.deepEqual(first, before);
  const trimmed = accept(first, "run-1", "  Padded  ");
  assert.equal(screenByTitle(trimmed, "Padded").title, "Padded", "titles are stored trimmed");
});

test("run ids that are also inherited property names behave like any other id", () => {
  const request = explore(2);
  let manifest = beginDesignRun(project(), {
    runId: "constructor",
    turnId: "turn-1",
    request,
    plan: planDesignRun(project(), request),
    directionSetId: "toString",
    now: 2_000,
  });
  check(manifest);
  assert.throws(
    () => acceptDesignArtifact(manifest, artifactInput("valueOf", "x"), ids(), NO_OTHERS, 3_000),
    expectStoreError("invalid", /no longer accepting/u),
  );
  manifest = accept(manifest, "constructor", "Calm");
  manifest = settle(manifest, "constructor", "cancelled", 4_000)!;
  const runId: string = "constructor";
  assert.equal(manifest.runs[runId]!.status, "partial");
  assert.equal(finishDesignRun(manifest, "hasOwnProperty", "failed", 5_000), undefined);
  assert.equal(orphanRevisionIds(manifest, new Map([["constructor", 1]])).join(), "constructor");
});

test("beginning a run is refused while another runs or when its ids are already taken", () => {
  const { manifest } = startRun(project(), "run-1", explore(2));
  const request = explore(2);
  const attempt = (current: DesignProjectManifestV1, runId: string, directionSetId: string) =>
    beginDesignRun(current, {
      runId,
      turnId: "turn-x",
      request,
      plan: { kind: "explore", cap: 2 },
      directionSetId,
      now: 3_000,
    });
  assert.throws(() => attempt(manifest, "run-2", "set-2"), expectStoreError("busy", /already in progress/u));
  assert.throws(() => attempt(manifest, "run-1", "set-2"), expectStoreError("invalid", /already exists/u));
  const settled = settle(manifest, "run-1", "failed", 4_000)!;
  assert.throws(() => attempt(settled, "run-1", "set-2"), expectStoreError("invalid", /already exists/u));
  const kept = settle(accept(manifest, "run-1", "A"), "run-1", "cancelled", 4_000)!;
  assert.throws(() => attempt(kept, "run-2", "set-run-1"), expectStoreError("invalid", /direction set already exists/u));
  assert.throws(
    () =>
      beginDesignRun(kept, {
        runId: "run-2", turnId: "t", request: explore(2, { resumeRunId: "run-1" }),
        plan: { kind: "explore", cap: 1, directionSetId: "gone" }, directionSetId: "unused", now: 3_000,
      }),
    expectStoreError("invalid", /no longer exists/u),
  );
});

test("archiving a set and files that went missing still count against the project quota", () => {
  let heavy = seedScreen(project(), "a", Array.from({ length: 100 }, () => 256 * KIB));
  heavy = seedScreen(heavy, "b", Array.from({ length: 100 }, () => 256 * KIB));
  heavy = seedScreen(heavy, "c", [...Array.from({ length: 55 }, () => 256 * KIB), 156 * KIB]);
  heavy.directionSets.old = { id: "old", runId: "seed-a", requestedCount: 2, screenIds: ["a"], archived: true };
  heavy.screens.a!.directionSetId = "old";
  heavy.revisions["b-rev-0"]!.state = "missing";
  heavy = startRun(heavy, "run-heavy", refine("c", "c-rev-55")).manifest;
  assert.throws(
    () => acceptDesignArtifact(heavy, artifactInput("run-heavy", "c", 200 * KIB), ids(), NO_OTHERS, 3_000),
    expectStoreError("quota", /64 MiB/u),
  );
  const freed = structuredClone(heavy);
  removeDesignScreen(freed, "a");
  assert.ok(check(acceptDesignArtifact(freed, artifactInput("run-heavy", "c", 200 * KIB), ids(), NO_OTHERS, 3_000).manifest));
  // The user is shown the number the cap is checked against, missing files included.
  let everyRevision = 0;
  for (const revision of Object.values(heavy.revisions)) everyRevision += revision.bytes;
  assert.equal(designProjectSummary(heavy).bytes, everyRevision);
  assert.deepEqual(
    [designDeletePreview(heavy).screens, designDeletePreview(heavy).revisions, designDeletePreview(heavy).bytes],
    [3, 256, everyRevision],
  );
  assert.equal(designProjectBytes(heavy), everyRevision);
});

test("a restart never publishes a design whose file vanished, and a clock that ran backwards still parses", () => {
  const base = exploredProject(["Home"], 2);
  const screen = screenByTitle(base, "Home");
  let manifest = startRun(base, "run-2", refine(screen.id, screen.activeRevisionId)).manifest;
  manifest = accept(manifest, "run-2", "Home");
  const draft = manifest.runs["run-2"]!.revisionIds[0]!;
  const files = new Map(Object.values(manifest.revisions).filter((r) => r.id !== draft).map((r) => [r.id, r.bytes]));
  const restarted = check(reconcile(manifest, files, 1).manifest); // earlier than the run's start
  assert.equal(restarted.revisions[draft]!.state, "missing");
  assert.equal(restarted.screens[screen.id]!.activeRevisionId, screen.activeRevisionId, "the current design is unchanged");
  assert.equal(restarted.runs["run-2"]!.endedAt, restarted.runs["run-2"]!.startedAt);
  assert.equal(revisionIdForToolCall(restarted, restarted.revisions[draft]!.toolCallId), draft);
  assert.equal(revisionIdForToolCall(restarted, "unknown-call"), undefined);
});

test("run records are trimmed to the newest 100 without touching a run in progress", () => {
  let manifest = project();
  for (let index = 0; index < 101; index += 1) {
    const runId = `run-${index}`;
    manifest = startRun(manifest, runId, explore(2)).manifest;
    manifest = settle(manifest, runId, "failed", 2_000 + index)!;
  }
  assert.equal(Object.keys(manifest.runs).length, 100);
  assert.equal(manifest.runs["run-0"], undefined, "the oldest settled run went first");
  const running = startRun(manifest, "run-last", explore(2)).manifest;
  assert.equal(Object.keys(running.runs).length, 100);
  assert.equal(running.runs["run-last"]!.status, "running");
});

test("Resume defaults to the model of the set's newest direction", () => {
  const other = { providerId: "openrouter", model: "model-b" };
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = accept(manifest, "run-1", "Old");
  manifest = check(
    acceptDesignArtifact(manifest, { ...artifactInput("run-1", "New"), model: other }, ids(), NO_OTHERS, 3_500).manifest,
  );
  manifest = settle(manifest, "run-1", "failed", 4_000)!;
  const offer = designResumeOffer(manifest, "run-1");
  assert.ok(offer.ok);
  assert.deepEqual(offer.model, other);
  assert.deepEqual(offer.existingTitles, ["Old", "New"]);
  assert.equal(offer.cap, 1);
  const refused = designResumeOffer(manifest, "missing-run");
  assert.equal(refused.ok, false);
});

test("a Screen being rendered into cannot be deleted, and the refusal changes nothing", () => {
  // A draft of a running Explore.
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = accept(manifest, "run-1", "Calm");
  const calm = screenByTitle(manifest, "Calm");
  const attempt = structuredClone(manifest);
  assert.throws(() => removeDesignScreen(attempt, calm.id), expectStoreError("busy", /being rendered/u));
  assert.deepEqual(attempt, manifest);
  // The target of a running Refine, even before it renders anything.
  const settled = settle(manifest, "run-1", "completed", 4_000)!;
  const refining = startRun(settled, "run-2", refine(calm.id, calm.activeRevisionId)).manifest;
  const target = structuredClone(refining);
  assert.throws(() => removeDesignScreen(target, calm.id), expectStoreError("busy", /being rendered/u));
  assert.deepEqual(target, refining);
  // Once the run ends the Screen can go.
  const done = settle(refining, "run-2", "cancelled", 5_000)!;
  const free = structuredClone(done);
  assert.deepEqual(removeDesignScreen(free, calm.id), done.screens[calm.id]!.revisionIds);
  check(free);
});

test("the newest run of a set survives trimming, so its Resume offer stays", () => {
  // Its id sorts first and every run starts at the same instant, so it is the oldest by any ordering.
  let manifest = startRun(project(), "aa-first", explore(3)).manifest;
  manifest = settle(accept(manifest, "aa-first", "Only"), "aa-first", "cancelled", 4_000)!;
  for (let index = 0; index < 105; index += 1) {
    const runId = `later-${index}`;
    manifest = startRun(manifest, runId, explore(2)).manifest;
    manifest = settle(manifest, runId, "failed", 5_000 + index)!;
  }
  assert.ok(manifest.runs["aa-first"], "the oldest record is still the newest run of its set");
  assert.equal(Object.keys(manifest.runs).length, 100);
  const offer = designResumeOffer(manifest, "aa-first");
  assert.deepEqual(offer.ok && offer.cap, 2);
});

test("a Resume that ends empty after its set lost every Screen leaves no set and no offer", () => {
  let manifest = exploredProject(["A"], 3, "cancelled");
  const screenA = screenByTitle(manifest, "A");
  manifest = startRun(manifest, "run-2", explore(3, { resumeRunId: "run-1" })).manifest;
  const deleting = structuredClone(manifest);
  removeDesignScreen(deleting, screenA.id); // A is published, not a draft: allowed while run-2 runs
  manifest = check(touchDesignManifest(deleting, 4_500));
  assert.deepEqual(Object.keys(manifest.directionSets), ["set-run-1"], "the running Resume still fills the set");
  manifest = settle(manifest, "run-2", "cancelled", 5_000)!;
  assert.deepEqual(manifest.directionSets, {}, "no empty set remains");
  assert.equal(manifest.runs["run-2"]!.directionSetId, undefined);
  assert.equal(designResumeOffer(manifest, "run-2").ok, false);
  assert.equal(designProjectSummary(manifest).health, "ok");
});

test("a Resume always ranks as its set's newest run, even when the clock ran backwards", () => {
  const manifest = exploredProject(["First"], 3, "cancelled");
  const request = explore(3, { resumeRunId: "run-1" });
  const resumed = check(
    beginDesignRun(manifest, {
      runId: "run-2",
      turnId: "turn-2",
      request,
      plan: planDesignRun(manifest, request),
      directionSetId: "unused",
      now: 100, // before run-1 started
    }),
  );
  assert.ok(resumed.runs["run-2"]!.startedAt > resumed.runs["run-1"]!.startedAt);
  const ended = settle(resumed, "run-2", "cancelled", 100)!;
  assert.throws(() => planDesignRun(ended, explore(3, { resumeRunId: "run-1" })), /newest run/u);
  assert.equal(planDesignRun(ended, explore(3, { resumeRunId: "run-2" })).cap, 2);
  // Record order does not decide which run is newest.
  const shuffled = structuredClone(ended);
  shuffled.runs = Object.fromEntries(Object.entries(ended.runs).reverse());
  assert.equal(planDesignRun(shuffled, explore(3, { resumeRunId: "run-2" })).cap, 2);
  // Equal start times (a manifest written before the clamp) fall back to the run id, in either record order.
  for (const order of [["run-1", "run-2"], ["run-2", "run-1"]]) {
    const tied = structuredClone(ended);
    tied.runs["run-2"]!.startedAt = tied.runs["run-1"]!.startedAt;
    tied.runs["run-2"]!.endedAt = tied.runs["run-2"]!.startedAt;
    tied.runs = Object.fromEntries(order.map((id) => [id, tied.runs[id]!]));
    assert.equal(designResumeOffer(tied, "run-2").ok, true, order.join());
    assert.equal(designResumeOffer(tied, "run-1").ok, false, order.join());
  }
});

test("direction titles compare through Unicode composition and zero-width characters", () => {
  assert.equal(designDirectionTitleKey("Caf\u00e9"), designDirectionTitleKey("Cafe\u0301"));
  assert.equal(designDirectionTitleKey("Calm Dawn"), designDirectionTitleKey("Calm\u200BDa\uFEFFwn"));
  assert.equal(designDirectionTitleKey("\uFF23alm"), designDirectionTitleKey("calm"));
  assert.notEqual(designDirectionTitleKey("Calm"), designDirectionTitleKey("Calmer"));
  let { manifest } = startRun(project(), "run-1", explore(3));
  manifest = accept(manifest, "run-1", "Caf\u00e9");
  assert.throws(
    () => acceptDesignArtifact(manifest, artifactInput("run-1", "Cafe\u0301"), ids(), NO_OTHERS, 3_000),
    expectStoreError("invalid", /already exists/u),
  );
  assert.throws(
    () => acceptDesignArtifact(manifest, artifactInput("run-1", "Ca\u200Bf\u00e9"), ids(), NO_OTHERS, 3_000),
    expectStoreError("invalid", /already exists/u),
  );
});

/** Small deterministic generator so every walk replays identically. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random legal operation sequences always leave a parseable manifest that keeps the store invariants", () => {
  const TITLES = ["Calm", "Bold", "Dense", "Warm", "Cool", "Quiet", "Loud", "Soft"];
  let refusals = 0;
  let resumes = 0;
  let busyDeletes = 0;
  let emptyEnds = 0;
  for (let seed = 1; seed <= 50; seed += 1) {
    const random = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
    let counter = 0;
    let now = 10_000;
    let manifest = check(createDesignProjectManifest({ id: "walk", chatId: "chat-walk", title: "Walk", now }));
    const attempt = <T>(action: () => T): T | undefined => {
      try {
        return action();
      } catch (error) {
        // Refusals are legal outcomes of an unlucky draw; anything else is a bug.
        if (!(error instanceof DesignStoreError)) throw error;
        refusals += 1;
        return undefined;
      }
    };
    for (let step = 0; step < 60; step += 1) {
      now += random() < 0.15 ? -500 : 100; // the clock sometimes runs backwards
      const running = Object.values(manifest.runs).find((run) => run.status === "running");
      const roll = random();
      if (running && roll < 0.35) {
        const drafts = running.revisionIds.filter((id) => manifest.revisions[id]?.state === "draft");
        const replaces = random() < 0.25 ? pick(drafts) : undefined;
        const title = random() < 0.2 && replaces === undefined ? "calm" : pick(TITLES)!;
        counter += 1;
        const input: DesignArtifactAcceptance = {
          runId: running.id,
          toolCallId: `walk-call-${counter}`,
          title,
          bytes: 1 + Math.floor(random() * 256 * KIB),
          sha256: "c".repeat(64),
          model: MODEL,
          ...(replaces === undefined ? {} : { replacesRevisionId: replaces }),
        };
        const result = attempt(() =>
          acceptDesignArtifact(
            manifest,
            input,
            { revisionId: `w-rev-${counter}`, screenId: `w-screen-${counter}`, nodeId: `w-node-${counter}` },
            NO_OTHERS,
            now,
          ),
        );
        if (result) manifest = result.manifest;
      } else if (running && roll < 0.55) {
        const outcome = pick(["completed", "cancelled", "failed"] as const)!;
        if (running.revisionIds.length === 0) emptyEnds += 1;
        manifest = finishDesignRun(manifest, running.id, outcome, now)!;
      } else if (!running && roll < 0.5) {
        counter += 1;
        const runId = `w-run-${counter}`;
        const kind = random();
        let request: DesignRunRequest | undefined;
        if (kind < 0.4) {
          const resumable = pick(Object.values(manifest.runs).filter((run) => run.request.op === "explore"));
          if (resumable && resumable.request.op === "explore") {
            request = { ...resumable.request, resumeRunId: resumable.id };
            resumes += 1;
          }
        } else if (kind < 0.65) {
          const base = pick(Object.values(manifest.revisions));
          if (base) request = refine(base.screenId, base.id);
        }
        if (request === undefined) {
          const baseRevisionId = random() < 0.2 ? pick(Object.keys(manifest.revisions)) : undefined;
          request = explore(pick([2, 3, 4] as const)!, baseRevisionId === undefined ? {} : { baseRevisionId });
        }
        const started = attempt(() => {
          const plan = planDesignRun(manifest, request!);
          return beginDesignRun(manifest, {
            runId,
            turnId: `w-turn-${counter}`,
            request: request!,
            plan,
            directionSetId: `w-set-${counter}`,
            now,
          });
        });
        if (started) manifest = started;
      } else if (roll < 0.7) {
        const target = pick(Object.keys(manifest.screens));
        if (target !== undefined) {
          const clone = structuredClone(manifest);
          try {
            removeDesignScreen(clone, target);
            manifest = touchDesignManifest(clone, now);
          } catch (error) {
            if (!(error instanceof DesignStoreError) || error.code !== "busy") throw error;
            busyDeletes += 1;
            assert.deepEqual(clone, manifest, "a refused delete changes nothing");
          }
        }
      } else if (roll < 0.8) {
        const revisionId = pick(Object.keys(manifest.revisions));
        if (revisionId !== undefined) manifest = markDesignRevisionMissing(manifest, revisionId, now);
      } else if (roll < 0.9) {
        const files = new Map<string, number>();
        for (const revision of Object.values(manifest.revisions)) {
          const luck = random();
          if (luck < 0.8) files.set(revision.id, revision.bytes);
          else if (luck < 0.9) files.set(revision.id, revision.bytes + 1);
        }
        manifest = reconcile(manifest, files, now).manifest;
      } else {
        const set = pick(Object.values(manifest.directionSets));
        if (set) {
          const clone = structuredClone(manifest);
          clone.directionSets[set.id]!.archived = !set.archived;
          manifest = touchDesignManifest(clone, now);
        }
      }
      check(manifest);
    }
  }
  // The walks must actually reach the interesting transitions, or they prove nothing.
  assert.ok(refusals > 0 && resumes > 0 && busyDeletes > 0 && emptyEnds > 0, `${refusals} ${resumes} ${busyDeletes} ${emptyEnds}`);
});
