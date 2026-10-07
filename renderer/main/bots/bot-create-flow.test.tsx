import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotCreateInput } from "../../shared/bots";
import type { BotAccessUpdate } from "../../shared/bot-capabilities";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";
import { botFixture, catalogFixture } from "./test-fixtures";

afterEach(cleanup);

async function createBot(name: string, help: string) {
  fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
  const dialog = await screen.findByRole("dialog", { name: "New Bot" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it help with?" }), {
    target: { value: help },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
}

test("a name and what it helps with are enough to create a Bot and open its chat", async () => {
  let created: { bot: BotCreateInput; access: BotAccessUpdate } | undefined;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-9", name: "Meal Planner" })] : []),
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": (input) => {
      created = input as typeof created;
      return botFixture({ id: "bot-9", name: "Meal Planner", description: created!.bot.description });
    },
    "bots:sessionState": () => ({ kind: "idle" }),
    "bots:openChat": () => ({ chatId: "chat-9", title: "New chat", updatedAt: 2 }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await createBot("Meal Planner", "Plan my meals every week");

  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-9/chat/chat-9"));
  assert.ok(created);
  assert.equal(created.bot.name, "Meal Planner");
  assert.equal(created.bot.description, "Plan my meals every week");
  assert.match(created.bot.instructions, /Plan my meals every week/u);
  // The recommended model is the first one set up; it reads text only, so the
  // first model that reads images handles photos.
  assert.deepEqual(created.access, {
    accessMode: "full",
    catalogRevision: "catalog-1",
    confirmedForeground: true,
    providerId: "prov-text",
    modelId: "model-text",
    visionModel: { providerId: "prov-vision", modelId: "model-vision" },
  });
  assert.equal(calls.some((call) => call.channel === "bots:acknowledgeAccessNotice"), false);
});

test("with no AI model the Bot is still created and its chat asks for one", async () => {
  let created = false;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-2", name: "Researcher" })] : []),
    "bots:getCapabilityCatalog": () => catalogFixture({ models: false, accepted: false }),
    "bots:acknowledgeAccessNotice": () => ({}),
    "bots:create": () => {
      created = true;
      return botFixture({ id: "bot-2", name: "Researcher" });
    },
    "bots:sessionState": () => ({ kind: "needs_model" }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await createBot("Researcher", "");

  const status = await screen.findByRole("status");
  assert.ok(within(status).getByText("Needs an AI model"));
  assert.equal(calls.some((call) => call.channel === "bots:openChat"), false);
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);
  const access = calls.find((call) => call.channel === "bots:create")?.args[0] as { access: BotAccessUpdate };
  assert.equal("providerId" in access.access, false);

  fireEvent.click(within(status).getByRole("button", { name: "Set up" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.deepEqual({ ...router.state.location.search }, { section: "providers" });
});

test("a Bot that needs a model asks for one instead of opening its chat", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:sessionState": () => ({ kind: "needs_model" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const row = await screen.findByRole("button", { name: /Planner/u });
  await waitFor(() => assert.ok(within(row).getByText("Needs an AI model")));
  fireEvent.click(row);
  assert.ok(await screen.findByRole("button", { name: "Set up" }));
  assert.equal(calls.some((call) => call.channel === "bots:openChat"), false);
});

test("an interrupted Bot's row reads Paused", async () => {
  installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:sessionState": () => ({ kind: "interrupted", submissionId: "s-1" }),
    "bots:openChat": () => ({ chatId: "chat-1", title: "Lisbon", updatedAt: 1 }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const row = await screen.findByRole("button", { name: /Planner/u });
  await waitFor(() => assert.ok(within(row).getByText("Paused — tap to resume")));
});
