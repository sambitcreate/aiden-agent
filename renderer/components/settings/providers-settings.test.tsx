import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES, type AppCapabilities } from "../../lib/app-capabilities";
import type { AppSettings } from "../../lib/types";
import { ProvidersSettings } from "./providers-settings";

afterEach(cleanup);

const source = readFileSync(new URL("./providers-settings.tsx", import.meta.url), "utf8");

test("built-in providers show readiness beside the name without duplicating setup", () => {
  const statusBadge = source.slice(
    source.indexOf("function statusBadge"),
    source.indexOf("function foundationModelsBadge"),
  );
  const builtinRows = source.slice(
    source.indexOf("function BuiltinProviderRows"),
    source.indexOf("export function ProvidersSettings"),
  );

  assert.match(statusBadge, /p\.hasKey \? <Badge color="green" icon=\{<Check \/>\}>Ready<\/Badge> : null/u);
  assert.doesNotMatch(statusBadge, /Set up/u);
  assert.match(builtinRows, /provider\.hasKey \? "Manage" : "Set up"/u);
});

function mount(capabilities: Partial<AppCapabilities>, settings: Partial<AppSettings> = {}) {
  installBotTestIpc({
    "settings:get": () => settings,
    "providers:catalogStatus": () => ({ source: "bundled", fetchedAt: null }),
    "titleProviders:status": () => ({ state: "ready", detail: "Ready on this Mac." }),
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, ...capabilities }}>
        <ProvidersSettings />
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );
}

test("an imported on-device title preference stays explicit on an unsupported host", async () => {
  mount({ appleFoundationModels: false }, { chatTitleProviderId: "apple-foundation-models" });
  await screen.findByText(/Choose Automatic or Selected chat model to allow your selected model to generate titles/u);
  const select = screen.getByRole("combobox", { name: "Chat title provider" });
  assert.match(select.textContent ?? "", /On-device only \(unavailable\)/u);
});

test("chat title generation is one row whose hint says what stays on the device", async () => {
  mount({ appleFoundationModels: true, platform: "darwin" });
  const row = await screen.findByRole("group", { name: "Chat title generation" });
  within(row).getByRole("combobox", { name: "Chat title provider" });
  fireEvent.click(within(row).getByRole("button", { name: "About chat title generation" }));
  assert.match((await screen.findByRole("tooltip")).textContent ?? "", /On-device only never sends titles out\./u);
});

test("the page explains provider connections from hints, not dialogs", async () => {
  mount({});
  fireEvent.click(await screen.findByRole("button", { name: "About provider connections" }));
  await screen.findByRole("tooltip");
  assert.equal(screen.queryByRole("dialog") === null, true);
});
