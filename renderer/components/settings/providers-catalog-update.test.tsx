import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { ProvidersSettings } from "./providers-settings";
import type { ProviderCatalogUpdateResult } from "../../lib/types";

afterEach(cleanup);

const STATUS = { source: "bundled", fetchedAt: null } as const;

function mount(updateCatalogs: () => ProviderCatalogUpdateResult) {
  const calls = installBotTestIpc({
    "settings:get": () => ({}),
    "providers:catalogStatus": () => STATUS,
    "providers:updateCatalogs": updateCatalogs,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  return calls;
}

const updated: ProviderCatalogUpdateResult = {
  providers: [],
  inventoryErrors: [],
  modelsDev: { ok: true, status: { source: "device-cache", fetchedAt: null } },
};

const updateCalls = (calls: ReturnType<typeof mount>) =>
  calls.filter((call) => call.channel === "providers:updateCatalogs");

test("catalogs update only when the person asks, and the row reports the result", async () => {
  const calls = mount(() => updated);
  const row = await screen.findByRole("group", { name: "Model catalog" });
  await waitFor(() => assert.match(row.textContent ?? "", /Model details: bundled snapshot/u));
  assert.equal(updateCalls(calls).length, 0);

  fireEvent.click(screen.getByRole("button", { name: "Update model catalogs" }));

  await waitFor(() =>
    assert.match(row.textContent ?? "", /Provider inventory and model details are up to date\./u),
  );
  assert.equal(updateCalls(calls).length, 1);
});

test("a partial update says which half kept its cached data", async () => {
  mount(() => ({
    ...updated,
    inventoryErrors: [{ providerId: "openai", message: "Offline" }],
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Update model catalogs" }));
  const row = await screen.findByRole("group", { name: "Model catalog" });
  await waitFor(() =>
    assert.match(row.textContent ?? "", /Provider inventory kept cached data; model details updated\./u),
  );
});

test("a failed update says cached data is still available", async () => {
  mount(() => {
    throw new Error("Offline");
  });
  fireEvent.click(await screen.findByRole("button", { name: "Update model catalogs" }));
  const row = await screen.findByRole("group", { name: "Model catalog" });
  await waitFor(() =>
    assert.match(row.textContent ?? "", /Catalog update failed; cached data is still available\./u),
  );
});

test("the row says what the update contacts and sends, and the hint what the data changes", async () => {
  mount(() => updated);
  const row = await screen.findByRole("group", { name: "Model catalog" });
  // What leaves the device stays readable without opening anything.
  assert.match(row.textContent ?? "", /contacts built-in catalog services and models\.dev/u);
  assert.match(row.textContent ?? "", /sends no prompts, chats or device identifier/u);
  // A provider's own catalog service can use that provider's sign-in, so keys are not ruled out.
  assert.match(row.textContent ?? "", /may use your sign-in for that provider; models\.dev gets no credentials/u);
  fireEvent.click(await screen.findByRole("button", { name: "About model catalogs" }));
  const hint = (await screen.findByRole("tooltip")).textContent ?? "";
  assert.match(hint, /display details only, never which models can run/u);
});
