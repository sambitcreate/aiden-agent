import "../../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../../main/bots/test-providers";
import type { AppSettings, Provider } from "../../../lib/types";
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
  models: ["mine", "other", "extra"],
  needsKey: false,
  hasKey: true,
};

const initialPlacements: ModelPadPlacements = {
  "test::mine": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
  "test::other": { x: 0, y: 1, xSource: "user", ySource: "user" },
};

function settingsServer(options: { failWrites?: boolean } = {}) {
  let current = { modelPadPlacements: initialPlacements, pinnedModels: [] } as AppSettings;
  const calls = installBotTestIpc({
    "providers:list": () => [provider],
    "models:info": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      if (options.failWrites) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
  });
  return {
    writes: () =>
      calls
        .filter((call) => call.channel === "settings:set")
        .map((call) => (call.args[0] as AppSettings).modelPadPlacements),
    stored: () => current.modelPadPlacements,
  };
}

let unmountEditor = () => {};

async function mountEditor() {
  ({ unmount: unmountEditor } = render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
      <Toaster />
    </QueryClientProvider>,
  ));
  return waitFor(() => {
    const pad = screen.getByRole("group", { name: "Personal Model Pad arrangement" });
    assert.equal(pad.querySelectorAll("[data-placement-source]").length, 2);
    return pad;
  });
}

function marker(pad: HTMLElement, label: string): HTMLElement | null {
  return [...pad.querySelectorAll<HTMLElement>("[data-placement-source]")].find((element) =>
    element.getAttribute("aria-label")?.startsWith(`${label} from`),
  ) ?? null;
}

async function addExtra() {
  fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add Extra from Test to Pad" }));
}

test("there is no Save or Reset step: adding a model saves it immediately", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  assert.ok(!screen.queryByRole("button", { name: /Save Pad|Reset changes/u }));

  await addExtra();

  await waitFor(() => assert.equal(server.writes().length, 1));
  assert.deepEqual(Object.keys(server.stored() ?? {}).sort(), [
    "test::extra",
    "test::mine",
    "test::other",
  ]);
  assert.ok(marker(pad, "Extra"));
  await screen.findByText("Added Extra from Test");
});

test("Undo on the toast restores the layout from just before the action", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  await addExtra();
  await screen.findByText("Added Extra from Test");

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));

  await waitFor(() => assert.equal(server.writes().length, 2));
  assert.deepEqual(server.stored(), initialPlacements);
  await waitFor(() => assert.ok(!marker(pad, "Extra")));
});

test("a burst of arrow-key nudges is one save and one undo step", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  const mine = marker(pad, "Mine")!;
  const start = mine.style.left;
  act(() => mine.focus());

  for (let press = 0; press < 3; press += 1) {
    fireEvent.keyDown(mine, { key: "ArrowRight" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  }
  // The marker follows every press while the burst is still open.
  assert.notEqual(marker(pad, "Mine")!.style.left, start);
  assert.equal(server.writes().length, 0);

  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
  await waitFor(() => assert.equal(server.writes().length, 1));
  const moved = server.stored()?.["test::mine"];
  assert.ok(moved && moved.x > initialPlacements["test::mine"].x);
  assert.equal(screen.getAllByText("Moved Mine from Test").length, 1);

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.equal(server.writes().length, 2));
  assert.deepEqual(server.stored(), initialPlacements);
  await waitFor(() => assert.equal(marker(pad, "Mine")!.style.left, start));
});

test("a nudge burst still saves when focus leaves the marker", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  const mine = marker(pad, "Mine")!;
  act(() => mine.focus());
  fireEvent.keyDown(mine, { key: "ArrowUp" });
  fireEvent.blur(mine);

  await waitFor(() => assert.equal(server.writes().length, 1));
  const moved = server.stored()?.["test::mine"];
  assert.ok(moved && moved.y > initialPlacements["test::mine"].y);
});

test("removing every model needs no confirmation and can be undone", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  fireEvent.click(screen.getByText("Pad management"));
  fireEvent.click(screen.getByRole("button", { name: "Remove all models from Pad" }));

  await waitFor(() => assert.deepEqual(server.stored(), {}));
  await screen.findByText("Cleared the Pad");
  assert.equal(pad.querySelectorAll("[data-placement-source]").length, 0);
  // The Pad management section closes with the last model; focus lands on a stable control.
  assert.ok(
    document.activeElement === screen.getByRole("button", { name: "Browse models" }),
    "focus moved to Browse models",
  );

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(server.stored(), initialPlacements));
  await waitFor(() => assert.equal(pad.querySelectorAll("[data-placement-source]").length, 2));
});

test("a failed save reports the error and returns to the last saved layout", async () => {
  const server = settingsServer({ failWrites: true });
  const pad = await mountEditor();
  await addExtra();

  await screen.findByText("Aiden couldn’t save your Model Pad.");
  assert.ok(!screen.queryByText("Added Extra from Test"));
  await waitFor(() => assert.ok(!marker(pad, "Extra")));
  assert.equal(pad.querySelectorAll("[data-placement-source]").length, 2);
  assert.deepEqual(server.stored(), initialPlacements);
});

test("only the latest action can be undone, and Undo reverts just that action", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  await addExtra();
  await screen.findByText("Added Extra from Test");
  fireEvent.click(screen.getByRole("button", { name: "Remove Mine from Test from Pad" }));
  await screen.findByText("Removed Mine from Test");

  const undo = screen.getAllByRole("button", { name: "Undo" });
  assert.equal(undo.length, 1);
  fireEvent.click(undo[0]);

  await waitFor(() => assert.equal(server.writes().length, 3));
  assert.deepEqual(Object.keys(server.stored() ?? {}).sort(), [
    "test::extra",
    "test::mine",
    "test::other",
  ]);
  await waitFor(() => assert.ok(marker(pad, "Mine")));
  assert.ok(marker(pad, "Extra"));
});

test("leaving the editor mid-burst still saves the moved position", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  const mine = marker(pad, "Mine")!;
  act(() => mine.focus());
  fireEvent.keyDown(mine, { key: "ArrowLeft" });
  assert.equal(server.writes().length, 0);

  unmountEditor();

  await waitFor(() => assert.equal(server.writes().length, 1));
  const moved = server.stored()?.["test::mine"];
  assert.ok(moved && moved.x < initialPlacements["test::mine"].x);
});

test("dragging a marker saves once, on release", async () => {
  const server = settingsServer();
  const pad = await mountEditor();
  pad.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
  const mine = marker(pad, "Mine")!;
  const pointer = { button: 0, pointerId: 1 };

  fireEvent.pointerDown(mine, { ...pointer, clientX: 50, clientY: 50 });
  fireEvent.pointerMove(mine, { ...pointer, clientX: 80, clientY: 50 });
  fireEvent.pointerMove(mine, { ...pointer, clientX: 90, clientY: 80 });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(server.writes().length, 0);

  fireEvent.pointerUp(mine, { ...pointer, clientX: 90, clientY: 80 });

  await waitFor(() => assert.equal(server.writes().length, 1));
  const moved = server.stored()?.["test::mine"];
  assert.ok(moved && moved.x > 0.5 && moved.y < 0.5, JSON.stringify(moved));
  assert.equal(moved.xSource, "user");
  await screen.findByText("Moved Mine from Test");
});
