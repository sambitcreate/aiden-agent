import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import type { AppSettings } from "../../lib/types";
import { botFixture } from "../../main/bots/test-fixtures";
import type { BotAllowedEntry } from "../../shared/tool-approval-scope";
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

test("the page lists what always comes to the person; Computer Use only where this Mac offers it", async () => {
  mount({}, { computerUse: false });
  await screen.findByText("Passwords, 2FA codes and money");
  screen.getByText("Steps a Bot’s rules hand off to you");
  assert.ok(!screen.queryByText("Using your Mac with Computer Use"));
  cleanup();
  mount({}, { computerUse: true });
  await screen.findByText("Using your Mac with Computer Use");
});

test('the messaging switch saves botMessaging', async () => {
 const {saves}=mount({});
 const toggle=await screen.findByRole('switch',{name:'Bots can message each other'});
 await waitFor(()=>assert.equal(toggle.hasAttribute('disabled'),false));
 assert.equal(toggle.getAttribute('aria-checked'),'true');
 fireEvent.click(toggle);
 await waitFor(()=>assert.deepEqual(saves(),[{botMessaging:false}]));
});


function mountAllowed(initial: BotAllowedEntry[], remove?: (input: unknown) => unknown) {
  let entries = initial;
  const calls = installBotTestIpc({
    "settings:get": () => ({}),
    "bots:list": () => [botFixture({id: "bot:ada", name: "Ada"}), botFixture({id: "bot:jo", name: "Jo"})],
    "bots:allowed:list": () => entries,
    "bots:allowed:remove": (input) => {
      if (remove) return remove(input);
      const { botId, entryId } = input as { botId: string; entryId: string };
      entries = entries.filter((entry) => entry.botId !== botId || entry.id !== entryId);
      return { removed: true };
    },
  });
  const client = createBotTestQueryClient();
  render(<AppCapabilitiesProvider capabilities={DISABLED_APP_CAPABILITIES}><QueryClientProvider client={client}><BotsSettings /></QueryClientProvider></AppCapabilitiesProvider>);
  return { calls, entries: (next: BotAllowedEntry[]) => { entries = next; }, client };
}
const ALLOWED: BotAllowedEntry[] = [
  {kind: "rule", botId: "bot:ada", id: "r-ada", what: "Calendar · Create event", createdAt: "2026-11-03T15:00:00Z", uses: 12},
  {kind: "folder", botId: "bot:jo", id: "folder_team", what: "Folder · ~/Team", createdAt: "2026-11-03T15:00:00Z"},
];
test("Settings groups allowed entries by Bot, removes Jo's folder and refreshes both list caches", async () => {
  const { calls, client } = mountAllowed(ALLOWED);
  client.setQueryData(["bot-allowed", "bot:jo"], [ALLOWED[1]]);
  const jo = await screen.findByRole("group", { name: "Jo" });
  within(await screen.findByRole("group", { name: "Ada" })).getByText("Calendar · Create event");
  within(jo).getByText("Folder · ~/Team");
  fireEvent.click(within(jo).getByRole("button", { name: "Remove" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:allowed:remove").map((call) => call.args), [[{botId: "bot:jo", entryId: "folder_team"}]]));
  await waitFor(() => assert.ok(!screen.queryByText("Folder · ~/Team")));
  assert.equal(client.getQueryState(["bot-allowed", "bot:jo"])?.isInvalidated, true);
  screen.getByText("Calendar · Create event");
});

test("Settings shows the planned empty copy only after the list settles", async () => {
  mountAllowed([]);
  await screen.findByText("No Bot does anything without asking yet.");
});

test("a failed Remove preserves the row and retries with one in-flight request", async () => {
  let reject!: (error: Error) => void;
  const { calls } = mountAllowed(ALLOWED, () => new Promise((_resolve, no) => { reject = no; }));
  const jo = await screen.findByRole("group", { name: "Jo" });
  const remove = within(jo).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
  act(() => {
    remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(calls.filter((call) => call.channel === "bots:allowed:remove").length, 1);
  assert.equal(remove.disabled, true);
  await act(async () => reject(new Error("Access changed. Try again.")));
  screen.getByText("Folder · ~/Team");
  assert.equal((await screen.findByRole("alert")).textContent, "Access changed. Try again.");
  assert.equal(remove.disabled, false);
  fireEvent.click(remove);
  assert.equal(calls.filter((call) => call.channel === "bots:allowed:remove").length, 2);
  await act(async () => reject(new Error("Still unavailable")));
});

test("a host changed event refreshes the Settings list without unrelated Bot reads", async () => {
  const state = mountAllowed([]);
  await screen.findByText("No Bot does anything without asking yet.");
  state.entries(ALLOWED);
  act(() => emitBotTestNotification("bots:allowed:changed", {botId: "bot:jo"}));
  await screen.findByText("Folder · ~/Team");
});
