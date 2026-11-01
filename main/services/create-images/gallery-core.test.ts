import assert from "node:assert/strict";
import test from "node:test";
import { GALLERY_MAX_ITEMS } from "../../../renderer/shared/images/ipc-types.js";
import type { OutputRef } from "../../../renderer/shared/images/run-types.js";
import { selectGalleryImages, toGalleryItems } from "./gallery-core.js";
import type { GeneratedAttempt } from "./run-ledger.js";

const out = (seed: string): OutputRef => ({ assetId: seed.repeat(64), width: 16, height: 9, mediaType: "image/png" });
function attempt(runId: string, finishedAt: number, output: OutputRef[], overrides: Partial<GeneratedAttempt> = {}): GeneratedAttempt {
  return { runId, runState: "succeeded", workflowId: "wf-a", nodeId: "g1", variant: 0, provider: "openrouter", model: "m", finishedAt, output, ...overrides };
}
const everything = { exists: () => true };

test("images are listed newest first across workflows, in each request's own order", () => {
  const images = selectGalleryImages(
    [
      attempt("old", 100, [out("a")]),
      attempt("new", 300, [out("b"), out("c")], { workflowId: "wf-b" }),
      attempt("middle", 200, [out("d")]),
    ],
    everything,
  );
  assert.deepEqual(
    images.map((image) => [image.attempt.runId, image.ref.assetId[0], image.index]),
    [["new", "b", 0], ["new", "c", 1], ["middle", "d", 0], ["old", "a", 0]],
  );
});

test("equal finish times keep the ledger's order, an image appears once, and collected images are left out", () => {
  const images = selectGalleryImages(
    [attempt("first", 100, [out("a"), out("b")]), attempt("second", 100, [out("a"), out("c")])],
    { exists: (assetId) => !assetId.startsWith("c") },
  );
  assert.deepEqual(images.map((image) => [image.attempt.runId, image.ref.assetId[0]]), [["first", "a"], ["first", "b"]]);
});

test("the list stops at its limit, and never exceeds the gallery maximum", () => {
  const many = Array.from({ length: 1_100 }, (_, index) =>
    attempt(`r${index}`, index, [out(index.toString(16).padStart(4, "0")), out(`f${index.toString(16).padStart(3, "0")}`)]),
  );
  assert.equal(selectGalleryImages(many, { ...everything, limit: 3 }).length, 3);
  const capped = selectGalleryImages(many, { ...everything, limit: GALLERY_MAX_ITEMS + 500 });
  assert.equal(capped.length, GALLERY_MAX_ITEMS);
  assert.equal(capped[0]?.attempt.runId, "r1099");
});

test("items carry current titles when they still exist, the prompt, the saved state and a thumbnail", () => {
  const images = selectGalleryImages(
    [
      attempt("r2", 200, [out("b")], { workflowId: "gone", nodeId: "g9", prompt: "A red bicycle" }),
      attempt("r1", 100, [out("a"), out("c")], { model: "google/gemini-3.1-flash-image" }),
    ],
    everything,
  );
  const items = toGalleryItems(images, {
    workflowTitle: (workflowId) => (workflowId === "wf-a" ? "Bikes" : undefined),
    nodeTitle: (workflowId, nodeId) => (workflowId === "wf-a" && nodeId === "g1" ? "Hero shot" : undefined),
    saved: new Set([out("a").assetId]),
    thumbUrl: (assetId) => (assetId === out("c").assetId ? undefined : `aiden-asset://grant/${assetId.slice(0, 4)}`),
  });
  assert.deepEqual(items, [
    {
      ...out("b"), runId: "r2", runState: "succeeded", workflowId: "gone", nodeId: "g9", variant: 0, index: 0, provider: "openrouter", model: "m",
      prompt: "A red bicycle", createdAt: 200, saved: false, thumbUrl: "aiden-asset://grant/bbbb",
    },
    {
      ...out("a"), runId: "r1", runState: "succeeded", workflowId: "wf-a", workflowTitle: "Bikes", nodeId: "g1", nodeTitle: "Hero shot", variant: 0, index: 0,
      provider: "openrouter", model: "google/gemini-3.1-flash-image", createdAt: 100, saved: true, thumbUrl: "aiden-asset://grant/aaaa",
    },
  ]);
});
