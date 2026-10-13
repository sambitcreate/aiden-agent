import { installBotTestIpc } from "./test-dom";
import { MCP_PRESETS } from "../../../main/services/mcp-presets";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotCreateInput } from "../../shared/bots";
import type { BotAccessUpdate } from "../../shared/bot-capabilities";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";
import { botFixture, catalogFixture } from "./test-fixtures";

afterEach(cleanup);

async function fillNameStep(name: string, help: string) {
  fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
  const dialog = await screen.findByRole("dialog", { name: "New Bot" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it help with?" }), {
    target: { value: help },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  return dialog;
}

const liveSnapshot = (botId: string, state: { kind: string }) => ({
  botId,
  epoch: "e1",
  seq: 0,
  entries: [],
  partial: null,
  state,
});

test("name and what it helps with create a Bot, offer connections, and open its chat", async () => {
  let created: { bot: BotCreateInput; access: BotAccessUpdate } | undefined;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-9", name: "Meal Planner" })] : []),
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": (input) => {
      created = input as typeof created;
      return botFixture({ id: "bot-9", name: "Meal Planner", description: created!.bot.description });
    },
    "bots:introduce": () => true,
    "bots:get": () => botFixture({ id: "bot-9", name: "Meal Planner" }),
    "bots:live:summary": () => ({ botId: "bot-9", preview: null, updatedAt: null, state: { kind: "idle" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-9", { kind: "idle" }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Meal Planner", "Plan my meals and email the grocery list");

  // Step two offers chips ranked from the answer; Gmail is one of them.
  const chips = within(dialog).getByRole("list", { name: "Suggested connections" });
  assert.ok(within(chips).getByRole("button", { name: "Connect Gmail" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-9/chat"));
  assert.ok(created);
  assert.equal(created.bot.name, "Meal Planner");
  assert.equal(created.bot.description, "Plan my meals and email the grocery list");
  assert.deepEqual(created.access, {
    accessMode: "full",
    catalogRevision: "catalog-1",
    confirmedForeground: true,
    providerId: "prov-text",
    modelId: "model-text",
    visionModel: { providerId: "prov-vision", modelId: "model-vision" },
  });
  const introduced = calls.filter((call) => call.channel === "bots:introduce");
  assert.deepEqual(introduced.map((call) => call.args[0]), ["bot-9"]);
});

test("with no AI model the Bot is still created and its chat asks for one, with no self-intro", async () => {
  let created = false;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-2", name: "Researcher" })] : []),
    "bots:getCapabilityCatalog": () => catalogFixture({ models: false, accepted: false }),
    "bots:acknowledgeAccessNotice": () => ({}),
    "bots:create": () => {
      created = true;
      return botFixture({ id: "bot-2", name: "Researcher" });
    },
    "bots:get": () => botFixture({ id: "bot-2", name: "Researcher" }),
    "bots:live:summary": () => ({ botId: "bot-2", preview: null, updatedAt: null, state: { kind: "needs_model" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-2", { kind: "needs_model" }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Researcher", "");
  // Connections are optional: Create goes ahead without any.
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  assert.equal(calls.some((call) => call.channel === "bots:introduce"), false);
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);
  const access = calls.find((call) => call.channel === "bots:create")?.args[0] as { access: BotAccessUpdate };
  assert.equal("providerId" in access.access, false);
});

test("Back on the connections step returns to the first step with the draft kept, without closing", async () => {
  const calls = installBotTestIpc({ "bots:list": () => [] });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Meal Planner", "Plan my meals");
  assert.ok(within(dialog).getByRole("list", { name: "Suggested connections" }));

  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));

  const firstStep = await screen.findByRole("dialog", { name: "New Bot" });
  assert.equal((within(firstStep).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Meal Planner");
  assert.equal(
    (within(firstStep).getByRole("textbox", { name: "What should it help with?" }) as HTMLTextAreaElement).value,
    "Plan my meals",
  );
  assert.equal(calls.some((call) => call.channel === "bots:create"), false);
  // Next goes forward again from the kept draft.
  fireEvent.click(within(firstStep).getByRole("button", { name: "Next" }));
  assert.ok(await screen.findByRole("dialog", { name: "Connections" }));
});

test("connection chips start an app's setup, and an app already connected on this Mac shows as connected", async () => {
  const presets = MCP_PRESETS.map((preset) => ({
    preset,
    serverId: `preset-${preset.id}`,
    // Notion is already set up, switched on, and signed in.
    configured: preset.id === "notion",
    enabled: preset.id === "notion",
    ready: preset.id === "notion",
  }));
  installBotTestIpc({
    "bots:list": () => [],
    "mcp:list": () => [],
    "mcp:presets": () => presets,
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Notes Helper", "Keep my notes and email tidy");
  const chips = within(dialog).getByRole("list", { name: "Suggested connections" });
  await waitFor(() => assert.ok(within(chips).getByText("connected")));
  assert.equal(within(chips).queryByRole("button", { name: "Connect Notion" }), null);

  fireEvent.click(within(chips).getByRole("button", { name: "Connect Gmail" }));
  // The app's own setup opens on top; the create dialog keeps its place underneath.
  await waitFor(() => assert.equal(document.querySelectorAll('[role="dialog"]').length, 2));
  const [create, setup] = Array.from(document.querySelectorAll('[role="dialog"]'));
  assert.match(create!.textContent ?? "", /Connections/u);
  assert.match(setup!.textContent ?? "", /Gmail|Composio/u);
});
