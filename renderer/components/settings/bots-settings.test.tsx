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

test("the routines switch is no longer on the Bots page, even for someone who had it on", async () => {
  mount({ botRoutinesGoAhead: true });
  await screen.findByRole("switch", { name: "Bots can message each other" });
  assert.equal(screen.queryByRole("switch", { name: "Let routines go ahead without asking" }), null);
});

test('the messaging switch saves botMessaging', async () => {
 const {saves}=mount({});
 const toggle=await screen.findByRole('switch',{name:'Bots can message each other'});
 await waitFor(()=>assert.equal(toggle.hasAttribute('disabled'),false));
 assert.equal(toggle.getAttribute('aria-checked'),'true');
 fireEvent.click(toggle);
 await waitFor(()=>assert.deepEqual(saves(),[{botMessaging:false}]));
});


test("what Bots may do points to Settings → Approvals", async () => {
  mount({});
  await screen.findByRole("button", { name: "Open Approvals" });
  assert.equal(screen.queryByText("Allowed without asking"), null);
  assert.equal(screen.queryByText("Always comes to you"), null);
});
