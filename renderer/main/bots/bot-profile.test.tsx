import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";
import { botFixture, catalogFixture } from "./test-fixtures";

afterEach(cleanup);

/** An in-memory Bot store behind the fake IPC, so saves round-trip. */
function botStoreIpc(initial: BotDefinition, extra: Record<string, (...args: unknown[]) => unknown> = {}) {
  let bot = initial;
  const updates: BotUpdateInput[] = [];
  const calls = installBotTestIpc({
    "bots:list": () => [bot],
    "bots:get": () => bot,
    "bots:update": (input) => {
      const update = input as BotUpdateInput;
      updates.push(update);
      const { id: _id, expectedRevision: _revision, ...fields } = update;
      bot = { ...bot, ...fields, revision: `${bot.revision}+` };
      return bot;
    },
    ...extra,
  });
  return { calls, updates, current: () => bot };
}

async function openMenu(name: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name }), { key: "Enter" });
}

test("instructions Save keeps the new text, and Back without saving discards it", async () => {
  const store = botStoreIpc(botFixture({ instructions: "Plan trips." }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });

  fireEvent.click(await screen.findByRole("button", { name: "Instructions" }));
  const editor = screen.getByRole("textbox", { name: "Instructions for Planner" });
  fireEvent.change(editor, { target: { value: "Plan cheap trips by train." } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  assert.equal(store.updates.length, 0);

  fireEvent.click(await screen.findByRole("button", { name: "Instructions" }));
  const reopened = screen.getByRole("textbox", { name: "Instructions for Planner" }) as HTMLTextAreaElement;
  assert.equal(reopened.value, "Plan trips.");
  fireEvent.change(reopened, { target: { value: "Plan cheap trips by train." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByRole("button", { name: "Instructions" });
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0]!.instructions, "Plan cheap trips by train.");
  assert.equal(store.updates[0]!.name, "Planner");
  assert.equal(store.current().instructions, "Plan cheap trips by train.");
});

test("editing the name inline saves it when the field loses focus", async () => {
  const store = botStoreIpc(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  const name = await screen.findByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Trip Planner" } });
  fireEvent.blur(name);
  await waitFor(() => assert.equal(store.updates[store.updates.length - 1]?.name, "Trip Planner"));
  assert.equal(store.updates[0]!.instructions, "Plan trips.");
});

test("the Profile ••• menu holds Advanced and Delete Bot", async () => {
  botStoreIpc(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  await openMenu("More for Planner");
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Advanced", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Bot" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Delete Planner?" }));
});

test("Advanced shows the model, image model, access, greeting, and Telegram controls", async () => {
  botStoreIpc(botFixture(), {
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access: { botId: "bot-1", revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" },
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:getTelegramBinding": () => null,
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  await openMenu("More for Planner");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Advanced" }));

  assert.ok(await screen.findByRole("combobox", { name: "AI model" }));
  assert.ok(screen.getByRole("combobox", { name: "AI service" }));
  assert.ok(screen.getByRole("combobox", { name: "Image model" }));
  assert.ok(screen.getByRole("button", { name: /Use recommended/u }));
  const access = screen.getByRole("radiogroup", { name: "What it can use" });
  assert.equal(within(access).getByRole("radio", { name: "Everything" }).getAttribute("aria-checked"), "true");
  assert.ok(screen.getByRole("textbox", { name: "Opening greeting" }));
  assert.ok(await screen.findByRole("button", { name: /Connect Telegram/u }));
  assert.equal(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    true,
  );

  fireEvent.click(within(access).getByRole("radio", { name: "Only what I choose" }));
  assert.ok(await screen.findByRole("switch", { name: "Allow Mail" }));
  assert.equal(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    false,
  );
});
