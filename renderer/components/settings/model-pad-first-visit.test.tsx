import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { AppSettings, ModelBenchmarkScores, ModelInfo, Provider } from "../../lib/types";
import type { ModelPadPlacements } from "../../shared/model-pad-preferences";
import { Toaster, toast } from "../ui";
import { ModelPadSettings } from "./model-pad-settings";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

// m0 is the least capable model and m9 the most capable one.
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

function benchmark(coding: number): ModelBenchmarkScores {
  return {
    source: "openrouter",
    datasetSource: "artificial-analysis",
    sourceLabel: "Artificial Analysis via OpenRouter",
    sourceUrl: "https://openrouter.ai",
    citation: "Artificial Analysis",
    asOf: "2026-10-01",
    license: "CC BY 4.0",
    coding,
  };
}

function editorServer(
  options: {
    placements?: ModelPadPlacements;
    pinnedModels?: string[];
    recentModels?: string[];
    insightsReady?: boolean;
  } = {},
) {
  let current = {
    modelPadPlacements: options.placements ?? {},
    pinnedModels: options.pinnedModels ?? [],
    recentModels: options.recentModels ?? [],
  } as AppSettings;
  const info: Record<string, ModelInfo> = options.insightsReady
    ? Object.fromEntries(
        MODELS.map((model, index): [string, ModelInfo] => [
          model,
          {
            id: model,
            metadataSource: "fallback",
            matched: false,
            benchmark: benchmark(10 + index),
          },
        ]),
      )
    : {};
  const calls = installBotTestIpc({
    "providers:list": () => [provider],
    "models:info": () => info,
    "modelInsights:status": () => ({
      hasKey: Boolean(options.insightsReady),
      ready: Boolean(options.insightsReady),
      cachedModelCount: options.insightsReady ? MODELS.length : 0,
    }),
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
  });
  return {
    writes: () => calls.filter((call) => call.channel === "settings:set").length,
    stored: () => current.modelPadPlacements ?? {},
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

function browseButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browse models" });
}

function markerCount(): number {
  return screen
    .getByRole("group", { name: "Personal Model Pad arrangement" })
    .querySelectorAll("[data-placement-source]").length;
}

test("an empty Pad opens Browse models once loading finishes", async () => {
  editorServer();
  mountEditor();

  await waitFor(() => assert.equal(browseButton().getAttribute("aria-expanded"), "true"));
  const panel = screen.getByRole("complementary", { name: "Browse models for the Pad" });
  assert.equal(panel.hidden, false);
  const rows = await screen.findAllByRole("button", { name: /^Add .+ from Test to Pad$/u });
  assert.equal(rows.length, MODELS.length);
});

test("a Pad with models opens with Browse models closed", async () => {
  editorServer({
    placements: { "test::m1": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" } },
  });
  mountEditor();

  await waitFor(() => assert.equal(markerCount(), 1));
  assert.equal(browseButton().getAttribute("aria-expanded"), "false");
});

test("Browse models is not reopened after the user closes it or the Pad empties", async () => {
  const server = editorServer({
    placements: { "test::m1": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" } },
  });
  mountEditor();
  await waitFor(() => assert.equal(markerCount(), 1));

  fireEvent.click(screen.getByText("Pad management"));
  fireEvent.click(screen.getByRole("button", { name: "Remove all models from Pad" }));
  await waitFor(() => assert.deepEqual(server.stored(), {}));
  await screen.findByText("Cleared the Pad");
  assert.equal(browseButton().getAttribute("aria-expanded"), "false");
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
  await waitFor(() => assert.equal(browseButton().getAttribute("aria-expanded"), "true"));

  assert.equal(add.getAttribute("aria-disabled"), "true");
  const reason = document.getElementById(add.getAttribute("aria-describedby") ?? "");
  assert.match(reason?.textContent ?? "", /Pin or choose a few models first/u);
  fireEvent.click(add);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.writes(), 0);
});

test("Start from benchmarks needs benchmark insights first", async () => {
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
  assert.match(reason?.textContent ?? "", /Connect benchmark insights first/u);
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

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), {}));
});
