import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { AppSettings, Provider } from "../../lib/types";
import type { ModelPaceSummary } from "../../shared/model-pace";
import type { ModelPadPlacements } from "../../shared/model-pad-preferences";
import { Toaster, toast } from "../ui";
import { ModelPadSettings } from "./model-pad-settings";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

const provider: Provider = {
  id: "test",
  label: "Test",
  kind: "openai",
  baseUrl: "https://example.test/v1",
  models: ["fast", "slow", "fresh", "plain"],
  needsKey: false,
  hasKey: true,
};

// Four placed models keep the 7 × 7 base grid.
const initialPlacements: ModelPadPlacements = {
  "test::fast": { x: 0.5, y: 1, xSource: "user", ySource: "user" },
  "test::slow": { x: 0.5, y: 0, xSource: "user", ySource: "benchmark" },
  "test::fresh": { x: 0, y: 0.5, xSource: "user", ySource: "user" },
  "test::plain": { x: 1, y: 0.5, xSource: "user", ySource: "user" },
};

function pace(medianTtftMs: number, medianTokensPerSecond: number, sampleCount: number): ModelPaceSummary {
  return { medianTtftMs, medianTokensPerSecond, sampleCount, lastSampledAt: 1 };
}

const measured: Record<string, ModelPaceSummary> = {
  "test::fast": pace(300, 120, 5),
  "test::slow": pace(2_500, 20, 4),
  // Measured, but not often enough to set pace yet.
  "test::fresh": pace(240, 90, 2),
};

function editorServer(summaries: Record<string, ModelPaceSummary>) {
  let current = { modelPadPlacements: initialPlacements, pinnedModels: [] } as AppSettings;
  let paceSummaries = summaries;
  const calls = installBotTestIpc({
    "providers:list": () => [provider],
    "models:info": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "modelPace:summaries": () => structuredClone(paceSummaries),
    "modelPace:clear": () => {
      paceSummaries = {};
    },
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
  });
  return {
    writes: () => calls.filter((call) => call.channel === "settings:set").length,
    clears: () => calls.filter((call) => call.channel === "modelPace:clear").length,
    stored: () => current.modelPadPlacements,
  };
}

async function mountEditor() {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  return waitFor(() => {
    const pad = screen.getByRole("group", { name: "Personal Model Pad arrangement" });
    assert.equal(pad.querySelectorAll("[data-placement-source]").length, 4);
    return pad;
  });
}

function marker(pad: HTMLElement, value: string): HTMLElement {
  const element = pad.querySelector<HTMLElement>(`[data-value="${value}"]`);
  assert.ok(element, `${value} has a marker`);
  return element;
}

test("markers show measured speed once a model has a sample, in the label and its accessible name", async () => {
  editorServer(measured);
  const pad = await mountEditor();
  const label = (value: string) =>
    marker(pad, value).querySelector(".model-pad-marker-label")?.textContent ?? "";

  await waitFor(() => assert.match(label("test::fast"), /0\.3 s first token · 120 tok\/s/u));
  assert.match(label("test::slow"), /2\.5 s first token · 20 tok\/s/u);
  // One sample is enough to show; three are needed to set pace.
  assert.match(label("test::fresh"), /0\.2 s first token · 90 tok\/s/u);
  assert.doesNotMatch(label("test::plain"), /tok\/s/u);
  assert.match(
    marker(pad, "test::fast").getAttribute("aria-label") ?? "",
    /, 0\.3 s first token · 120 tok\/s[,.]/u,
  );
  assert.doesNotMatch(marker(pad, "test::plain").getAttribute("aria-label") ?? "", /tok\/s/u);
});

test("Set pace from measured speed saves measured X for well-sampled models and can be undone", async () => {
  const server = editorServer(measured);
  const pad = await mountEditor();
  const action = await screen.findByRole("button", { name: "Set pace from measured speed" });
  await waitFor(() => assert.equal(action.getAttribute("aria-disabled"), "false"));

  fireEvent.click(action);

  await waitFor(() => assert.equal(server.writes(), 1));
  assert.deepEqual(server.stored(), {
    "test::fast": { x: 0, y: 1, xSource: "measured", ySource: "user" },
    "test::slow": { x: 1, y: 0, xSource: "measured", ySource: "benchmark" },
    "test::fresh": initialPlacements["test::fresh"],
    "test::plain": initialPlacements["test::plain"],
  });
  await screen.findByText("Set pace for 2 models · 2 need more chats");
  // Measured pace is data-assisted, like a benchmark height.
  await waitFor(() =>
    assert.equal(marker(pad, "test::fast").dataset.placementSource, "benchmark"),
  );

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), initialPlacements));
});

test("moving a measured model sideways makes its pace yours; moving it up keeps it measured", async () => {
  const server = editorServer(measured);
  const pad = await mountEditor();
  const action = await screen.findByRole("button", { name: "Set pace from measured speed" });
  await waitFor(() => assert.equal(action.getAttribute("aria-disabled"), "false"));
  fireEvent.click(action);
  await waitFor(() => assert.equal(server.stored()?.["test::slow"]?.xSource, "measured"));

  act(() => marker(pad, "test::slow").focus());
  fireEvent.keyDown(marker(pad, "test::slow"), { key: "ArrowUp" });
  fireEvent.blur(marker(pad, "test::slow"));
  await waitFor(() => assert.equal(server.writes(), 2));
  assert.equal(server.stored()?.["test::slow"]?.xSource, "measured");
  assert.equal(server.stored()?.["test::slow"]?.ySource, "user");

  act(() => marker(pad, "test::slow").focus());
  fireEvent.keyDown(marker(pad, "test::slow"), { key: "ArrowLeft" });
  fireEvent.blur(marker(pad, "test::slow"));
  await waitFor(() => assert.equal(server.writes(), 3));
  assert.equal(server.stored()?.["test::slow"]?.xSource, "user");
});

test("without three samples for any placed model the action explains itself and saves nothing", async () => {
  const server = editorServer({ "test::fresh": measured["test::fresh"] });
  await mountEditor();
  const action = await screen.findByRole("button", {
    name: "Set pace from measured speed",
    description: /Use a few models in chat first to measure their speed/u,
  });
  await waitFor(() => assert.equal(action.getAttribute("aria-disabled"), "true"));

  fireEvent.click(action);
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(server.writes(), 0);
});

test("Clear measured speeds asks first, forgets the speeds, and leaves the Pad as it is", async () => {
  const server = editorServer(measured);
  const pad = await mountEditor();
  fireEvent.click(screen.getByText("Pad management"));
  fireEvent.click(await screen.findByRole("button", { name: "Clear measured speeds" }));

  const confirm = await screen.findByRole("button", { name: "Clear speeds" });
  assert.equal(server.clears(), 0);
  fireEvent.click(confirm);

  await waitFor(() => assert.equal(server.clears(), 1));
  await waitFor(() =>
    assert.ok(!screen.queryByRole("button", { name: "Clear measured speeds" })),
  );
  await waitFor(() =>
    assert.doesNotMatch(
      marker(pad, "test::fast").querySelector(".model-pad-marker-label")?.textContent ?? "",
      /tok\/s/u,
    ),
  );
  assert.equal(server.writes(), 0);
  assert.deepEqual(server.stored(), initialPlacements);
});

test("Clear measured speeds is not offered before any speed is measured", async () => {
  editorServer({});
  await mountEditor();
  fireEvent.click(screen.getByText("Pad management"));
  await screen.findByRole("button", { name: "Remove all models from Pad" });
  assert.ok(!screen.queryByRole("button", { name: "Clear measured speeds" }));
});
