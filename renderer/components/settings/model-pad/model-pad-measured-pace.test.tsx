import "../../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../../main/bots/test-providers";
import type { AppSettings, Provider } from "../../../lib/types";
import type { ModelPaceSummary } from "../../../shared/model-pace";
import type { ModelPadPlacements } from "../../../shared/model-pad-preferences";
import { Toaster, toast } from "../../ui";
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

/** Open Arrange and return its "Pace from my chats" item. */
async function openPaceAction(): Promise<HTMLElement> {
  fireEvent.keyDown(screen.getByRole("button", { name: "Arrange" }), { key: "Enter" });
  return screen.findByRole("menuitem", { name: "Pace from my chats" });
}

/** The text of every element that describes `item`. */
function description(item: HTMLElement): string {
  return (item.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

function unavailableReason(item: HTMLElement): string {
  assert.equal(item.getAttribute("aria-disabled"), "true");
  return document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
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

test("Pace from my chats saves measured X for well-sampled models and can be undone", async () => {
  const server = editorServer(measured);
  const pad = await mountEditor();
  const action = await openPaceAction();
  await waitFor(() => assert.notEqual(action.getAttribute("aria-disabled"), "true"));
  // Fast and Slow have three or more chats; Fresh has two.
  assert.match(action.textContent ?? "", /2 ready/u);
  // The count is part of the item's accessible description, not only its text.
  assert.match(description(action), /^2 ready$/u);

  fireEvent.click(action);

  await waitFor(() => assert.equal(server.writes(), 1));
  assert.deepEqual(server.stored(), {
    "test::fast": { x: 0, y: 1, xSource: "measured", ySource: "user" },
    "test::slow": { x: 1, y: 0, xSource: "measured", ySource: "benchmark" },
    "test::fresh": initialPlacements["test::fresh"],
    "test::plain": initialPlacements["test::plain"],
  });
  await screen.findByText("Set pace for 2 models · 2 need more chats");
  // Drawn as data-assisted, announced as measured, and still located on the grid.
  await waitFor(() =>
    assert.equal(marker(pad, "test::fast").dataset.placementSource, "benchmark"),
  );
  assert.match(
    marker(pad, "test::fast").getAttribute("aria-label") ?? "",
    /^Fast from Test, Measured pace, row 1, column 1, /u,
  );
  assert.match(
    marker(pad, "test::slow").getAttribute("aria-label") ?? "",
    /^Slow from Test, Benchmark height, measured pace, row 7, column 7, /u,
  );

  // Once the Pad shows the measured pace, setting it again has nothing to do.
  const again = await openPaceAction();
  await waitFor(() => assert.match(unavailableReason(again), /Pace is already up to date/u));
  toast.dismiss();
  fireEvent.click(again);
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(server.writes(), 1);
  fireEvent.keyDown(again, { key: "Escape" });

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), initialPlacements));
});

test("moving a measured model sideways makes its pace yours; moving it up keeps it measured", async () => {
  const server = editorServer(measured);
  const pad = await mountEditor();
  const action = await openPaceAction();
  await waitFor(() => assert.notEqual(action.getAttribute("aria-disabled"), "true"));
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
  const action = await openPaceAction();
  await waitFor(() =>
    assert.match(unavailableReason(action), /Use a few models in chat first to measure their speed/u),
  );

  fireEvent.click(action);
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(server.writes(), 0);
});

test("when measured speeds can't be read the action says so", async () => {
  const calls = installBotTestIpc({
    "providers:list": () => [provider],
    "models:info": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "modelPace:summaries": () => {
      throw new Error("unreadable");
    },
    "settings:get": () => ({ modelPadPlacements: initialPlacements, pinnedModels: [] }),
  });
  await mountEditor();
  const action = await openPaceAction();
  await waitFor(() => assert.match(unavailableReason(action), /Couldn’t read measured speeds/u));
  fireEvent.click(action);
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.ok(!calls.some((call) => call.channel === "settings:set"));
});

test("Clear measured speeds asks first, forgets the speeds, and leaves the Pad as it is", async () => {
  const server = editorServer(measured);
  const pad = await mountEditor();
  const data = screen.getByRole("group", { name: "Measured speed" });
  await within(data).findByText("3 models · from your chats on this Mac");
  fireEvent.click(await within(data).findByRole("button", { name: "Clear measured speeds" }));

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
  await screen.findByText("Nothing measured yet");
  assert.ok(!screen.queryByRole("button", { name: "Clear measured speeds" }));
});
