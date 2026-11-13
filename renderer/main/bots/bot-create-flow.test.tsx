import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotCreateInput } from "../../shared/bots";
import type { BotAccessUpdate } from "../../shared/bot-capabilities";
import { BOT_PRESETS, BOT_STARTER_INSTRUCTIONS, BOT_TEMPLATE_STALE_MESSAGE } from "../../shared/bot-presets";
import { BotsView } from "../bots-view";
import { BotTemplatesDialog } from "./bot-templates-dialog";
import { mountWithBotRouter } from "./test-providers";
import { botFixture, catalogFixture } from "./test-fixtures";

afterEach(cleanup);

const liveSnapshot = (botId: string, state: { kind: string }) => ({
  botId,
  epoch: "e1",
  seq: 0,
  entries: [],
  partial: null,
  state,
});

const chatHandlers = (botId: string, name: string) => ({
  "bots:get": () => botFixture({ id: botId, name }),
  "bots:live:summary": () => ({ botId, preview: null, updatedAt: null, state: { kind: "idle" } }),
  "bots:live:subscribe": () => liveSnapshot(botId, { kind: "idle" }),
});

/** Opens New bot from the empty Bots page. */
async function openNewBot() {
  fireEvent.click(await screen.findByRole("button", { name: "New bot" }));
  return screen.findByRole("dialog", { name: "New bot" });
}

test("a name and Return create a Bot with no job yet, a random look and Full access, then open its chat", async () => {
  let created: { bot: BotCreateInput; access: BotAccessUpdate } | undefined;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-9", name: "Ada" })] : []),
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": (input) => {
      created = input as typeof created;
      return botFixture({ id: "bot-9", name: "Ada" });
    },
    "bots:introduce": () => true,
    ...chatHandlers("bot-9", "Ada"),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await openNewBot();
  // One field: no model picker, no help field, no connections step.
  assert.deepEqual(within(dialog).getAllByRole("textbox").map((box) => box.getAttribute("aria-label")), ["Name your Bot"]);
  const name = within(dialog).getByRole("textbox", { name: "Name your Bot" });
  fireEvent.change(name, { target: { value: "Ada" } });
  fireEvent.keyDown(name, { key: "Enter" });

  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-9/chat"));
  assert.ok(created);
  assert.equal(created.bot.name, "Ada");
  assert.equal(created.bot.instructions, BOT_STARTER_INSTRUCTIONS);
  assert.equal(created.bot.description, undefined, "the Bot writes its own description later");
  assert.equal(created.access.accessMode, "full");
  assert.equal((created.access as { providerId?: string }).providerId, "prov-text");
  assert.deepEqual(calls.filter((call) => call.channel === "bots:introduce").map((call) => call.args[0]), ["bot-9"]);
});

test("the look picked in the dialog is the Bot's look", async () => {
  let created: { bot: BotCreateInput } | undefined;
  installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": (input) => {
      created = input as typeof created;
      return botFixture({ id: "bot-9", name: "Ada" });
    },
    "bots:introduce": () => true,
    ...chatHandlers("bot-9", "Ada"),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await openNewBot();
  fireEvent.click(within(dialog).getByRole("radio", { name: "Coral" }));
  fireEvent.click(within(dialog).getByRole("radio", { name: "Hex" }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name your Bot" }), { target: { value: "Ada" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(created));
  assert.deepEqual(created!.bot.avatar, { version: 1, color: "coral", shape: "hex" });
});

test("Cancel makes nothing, and Create waits for a name", async () => {
  const calls = installBotTestIpc({ "bots:list": () => [], "bots:getCapabilityCatalog": () => catalogFixture() });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await openNewBot();
  assert.equal((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled, true);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name your Bot" }), { target: { value: "Ada" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "New bot" }), null));
  assert.equal(calls.filter((call) => call.channel === "bots:create").length, 0);
});

test("with no AI model set up, New bot asks for one first and creates nothing", async () => {
  const calls = installBotTestIpc({ "bots:list": () => [], "bots:getCapabilityCatalog": () => catalogFixture({ models: false }) });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await openNewBot();
  await within(dialog).findByText("No AI model set up yet. Set one up first so your Bot can answer.");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name your Bot" }), { target: { value: "Ada" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Set up…" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.equal(calls.filter((call) => call.channel === "bots:create").length, 0);
});

test("the Create menu offers New bot and Templates", async () => {
  installBotTestIpc({ "bots:list": () => [], "bots:getCapabilityCatalog": () => catalogFixture(), "bots:presetBots": () => ({}) });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const trigger = await screen.findByRole("button", { name: "Create" });
  act(() => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const menu = await screen.findByRole("menu");
  assert.deepEqual(within(menu).getAllByRole("menuitem").map((item) => item.textContent), ["New bot", "Templates"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Templates" }));
  const templates = await screen.findByRole("dialog", { name: "Templates" });
  assert.deepEqual(
    within(within(templates).getByRole("list", { name: "Templates" })).getAllByRole("button").map((card) => card.getAttribute("aria-label")),
    BOT_PRESETS.map((preset) => `${preset.name}: ${preset.subtitle}`),
  );
});

test("a template's detail shows what it adds, paused, and the apps it works with; Create bot makes it and opens its chat", async () => {
  let createdWith: unknown;
  installBotTestIpc({
    "bots:list": () => [],
    "bots:presetBots": () => ({}),
    "bots:createFromPreset": (input) => {
      createdWith = input;
      return { bot: botFixture({ id: "bot-mp", name: "Meal Planner" }), created: true };
    },
    ...chatHandlers("bot-mp", "Meal Planner"),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "Templates" }));
  const templates = await screen.findByRole("dialog", { name: "Templates" });
  fireEvent.click(within(templates).getByRole("button", { name: /^Meal Planner:/u }));
  const detail = await screen.findByRole("dialog", { name: "Meal Planner" });
  const adds = within(detail).getByRole("region", { name: "Adds" });
  within(adds).getByRole("button", { name: "Instructions" });
  within(adds).getByRole("button", { name: /paused until you turn it on$/u });
  const works = within(detail).getByRole("region", { name: "Works with" });
  within(works).getByText("Not connected");
  fireEvent.click(within(detail).getByRole("button", { name: "Create bot" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-mp/chat"));
  assert.deepEqual(createdWith, { presetId: "meal-planner", version: BOT_PRESETS.find((preset) => preset.id === "meal-planner")!.version });
});

test("a template whose Bot exists offers Open, which opens that Bot without making another", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:presetBots": () => ({ researcher: "bot-r" }),
    ...chatHandlers("bot-r", "Researcher"),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "Templates" }));
  const templates = await screen.findByRole("dialog", { name: "Templates" });
  fireEvent.click(within(templates).getByRole("button", { name: /^Researcher:/u }));
  const detail = await screen.findByRole("dialog", { name: "Researcher" });
  fireEvent.click(await within(detail).findByRole("button", { name: "Open" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-r/chat"));
  assert.equal(calls.filter((call) => call.channel === "bots:createFromPreset").length, 0);
});

test("a detail shown from an older version of a template says it changed and opens nothing", async () => {
  const stale = BOT_PRESETS.map((preset) => (preset.id === "inbox-helper" ? { ...preset, version: preset.version - 1 } : preset));
  installBotTestIpc({
    "bots:presetBots": () => ({}),
    "bots:createFromPreset": (input) => {
      const { version } = input as { version: number };
      if (version !== BOT_PRESETS.find((preset) => preset.id === "inbox-helper")!.version) throw new Error(BOT_TEMPLATE_STALE_MESSAGE);
      return { bot: botFixture({ id: "bot-i" }), created: true };
    },
  });
  const opened: string[] = [];
  await mountWithBotRouter(<BotTemplatesDialog open onOpenChange={() => undefined} onOpenChat={(bot) => opened.push(bot.id)} presets={stale} />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: /^Inbox Helper:/u }));
  fireEvent.click(await screen.findByRole("button", { name: "Create bot" }));
  await screen.findByText(BOT_TEMPLATE_STALE_MESSAGE);
  assert.deepEqual(opened, []);
});
