import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import { BotsView } from "../bots-view";
import { botFixture, catalogFixture } from "./test-fixtures";
import { mountWithBotRouter } from "./test-providers";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

function store(initial: BotDefinition, options: { failUpdate?: boolean } = {}) {
  let bot = initial;
  const updates: BotUpdateInput[] = [];
  installBotTestIpc({
    "bots:list": () => [bot],
    "bots:get": () => bot,
    "bots:update": (input) => {
      const update = input as BotUpdateInput;
      updates.push(update);
      if (options.failUpdate) throw new Error("This Bot changed on another surface. Refresh it and try again.");
      const { id: _id, expectedRevision: _revision, ...fields } = update;
      bot = { ...bot, ...fields, revision: `${bot.revision}+` };
      return bot;
    },
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access: { botId: "bot-1", revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" },
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:getTelegramBinding": () => null,
  });
  return { updates, current: () => bot };
}

test("Advanced shows the current choice and opens Chat activity; Back returns to Advanced", async () => {
  store(botFixture({ chatActivity: { level: "summary", wording: "follows" } }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const row = await screen.findByRole("button", { name: "Chat activity" });
  assert.ok(within(row).getByText("Summary · Follows the work"));
  fireEvent.click(row);
  assert.ok(await screen.findByRole("heading", { name: "Chat activity" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  assert.ok(await screen.findByRole("radiogroup", { name: "What it can use" }));
});

test("each choice saves as it is picked, with the Bot's revision and nothing else changed", async () => {
  const bots = store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  assert.equal(within(level).getByRole("radio", { name: "Quiet" }).getAttribute("data-state"), "checked");
  fireEvent.click(within(level).getByRole("radio", { name: "Detailed" }));
  await waitFor(() => assert.equal(bots.updates.length, 1));
  assert.deepEqual(bots.updates[0]!.chatActivity, { level: "detailed", wording: "follows" });
  assert.equal(bots.updates[0]!.expectedRevision, "rev-1");
  assert.equal(bots.updates[0]!.name, "Planner");
  const wording = screen.getByRole("radiogroup", { name: "What the status line says" });
  fireEvent.click(within(wording).getByRole("radio", { name: "Always “Thinking”" }));
  await waitFor(() => assert.equal(bots.updates.length, 2));
  assert.deepEqual(bots.updates[1]!.chatActivity, { level: "detailed", wording: "thinking" });
  assert.equal(bots.updates[1]!.expectedRevision, "rev-1+");
  assert.equal(screen.queryByRole("button", { name: "Save" }), null, "no Save button on this page");
});

test("a choice that fails to save goes back to the saved one", async () => {
  store(botFixture(), { failUpdate: true });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  const level = await screen.findByRole("radiogroup", { name: "How much to show" });
  fireEvent.click(within(level).getByRole("radio", { name: "Summary" }));
  await waitFor(() =>
    assert.equal(within(level).getByRole("radio", { name: "Quiet" }).getAttribute("data-state"), "checked"),
  );
  assert.equal(within(level).getByRole("radio", { name: "Summary" }).getAttribute("data-state"), "unchecked");
});

test("under Reduce Motion each preview is a still frame with Play, built from the real status line", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  store(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=chat-activity" });
  await screen.findByRole("radiogroup", { name: "How much to show" });
  const follows = document.querySelector('[data-bot-chat-activity-preview="wording-follows"]') as HTMLElement;
  const thinking = document.querySelector('[data-bot-chat-activity-preview="wording-thinking"]') as HTMLElement;
  assert.ok(follows.querySelector('[data-bot-status-phase="searching"]'));
  assert.ok(thinking.querySelector('[data-bot-status-phase="thinking"]'));
  assert.ok(within(follows).getAllByText("Searching the web").length > 0);
  assert.ok(within(thinking).getAllByText("Thinking").length > 0);
  const play = screen.getByRole("button", { name: "Play preview: Detailed" });
  fireEvent.click(play);
  assert.ok(screen.getByRole("button", { name: "Pause preview: Detailed" }));
  // The phones group explains that phones always show just the line.
  assert.ok(screen.getByText("Always just the line, with the same words."));
});
