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

type FullAccessUpdate = Extract<BotAccessUpdate, { accessMode: "full" }>;

afterEach(cleanup);

async function fillNameStep(name: string, help: string, beforeNext?: (dialog: HTMLElement) => Promise<void>) {
  fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
  const dialog = await screen.findByRole("dialog", { name: "New Bot" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it help with?" }), {
    target: { value: help },
  });
  await beforeNext?.(dialog);
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
    webSearchEnabled: true,
    visionModel: { providerId: "prov-vision", modelId: "model-vision" },
  });
  const introduced = calls.filter((call) => call.channel === "bots:introduce");
  assert.deepEqual(introduced.map((call) => call.args[0]), ["bot-9"]);
});

test("the AI model field starts on the recommended model and its photo model", async () => {
  installBotTestIpc({ "bots:list": () => [], "bots:getCapabilityCatalog": () => catalogFixture() });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
  const dialog = await screen.findByRole("dialog", { name: "New Bot" });
  const model = await within(dialog).findByRole("button", { name: "AI model" });
  assert.match(model.textContent ?? "", /Writer.*Recommended/u);
  assert.match(within(dialog).getByRole("button", { name: "Model for photos" }).textContent ?? "", /Seer/u);
});

test("choosing a model that reads images creates the Bot with it and no photo model", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": () => botFixture({ id: "bot-9", name: "Seer Bot" }),
    "bots:introduce": () => true,
    "bots:get": () => botFixture({ id: "bot-9", name: "Seer Bot" }),
    "bots:live:summary": () => ({ botId: "bot-9", preview: null, updatedAt: null, state: { kind: "idle" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-9", { kind: "idle" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Seer Bot", "", async (step) => {
    fireEvent.click(await within(step).findByRole("button", { name: "AI model" }));
    fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
    assert.equal(within(step).queryByRole("button", { name: "Model for photos" }) === null, true);
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:create")));
  const { access } = calls.find((call) => call.channel === "bots:create")!.args[0] as { access: FullAccessUpdate };
  assert.equal(access.providerId, "prov-vision");
  assert.equal(access.modelId, "model-vision");
  assert.equal("visionModel" in access, false);
});

test("a chosen model that is gone by Create stops on the first step and creates nothing", async () => {
  let catalog = catalogFixture();
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => catalog,
    "bots:create": () => botFixture({ id: "bot-9" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Seer Bot", "", async (step) => {
    fireEvent.click(await within(step).findByRole("button", { name: "AI model" }));
    fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  });
  // Seer's service is signed out before Create.
  catalog = {
    ...catalog,
    providers: catalog.providers.map((provider) =>
      provider.id === "prov-vision" ? { ...provider, available: false } : provider),
  };
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  const step1 = await screen.findByRole("dialog", { name: "New Bot" });
  assert.ok(await within(step1).findByText("That model isn’t available any more. Choose another one."));
  assert.equal(calls.some((call) => call.channel === "bots:create"), false);

  // Choosing another model answers the message, so it goes away, and stays gone on the next step.
  fireEvent.click(within(step1).getByRole("button", { name: "AI model" }));
  fireEvent.click(await screen.findByRole("option", { name: /^Writer/u }));
  await waitFor(() => assert.equal(within(step1).queryByRole("alert") === null, true));
  fireEvent.click(within(step1).getByRole("button", { name: "Next" }));
  const step2 = await screen.findByRole("dialog", { name: "Connections" });
  assert.equal(within(step2).queryByRole("alert") === null, true);
});

test("a refresh of the models that fails keeps the last list on screen", async () => {
  let catalog = catalogFixture();
  let catalogCalls = 0;
  installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => {
      catalogCalls += 1;
      // The dialog's load and Create's own check succeed; the refresh after it fails.
      if (catalogCalls > 2) throw new Error("offline");
      return catalog;
    },
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Seer Bot", "", async (step) => {
    fireEvent.click(await within(step).findByRole("button", { name: "AI model" }));
    fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  });
  catalog = {
    ...catalog,
    providers: catalog.providers.map((provider) =>
      provider.id === "prov-vision" ? { ...provider, available: false } : provider),
  };
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  const step1 = await screen.findByRole("dialog", { name: "New Bot" });
  assert.ok(await within(step1).findByText("That model isn’t available any more. Choose another one."));
  await waitFor(() => assert.equal(catalogCalls > 2, true));
  assert.ok(within(step1).getByRole("button", { name: "AI model" }));
  assert.equal(within(step1).queryByText("Aiden couldn’t load your models.") === null, true);
});

test("if the models can't be loaded the field says so, and the Bot is still created with the recommended model", async () => {
  let failCatalog = true;
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => {
      if (failCatalog) throw new Error("offline");
      return catalogFixture();
    },
    "bots:create": () => botFixture({ id: "bot-9", name: "Planner" }),
    "bots:introduce": () => true,
    "bots:get": () => botFixture({ id: "bot-9", name: "Planner" }),
    "bots:live:summary": () => ({ botId: "bot-9", preview: null, updatedAt: null, state: { kind: "idle" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-9", { kind: "idle" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Planner", "", async (step) => {
    assert.ok(await within(step).findByText("Aiden couldn’t load your models."));
    assert.ok(within(step).getByRole("button", { name: "Try again" }));
    failCatalog = false;
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:create")));
  const { access } = calls.find((call) => call.channel === "bots:create")!.args[0] as { access: FullAccessUpdate };
  assert.equal(access.modelId, "model-text");
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
  const dialog = await fillNameStep("Researcher", "", async (step) => {
    assert.ok(await within(step).findByText(/No AI model set up yet/u));
    assert.ok(within(step).getByRole("button", { name: "Set up…" }));
  });
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

test("Create opens the new Bot's chat before its self-intro and the list reread answer", async () => {
  let finishIntro: (value: boolean) => void = () => undefined;
  let listReads = 0;
  const calls = installBotTestIpc({
    "bots:list": () => {
      listReads += 1;
      // The reread after create never answers during this test.
      return listReads === 1 ? [] : new Promise<never>(() => undefined);
    },
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": () => botFixture({ id: "bot-9", name: "Meal Planner" }),
    "bots:introduce": () => new Promise<boolean>((resolve) => (finishIntro = resolve)),
    "bots:get": () => botFixture({ id: "bot-9", name: "Meal Planner" }),
    "bots:live:summary": () => ({ botId: "bot-9", preview: null, updatedAt: null, state: { kind: "idle" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-9", { kind: "idle" }),
  });
  const { router, queryClient } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Meal Planner", "Plan my meals");
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-9/chat"));
  assert.equal(calls.filter((call) => call.channel === "bots:introduce").length, 1, "the intro was started");
  const listed = queryClient.getQueryData<ReturnType<typeof botFixture>[]>(["bots", "active"]);
  assert.deepEqual(listed?.map((bot) => bot.id), ["bot-9"], "the new Bot is in the list before the reread answers");
  finishIntro(true);
});
