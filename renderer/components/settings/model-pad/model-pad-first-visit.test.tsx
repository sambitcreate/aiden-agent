import "../../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../../main/bots/test-providers";
import type { AppSettings, ModelBenchmarkScores, ModelInfo, Provider } from "../../../lib/types";
import type { ModelPadMetric, ModelPadPlacements } from "../../../shared/model-pad-preferences";
import { Toaster, toast } from "../../ui";
import { ModelPadSettings } from "./model-pad-settings";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

// For coding, m0 is the least capable model and m9 the most capable one;
// the General (intelligence) score runs the other way.
const MODELS = Array.from({ length: 10 }, (_, index) => `m${index}`);

const provider: Provider = {
  id: "test",
  label: "Test",
  kind: "openai",
  baseUrl: "https://example.test/v1",
  models: MODELS,
  needsKey: false,
  hasKey: true,
};

function benchmark(coding: number, intelligence: number): ModelBenchmarkScores {
  return {
    source: "openrouter",
    datasetSource: "artificial-analysis",
    sourceLabel: "Artificial Analysis via OpenRouter",
    sourceUrl: "https://openrouter.ai",
    citation: "Artificial Analysis",
    asOf: "2026-10-01",
    license: "CC BY 4.0",
    coding,
    intelligence,
  };
}

function editorServer(
  options: {
    placements?: ModelPadPlacements;
    pinnedModels?: string[];
    recentModels?: string[];
    metric?: ModelPadMetric;
    insightsReady?: boolean;
    /** Whether models carry benchmark scores; defaults to `insightsReady`. */
    scored?: boolean;
    /** Score only these models instead of all of them. */
    scoredModels?: readonly string[];
    /** Add a loopback provider (label "Ollama") serving these unscored models. */
    localModels?: readonly string[];
    skippedAmbiguousCount?: number;
    /** Serve only these models from the Test provider instead of all of MODELS. */
    models?: readonly string[];
    /** When the cached benchmark snapshot was fetched. */
    fetchedAt?: string;
    /** Fail every model-details read. */
    infoFails?: boolean;
    /** Keep the provider list loading forever. */
    providersPending?: boolean;
    /** Reject every settings write. */
    failWrites?: boolean;
    /** Hold each settings write until the returned `release` is called. */
    holdWrites?: boolean;
  } = {},
) {
  const held: Array<() => void> = [];
  let current = {
    modelPadPlacements: options.placements ?? {},
    pinnedModels: options.pinnedModels ?? [],
    recentModels: options.recentModels ?? [],
    ...(options.metric ? { modelPadMetric: options.metric } : {}),
  } as AppSettings;
  const info: Record<string, ModelInfo> = (options.scored ?? options.insightsReady)
    ? Object.fromEntries(
        MODELS.flatMap((model, index): Array<[string, ModelInfo]> => {
          if (options.scoredModels && !options.scoredModels.includes(model)) return [];
          return [
            [
              model,
              {
                id: model,
                metadataSource: "fallback",
                matched: false,
                benchmark: benchmark(10 + index, 50 - index),
              },
            ],
          ];
        }),
      )
    : {};
  const calls = installBotTestIpc({
    "providers:list": () =>
      options.providersPending
        ? new Promise<Provider[]>(() => {})
        : [
            options.models ? { ...provider, models: [...options.models] } : provider,
            ...(options.localModels
              ? [
                  {
                    ...provider,
                    id: "ollama",
                    label: "Ollama",
                    baseUrl: "http://localhost:11434/v1",
                    models: [...options.localModels],
                  },
                ]
              : []),
          ],
    "models:info": () => {
      if (options.infoFails) throw new Error("catalog unreadable");
      return info;
    },
    "modelInsights:status": () => ({
      hasKey: Boolean(options.insightsReady),
      ready: Boolean(options.insightsReady),
      cachedModelCount: options.insightsReady ? MODELS.length : 0,
      skippedAmbiguousCount: options.skippedAmbiguousCount ?? 0,
      ...(options.fetchedAt ? { fetchedAt: options.fetchedAt } : {}),
    }),
    "settings:get": () => structuredClone(current),
    "settings:set": async (patch: unknown) => {
      if (options.holdWrites) await new Promise<void>((resolve) => held.push(resolve));
      if (options.failWrites) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
  });
  return {
    writes: () => calls.filter((call) => call.channel === "settings:set").length,
    stored: () => current.modelPadPlacements ?? {},
    settings: () => current,
    release: () => held.splice(0).forEach((resolve) => resolve()),
  };
}

function mountEditor() {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
      <Toaster />
    </QueryClientProvider>,
  );
}

function addButton(): HTMLElement {
  return screen.getByRole("button", { name: "Add" });
}

/** Open the header's Arrange menu and return one of its items. */
async function arrangeItem(name: string): Promise<HTMLElement> {
  fireEvent.keyDown(screen.getByRole("button", { name: "Arrange" }), { key: "Enter" });
  return screen.findByRole("menuitem", { name });
}

/** Wait until the empty Pad's quick starts stop saying the models are loading. */
async function modelsLoaded(): Promise<void> {
  await waitFor(() => {
    for (const name of ["Add pinned & recent", "Start from benchmarks"]) {
      assert.doesNotMatch(screen.getByRole("button", { name }).getAttribute("title") ?? "", /Loading/u);
    }
  });
}

function itemReason(item: HTMLElement): string {
  return document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
}

function assertFocusOnMarker() {
  const focused = document.activeElement as HTMLElement | null;
  assert.ok(
    focused?.dataset.placementSource,
    `focus is on a placed marker, not ${focused?.getAttribute("aria-label") ?? focused?.textContent}`,
  );
}

function disabledReason(button: HTMLElement): string {
  assert.equal(button.getAttribute("aria-disabled"), "true");
  return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
}

function pad(): HTMLElement {
  return screen.getByRole("group", { name: "Personal Model Pad arrangement" });
}

/** Placed models only; previewed suggestions are not on the Pad yet. */
function markerCount(): number {
  return pad().querySelectorAll('[data-placement-source]:not([data-placement-source="suggestion"])')
    .length;
}

function suggestions(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^Keep suggestion: / });
}

function suggestionNames(): string[] {
  return suggestions().map((ghost) =>
    (ghost.getAttribute("aria-label") ?? "").replace(/^Keep suggestion: (\S+) from Test$/u, "$1"),
  );
}

function position(element: HTMLElement): string {
  return `${element.style.left} ${element.style.top}`;
}

function marker(model: string): HTMLElement {
  const found = [...pad().querySelectorAll<HTMLElement>("[data-placement-source]")].find(
    (element) =>
      element.dataset.placementSource !== "suggestion" &&
      element.getAttribute("aria-label")?.startsWith(`${model} from Test,`),
  );
  assert.ok(found, `${model} is on the Pad`);
  return found;
}

async function openPreview(): Promise<void> {
  const suggest = await arrangeItem("Suggest models");
  await waitFor(() => assert.notEqual(suggest.getAttribute("aria-disabled"), "true"));
  fireEvent.click(suggest);
  await waitFor(() => assert.ok(suggestions().length > 0));
}

function keepAllButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Keep all" });
}

function previewBar(): HTMLElement {
  return screen.getByRole("group", { name: "Benchmark suggestions" });
}

test("an empty Pad puts focus on Add once loading finishes", async () => {
  editorServer();
  mountEditor();
  await waitFor(() => assert.ok(document.activeElement === addButton(), "Add has focus"));
  // The empty Pad offers both quick starts and the tray says what will appear.
  assert.ok(screen.getByRole("button", { name: "Add pinned & recent" }));
  assert.ok(screen.getByRole("button", { name: "Start from benchmarks" }));
  assert.ok(screen.getByText("Models you add appear here."));
});

test("Add lists the available models and counts them in the singular and plural", async () => {
  editorServer();
  mountEditor();
  fireEvent.click(addButton());
  assert.ok(await screen.findByPlaceholderText("Search 10 models"));
  const options = await screen.findAllByRole("option", { name: /^Add .+ from Test to Pad$/u });
  assert.equal(options.length, MODELS.length);
  cleanup();

  editorServer({ models: ["m0"] });
  mountEditor();
  fireEvent.click(addButton());
  assert.ok(await screen.findByPlaceholderText("Search 1 model"));
});

test("a Pad with models leaves focus where it was", async () => {
  editorServer({
    placements: { "test::m1": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" } },
  });
  mountEditor();

  await waitFor(() => assert.equal(markerCount(), 1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(document.activeElement !== addButton(), "Add did not take focus");
});

test("Add takes focus only on the first visit, not when the Pad empties again", async () => {
  const server = editorServer({ pinnedModels: ["test::m3"] });
  mountEditor();
  await waitFor(() => assert.ok(document.activeElement === addButton()));

  const add = screen.getByRole("button", { name: "Add pinned & recent" });
  await waitFor(() => assert.notEqual(add.getAttribute("aria-disabled"), "true"));
  fireEvent.click(add);
  await screen.findByText("Added 1 model");
  await waitFor(assertFocusOnMarker);
  act(() => (document.activeElement as HTMLElement | null)?.blur());
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), {}));
  await waitFor(() => assert.equal(markerCount(), 0));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(document.activeElement !== addButton(), "Add was not refocused");
});

test("Add pinned & recent places pinned then recent models on the empty Pad, with Undo", async () => {
  const server = editorServer({
    pinnedModels: ["test::m2", "test::gone"],
    recentModels: ["test::m5", "test::m2"],
  });
  mountEditor();

  const add = await screen.findByRole("button", { name: "Add pinned & recent" });
  await waitFor(() => assert.notEqual(add.getAttribute("aria-disabled"), "true"));
  fireEvent.click(add);

  await screen.findByText("Added 2 models");
  const stored = server.stored();
  assert.deepEqual(Object.keys(stored).sort(), ["test::m2", "test::m5"]);
  for (const placement of Object.values(stored)) {
    assert.equal(placement.xSource, "user");
    assert.equal(placement.ySource, "user");
  }
  const [first, second] = Object.values(stored);
  assert.ok(first.x !== second.x || first.y !== second.y, "models take different cells");
  await waitFor(() => assert.equal(markerCount(), 2));
  // The quick start's overlay is gone; focus moves to a placed model to arrange.
  await waitFor(assertFocusOnMarker);

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), {}));
  await waitFor(() => assert.equal(markerCount(), 0));
});

test("one pinned model reads as a single model in the toast", async () => {
  editorServer({ pinnedModels: ["test::m4"] });
  mountEditor();
  const add = await screen.findByRole("button", { name: "Add pinned & recent" });
  await waitFor(() => assert.notEqual(add.getAttribute("aria-disabled"), "true"));
  fireEvent.click(add);
  await screen.findByText("Added 1 model");
});

test("without pinned or recent models the quick start explains why it is unavailable", async () => {
  const server = editorServer();
  mountEditor();
  const add = await screen.findByRole("button", { name: "Add pinned & recent" });
  await modelsLoaded();

  assert.equal(add.getAttribute("aria-disabled"), "true");
  const reason = document.getElementById(add.getAttribute("aria-describedby") ?? "");
  assert.match(reason?.textContent ?? "", /Pin or choose a few models first/u);
  fireEvent.click(add);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.writes(), 0);
});

test("Start from benchmarks needs benchmark scores connected first", async () => {
  editorServer({ pinnedModels: ["test::m1"] });
  mountEditor();
  const start = await screen.findByRole("button", { name: "Start from benchmarks" });
  await waitFor(() =>
    assert.notEqual(
      screen.getByRole("button", { name: "Add pinned & recent" }).getAttribute("aria-disabled"),
      "true",
    ),
  );
  assert.equal(start.getAttribute("aria-disabled"), "true");
  const reason = document.getElementById(start.getAttribute("aria-describedby") ?? "");
  assert.match(reason?.textContent ?? "", /Connect benchmark scores in Data below first/u);
});

test("Start from benchmarks places the eight most capable models as benchmark suggestions", async () => {
  const server = editorServer({ insightsReady: true });
  mountEditor();
  const start = await screen.findByRole("button", { name: "Start from benchmarks" });
  await waitFor(() => assert.notEqual(start.getAttribute("aria-disabled"), "true"));
  fireEvent.click(start);

  await screen.findByText("Added 8 suggestions");
  const stored = server.stored();
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"].map((model) => `test::${model}`),
  );
  for (const placement of Object.values(stored)) {
    assert.equal(placement.xSource, "neutral");
    assert.equal(placement.ySource, "benchmark");
  }
  // Height follows capability.
  assert.ok(stored["test::m9"].y > stored["test::m2"].y);
  await waitFor(() => assert.equal(markerCount(), 8));
  await waitFor(assertFocusOnMarker);

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), {}));
});

test("Start from benchmarks explains when no visible model has a score for the metric", async () => {
  editorServer({ insightsReady: true, scored: false, pinnedModels: ["test::m1"] });
  mountEditor();
  const add = await screen.findByRole("button", { name: "Add pinned & recent" });
  await waitFor(() => assert.notEqual(add.getAttribute("aria-disabled"), "true"));
  assert.match(
    disabledReason(screen.getByRole("button", { name: "Start from benchmarks" })),
    /None of your visible models has a score for this benchmark yet/u,
  );
});

test("while models are loading, both quick starts say so", async () => {
  editorServer({ providersPending: true, insightsReady: true, pinnedModels: ["test::m1"] });
  mountEditor();
  for (const name of ["Add pinned & recent", "Start from benchmarks"]) {
    const button = await screen.findByRole("button", { name });
    assert.match(disabledReason(button), /Loading your models…/u);
  }
});

const userPlacement = { x: 0.5, y: 0.5, xSource: "user", ySource: "user" } as const;

test("Suggest models shows pinned and recent models first, then the most capable, without saving", async () => {
  const server = editorServer({
    insightsReady: true,
    placements: { "test::m0": userPlacement },
    pinnedModels: ["test::m2"],
    recentModels: ["test::m1"],
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();

  assert.deepEqual(suggestionNames(), ["M2", "M1", "M9", "M8", "M7", "M6", "M5", "M4"]);
  assert.equal(server.writes(), 0);
  assert.equal(markerCount(), 1);
  // The bar under the Pad counts the suggestions and offers both choices.
  assert.match(previewBar().textContent ?? "", /^8 suggestions/u);
  assert.ok(within(previewBar()).getByRole("button", { name: "Keep all" }));
  assert.ok(within(previewBar()).getByRole("button", { name: "Dismiss" }));
  // Suggest models moved focus to the first ghost, and its tag says how to keep it.
  await waitFor(() => assert.ok(document.activeElement === suggestions()[0], "focus is on the first suggestion"));
  assert.match(suggestions()[0].textContent ?? "", /Click to keep · Coding \d+/u);
});

test("keeping one suggestion saves only that model where it was previewed, with Undo", async () => {
  const server = editorServer({
    insightsReady: true,
    placements: { "test::m0": userPlacement },
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  const before = new Map(
    suggestions().map((ghost) => [ghost.getAttribute("aria-label"), position(ghost)]),
  );

  fireEvent.click(screen.getByRole("button", { name: "Keep suggestion: M5 from Test" }));

  await screen.findByText("Added M5 from Test");
  const stored = server.stored();
  assert.deepEqual(Object.keys(stored).sort(), ["test::m0", "test::m5"]);
  assert.equal(stored["test::m5"].xSource, "neutral");
  assert.equal(stored["test::m5"].ySource, "benchmark");
  await waitFor(() => assert.equal(markerCount(), 2));
  assert.equal(position(marker("M5")), before.get("Keep suggestion: M5 from Test"));
  // The other suggestions stay where they were.
  assert.equal(suggestions().length, 7);
  for (const ghost of suggestions()) {
    assert.equal(position(ghost), before.get(ghost.getAttribute("aria-label")));
  }

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(Object.keys(server.stored()), ["test::m0"]));
});

test("Keep all places every suggestion where it was previewed", async () => {
  const server = editorServer({
    insightsReady: true,
    placements: { "test::m0": userPlacement },
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  const previewed = new Map(
    suggestions().map((ghost) => [
      (ghost.getAttribute("aria-label") ?? "").replace(/^Keep suggestion: (\S+) from Test$/u, "$1"),
      position(ghost),
    ]),
  );
  previewed.set("M0", position(marker("M0")));

  fireEvent.click(keepAllButton()!);

  await screen.findByText("Added 8 suggestions");
  assert.equal(Object.keys(server.stored()).length, 9);
  await waitFor(() => assert.equal(markerCount(), 9));
  assert.equal(suggestions().length, 0);
  for (const [model, spot] of previewed) assert.equal(position(marker(model)), spot, model);
  assert.ok(!keepAllButton());
});

test("Dismiss clears the suggestions without saving", async () => {
  const server = editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

  assert.equal(suggestions().length, 0);
  assert.ok(!keepAllButton());
  assert.equal(server.writes(), 0);
});

test("changing the metric in Arrange saves it and previews again for the new score", async () => {
  const server = editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  assert.deepEqual(suggestionNames().slice(0, 2), ["M9", "M8"]);

  fireEvent.keyDown(screen.getByRole("button", { name: "Arrange" }), { key: "Enter" });
  const coding = await screen.findByRole("menuitemradio", { name: "Coding" });
  assert.equal(coding.getAttribute("aria-checked"), "true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "General" }));

  await waitFor(() => assert.equal(server.settings().modelPadMetric, "intelligence"));
  // The score switch works like a segmented control: the menu stays open on the new choice.
  const general = screen.getByRole("menuitemradio", { name: "General" });
  assert.equal(general.getAttribute("aria-checked"), "true");
  fireEvent.keyDown(general, { key: "Escape" });
  // m0 is placed, so the most capable unplaced General models are m1 onwards.
  await waitFor(() =>
    assert.deepEqual(suggestionNames(), ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]),
  );
  assert.deepEqual(Object.keys(server.stored()), ["test::m0"]);
});

test("Suggest models explains why it is unavailable", async () => {
  editorServer({ placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  const suggest = await arrangeItem("Suggest models");
  await waitFor(() => assert.match(itemReason(suggest), /Connect benchmark scores in Data below first/u));
  assert.equal(suggest.getAttribute("aria-disabled"), "true");
  fireEvent.click(suggest);
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(suggestions().length, 0);
  fireEvent.keyDown(suggest, { key: "Escape" });
  cleanup();

  editorServer({ insightsReady: true, scored: false, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  const none = await arrangeItem("Suggest models");
  await waitFor(() => assert.match(itemReason(none), /No model off the Pad has a Coding score/u));
});

test("Dismiss returns focus to Arrange", async () => {
  editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  fireEvent.click(within(previewBar()).getByRole("button", { name: "Dismiss" }));
  assert.ok(document.activeElement === screen.getByRole("button", { name: "Arrange" }), "focus is on Arrange");
});

test("Start from benchmarks uses the saved metric and the Pad's chip names it", async () => {
  const server = editorServer({ insightsReady: true, metric: "intelligence" });
  mountEditor();
  const start = await screen.findByRole("button", { name: "Start from benchmarks" });
  await waitFor(() => assert.notEqual(start.getAttribute("aria-disabled"), "true"));
  assert.ok(!screen.queryByRole("button", { name: /^Height:/u }));
  fireEvent.click(start);

  await screen.findByText("Added 8 suggestions");
  assert.deepEqual(
    Object.keys(server.stored()).sort(),
    ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((model) => `test::${model}`),
  );
  const chip = await screen.findByRole("button", { name: /^Height: General score/u });
  assert.equal(chip.textContent, "General");
  // The chip switches the score too.
  fireEvent.keyDown(chip, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Agentic" }));
  await waitFor(() => assert.equal(server.settings().modelPadMetric, "agentic"));
  await screen.findByRole("button", { name: /^Height: Agentic score/u });
});

test("the Pad names no metric while every height is the user's own", async () => {
  editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  assert.ok(!screen.queryByRole("button", { name: /^Height:/u }));
});

function percentPoint(element: HTMLElement): [number, number] {
  return [Number.parseFloat(element.style.left), Number.parseFloat(element.style.top)];
}

test("suggestions take their own dots: no grid dot under a ghost and no two markers share a spot", async () => {
  editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();

  const spots = [...suggestions(), marker("M0")].map(percentPoint);
  const keys = new Set(spots.map(([left, top]) => `${left.toFixed(2)}:${top.toFixed(2)}`));
  assert.equal(keys.size, spots.length);
  for (const dot of pad().querySelectorAll<HTMLElement>("[data-grid-cell]")) {
    const [left, top] = percentPoint(dot);
    for (const [ghostLeft, ghostTop] of spots) {
      assert.ok(
        Math.abs(left - ghostLeft) > 0.01 || Math.abs(top - ghostTop) > 0.01,
        "a grid dot is drawn under a marker",
      );
    }
  }
});

test("adding or removing a model from the list dismisses an open preview", async () => {
  editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  fireEvent.click(addButton());
  // M1 is the one unplaced model that is not previewed.
  fireEvent.click(await screen.findByRole("option", { name: "Add M1 from Test to Pad" }));
  await screen.findByText("Added M1 from Test");
  assert.equal(suggestions().length, 0);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Add models to the Pad" }), { key: "Escape" });

  await openPreview();
  fireEvent.click(addButton());
  fireEvent.click(await screen.findByRole("option", { name: "Remove M0 from Test from Pad" }));
  await screen.findByText("Removed M0 from Test");
  assert.equal(suggestions().length, 0);
});

test("the Pad keeps the preview grid while Keep all is saving", async () => {
  const server = editorServer({
    insightsReady: true,
    placements: { "test::m0": userPlacement },
    holdWrites: true,
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  const previewGrid = pad().dataset.gridSize;
  const seen: string[] = [];
  const observer = new MutationObserver(() => seen.push(pad().dataset.gridSize ?? ""));
  observer.observe(pad(), { attributes: true, attributeFilter: ["data-grid-size"] });

  fireEvent.click(keepAllButton()!);
  // The optimistic layout shows the accepted models while the write is held.
  await waitFor(() => assert.equal(markerCount(), 9));
  assert.equal(pad().dataset.gridSize, previewGrid);
  await act(async () => server.release());
  await screen.findByText("Added 8 suggestions");
  await waitFor(() => assert.equal(markerCount(), 9));
  observer.disconnect();

  assert.equal(pad().dataset.gridSize, previewGrid);
  assert.deepEqual(
    seen.filter((size) => size !== previewGrid),
    [],
  );
  assert.equal(suggestions().length, 0);
});

test("a failed keep keeps the suggestion on the Pad", async () => {
  const server = editorServer({
    insightsReady: true,
    placements: { "test::m0": userPlacement },
    failWrites: true,
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();

  const ghost = screen.getByRole("button", { name: "Keep suggestion: M5 from Test" });
  ghost.focus();
  fireEvent.click(ghost);

  await screen.findByText("Aiden couldn’t save your Model Pad.");
  await waitFor(() => assert.equal(suggestions().length, 8));
  assert.ok(screen.getByRole("button", { name: "Keep suggestion: M5 from Test" }));
  assert.deepEqual(Object.keys(server.stored()), ["test::m0"]);
});

/** Let the optimistic layout render while the write is held, then fail the write. */
async function failHeldWrite(server: ReturnType<typeof editorServer>, optimisticMarkers: number) {
  await waitFor(() => assert.equal(markerCount(), optimisticMarkers));
  await act(async () => server.release());
  await screen.findByText("Aiden couldn’t save your Model Pad.");
}

test("a failed Keep all brings every suggestion back and adds no models", async () => {
  const server = editorServer({
    insightsReady: true,
    placements: { "test::m0": userPlacement },
    holdWrites: true,
    failWrites: true,
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  await openPreview();
  const previewed = suggestionNames();

  fireEvent.click(keepAllButton()!);
  await failHeldWrite(server, 9);

  await waitFor(() => assert.deepEqual(suggestionNames(), previewed));
  assert.equal(markerCount(), 1);
  assert.match(previewBar().textContent ?? "", /^8 suggestions/u);
  assert.deepEqual(Object.keys(server.stored()), ["test::m0"]);
});

test("a failed keep of the last suggestion brings it back", async () => {
  const placements: ModelPadPlacements = Object.fromEntries(
    MODELS.slice(0, 9).map((model, index) => [
      `test::${model}`,
      { x: (index % 3) / 2, y: Math.floor(index / 3) / 2, xSource: "user", ySource: "user" },
    ]),
  );
  const server = editorServer({ insightsReady: true, placements, holdWrites: true, failWrites: true });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 9));
  await openPreview();
  assert.deepEqual(suggestionNames(), ["M9"]);

  fireEvent.click(screen.getByRole("button", { name: "Keep suggestion: M9 from Test" }));
  await failHeldWrite(server, 10);

  await waitFor(() => assert.deepEqual(suggestionNames(), ["M9"]));
  assert.equal(markerCount(), 9);
  assert.equal(Object.keys(server.stored()).length, 9);
});

test("benchmark insights report Pad and visible coverage and why Pad models are unmatched", async () => {
  editorServer({
    insightsReady: true,
    scoredModels: ["m0", "m1", "m2"],
    localModels: ["llama"],
    skippedAmbiguousCount: 3,
    placements: {
      "test::m0": userPlacement,
      "test::m5": { ...userPlacement, x: 0 },
      "ollama::llama": { ...userPlacement, x: 1 },
    },
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 3));
  const panel = await screen.findByRole("group", { name: "Benchmark coverage" });
  await within(panel).findByText("1 of 3 Pad models matched");
  within(panel).getByText("3 of 11 visible models");
  within(panel).getByText("3 ambiguous benchmark rows skipped");
  const details = within(panel).getByText("Unmatched Pad models (2)").closest("details");
  assert.ok(details);
  assert.equal(details.open, false, "the unmatched list starts collapsed");
  assert.deepEqual(
    within(details)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
    ["M5 · TestNo benchmark row", "Llama · OllamaLocal model"],
  );
});

test("a single skipped benchmark row is counted in the singular", async () => {
  editorServer({
    insightsReady: true,
    skippedAmbiguousCount: 1,
    placements: { "test::m0": userPlacement },
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  const panel = await screen.findByRole("group", { name: "Benchmark coverage" });
  await within(panel).findByText("1 ambiguous benchmark row skipped");
});

test("benchmark coverage omits the unmatched list and skipped rows when there are none", async () => {
  editorServer({ insightsReady: true, placements: { "test::m0": userPlacement } });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  const panel = await screen.findByRole("group", { name: "Benchmark coverage" });
  await within(panel).findByText("1 of 1 Pad model matched");
  assert.ok(!within(panel).queryByText(/Unmatched Pad models/u));
  assert.ok(!within(panel).queryByText(/ambiguous benchmark rows skipped/u));
  assert.ok(!within(panel).queryByText(/ha(?:s|ve) no .+ score/u));
});

test("benchmark coverage stays hidden until insights are ready", async () => {
  editorServer({ scored: true });
  mountEditor();
  await modelsLoaded();
  assert.ok(!screen.queryByText(/Pad models? matched/u));
});

test("benchmark coverage waits for the model list instead of counting nothing", async () => {
  editorServer({ insightsReady: true, providersPending: true });
  mountEditor();
  await screen.findByText("Benchmark insights ready");
  assert.ok(!screen.queryByRole("group", { name: "Benchmark coverage" }));
  assert.ok(!screen.queryByText(/visible models?$/u));
});

test("benchmark coverage stays hidden when model details can't be read", async () => {
  editorServer({ insightsReady: true, infoFails: true });
  mountEditor();
  await modelsLoaded();
  await screen.findByText("Benchmark insights ready");
  assert.ok(!screen.queryByRole("group", { name: "Benchmark coverage" }));
  assert.ok(!screen.queryByText(/visible models?$/u));
});

test("benchmark coverage on an empty Pad says there is nothing to match yet", async () => {
  editorServer({ insightsReady: true });
  mountEditor();
  await modelsLoaded();
  const panel = await screen.findByRole("group", { name: "Benchmark coverage" });
  await within(panel).findByText("No models on the Pad yet");
  within(panel).getByText("10 of 10 visible models");
  assert.ok(!within(panel).queryByText(/Pad models? matched/u));
});

test("benchmark coverage counts matched visible models without a score for the chosen metric", async () => {
  editorServer({
    insightsReady: true,
    metric: "agentic",
    scoredModels: ["m0", "m1", "m2"],
    placements: { "test::m0": userPlacement },
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));
  const panel = await screen.findByRole("group", { name: "Benchmark coverage" });
  await within(panel).findByText("1 of 1 Pad model matched");
  within(panel).getByText("3 matched visible models have no Agentic score");

  fireEvent.keyDown(screen.getByRole("button", { name: "Arrange" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Coding" }));
  await waitFor(() => assert.ok(!within(panel).queryByText(/matched models? ha(?:s|ve) no/u)));
});

test("the benchmark connection suggests fetching again once the snapshot is over 60 days old", async () => {
  editorServer({
    insightsReady: true,
    fetchedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1_000).toISOString(),
  });
  mountEditor();
  await screen.findByText("Benchmarks are over 60 days old. Fetch latest to update.");
});

test("a recent benchmark snapshot shows no staleness hint", async () => {
  editorServer({ insightsReady: true, fetchedAt: new Date(Date.now() - 3_600_000).toISOString() });
  mountEditor();
  await screen.findByText(/Fetched /u);
  assert.ok(!screen.queryByText(/over 60 days old/u));
});
