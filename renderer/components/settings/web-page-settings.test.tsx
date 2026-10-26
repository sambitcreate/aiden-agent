import { installBotTestIpc } from "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { WebPageSettings } from "./web-page-settings";
import {
  defaultWebFetchSettings,
  webFetchRendererSnapshot,
  type WebFetchSettingsV1,
} from "../../shared/web-fetch-settings";

afterEach(() => cleanup());

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/** A fake main process holding the settings document and a key count. */
function webFetchServer(initial: { settings?: WebFetchSettingsV1; keys?: number; webSearchEnabled?: boolean } = {}) {
  let settings = initial.settings ?? defaultWebFetchSettings();
  const keys = initial.keys ?? 0;
  const snapshot = () => webFetchRendererSnapshot({ settings, webSearchEnabled: initial.webSearchEnabled ?? true, keyCount: keys });
  const calls = installBotTestIpc({
    "webSearch:pages:get": snapshot,
    "webSearch:pages:setEnabled": (enabled: unknown) => {
      settings = { ...settings, enabled: enabled as boolean };
      return snapshot();
    },
    "webSearch:pages:setExtractEnabled": (enabled: unknown) => {
      if (enabled && !snapshot().extract.ready) throw new Error("Add the Cloudflare account ID and at least one API key before turning on extract mode.");
      settings = { ...settings, extract: { ...settings.extract, enabled: enabled as boolean } };
      return snapshot();
    },
    "webSearch:pages:setExtractAccountId": (accountId: unknown) => {
      settings = { ...settings, extract: { ...settings.extract, accountId: accountId as string } };
      return snapshot();
    },
    "webSearch:keyPool:get": () => ({ providerId: "cloudflare-workers-ai", strategy: "ordered", maxEntries: 8, observedAt: 0, entries: [] }),
  });
  return { calls, current: () => settings };
}

async function mount() {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <WebPageSettings />
    </QueryClientProvider>,
  );
  await screen.findByText("Web pages");
}

test("page reading is on, and extract mode cannot turn on until it is set up", async () => {
  webFetchServer();
  await mount();
  const reading = screen.getByRole("switch", { name: "Read web pages" });
  assert.equal(reading.getAttribute("aria-checked"), "true");
  const extract = screen.getByRole("switch", { name: "Extract only the values asked for" });
  assert.equal(extract.hasAttribute("disabled"), true);
  assert.ok(screen.getByText("Needs setup"));
  assert.ok(screen.getByText(/Add your cloudflare account id and an API key/u));
  // The Cloudflare key goes into the same write-only pool editor Web Search uses.
  assert.ok(screen.getByRole("textbox", { name: "Cloudflare key label" }));
});

test("a malformed account ID is not sent; a valid one is saved lowercase", async () => {
  const server = webFetchServer();
  await mount();
  const field = screen.getByRole("textbox", { name: "Cloudflare account ID" });
  fireEvent.change(field, { target: { value: "acct-123" } });
  assert.ok(screen.getByText(/32 letters and digits/u));
  assert.equal(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"), true);

  fireEvent.change(field, { target: { value: ACCOUNT_ID.toUpperCase() } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });
  await waitFor(() => assert.ok(screen.getByText("Account ID saved.")));
  assert.deepEqual(
    server.calls.filter((call) => call.channel === "webSearch:pages:setExtractAccountId").map((call) => call.args),
    [[ACCOUNT_ID.toUpperCase()]],
  );
});

test("once set up, extract mode turns on and says so", async () => {
  const settings = { ...defaultWebFetchSettings(), extract: { enabled: false, model: "cloudflare-clairic" as const, accountId: ACCOUNT_ID } };
  const server = webFetchServer({ settings, keys: 1 });
  await mount();
  const extract = screen.getByRole("switch", { name: "Extract only the values asked for" });
  assert.equal(extract.hasAttribute("disabled"), false);
  await act(async () => {
    fireEvent.click(extract);
  });
  await waitFor(() => assert.equal(extract.getAttribute("aria-checked"), "true"));
  assert.ok(within(extract.closest("[role=group]") as HTMLElement).getByText("On"));
  assert.equal(server.current().extract.enabled, true);
});

test("turning page reading off hides the extract setup", async () => {
  const server = webFetchServer();
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Read web pages" }));
  });
  await waitFor(() => assert.equal(screen.queryByRole("switch", { name: "Extract only the values asked for" }), null));
  assert.equal(server.current().enabled, false);
});

test("with Web Search off, the row says how to make pages readable", async () => {
  webFetchServer({ webSearchEnabled: false });
  await mount();
  assert.ok(screen.getByText("Turn on Web Search above to let the agent read pages."));
});
