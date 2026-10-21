import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createBotRuleStore } from "../../../main/services/bot-rules/store";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import type { BotRulesUpdateInput } from "../../shared/bot-rules";
import { BotRules } from "./bot-rules";
import { mountWithBotRouter } from "./test-providers";

afterEach(cleanup);
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const bot = { id: "bot-1", name: "Planner" };

/** The real rules store behind the fake IPC, so revisions and refusals are main's own. */
function rulesIpc() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-rules-ui-"));
  roots.push(root);
  const store = createBotRuleStore({ profileDir: root, knownBot: async (botId) => botId === bot.id });
  const calls = installBotTestIpc({
    "bots:rules:get": (botId) => store.get(String(botId)),
    "bots:rules:update": (input) => {
      const { botId, revision, change } = input as BotRulesUpdateInput;
      return store.update(botId, revision, change);
    },
  });
  const updates = () => calls.filter((call) => call.channel === "bots:rules:update");
  return { store, updates };
}

async function mount() {
  await mountWithBotRouter(<BotRules bot={bot} />, { initialPath: "/bots/bot-1" });
  return screen.findByRole("list", { name: "Rules" });
}

function row(list: HTMLElement, title: string): HTMLElement {
  return within(list).getByText(title).closest("li")!;
}

async function openMenu(title: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Change rule: ${title}` }), { key: "Enter" });
  return screen.findByRole("menu");
}

test("every rule says what the Bot does; locked rules say Always and can't be changed", async () => {
  rulesIpc();
  const list = await mount();
  assert.equal(within(list).getAllByRole("listitem").length, 7);
  for (const locked of ["Enter a password or 2FA code, or change account security", "Move money or enter card details"]) {
    const item = row(list, locked);
    assert.ok(within(item).getByText("Hand off to me"));
    assert.ok(within(item).getByText("Always"));
    assert.ok(!within(item).queryByRole("button"), `${locked} has no menu`);
  }
  const purchase = row(list, "Make a purchase or booking");
  assert.ok(within(purchase).getByText("Ask first"));
  assert.ok(!within(purchase).queryByText("Always"));
  assert.ok(screen.getByText("Rules don’t cover shell commands; the Shell setting does, and commands in a Bot’s own computer follow its Bot computer access."));
});

test("a built-in rule switches to Hand off to me from its menu, which has no Edit or Delete", async () => {
  const { store, updates } = rulesIpc();
  const list = await mount();
  const menu = await openMenu("Make a purchase or booking");
  assert.deepEqual(
    within(menu).getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    [
      ["Ask first", "true"],
      ["Hand off to me", "false"],
    ],
  );
  assert.ok(!within(menu).queryByRole("menuitem"));
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Hand off to me" }));

  await waitFor(() => assert.ok(within(row(list, "Make a purchase or booking")).getByText("Hand off to me")));
  assert.equal(updates().length, 1);
  const saved = (await store.rules(bot.id)).find((rule) => rule.id === "default.purchase");
  assert.equal(saved?.behavior, "hand_off");
});

test("Add a rule saves the person's words with the behavior they picked", async () => {
  const { store } = rulesIpc();
  const list = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a rule" });
  assert.equal(within(dialog).getByRole("radio", { name: /^Ask first/u }).getAttribute("aria-checked"), "true");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "When Planner wants to" }), { target: { value: "book a flight" } });
  fireEvent.click(within(dialog).getByRole("radio", { name: /^Hand off to me/u }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  await waitFor(() => assert.ok(!screen.queryByRole("dialog"), "the dialog closed"));
  const item = row(list, "When Planner wants to book a flight");
  assert.ok(within(item).getByText("Hand off to me"));
  const custom = (await store.rules(bot.id)).filter((rule) => rule.actionClass === undefined);
  assert.deepEqual(
    custom.map((rule) => [rule.text, rule.behavior, rule.locked]),
    [["book a flight", "hand_off", false]],
  );
});

test("the person's own rule can be edited and deleted from its menu", async () => {
  const { store } = rulesIpc();
  await store.update(bot.id, 0, { type: "add_custom", text: "order food", behavior: "ask" });
  const list = await mount();

  fireEvent.click(within(await openMenu("When Planner wants to order food")).getByRole("menuitem", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit rule" });
  const field = within(dialog).getByRole("textbox", { name: "When Planner wants to" }) as HTMLInputElement;
  assert.equal(field.value, "order food");
  fireEvent.change(field, { target: { value: "order groceries" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.ok(within(list).getByText("When Planner wants to order groceries")));
  assert.ok(!within(list).queryByText("When Planner wants to order food"));

  fireEvent.click(within(await openMenu("When Planner wants to order groceries")).getByRole("menuitem", { name: "Delete" }));
  await waitFor(() => assert.ok(!within(list).queryByText("When Planner wants to order groceries")));
  assert.equal((await store.rules(bot.id)).some((rule) => rule.actionClass === undefined), false);
  assert.equal(within(list).getAllByRole("listitem").length, 7);
});

test("a rule the store refuses keeps the dialog open and says why", async () => {
  const { store } = rulesIpc();
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a rule" });
  const field = within(dialog).getByRole("textbox", { name: "When Planner wants to" });

  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.match((await within(dialog).findByRole("alert")).textContent ?? "", /Say what Planner might do/u);

  // Only words that match nothing.
  fireEvent.change(field, { target: { value: "do something" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.match(within(dialog).getByRole("alert").textContent ?? "", /book a flight/u));
  assert.ok(screen.getByRole("dialog", { name: "Add a rule" }));
  assert.equal((await store.get(bot.id)).revision, 0, "nothing was saved");
});

test("a change made against rules another window changed says so and shows the current rules", async () => {
  const { store } = rulesIpc();
  const list = await mount();
  // Another window changes a rule after this one loaded them.
  await store.update(bot.id, 0, { type: "set_behavior", ruleId: "default.delete", behavior: "hand_off" });

  fireEvent.click(within(await openMenu("Send a message or email to someone")).getByRole("menuitemradio", { name: "Hand off to me" }));
  assert.match((await screen.findByRole("alert")).textContent ?? "", /changed somewhere else/u);
  await waitFor(() => assert.ok(within(row(list, "Permanently delete something")).getByText("Hand off to me")));
  assert.ok(within(row(list, "Send a message or email to someone")).getByText("Ask first"));
  assert.equal((await store.rules(bot.id)).find((rule) => rule.id === "default.communicate")?.behavior, "ask");
});

test("where Bots have their own computers, the rules say they read the Bot's stated intent there", async () => {
  const note =
    "On Planner’s own computer, rules read Planner’s stated intent, and with element control the button or field it acts on; Planner is told to hand off passwords and payments.";
  rulesIpc();
  await mountWithBotRouter(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", bots: true, botComputers: true }}>
      <BotRules bot={bot} />
    </AppCapabilitiesProvider>,
    { initialPath: "/bots/bot-1" },
  );
  await screen.findByRole("list", { name: "Rules" });
  assert.ok(screen.getByText(note));
  cleanup();

  // Linux and Intel Macs have no Bot computers, so the note never shows.
  rulesIpc();
  await mount();
  assert.equal(screen.queryByText(note), null);
});
