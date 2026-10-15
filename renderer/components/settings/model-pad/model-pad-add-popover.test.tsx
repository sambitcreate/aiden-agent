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

const zephyr: Provider = {
  id: "zephyr",
  label: "Zephyr",
  kind: "openai",
  baseUrl: "https://zephyr.test/v1",
  models: ["swift", "atlas"],
  needsKey: false,
  hasKey: true,
};

const acme: Provider = {
  ...zephyr,
  id: "acme",
  label: "Acme",
  baseUrl: "https://acme.test/v1",
  models: ["nova", "bolt", "comet", "drift", "ember", "flare", "glint"],
};

function editorServer(settings: Partial<AppSettings>) {
  let current = {
    modelPadPlacements: {},
    pinnedModels: [],
    recentModels: [],
    ...settings,
  } as AppSettings;
  installBotTestIpc({
    "providers:list": () => [zephyr, acme],
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

async function openAdd(): Promise<HTMLElement> {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole("dialog", { name: "Add models to the Pad" });
  await within(dialog).findByPlaceholderText("Search 9 models");
  return dialog;
}

/** Group headings and option names, in order, as the list shows them. */
function listing(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll<HTMLElement>("[cmdk-group-heading], [role=option]")].map(
    (element) => element.getAttribute("aria-label") ?? element.textContent ?? "",
  );
}

const placedSwift: ModelPadPlacements = {
  "zephyr::swift": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
};

test("Add lists pinned and recent models off the Pad first, then every model by provider and name", async () => {
  editorServer({
    modelPadPlacements: placedSwift,
    // Swift is already on the Pad, so Recent skips it; Comet is pinned, Atlas recent.
    pinnedModels: ["acme::comet", "zephyr::swift"],
    recentModels: ["zephyr::atlas", "acme::comet"],
  });
  const dialog = await openAdd();

  assert.deepEqual(listing(dialog), [
    "Recent",
    "Add Comet from Acme to Pad",
    "Add Atlas from Zephyr to Pad",
    "All models",
    "Add Bolt from Acme to Pad",
    "Add Comet from Acme to Pad",
    "Add Drift from Acme to Pad",
    "Add Ember from Acme to Pad",
    "Add Flare from Acme to Pad",
    "Add Glint from Acme to Pad",
    "Add Nova from Acme to Pad",
    "Add Atlas from Zephyr to Pad",
    "Remove Swift from Zephyr from Pad",
  ]);
});

test("Recent lists at most five models", async () => {
  editorServer({
    recentModels: ["acme::nova", "acme::bolt", "acme::comet", "acme::drift", "acme::ember", "acme::flare"],
  });
  const dialog = await openAdd();
  const all = listing(dialog).indexOf("All models");
  assert.equal(listing(dialog)[0], "Recent");
  assert.equal(all - 1, 5);
});

test("searching narrows the list to matching names or providers and drops the sections", async () => {
  editorServer({ recentModels: ["acme::nova"] });
  const dialog = await openAdd();
  const search = within(dialog).getByRole("combobox", { name: "Search models" });

  fireEvent.change(search, { target: { value: "zeph" } });
  await waitFor(() =>
    assert.deepEqual(listing(dialog), ["Add Atlas from Zephyr to Pad", "Add Swift from Zephyr to Pad"]),
  );

  fireEvent.change(search, { target: { value: "no such model" } });
  await within(dialog).findByText("No models match.");
});

test("each row toggles its model on and off the Pad and the list stays open", async () => {
  const server = editorServer({});
  const dialog = await openAdd();

  fireEvent.click(within(dialog).getByRole("option", { name: "Add Nova from Acme to Pad" }));
  await waitFor(() => assert.deepEqual(Object.keys(server.stored()), ["acme::nova"]));
  await screen.findByText("Added Nova from Acme");
  // Still open, and the row now shows the model is on the Pad.
  const row = await within(dialog).findByRole("option", { name: "Remove Nova from Acme from Pad" });
  assert.equal(row.dataset.onPad, "true");

  fireEvent.click(row);
  await waitFor(() => assert.deepEqual(server.stored(), {}));
  await screen.findByText("Removed Nova from Acme");
  assert.ok(within(dialog).getByRole("option", { name: "Add Nova from Acme to Pad" }));
});

test("Escape closes the list and returns focus to Add", async () => {
  editorServer({});
  const dialog = await openAdd();
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "Search models" }), {
    key: "Escape",
  });
  await waitFor(() => assert.ok(!screen.queryByRole("dialog", { name: "Add models to the Pad" })));
  await waitFor(() =>
    assert.ok(document.activeElement === screen.getByRole("button", { name: "Add" }), "focus on Add"),
  );
});

test("the list explains that hidden models stay out", async () => {
  editorServer({});
  const dialog = await openAdd();
  assert.ok(within(dialog).getByText("Hidden models stay out"));
  fireEvent.click(within(dialog).getByRole("button", { name: "About hidden models" }));
  const hint = await screen.findByRole("tooltip");
  assert.match(hint.textContent ?? "", /Only models visible in Settings → Providers/u);
});

test("arrow keys move through the list and Enter toggles the highlighted model", async () => {
  const server = editorServer({});
  const dialog = await openAdd();
  const search = within(dialog).getByRole("combobox", { name: "Search models" });
  // The list starts on Bolt, the first Acme model by name.
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.deepEqual(Object.keys(server.stored()), ["acme::comet"]));
});

test("Enter twice on a Recent row adds that model and then removes the same model", async () => {
  const server = editorServer({ recentModels: ["acme::nova", "zephyr::atlas"] });
  const dialog = await openAdd();
  const search = within(dialog).getByRole("combobox", { name: "Search models" });
  await waitFor(() => assert.equal(listing(dialog)[0], "Recent"));

  // The list starts on the first Recent row, Nova.
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.deepEqual(Object.keys(server.stored()), ["acme::nova"]));
  await screen.findByText("Added Nova from Acme");
  // Nova stays in Recent, checked, until the list closes.
  await waitFor(() =>
    assert.deepEqual(listing(dialog).slice(0, 3), [
      "Recent",
      "Remove Nova from Acme from Pad",
      "Add Atlas from Zephyr to Pad",
    ]),
  );

  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.deepEqual(server.stored(), {}));
  await screen.findByText("Removed Nova from Acme");
});

test("a search can name the model and its provider together", async () => {
  editorServer({});
  const dialog = await openAdd();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Search models" }), {
    target: { value: "nova acme" },
  });
  await waitFor(() => assert.deepEqual(listing(dialog), ["Add Nova from Acme to Pad"]));
});

test("Recent doesn't appear mid-session when a pinned model leaves the Pad", async () => {
  editorServer({
    modelPadPlacements: { "acme::nova": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" } },
    pinnedModels: ["acme::nova"],
  });
  const dialog = await openAdd();
  // Every pinned model is on the Pad, so there is no Recent section.
  await within(dialog).findByRole("option", { name: "Remove Nova from Acme from Pad" });
  assert.equal(listing(dialog)[0], "All models");

  fireEvent.click(within(dialog).getByRole("option", { name: "Remove Nova from Acme from Pad" }));
  await screen.findByText("Removed Nova from Acme");
  await within(dialog).findByRole("option", { name: "Add Nova from Acme to Pad" });
  assert.equal(listing(dialog)[0], "All models");
});
