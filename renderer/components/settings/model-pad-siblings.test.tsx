import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { AppSettings, Provider } from "../../lib/types";
import type { ModelPadPlacements } from "../../shared/model-pad-preferences";
import { Toaster, toast } from "../ui";
import { ModelPadSettings } from "./model-pad-settings";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

const direct: Provider = {
  id: "test",
  label: "Test",
  kind: "openai",
  baseUrl: "https://example.test/v1",
  models: ["gpt-4o", "solo", "unplaced"],
  needsKey: false,
  hasKey: true,
};

// A router serving the same model under a namespaced id, plus a second copy of the
// "unplaced" model that is never put on the Pad.
const relay: Provider = {
  ...direct,
  id: "relay",
  label: "Relay Hub",
  baseUrl: "https://relay.test/v1",
  models: ["openai/gpt-4o", "vendor/unplaced"],
};

const placements: ModelPadPlacements = {
  "test::gpt-4o": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
  "relay::openai/gpt-4o": { x: 0, y: 1, xSource: "user", ySource: "user" },
  "test::solo": { x: 1, y: 0, xSource: "user", ySource: "user" },
  "test::unplaced": { x: 1, y: 1, xSource: "user", ySource: "user" },
};

function installServer() {
  const current = {
    modelPadPlacements: placements,
    pinnedModels: [],
  } as AppSettings;
  installBotTestIpc({
    "providers:list": () => [direct, relay],
    "models:info": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "settings:get": () => structuredClone(current),
    "settings:set": () => structuredClone(current),
  });
}

async function mountEditor() {
  installServer();
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  return waitFor(() => {
    const pad = screen.getByRole("group", {
      name: "Personal Model Pad arrangement",
    });
    assert.equal(pad.querySelectorAll("[data-placement-source]").length, 4);
    return pad;
  });
}

function marker(pad: HTMLElement, value: string): HTMLElement {
  const element = pad.querySelector<HTMLElement>(`[data-value="${value}"]`);
  assert.ok(element, `${value} has a marker`);
  return element;
}

function linkedValues(pad: HTMLElement): string[] {
  return [...pad.querySelectorAll<HTMLElement>('[data-linked="true"]')]
    .map((element) => element.dataset.value ?? "")
    .sort();
}

test("marker labels name the other providers that serve the same model", async () => {
  const pad = await mountEditor();
  const label = (value: string) =>
    marker(pad, value).querySelector(".model-pad-marker-label")?.textContent ??
    "";

  assert.match(label("test::gpt-4o"), /Also via Relay Hub/u);
  assert.match(label("relay::openai/gpt-4o"), /Also via Test/u);
  // A sibling that is visible but not placed still counts as another route.
  assert.match(label("test::unplaced"), /Also via Relay Hub/u);
  assert.doesNotMatch(label("test::solo"), /Also via/u);
});

test("focusing or hovering a marker links its placed siblings and nothing else", async () => {
  const pad = await mountEditor();
  assert.deepEqual(linkedValues(pad), []);

  fireEvent.focus(marker(pad, "test::gpt-4o"));
  await waitFor(() =>
    assert.deepEqual(linkedValues(pad), ["relay::openai/gpt-4o"]),
  );

  fireEvent.keyDown(marker(pad, "test::gpt-4o"), { key: "Escape" });
  await waitFor(() => assert.deepEqual(linkedValues(pad), []));

  fireEvent.pointerEnter(marker(pad, "relay::openai/gpt-4o"));
  await waitFor(() => assert.deepEqual(linkedValues(pad), ["test::gpt-4o"]));
  fireEvent.pointerLeave(marker(pad, "relay::openai/gpt-4o"));
  await waitFor(() => assert.deepEqual(linkedValues(pad), []));

  // A model whose sibling is not on the Pad links nothing.
  fireEvent.focus(marker(pad, "test::unplaced"));
  await waitFor(() =>
    assert.equal(marker(pad, "test::unplaced").dataset.selected, "true"),
  );
  assert.deepEqual(linkedValues(pad), []);
});

test("Browse rows add the other providers to the provider line", async () => {
  await mountEditor();
  fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
  const rows = (
    await screen.findAllByRole("button", {
      name: /^(?:Add|Remove) .* (?:to|from) Pad$/u,
    })
  ).map((button) => button.parentElement?.textContent ?? "");
  assert.ok(
    rows.some((text) => /Relay Hub · Hosted · Also via Test/u.test(text)),
  );
  assert.ok(
    rows.some((text) => /Test · Hosted · Also via Relay Hub/u.test(text)),
  );
  const solo = rows.filter((text) => /Solo/iu.test(text));
  assert.equal(solo.length, 1);
  assert.doesNotMatch(solo[0], /Also via/u);
});
