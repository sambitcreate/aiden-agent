import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import type { AppSettings } from "../../lib/types";
import { BotsSettings } from "./bots-settings";

afterEach(cleanup);

const switchName = "Let routines go ahead without asking";

function mount(settings: Partial<AppSettings>, options: { computerUse?: boolean; failSave?: boolean } = {}) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      if (options.failSave) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
  });
  render(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, computerUse: options.computerUse === true }}>
      <QueryClientProvider client={createBotTestQueryClient()}>
        <BotsSettings />
      </QueryClientProvider>
    </AppCapabilitiesProvider>,
  );
  const saves = () => calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  return { saves, current: () => current };
}

test("routines ask by default, and turning the switch on saves it for every Bot", async () => {
  const { saves, current } = mount({});
  const toggle = await screen.findByRole("switch", { name: switchName });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(saves(), [{ botRoutinesGoAhead: true }]));
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.equal(current().botRoutinesGoAhead, true);
});

test("a saved choice shows as on and can be turned off", async () => {
  const { saves } = mount({ botRoutinesGoAhead: true });
  const toggle = await screen.findByRole("switch", { name: switchName });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(saves(), [{ botRoutinesGoAhead: false }]));
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
});

test("a save that fails puts the switch back", async () => {
  mount({}, { failSave: true });
  const toggle = await screen.findByRole("switch", { name: switchName });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
});

test("the page lists what always comes to the person; Computer Use only where this Mac offers it", async () => {
  mount({}, { computerUse: false });
  await screen.findByText("Passwords, 2FA codes and money");
  screen.getByText("Steps a Bot’s rules hand off to you");
  assert.ok(!screen.queryByText("Using your Mac with Computer Use"));
  cleanup();
  mount({}, { computerUse: true });
  await screen.findByText("Using your Mac with Computer Use");
});
