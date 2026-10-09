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

test("instructions Back with unsaved edits asks first: Cancel keeps editing, Discard leaves without saving", async () => {
  const store = botStoreIpc(botFixture({ instructions: "Plan trips." }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });

  fireEvent.click(await screen.findByRole("button", { name: "Instructions" }));
  const editor = await screen.findByRole("textbox", { name: "Instructions for Planner" });
  fireEvent.change(editor, { target: { value: "Plan cheap trips by train." } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));

  const confirm = await screen.findByRole("alertdialog");
  assert.ok(within(confirm).getByRole("heading", { name: "Discard changes?" }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
  assert.equal(
    (screen.getByRole("textbox", { name: "Instructions for Planner" }) as HTMLTextAreaElement).value,
    "Plan cheap trips by train.",
    "Cancel keeps the draft",
  );

  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
  await screen.findByRole("button", { name: "Instructions" });
  assert.equal(store.updates.length, 0);
});

test("instructions Back with nothing changed leaves at once, and Save keeps the new text", async () => {
  const store = botStoreIpc(botFixture({ instructions: "Plan trips." }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });

  fireEvent.click(await screen.findByRole("button", { name: "Instructions" }));
  await screen.findByRole("textbox", { name: "Instructions for Planner" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Instructions" });
  assert.equal(screen.queryByRole("alertdialog"), null);

  fireEvent.click(screen.getByRole("button", { name: "Instructions" }));
  const editor = (await screen.findByRole("textbox", { name: "Instructions for Planner" })) as HTMLTextAreaElement;
  assert.equal(editor.value, "Plan trips.");
  fireEvent.change(editor, { target: { value: "Plan cheap trips by train." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByRole("button", { name: "Instructions" });
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0]!.instructions, "Plan cheap trips by train.");
  assert.equal(store.updates[0]!.name, "Planner");
  assert.equal(store.current().instructions, "Plan cheap trips by train.");
});

test("instructions can't be saved empty, and the editor says why", async () => {
  const store = botStoreIpc(botFixture({ instructions: "Plan trips." }));
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  fireEvent.click(await screen.findByRole("button", { name: "Instructions" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Instructions for Planner" }), {
    target: { value: "   " },
  });
  assert.ok(screen.getByText("Instructions can’t be empty."));
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  assert.equal(save.disabled, true);
  fireEvent.click(save);
  assert.equal(store.updates.length, 0);
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

test("Advanced shows the model, image model, access and Telegram controls, and no opening greeting", async () => {
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
  assert.equal(screen.queryByRole("textbox", { name: "Opening greeting" }), null);
  assert.equal(screen.queryByText(/Opening greeting/u), null);
  assert.ok(await screen.findByRole("button", { name: /Connect Telegram/u }));
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);

  fireEvent.click(within(access).getByRole("radio", { name: "Only what I choose" }));
  assert.ok(await screen.findByRole("switch", { name: "Allow Mail" }));
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false);
});

function advancedIpc() {
  const accessUpdates: unknown[] = [];
  const store = botStoreIpc(botFixture(), {
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access: { botId: "bot-1", revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" },
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:updateBotAccess": (input) => {
      accessUpdates.push(input);
      return {};
    },
    "bots:getTelegramBinding": () => null,
  });
  return { ...store, accessUpdates };
}

test("Advanced saves access with the toolbar's one Save, then has nothing left to save", async () => {
  const store = advancedIpc();
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const access = await screen.findByRole("radiogroup", { name: "What it can use" });
  fireEvent.click(within(access).getByRole("radio", { name: "Only what I choose" }));
  // No separate access save button: the toolbar's Save is the only one.
  assert.deepEqual(
    screen.getAllByRole("button").map((button) => button.textContent).filter((text) => /save/iu.test(text ?? "")),
    ["Save"],
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => assert.equal(store.accessUpdates.length, 1));
  assert.deepEqual((store.accessUpdates[0] as { access: { accessMode: string } }).access.accessMode, "custom");
  assert.equal(store.updates.length, 0, "an access save leaves the Bot's identity alone");
  await waitFor(() =>
    assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true),
  );
});

test("Advanced Back with an unsaved access change asks before discarding it", async () => {
  const store = advancedIpc();
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const access = await screen.findByRole("radiogroup", { name: "What it can use" });
  fireEvent.click(within(access).getByRole("radio", { name: "Only what I choose" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
  await screen.findByRole("button", { name: "Instructions" });
  assert.equal(router.state.location.pathname, "/bots/bot-1");
  assert.equal(store.updates.length, 0);
  assert.equal(store.accessUpdates.length, 0);
});
