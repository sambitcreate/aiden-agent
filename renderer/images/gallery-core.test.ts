import assert from "node:assert/strict";
import test from "node:test";
import type { GalleryItem } from "../shared/images/ipc-types";
import type { AttemptSnapshot, RunSnapshot, RunState } from "../shared/images/run-types";
import { galleryRefreshKey, groupGalleryByRun, relativeTime, viewerItemsForOutputs } from "./gallery-core";

const item = (seed: string, runId: string, createdAt: number): GalleryItem => ({
  assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png", runId, runState: "succeeded", workflowId: "wf", nodeId: "g", variant: 0,
  index: 0, provider: "openrouter", model: "m", createdAt, saved: true, thumbUrl: `thumb:${seed}`,
});
const snapshot = (state: RunState, workflowId = "wf", runId = "r1"): RunSnapshot => ({
  version: 3,
  run: { runId, workflowId, workflowRevision: 1, scope: { kind: "all" }, state, requestLimit: 1, requestsSent: 1, createdAt: 1 },
  attempts: [],
});

test("history groups a newest-first gallery by run and keeps each image's place in the whole list", () => {
  const items = [item("a", "r2", 300), item("b", "r2", 290), item("c", "r1", 100), item("d", "r1", 90)];
  const groups = groupGalleryByRun(items);
  assert.deepEqual(groups.map((group) => group.runId), ["r2", "r1"]);
  assert.deepEqual(groups.map((group) => group.createdAt), [300, 100]);
  // The viewer opens over the whole history, so each thumbnail carries its global index.
  for (const group of groups) {
    for (const entry of group.entries) assert.equal(items[entry.index], entry.item);
  }
});

test("relative times read naturally and fall back to the date after a day", () => {
  const now = 10 * 24 * 3_600_000;
  const date = () => "the date";
  assert.equal(relativeTime(now - 5_000, now, date), "Just now");
  assert.equal(relativeTime(now - 5 * 60_000, now, date), "5 min ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now, date), "3 h ago");
  assert.equal(relativeTime(now - 30 * 3_600_000, now, date), "Yesterday");
  assert.equal(relativeTime(now - 5 * 24 * 3_600_000, now, date), "the date");
  // A clock that moved backwards is not "in the future".
  assert.equal(relativeTime(now + 60_000, now, date), "Just now");
});

test("the gallery re-reads once when a run of this workflow ends, not while it runs or for other workflows", () => {
  assert.equal(galleryRefreshKey(snapshot("running"), "wf"), null);
  assert.equal(galleryRefreshKey(snapshot("succeeded", "other"), "wf"), null);
  const key = galleryRefreshKey(snapshot("succeeded"), "wf");
  assert.ok(key);
  // A rebroadcast of the same final snapshot gives the same key, so it is not read twice.
  assert.equal(galleryRefreshKey({ ...snapshot("succeeded"), version: 9 }, "wf"), key);
  assert.notEqual(galleryRefreshKey(snapshot("failed", "wf", "r2"), "wf"), key);
  // The library listens to every workflow.
  assert.ok(galleryRefreshKey(snapshot("partial", "other"), undefined));
});

test("an Output node's images use the gallery's records, and the run's attempt for an image not listed yet", () => {
  const listed = item("a", "r1", 100);
  const fresh = { assetId: "b".repeat(64), width: 16, height: 9, mediaType: "image/jpeg" as const };
  const attempt: AttemptSnapshot = {
    nodeId: "g", variant: 0, state: "succeeded", provider: "openrouter", model: "m2", finishedAt: 500, prompt: "A red kite",
    cancelRequested: false, truncated: false, output: [fresh], mayHaveBeenBilled: false,
  };
  const items = viewerItemsForOutputs([listed, fresh], {
    gallery: [listed], workflowId: "wf", nodeId: "o", assetUrls: { [fresh.assetId]: "grant:b" }, attempts: [attempt], runId: "r2",
  });
  assert.equal(items[0], listed);
  assert.equal(items[1]?.assetId, fresh.assetId);
  assert.equal(items[1]?.prompt, "A red kite");
  assert.equal(items[1]?.model, "m2");
  assert.equal(items[1]?.createdAt, 500);
  assert.equal(items[1]?.thumbUrl, "grant:b");
  assert.equal(items[1]?.saved, false);
  // A document id named like an Object.prototype member never reads an inherited value.
  const odd = viewerItemsForOutputs([{ ...fresh, assetId: "constructor" }], {
    gallery: [], workflowId: "wf", nodeId: "o", assetUrls: {}, attempts: [],
  });
  assert.equal(odd[0]?.thumbUrl, "");
});
