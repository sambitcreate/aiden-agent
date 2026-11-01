import assert from "node:assert/strict";
import test from "node:test";
import { SAVE_ALL_MAX_IMAGES, type GalleryItem } from "../shared/images/ipc-types";
import type { ImageModelOption } from "../shared/images/port";
import {
  DELETED_WORKFLOWS_FACET,
  EMPTY_LIBRARY_FILTERS,
  filterLibrary,
  gridMove,
  libraryFacets,
  saveAllSelection,
  sectionByDay,
  summarizeWorkflowImages,
  tileLabel,
  workflowAvailable,
  type LibraryFilters,
  type TileRect,
} from "./library-core";

const item = (seed: string, patch: Partial<GalleryItem> = {}): GalleryItem => ({
  assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png", runId: "r", runState: "succeeded", workflowId: "wf-a",
  workflowTitle: "Posters", nodeId: "g", nodeTitle: "Generate Image", variant: 0, index: 0, provider: "openrouter", model: "google/flash-image",
  createdAt: 1_000, saved: true, thumbUrl: `thumb:${seed}`, ...patch,
});
const ids = (items: readonly GalleryItem[]) => items.map((entry) => entry.assetId[0]).join("");
const filters = (patch: Partial<LibraryFilters>): LibraryFilters => ({ ...EMPTY_LIBRARY_FILTERS, ...patch });
const MODELS: ImageModelOption[] = [
  { provider: "openrouter", providerLabel: "OpenRouter", model: "google/flash-image", label: "Nano Banana 2", acceptsReferences: true, textOutput: true },
];

const LIBRARY = [
  item("a", { createdAt: 500, prompt: "A LIGHTHOUSE at dusk, oil painting" }),
  item("b", { createdAt: 400, workflowId: "wf-b", workflowTitle: "Product shots", nodeTitle: "Hero", model: "black-forest/flux", prompt: "white sneaker" }),
  item("c", { createdAt: 300, workflowId: "wf-gone", workflowTitle: undefined, nodeTitle: undefined, prompt: "lighthouse in fog" }),
  item("d", { createdAt: 200, workflowId: "wf-b", workflowTitle: "Product shots", model: "black-forest/flux" }),
];

test("search is case-insensitive across prompt, model name, workflow title and node title, with every term required", () => {
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "lighthouse" }))), "ac");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "  Dusk   lighthouse " }))), "a");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "product" }))), "bd");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "hero" }))), "b");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "FLUX" }))), "bd");
  // The configured display name finds a model as well as its id.
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "nano banana" }), MODELS)), "ac");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "nano banana" }))), "");
  // A term never spans two fields: "painting" ends the prompt and "Posters" is the workflow title.
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "painting posters" }))), "a");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ query: "paintingposters" }))), "");
});

test("workflow and model filters combine with the search, and images of deleted workflows share one choice", () => {
  assert.equal(ids(filterLibrary(LIBRARY, filters({ workflow: "wf-b" }))), "bd");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ workflow: DELETED_WORKFLOWS_FACET }))), "c");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ model: "openrouter::google/flash-image" }))), "ac");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ workflow: "wf-b", query: "sneaker" }))), "b");
  assert.equal(ids(filterLibrary(LIBRARY, filters({ workflow: "wf-a", model: "openrouter::black-forest/flux" }))), "");
});

test("sorting puts the newest or the oldest first and keeps the gallery's order for ties", () => {
  const shuffled = [LIBRARY[2]!, LIBRARY[0]!, LIBRARY[3]!, LIBRARY[1]!];
  assert.equal(ids(filterLibrary(shuffled, filters({ sort: "newest" }))), "abcd");
  assert.equal(ids(filterLibrary(shuffled, filters({ sort: "oldest" }))), "dcba");
  const ties = [item("x", { createdAt: 9 }), item("y", { createdAt: 9 })];
  assert.equal(ids(filterLibrary(ties, filters({ sort: "oldest" }))), "xy");
});

test("facet counts follow the search and the other facet, most images first", () => {
  const all = libraryFacets(LIBRARY, EMPTY_LIBRARY_FILTERS, MODELS);
  assert.deepEqual(all.workflows.map((option) => [option.label, option.count]), [["Product shots", 2], ["Deleted workflows", 1], ["Posters", 1]]);
  assert.deepEqual(all.models.map((option) => [option.label, option.count]), [["black-forest/flux", 2], ["Nano Banana 2", 2]]);
  assert.equal(all.workflowTotal, 4);

  // Choosing a workflow narrows the model counts but not the workflow choices themselves.
  const picked = libraryFacets(LIBRARY, filters({ workflow: "wf-b" }), MODELS);
  assert.deepEqual(picked.models.map((option) => [option.label, option.count]), [["black-forest/flux", 2]]);
  assert.equal(picked.workflows.length, 3);
  assert.equal(picked.modelTotal, 2);

  const searched = libraryFacets(LIBRARY, filters({ query: "lighthouse" }), MODELS);
  assert.deepEqual(searched.workflows.map((option) => [option.key, option.count]), [[DELETED_WORKFLOWS_FACET, 1], ["wf-a", 1]]);
  assert.equal(searched.workflowTotal, 2);
});

test("day sections read Today, Yesterday, then the date, by local calendar day, and keep each image's list position", () => {
  const now = new Date(2026, 9, 31, 9, 0).getTime();
  const sorted = [
    item("a", { createdAt: new Date(2026, 9, 31, 0, 5).getTime() }),
    item("b", { createdAt: new Date(2026, 9, 30, 23, 55).getTime() }),
    item("c", { createdAt: new Date(2026, 9, 30, 0, 1).getTime() }),
    item("d", { createdAt: new Date(2026, 9, 2, 12).getTime() }),
    item("e", { createdAt: new Date(2025, 9, 2, 12).getTime() }),
  ];
  const sections = sectionByDay(sorted, now, (timestamp) => `date ${new Date(timestamp).getFullYear()}`);
  assert.deepEqual(sections.map((section) => section.label), ["Today", "Yesterday", "date 2026", "date 2025"]);
  assert.deepEqual(sections.map((section) => ids(section.entries.map((entry) => entry.item))), ["a", "bc", "d", "e"]);
  for (const section of sections) {
    for (const entry of section.entries) assert.equal(sorted[entry.index], entry.item);
  }
  // Oldest first keeps the same days, in the other order.
  const reversed = sectionByDay([...sorted].reverse(), now, () => "date");
  assert.deepEqual(reversed.map((section) => section.label), ["date", "date", "Yesterday", "Today"]);
});

test("Save All sends at most the cap, in the order shown, and says when more exist", () => {
  const few = saveAllSelection(LIBRARY);
  assert.deepEqual(few, { assetIds: LIBRARY.map((entry) => entry.assetId), total: 4, capped: false });
  const many = Array.from({ length: SAVE_ALL_MAX_IMAGES + 5 }, (_, index) => item(String.fromCharCode(65 + (index % 26)), { createdAt: index }));
  const capped = saveAllSelection(many);
  assert.equal(capped.assetIds.length, SAVE_ALL_MAX_IMAGES);
  assert.equal(capped.assetIds[0], many[0]!.assetId);
  assert.equal(capped.total, SAVE_ALL_MAX_IMAGES + 5);
  assert.equal(capped.capped, true);
});

test("a tile's name gives its place, its workflow and a shortened prompt", () => {
  assert.equal(tileLabel(LIBRARY[0]!, 0, 4), "Image 1 of 4, Posters: A LIGHTHOUSE at dusk, oil painting");
  assert.equal(tileLabel(LIBRARY[3]!, 3, 4), "Image 4 of 4, Product shots");
  assert.equal(tileLabel(LIBRARY[2]!, 2, 4), "Image 3 of 4, Deleted workflow: lighthouse in fog");
  const long = tileLabel(item("z", { prompt: `${"word ".repeat(40)}\n\nend` }), 0, 1);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("\n"));
});

// Two sections: a full row of three, a row of one, then (after a heading) a row of two.
const rect = (left: number, top: number): TileRect => ({ left, top, width: 100, height: 100 });
const GRID = [rect(0, 0), rect(110, 0), rect(220, 0), rect(0, 110), rect(0, 260), rect(110, 260)];

test("arrow keys step through the list and move by row to the tile closest in column, crossing sections", () => {
  assert.equal(gridMove(GRID, 1, "ArrowRight"), 2);
  assert.equal(gridMove(GRID, 2, "ArrowRight"), 3);
  assert.equal(gridMove(GRID, 5, "ArrowRight"), 5);
  assert.equal(gridMove(GRID, 0, "ArrowLeft"), 0);
  assert.equal(gridMove(GRID, 1, "ArrowDown"), 3);
  assert.equal(gridMove(GRID, 3, "ArrowDown"), 4);
  assert.equal(gridMove(GRID, 5, "ArrowUp"), 3);
  assert.equal(gridMove(GRID, 3, "ArrowUp"), 0);
  assert.equal(gridMove(GRID, 2, "ArrowUp"), 2);
  assert.equal(gridMove(GRID, 4, "ArrowDown"), 4);
  assert.equal(gridMove(GRID, 3, "Home"), 0);
  assert.equal(gridMove(GRID, 0, "End"), 5);
  assert.equal(gridMove([], 0, "End"), -1);
});

test("each workflow's summary is its newest image and its image count", () => {
  const summaries = summarizeWorkflowImages([LIBRARY[3]!, LIBRARY[1]!, LIBRARY[0]!]);
  assert.equal(summaries.get("wf-b")?.latest.assetId, LIBRARY[1]!.assetId);
  assert.equal(summaries.get("wf-b")?.count, 2);
  assert.equal(summaries.get("wf-a")?.count, 1);
  assert.equal(summaries.has("wf-none"), false);
});

test("Open Workflow is available only for a workflow that still exists", () => {
  assert.equal(workflowAvailable(LIBRARY[0]!, null), true);
  assert.equal(workflowAvailable(LIBRARY[0]!, new Set(["wf-a"])), true);
  assert.equal(workflowAvailable(LIBRARY[0]!, new Set(["wf-b"])), false);
  assert.equal(workflowAvailable(LIBRARY[2]!, null), false);
});
