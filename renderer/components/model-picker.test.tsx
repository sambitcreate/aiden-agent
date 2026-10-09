import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { mountWithBotRouter } from "../main/bots/test-providers";
import { modelOptionId } from "../lib/model-picker-data";
import type { AppSettings, Provider } from "../lib/types";
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

function settingsServer(initial: AppSettings, options: { failWrites?: boolean } = {}) {
  let current = structuredClone(initial);
  const calls = installBotTestIpc({
    "settings:get": () => structuredClone(current),
    "settings:set": (patch: unknown) => {
      if (options.failWrites) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return structuredClone(current);
    },
    "models:info": () => ({}),
  });
  return { calls, current: () => current };
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
  } = {},
) {
  const { router } = await mountWithBotRouter(
    <>
      <ModelPicker
        providers={[provider]}
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
  assert.equal(screen.queryByRole("button", { name: "Add to Pad" }), null);
  // Focus stays on the Pad when the Add button goes away.
  await waitFor(() => assert.equal(document.activeElement, pad));
  assert.equal(
    within(pad)
      .getByRole("option", { name: /^Current Model,/u })
      .getAttribute("aria-selected"),
    "true",
  );
});

test("a current model hidden from the picker is not offered for the Pad", async () => {
  const server = settingsServer(placedSettings);
  const pad = await openPicker(server, { hidden: ["current-model"] });

  assert.equal(pad.getAttribute("aria-activedescendant"), null);
  assert.equal(screen.queryByRole("button", { name: "Add to Pad" }), null);
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
  assert.equal(screen.queryByRole("listbox", { name: /Model pad/u }), null);

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
  assert.equal(screen.queryByRole("button", { name: "Add to Pad" }), null);
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

test("list rows say whether each model is on the Pad", async () => {
  const server = settingsServer(placedSettings);
  await openList(server);

  const remove = screen.getByRole("button", {
    name: "Remove Placed One from Pad",
  });
  assert.equal(remove.getAttribute("aria-pressed"), "true");
  assert.ok(screen.getByRole("button", { name: "Remove Placed Two from Pad" }));
  const add = screen.getByRole("button", { name: "Add Current Model to Pad" });
  assert.equal(add.getAttribute("aria-pressed"), "false");
});

test("adding a model from its list row places it on the Pad without choosing it", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const list = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  fireEvent.mouseDown(screen.getByRole("button", { name: "Add Current Model to Pad" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Current Model to Pad" }));

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "Remove Current Model from Pad" })),
  );
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

  fireEvent.click(screen.getByRole("button", { name: "Remove Placed Two from Pad" }));

  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Add Placed Two to Pad" })));
  const writes = savedPlacements(server);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    "acme::placed-one": placedSettings.modelPadPlacements?.["acme::placed-one"],
  });
});

test("a failed Pad toggle says why and leaves the row unchanged", async () => {
  const server = settingsServer(placedSettings, { failWrites: true });
  await openList(server);

  fireEvent.click(screen.getByRole("button", { name: "Add Current Model to Pad" }));

  await screen.findByText(/disk full/u);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Add Current Model to Pad" })));
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

// Keyboard users activate a row action with Enter; native button activation then
// clicks it. The command list must not treat that Enter as choosing the row.
function pressEnter(button: HTMLElement) {
  button.focus();
  const notPrevented = fireEvent.keyDown(button, { key: "Enter" });
  assert.ok(notPrevented, "Enter reaches the button's own activation");
  fireEvent.click(button);
}

test("Enter on a row's Pad toggle edits the Pad and keeps the list open", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const search = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  pressEnter(screen.getByRole("button", { name: "Remove Placed Two from Pad" }));

  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Add Placed Two to Pad" })));
  assert.deepEqual(savedPlacements(server), [
    { "acme::placed-one": placedSettings.modelPadPlacements?.["acme::placed-one"] },
  ]);
  assert.deepEqual(changes, []);
  assert.ok(search.isConnected, "the list stayed open");
});

test("Enter on a row's Pin pins the model and keeps the list open", async () => {
  const server = settingsServer(placedSettings);
  const changes: string[] = [];
  const search = await openList(server, {
    onChange: (providerId: string, model: string) => changes.push(`${providerId}::${model}`),
  });

  pressEnter(screen.getByRole("button", { name: "Pin Placed Two" }));

  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Unpin Placed Two" })));
  const writes = server.calls.filter((call) => call.channel === "settings:set");
  assert.deepEqual(
    writes.map((call) => (call.args[0] as AppSettings).pinnedModels),
    [["acme::placed-two"]],
  );
  assert.deepEqual(changes, []);
  assert.ok(search.isConnected, "the list stayed open");
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

  fireEvent.click(screen.getByRole("button", { name: "Remove Current Model from Pad" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Add Current Model to Pad" })));
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
