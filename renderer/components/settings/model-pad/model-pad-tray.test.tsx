import "../../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  models: ["low", "high", "middle", "left"],
  needsKey: false,
  hasKey: true,
};

const placements: ModelPadPlacements = {
  "test::low": { x: 0.5, y: 0, xSource: "user", ySource: "user" },
  "test::high": { x: 1, y: 1, xSource: "neutral", ySource: "benchmark" },
  "test::middle": { x: 1, y: 0.5, xSource: "user", ySource: "user" },
  "test::left": { x: 0, y: 0.5, xSource: "user", ySource: "user" },
};

function editorServer(initial: ModelPadPlacements = placements) {
  let current = { modelPadPlacements: initial, pinnedModels: [] } as AppSettings;
  installBotTestIpc({
    "providers:list": () => [provider],
    "models:info": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
  });
  return { stored: () => current.modelPadPlacements ?? {} };
}

async function mountEditor(count = 4) {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  const pad = await waitFor(() => {
    const group = screen.getByRole("group", { name: "Personal Model Pad arrangement" });
    assert.equal(group.querySelectorAll("[data-placement-source]").length, count);
    return group;
  });
  return { pad, tray: screen.getByRole("complementary", { name: "On your Pad" }) };
}

function rowValues(tray: HTMLElement): string[] {
  return [...tray.querySelectorAll<HTMLElement>("li[data-value]")].map(
    (row) => row.dataset.value ?? "",
  );
}

function row(tray: HTMLElement, value: string): HTMLElement {
  const element = tray.querySelector<HTMLElement>(`li[data-value="${value}"]`);
  assert.ok(element, `${value} has a row`);
  return element;
}

function marker(pad: HTMLElement, value: string): HTMLElement {
  const element = pad.querySelector<HTMLElement>(`[data-value="${value}"]`);
  assert.ok(element, `${value} has a marker`);
  return element;
}

test("the tray lists Pad models top to bottom, then left to right, with their count", async () => {
  editorServer();
  const { tray } = await mountEditor();
  assert.deepEqual(rowValues(tray), ["test::high", "test::left", "test::middle", "test::low"]);
  assert.match(tray.textContent ?? "", /^On your Pad4/u);
  // Each row names the model's source, as its marker does.
  assert.ok(
    within(tray).getByRole("button", { name: "High from Test, Benchmark-assisted. Show on the Pad" }),
  );
});

test("hovering a row lights its marker and hovering a marker lights its row", async () => {
  editorServer();
  const { pad, tray } = await mountEditor();

  fireEvent.pointerEnter(row(tray, "test::middle"));
  await waitFor(() => assert.equal(marker(pad, "test::middle").dataset.hot, "true"));
  assert.equal(row(tray, "test::middle").dataset.hot, "true");
  assert.equal(marker(pad, "test::low").dataset.hot, undefined);
  fireEvent.pointerLeave(row(tray, "test::middle"));
  await waitFor(() => assert.equal(marker(pad, "test::middle").dataset.hot, undefined));

  fireEvent.pointerEnter(marker(pad, "test::low"));
  await waitFor(() => assert.equal(row(tray, "test::low").dataset.hot, "true"));
  assert.equal(row(tray, "test::middle").dataset.hot, undefined);
  fireEvent.pointerLeave(marker(pad, "test::low"));
  await waitFor(() => assert.equal(row(tray, "test::low").dataset.hot, undefined));
});

test("choosing a row selects and focuses its marker", async () => {
  editorServer();
  const { pad, tray } = await mountEditor();
  fireEvent.click(within(row(tray, "test::left")).getByRole("button", { name: /Show on the Pad$/u }));
  await waitFor(() =>
    assert.ok(document.activeElement === marker(pad, "test::left"), "focus is on Left's marker"),
  );
  assert.equal(marker(pad, "test::left").dataset.selected, "true");
  assert.equal(row(tray, "test::left").dataset.selected, "true");
});

test("removing from the tray saves with Undo and moves focus to the next row", async () => {
  const server = editorServer();
  const { pad, tray } = await mountEditor();
  const remove = within(tray).getByRole("button", { name: "Remove Left from Test from Pad" });
  remove.focus();
  fireEvent.click(remove);

  await screen.findByText("Removed Left from Test");
  assert.deepEqual(Object.keys(server.stored()).sort(), ["test::high", "test::low", "test::middle"]);
  await waitFor(() => assert.deepEqual(rowValues(tray), ["test::high", "test::middle", "test::low"]));
  assert.ok(!pad.querySelector('[data-value="test::left"]'));
  assert.ok(
    document.activeElement === within(row(tray, "test::middle")).getAllByRole("button")[0],
    "focus moved to the next row",
  );

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.deepEqual(rowValues(tray), ["test::high", "test::left", "test::middle", "test::low"]));
});

test("removing the last tray row moves focus to Add and the tray explains itself", async () => {
  editorServer({ "test::low": placements["test::low"] });
  const { tray } = await mountEditor(1);
  fireEvent.click(within(tray).getByRole("button", { name: "Remove Low from Test from Pad" }));
  await within(tray).findByText("Models you add appear here.");
  assert.ok(
    document.activeElement === screen.getByRole("button", { name: "Add" }),
    "focus moved to Add",
  );
});
