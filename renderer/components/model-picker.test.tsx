import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { mountWithBotRouter } from "../main/bots/test-providers";
import { modelOptionId } from "../lib/model-picker-data";
import { detectedKeyboardPlatform } from "../shared/keybindings";
import type { AppSettings, Provider } from "../lib/types";
import type { ModelPaceSummary } from "../shared/model-pace";
import { ModelPicker } from "./model-picker";
import { Toaster } from "./ui";

afterEach(cleanup);

const user = { xSource: "user", ySource: "user" } as const;

const provider: Provider = {
  id: "acme",
  kind: "openai-compatible" as Provider["kind"],
  label: "Acme Cloud",
  baseUrl: "https://acme.invalid/v1",
  models: ["placed-one", "placed-two", "current-model"],
  needsKey: false,
  hasKey: true,
};

function settingsServer(
  initial: AppSettings,
  options: { failWrites?: boolean; pace?: Record<string, ModelPaceSummary> } = {},
) {
  let current = structuredClone(initial);
  let pace = options.pace ?? {};
  const calls = installBotTestIpc({
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      if (options.failWrites) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
    "models:info": () => ({}),
    "modelPace:summaries": () => structuredClone(pace),
  });
  return {
    calls,
    current: () => current,
    setPace: (next: Record<string, ModelPaceSummary>) => {
      pace = next;
    },
  };
}

const placedSettings: AppSettings = {
  modelPadPlacements: {
    "acme::placed-one": { x: 0, y: 1, ...user },
    "acme::placed-two": { x: 1, y: 0, ...user },
  },
};

async function mountPicker(
  server: ReturnType<typeof settingsServer>,
  options: {
    hidden?: string[];
    onChange?: (providerId: string, model: string) => void;
    settingsBlockedReason?: string;
    providers?: Provider[];
  } = {},
) {
  const { router } = await mountWithBotRouter(
    <>
      <ModelPicker
        providers={options.providers ?? [provider]}
        providerId="acme"
        model="current-model"
        onChange={options.onChange ?? (() => {})}
        hiddenModelsByProvider={options.hidden ? { acme: options.hidden } : undefined}
        settingsBlockedReason={options.settingsBlockedReason}
      />
      <Toaster />
    </>,
  );
  // The picker opens on the Pad once the saved placements have loaded.
  await act(async () => {
    await waitFor(() => assert.ok(server.calls.some((call) => call.channel === "settings:get")));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));
  return router;
}

async function openPicker(
  server: ReturnType<typeof settingsServer>,
  options: Parameters<typeof mountPicker>[1] = {},
) {
  await mountPicker(server, options);
  return screen.findByRole("listbox", { name: /Model pad/u });
}

test("a current model that is not on the Pad is not shown as selected and can be added", async () => {
  const server = settingsServer(placedSettings);
  const pad = await openPicker(server);

  assert.equal(pad.getAttribute("aria-activedescendant"), null);
  for (const option of within(pad).getAllByRole("option")) {
    assert.equal(option.getAttribute("aria-selected"), "false");
  }
  const panel = screen.getByRole("tabpanel");
  assert.match(panel.textContent ?? "", /Current Model\sisn’t on your Pad/u);
  // The side card describes the current model rather than the first Pad model.
  const card = screen.getByRole("complementary");
  assert.match(card.textContent ?? "", /Current Model/u);
  assert.doesNotMatch(card.textContent ?? "", /Placed One|placed-one/u);

  fireEvent.click(screen.getByRole("button", { name: "Add to Pad" }));

  await waitFor(() =>
    assert.equal(pad.getAttribute("aria-activedescendant"), modelOptionId("acme::current-model")),
  );
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.equal(writes.length, 1);
  const saved = (writes[0].args[0] as AppSettings).modelPadPlacements ?? {};
  assert.deepEqual(Object.keys(saved).sort(), [
    "acme::current-model",
    "acme::placed-one",
    "acme::placed-two",
  ]);
  assert.equal(saved["acme::current-model"].xSource, "user");
  assert.equal(saved["acme::current-model"].ySource, "user");
  assert.ok(!screen.queryByRole("button", { name: "Add to Pad" }));
  // Focus stays on the Pad when the Add button goes away.
  await waitFor(() => assert.equal(document.activeElement, pad));
  assert.equal(
    within(pad)
      .getByRole("option", { name: /^Current Model,/u })
      .getAttribute("aria-selected"),
    "true",
  );
});

test("the side card and knob tag name the other providers that serve the same model", async () => {
  const relay: Provider = {
    ...provider,
    id: "relay",
    label: "Relay Hub",
    baseUrl: "https://relay.invalid/v1",
    models: ["acme/current-model", "acme/placed-one"],
  };
  const server = settingsServer({
    modelPadPlacements: {
      ...placedSettings.modelPadPlacements,
      "acme::current-model": { x: 0.5, y: 0.5, ...user },
    },
  });
  const pad = await openPicker(server, { providers: [provider, relay] });

  const card = screen.getByRole("complementary");
  assert.match(card.textContent ?? "", /Current Model/u);
  assert.match(card.textContent ?? "", /Also via Relay Hub/u);
  const tag = pad.querySelector<HTMLElement>("[data-model-pad-knob-tag]");
  assert.match(tag?.textContent ?? "", /Also via Relay Hub/u);
});

test("the side card shows the speed measured from the user's own chats", async () => {
  const server = settingsServer(placedSettings, {
    pace: {
      "acme::current-model": {
        medianTtftMs: 1_250,
        medianTokensPerSecond: 48,
        sampleCount: 7,
        lastSampledAt: 1,
      },
    },
  });
  await openPicker(server);

  const card = screen.getByRole("complementary");
  await within(card).findByText("1.3 s first token · 48 tok/s (7 runs)");
  within(card).getByText("Your speed");

  // A chat finished while the picker was closed: reopening shows the new speed.
  const trigger = screen.getByRole("button", { name: /Choose a model/u });
  fireEvent.click(trigger);
  await waitFor(() => assert.ok(!screen.queryByRole("complementary")));
  server.setPace({
    "acme::current-model": {
      medianTtftMs: 800,
      medianTokensPerSecond: 90,
      sampleCount: 8,
      lastSampledAt: 2,
    },
  });
  fireEvent.click(trigger);
  await within(await screen.findByRole("complementary")).findByText(
    "0.8 s first token · 90 tok/s (8 runs)",
  );
});

test("a current model hidden from the picker is not offered for the Pad", async () => {
  const server = settingsServer(placedSettings);
  const pad = await openPicker(server, { hidden: ["current-model"] });

  assert.equal(pad.getAttribute("aria-activedescendant"), null);
  assert.ok(!screen.queryByRole("button", { name: "Add to Pad" }));
  assert.doesNotMatch(screen.getByRole("tabpanel").textContent ?? "", /isn’t on your Pad/u);
});

test("an empty Pad offers the current model and shows it on the Pad once added", async () => {
  const server = settingsServer({});
  await mountPicker(server);
  // With nothing placed the picker opens on the list; switch to the Pad tab.
  fireEvent.click(await screen.findByRole("tab", { name: "Personal Model Pad" }));

  const panel = screen.getByRole("tabpanel");
  assert.match(panel.textContent ?? "", /Current Model\sisn’t on your Pad/u);
  assert.ok(screen.getByRole("button", { name: "Customize Model Pad" }));
  assert.ok(!screen.queryByRole("listbox", { name: /Model pad/u }));

  fireEvent.click(screen.getByRole("button", { name: "Add to Pad" }));

  const pad = await screen.findByRole("listbox", { name: /Model pad/u });
  await waitFor(() =>
    assert.equal(pad.getAttribute("aria-activedescendant"), modelOptionId("acme::current-model")),
  );
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys((writes[0].args[0] as AppSettings).modelPadPlacements ?? {}), [
    "acme::current-model",
  ]);
  assert.ok(!screen.queryByRole("button", { name: "Add to Pad" }));
  // The empty-state call to action is replaced by the Pad's own Customize button.
  assert.equal(screen.getAllByRole("button", { name: "Customize Model Pad" }).length, 1);
  assert.ok(!screen.queryByText("Your Model Pad is empty"));
});

test("a failed Add to Pad says why and keeps offering the model", async () => {
  const server = settingsServer(placedSettings, { failWrites: true });
  const pad = await openPicker(server);

  fireEvent.click(screen.getByRole("button", { name: "Add to Pad" }));

  await screen.findByText(/disk full/u);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Add to Pad" })));
  assert.equal(pad.getAttribute("aria-activedescendant"), null);
  assert.equal(within(pad).getAllByRole("option").length, 2);
});

test("choosing a model on the Pad closes the picker after the confirm pulse", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const pad = await openPicker(server, {
    onChange: (providerId, model) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.keyDown(pad, { key: "ArrowUp" });
  fireEvent.keyDown(pad, { key: "Enter" });

  assert.deepEqual(changes, ["acme::placed-one"]);
  // The knob confirms the choice before the popover goes away.
  assert.ok(screen.getByRole("listbox", { name: /Model pad/u }));
  assert.equal(pad.querySelector(".model-pad-knob")?.getAttribute("data-confirmed"), "true");
  // (assert.ok rather than comparing the element: inspecting a DOM node can hang the runner.)
  await waitFor(() =>
    assert.ok(!screen.queryByRole("listbox", { name: /Model pad/u }), "the picker closed"),
  );
});

function savedPlacements(server: ReturnType<typeof settingsServer>) {
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  return writes.map((call) => (call.args[0] as AppSettings).modelPadPlacements);
}

async function openList(server: ReturnType<typeof settingsServer>, options = {}) {
  await openPicker(server, options);
  fireEvent.click(screen.getByRole("tab", { name: "List" }));
  return screen.findByLabelText("Filter chat models");
}

/** The List option that names `label`. */
function modelOption(label: string): HTMLElement {
  const option = screen
    .getAllByRole("option")
    .find((candidate) => candidate.textContent?.includes(label));
  assert.ok(option, `an option for ${label}`);
  return option;
}

/** A row's mouse-only Pin or Pad action, by what pressing it does ("Pin", "Add to Pad"…). */
function rowAction(label: string, action: string): HTMLElement {
  return within(modelOption(label)).getByTitle(new RegExp(`^${action} \\(`, "u"));
}

function rowDescription(label: string): string {
  const id = modelOption(label).getAttribute("aria-describedby");
  return (id && document.getElementById(id)?.textContent) || "";
}

/** The platform's Command+Shift+<letter> on the List's filter. */
function pressRowShortcut(filter: HTMLElement, letter: "P" | "A") {
  const primary = detectedKeyboardPlatform() === "darwin" ? { metaKey: true } : { ctrlKey: true };
  fireEvent.keyDown(filter, { key: letter, code: `Key${letter}`, shiftKey: true, ...primary });
}

test("list rows say whether each model is pinned and on the Pad, with no control inside the option", async () => {
  const server = settingsServer(placedSettings);
  await openList(server);

  assert.match(rowDescription("Placed One"), /Not pinned, on your Pad\..*pins it, .* removes it from your Pad/u);
  assert.match(rowDescription("Current Model"), /Not pinned, not on your Pad\..*adds it to your Pad/u);
  assert.ok(rowAction("Placed One", "Remove from Pad"));
  assert.ok(rowAction("Current Model", "Add to Pad"));
  assert.ok(rowAction("Placed One", "Pin"));
  // An option can't contain a focusable control (axe nested-interactive), and
  // its name is the model, not the actions' labels.
  for (const option of screen.getAllByRole("option")) {
    assert.equal(option.querySelectorAll("button, a[href], input, [tabindex]").length, 0);
    assert.ok(option.getAttribute("aria-keyshortcuts"));
  }
  assert.equal(screen.queryAllByRole("button", { name: /^(Pin|Unpin) |(to|from) Pad$/u }).length, 0);
});

test("adding a model from its list row places it on the Pad without choosing it", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const list = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.mouseDown(rowAction("Current Model", "Add to Pad"));
  fireEvent.click(rowAction("Current Model", "Add to Pad"));

  await waitFor(() => assert.ok(rowAction("Current Model", "Remove from Pad")));
  const writes = savedPlacements(server);
  assert.equal(writes.length, 1);
  const saved = writes[0] ?? {};
  assert.deepEqual(Object.keys(saved).sort(), [
    "acme::current-model",
    "acme::placed-one",
    "acme::placed-two",
  ]);
  assert.equal(saved["acme::current-model"].xSource, "user");
  assert.equal(saved["acme::current-model"].ySource, "user");
  // Three placed models never share a cell.
  const cells = new Set(Object.values(saved).map((point) => `${point.x},${point.y}`));
  assert.equal(cells.size, 3);
  // The toggle edits the Pad only: the row is not chosen and the picker stays open.
  assert.deepEqual(changes, []);
  assert.ok(list.isConnected);
});

test("removing a model from its list row takes it off the Pad and keeps the others", async () => {
  const server = settingsServer(placedSettings);
  await openList(server);

  fireEvent.click(rowAction("Placed Two", "Remove from Pad"));

  await waitFor(() => assert.ok(rowAction("Placed Two", "Add to Pad")));
  const writes = savedPlacements(server);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    "acme::placed-one": placedSettings.modelPadPlacements?.["acme::placed-one"],
  });
});

test("a list-row removal says so and Undo puts the model back where it was", async () => {
  const server = settingsServer(placedSettings);
  await openList(server);

  fireEvent.click(rowAction("Placed Two", "Remove from Pad"));

  await screen.findByText("Removed Placed Two from your Pad");
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

  await waitFor(() => assert.ok(rowAction("Placed Two", "Remove from Pad")));
  assert.deepEqual(server.current().modelPadPlacements, placedSettings.modelPadPlacements);
});

test("adding a model from its list row shows no toast", async () => {
  const server = settingsServer(placedSettings);
  await openList(server);

  fireEvent.click(rowAction("Current Model", "Add to Pad"));

  await waitFor(() => assert.ok(rowAction("Current Model", "Remove from Pad")));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(!screen.queryByRole("button", { name: "Undo" }));
});

test("a failed Pad toggle says why and leaves the row unchanged", async () => {
  const server = settingsServer(placedSettings, { failWrites: true });
  await openList(server);

  fireEvent.click(rowAction("Current Model", "Add to Pad"));

  await screen.findByText(/disk full/u);
  await waitFor(() => assert.ok(rowAction("Current Model", "Add to Pad")));
});

test("a Pad with models offers Customize Model Pad, which opens Model Pad settings", async () => {
  const server = settingsServer(placedSettings);
  const router = await mountPicker(server);
  await screen.findByRole("listbox", { name: /Model pad/u });

  const customize = screen.getAllByRole("button", {
    name: "Customize Model Pad",
  });
  assert.equal(customize.length, 1);
  fireEvent.click(customize[0]);

  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.deepEqual({ ...router.state.location.search }, { section: "modelData" });
  assert.ok(!screen.queryByRole("listbox", { name: /Model pad/u }), "the picker closed");
});

test("Customize Model Pad explains why settings are unavailable and stays put", async () => {
  const server = settingsServer(placedSettings);
  const router = await mountPicker(server, {
    settingsBlockedReason: "Finish the current task first",
  });
  await screen.findByRole("listbox", { name: /Model pad/u });

  const customize = screen.getByRole("button", { name: "Customize Model Pad" });
  assert.equal(customize.getAttribute("aria-disabled"), "true");
  const descriptionId = customize.getAttribute("aria-describedby") ?? "";
  assert.match(
    document.getElementById(descriptionId)?.textContent ?? "",
    /Finish the current task first/u,
  );

  fireEvent.click(customize);
  assert.notEqual(router.state.location.pathname, "/settings");
  assert.ok(screen.getByRole("listbox", { name: /Model pad/u }));
});

function actionAnnouncement(): string {
  const regions = [...document.querySelectorAll("[cmdk-root] [aria-live='polite']")];
  return regions.map((region) => region.textContent ?? "").join("|");
}

test("the Pad shortcut on the highlighted row edits the Pad and keeps the list open", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const search = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  // The list opens on the current model; one up is Placed Two.
  fireEvent.keyDown(search, { key: "ArrowUp" });
  await waitFor(() => assert.equal(modelOption("Placed Two").getAttribute("aria-selected"), "true"));
  pressRowShortcut(search, "A");

  await waitFor(() => assert.match(rowDescription("Placed Two"), /not on your Pad/u));
  assert.deepEqual(savedPlacements(server), [
    { "acme::placed-one": placedSettings.modelPadPlacements?.["acme::placed-one"] },
  ]);
  assert.deepEqual(changes, []);
  assert.ok(search.isConnected, "the list stayed open");
});

test("the Pin shortcut pins the highlighted row, says so, and keeps the list open", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const search = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.keyDown(search, { key: "ArrowUp" });
  await waitFor(() => assert.equal(modelOption("Placed Two").getAttribute("aria-selected"), "true"));
  pressRowShortcut(search, "P");

  await waitFor(() => assert.match(rowDescription("Placed Two"), /^.*\. Pinned, on your Pad/u));
  // Said once the save has gone through.
  await waitFor(() => assert.match(actionAnnouncement(), /Pinned Placed Two/u));
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.deepEqual(
    writes.map((call) => (call.args[0] as AppSettings).pinnedModels),
    [["acme::placed-two"]],
  );
  assert.deepEqual(changes, []);
  assert.ok(search.isConnected, "the list stayed open");
});

test("a long List shows a page of models and a Show more row that reveals the rest", async () => {
  const many: Provider = {
    ...provider,
    models: Array.from({ length: 130 }, (_, index) => `bulk-${String(index).padStart(3, "0")}`),
  };
  const server = settingsServer({});
  await mountPicker(server, { providers: [many] });
  const search = await screen.findByLabelText("Filter chat models");
  const options = () => screen.getAllByRole("option");

  // 100 models and the Show more row.
  await waitFor(() => assert.equal(options().length, 101));
  assert.equal(options()[100].getAttribute("aria-label"), "Show 30 more, 30 not shown");

  // Keyboard: End reaches Show more, Enter reveals the rest and selects the
  // first model it revealed, in Show more's place.
  fireEvent.keyDown(search, { key: "End" });
  await waitFor(() => assert.equal(options()[100].getAttribute("aria-selected"), "true"));
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.equal(options().length, 130));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(options()[100].getAttribute("aria-selected"), "true");
  assert.match(options()[100].textContent ?? "", /bulk.?100/iu);
  assert.ok(search.isConnected, "Show more doesn't choose a model or close the picker");

  // A new query starts from one page again; the count names every match.
  fireEvent.change(search, { target: { value: "bulk" } });
  await waitFor(() => assert.equal(options().length, 101));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.match(actionAnnouncement(), /130 results/u);

  // Back to the empty filter, and closing and reopening, start from one page too.
  fireEvent.change(search, { target: { value: "" } });
  await waitFor(() => assert.equal(options().length, 101));
  fireEvent.keyDown(search, { key: "End" });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.equal(options().length, 130));
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => assert.ok(!search.isConnected));
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));
  await screen.findByLabelText("Filter chat models");
  await waitFor(() => assert.equal(options().length, 101));
});

test("the current model stays listed, selected and choosable when it falls past the first page", async () => {
  const many: Provider = {
    ...provider,
    models: [
      ...Array.from({ length: 130 }, (_, index) => `bulk-${String(index).padStart(3, "0")}`),
      "current-model",
    ],
  };
  const server = settingsServer({});
  await mountPicker(server, { providers: [many] });
  const search = await screen.findByLabelText("Filter chat models");
  const options = () => screen.getAllByRole("option");

  // 100 models, then the current one in its place, then Show more for the other 30.
  await waitFor(() => assert.equal(options().length, 102));
  const current = options()[100];
  assert.match(current.textContent ?? "", /Current Model/u);
  assert.equal(current.getAttribute("aria-selected"), "true");
  assert.equal(options()[101].getAttribute("aria-label"), "Show 30 more, 30 not shown");

  // Enter chooses it, which records it as the most recent model and closes the picker.
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => assert.ok(!search.isConnected, "choosing closes the picker"));
  await waitFor(() => assert.deepEqual(savedRecents(server), [["acme::current-model"]]));
});

test("Customize Model Pad is available from the List while the Pad has models", async () => {
  const server = settingsServer(placedSettings);
  await openList(server);

  assert.equal(screen.getAllByRole("button", { name: "Customize Model Pad" }).length, 1);
});

test("a current model removed from the Pad in the List is offered again on the Pad", async () => {
  const server = settingsServer({
    modelPadPlacements: {
      ...placedSettings.modelPadPlacements,
      "acme::current-model": { x: 0.5, y: 0.5, ...user },
    },
  });
  await openList(server);

  fireEvent.click(rowAction("Current Model", "Remove from Pad"));
  await waitFor(() => assert.ok(rowAction("Current Model", "Add to Pad")));
  fireEvent.click(screen.getByRole("tab", { name: "Personal Model Pad" }));

  const pad = await screen.findByRole("listbox", { name: /Model pad/u });
  assert.equal(pad.getAttribute("aria-activedescendant"), null);
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /Current Model\sisn’t on your Pad/u);
});

test("typing on the Pad switches to the List and filters by the typed character", async () => {
  const server = settingsServer(placedSettings);
  const pad = await openPicker(server);

  const notPrevented = fireEvent.keyDown(pad, { key: "W", shiftKey: true });
  assert.equal(notPrevented, false);

  const filter = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  assert.equal(filter.value, "W");
  assert.ok(!screen.queryByRole("listbox", { name: /Model pad/u }));
  await waitFor(() => assert.equal(document.activeElement, filter));
  assert.equal(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected"), "true");
  assert.equal(
    screen.getByRole("tab", { name: "Personal Model Pad" }).getAttribute("aria-selected"),
    "false",
  );
  await waitFor(() => {
    const options = screen.getAllByRole("option");
    assert.equal(options.length, 1);
    assert.match(options[0].textContent ?? "", /Placed Two/u);
  });
});

test("navigation keys and shortcuts on the Pad keep the Pad", async () => {
  const server = settingsServer(placedSettings);
  const pad = await openPicker(server);

  // The current model is off the Pad, so nothing is active yet: Enter and Space
  // have nothing to commit and must not start a search either. (Escape closes the
  // picker here, so it is left to its own tests.)
  for (const init of [
    { key: "Enter" },
    { key: " " },
    { key: "Tab" },
    { key: "c", metaKey: true },
    { key: "c", ctrlKey: true },
    { key: "c", altKey: true },
    { key: "c", isComposing: true },
    { key: "ArrowUp" },
    { key: "ArrowRight" },
  ]) {
    fireEvent.keyDown(pad, init);
  }

  assert.ok(screen.queryByRole("listbox", { name: /Model pad/u }));
  assert.ok(!screen.queryByLabelText("Filter chat models"));
});

test("typing right after choosing on the Pad does not reopen the list", async () => {
  const server = settingsServer(placedSettings);
  const pad = await openPicker(server);
  fireEvent.keyDown(pad, { key: "ArrowUp" });
  fireEvent.keyDown(pad, { key: "Enter" });

  fireEvent.keyDown(pad, { key: "c" });

  assert.ok(screen.queryByRole("listbox", { name: /Model pad/u }));
  assert.ok(!screen.queryByLabelText("Filter chat models"));
  await waitFor(() => assert.ok(!screen.queryByRole("listbox", { name: /Model pad/u })));
});

test("the list filter is cleared when the picker reopens", async () => {
  const server = settingsServer({});
  await mountPicker(server);
  const filter = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  fireEvent.change(filter, { target: { value: "pl" } });
  assert.equal(filter.value, "pl");

  fireEvent.keyDown(filter, { key: "Escape" });
  await waitFor(() => assert.ok(!screen.queryByLabelText("Filter chat models")));
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));

  const reopened = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  assert.equal(reopened.value, "");
});

test("re-selecting the List tab keeps the typed filter", async () => {
  const server = settingsServer({});
  await mountPicker(server);
  const filter = (await screen.findByLabelText("Filter chat models")) as HTMLInputElement;
  fireEvent.change(filter, { target: { value: "pla" } });

  const listTab = screen.getByRole("tab", { name: "List" });
  fireEvent.click(listTab);
  fireEvent.keyDown(listTab, { key: "ArrowLeft" });
  fireEvent.keyDown(listTab, { key: "Home" });

  assert.equal((screen.getByLabelText("Filter chat models") as HTMLInputElement).value, "pla");
});

const MODEL_LABELS = ["Current Model", "Placed One", "Placed Two"];

/** The model each listed row names, in list order. */
function optionNames(container: HTMLElement) {
  return within(container)
    .getAllByRole("option")
    .map((option) => MODEL_LABELS.find((label) => option.textContent?.includes(label)) ?? "");
}

function savedRecents(server: ReturnType<typeof settingsServer>) {
  return server.calls
    .filter((call) => call.channel === "settings:set")
    .map((call) => (call.args[0] as AppSettings).recentModels)
    .filter((recent) => recent !== undefined);
}

test("the List shows recent models after pinned ones, without the current model or duplicates", async () => {
  const server = settingsServer({
    ...placedSettings,
    pinnedModels: ["acme::current-model"],
    recentModels: ["acme::current-model", "acme::gone", "acme::placed-two", "acme::placed-one"],
  });
  await openList(server);

  const list = screen.getByRole("listbox");
  const recent = within(list).getByRole("group", { name: "Recent" });
  // Pinned first, then Recent (in recency order), then the rest. Every model is
  // listed once, and the pinned current model is not repeated under Recent.
  assert.deepEqual(optionNames(recent), ["Placed Two", "Placed One"]);
  assert.deepEqual(optionNames(list), ["Current Model", "Placed Two", "Placed One"]);
});

test("filtering the List shows a flat list without the Recent group", async () => {
  const server = settingsServer({
    ...placedSettings,
    recentModels: ["acme::placed-two"],
  });
  const filter = (await openList(server)) as HTMLInputElement;
  assert.ok(screen.getByRole("group", { name: "Recent" }));

  fireEvent.change(filter, { target: { value: "placed" } });

  await waitFor(() => assert.ok(!screen.queryByRole("group", { name: "Recent" })));
  assert.deepEqual(optionNames(screen.getByRole("listbox")).sort(), ["Placed One", "Placed Two"]);
});

test("filtering marks the matched part of each label and matches the provider unmarked", async () => {
  const server = settingsServer(placedSettings);
  const filter = await openList(server);
  const list = screen.getByRole("listbox");
  const marks = () => [...list.querySelectorAll("mark")].map((mark) => mark.textContent);

  fireEvent.change(filter, { target: { value: "two" } });
  await waitFor(() => assert.deepEqual(optionNames(list), ["Placed Two"]));
  assert.deepEqual(marks(), ["Two"]);

  // Initials: "pt" is Placed Two's word starts.
  fireEvent.change(filter, { target: { value: "pt" } });
  await waitFor(() => assert.deepEqual(optionNames(list), ["Placed Two"]));
  assert.deepEqual(marks(), ["P", "T"]);

  // The provider name matches every row without marking anything.
  fireEvent.change(filter, { target: { value: "acme" } });
  await waitFor(() => assert.equal(optionNames(list).length, 3));
  assert.deepEqual(marks(), []);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.equal(list.parentElement?.querySelector("[aria-live='polite']")?.textContent, "3 results");
});

test("choosing a model in the List records it as the most recent", async () => {
  const server = settingsServer({ ...placedSettings, recentModels: ["acme::placed-one"] });
  const changes: string[] = [];
  await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.click(screen.getByRole("option", { name: /Placed Two/u }));

  assert.deepEqual(changes, ["acme::placed-two"]);
  await waitFor(() =>
    assert.deepEqual(savedRecents(server), [["acme::placed-two", "acme::placed-one"]]),
  );
});

test("re-choosing the current model on the Pad moves it to the front of the recents", async () => {
  const server = settingsServer({
    modelPadPlacements: {
      ...placedSettings.modelPadPlacements,
      "acme::current-model": { x: 0.5, y: 0.5, ...user },
    },
    recentModels: ["acme::placed-one", "acme::current-model"],
  });
  const changes: string[] = [];
  const pad = await openPicker(server, {
    onChange: (providerId, model) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.keyDown(pad, { key: "Enter" });

  // The current model needs no change, but it still becomes the newest recent.
  assert.deepEqual(changes, []);
  await waitFor(() =>
    assert.deepEqual(savedRecents(server), [["acme::current-model", "acme::placed-one"]]),
  );
});

test("choosing the newest recent model again writes nothing", async () => {
  const server = settingsServer({ ...placedSettings, recentModels: ["acme::placed-two"] });
  const changes: string[] = [];
  await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.click(screen.getByRole("option", { name: /Placed Two/u }));

  assert.deepEqual(changes, ["acme::placed-two"]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(server.calls.filter((call) => call.channel === "settings:set").length, 0);
});

test("a failed recents write neither blocks the choice nor shows an error", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const server = settingsServer(placedSettings, { failWrites: true });
  const changes: string[] = [];
  await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.click(screen.getByRole("option", { name: /Placed Two/u }));

  assert.deepEqual(changes, ["acme::placed-two"]);
  await waitFor(() => assert.equal(warn.mock.callCount(), 1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(!screen.queryByText(/disk full/u), "no error toast for history");
});

function padHelp(pad: HTMLElement): string {
  return document.getElementById(pad.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
}

test("the Pad names the height metric only while a benchmark-height model is on it", async () => {
  const server = settingsServer({
    modelPadPlacements: {
      ...placedSettings.modelPadPlacements,
      "acme::current-model": { x: 0.5, y: 0.5, xSource: "neutral", ySource: "benchmark" },
    },
    modelPadMetric: "agentic",
  });
  const pad = await openPicker(server);

  assert.match(pad.textContent ?? "", /Height: Agentic/u);
  assert.match(padHelp(pad), /Agentic/u);
});

test("the Pad names each saved height's own metric, or says mixed when they differ", async () => {
  const server = settingsServer({
    modelPadPlacements: {
      ...placedSettings.modelPadPlacements,
      "acme::current-model": {
        x: 0.5,
        y: 0.5,
        xSource: "neutral",
        ySource: "benchmark",
        yMetric: "intelligence",
      },
    },
    modelPadMetric: "agentic",
  });
  const pad = await openPicker(server);
  // The stored height came from General, whatever the current setting.
  assert.match(pad.textContent ?? "", /Height: General/u);
  assert.match(padHelp(pad), /General/u);
  cleanup();

  const mixed = settingsServer({
    modelPadPlacements: {
      "acme::placed-one": { x: 0, y: 1, xSource: "neutral", ySource: "benchmark", yMetric: "coding" },
      "acme::placed-two": { x: 1, y: 0, xSource: "neutral", ySource: "benchmark" },
    },
    modelPadMetric: "agentic",
  });
  const mixedPad = await openPicker(mixed);
  assert.match(mixedPad.textContent ?? "", /Height: mixed/u);
  assert.match(padHelp(mixedPad), /mixed scores/u);
});

test("the Pad names no metric when every height is the user's own", async () => {
  const server = settingsServer({ ...placedSettings, modelPadMetric: "agentic" });
  const pad = await openPicker(server);

  assert.doesNotMatch(pad.textContent ?? "", /Height:/u);
  assert.doesNotMatch(padHelp(pad), /Agentic/u);
});

test("a hidden benchmark-height model does not name the metric", async () => {
  const server = settingsServer({
    modelPadPlacements: {
      ...placedSettings.modelPadPlacements,
      "acme::current-model": { x: 0.5, y: 0.5, xSource: "neutral", ySource: "benchmark" },
    },
  });
  const pad = await openPicker(server, { hidden: ["current-model"] });

  assert.doesNotMatch(pad.textContent ?? "", /Height:/u);
});
