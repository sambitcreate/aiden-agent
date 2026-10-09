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
  options: { hidden?: string[] } = {},
) {
  await mountWithBotRouter(
    <>
      <ModelPicker
        providers={[provider]}
        providerId="acme"
        model="current-model"
        onChange={() => {}}
        hiddenModelsByProvider={options.hidden ? { acme: options.hidden } : undefined}
      />
      <Toaster />
    </>,
  );
  // The picker opens on the Pad once the saved placements have loaded.
  await act(async () => {
    await waitFor(() =>
      assert.ok(server.calls.some((call) => call.channel === "settings:get")),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole("button", { name: /Choose a model/u }));
}

async function openPicker(
  server: ReturnType<typeof settingsServer>,
  options: { hidden?: string[] } = {},
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
    within(pad).getByRole("option", { name: /^Current Model,/u }).getAttribute("aria-selected"),
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
  assert.equal(screen.queryByRole("button", { name: "Customize Model Pad" }), null);
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
