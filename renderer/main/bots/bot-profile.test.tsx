import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import type { BotSessionState } from "./bot-session-state";
import { useQueryClient } from "@tanstack/react-query";
import { useBotNotificationsSync } from "../../lib/bot-notifications-sync";
import { BotsView } from "../bots-view";
import { createBotTestQueryClient, mountWithBotRouter } from "./test-providers";
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
      // Like main: an update without a description clears it.
      const { description: _dropped, ...kept } = bot;
      bot = { ...kept, ...fields, revision: `${bot.revision}+` };
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

test("Escape abandons an inline name edit instead of saving it", async () => {
  const store = botStoreIpc(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
  name.focus();
  fireEvent.change(name, { target: { value: "Trip Planner" } });
  fireEvent.keyDown(name, { key: "Escape" });
  await waitFor(() => assert.equal(name.value, "Planner"));
  assert.equal(document.activeElement === name, false);
  assert.equal(store.updates.length, 0);

  // The next edit still saves on Enter.
  name.focus();
  fireEvent.change(name, { target: { value: "Trip Planner" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal(store.updates[0]!.name, "Trip Planner");
});

test("the Profile ••• menu holds Advanced, Pause Bot and Delete Bot", async () => {
  botStoreIpc(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  await openMenu("More for Planner");
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Advanced", "Pause Bot", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Bot" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Delete Planner?" }));
});

test("the Profile shows the Bot's rules after its routines", async () => {
  botStoreIpc(botFixture());
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  const rules = await screen.findByRole("list", { name: "Rules" });
  assert.ok(within(rules).getByText("Move money or enter card details"));
  const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  assert.ok(headings.includes("Routines") && headings.indexOf("Rules") > headings.indexOf("Routines"), headings.join(", "));
});

test("a paused Bot's Profile ••• menu resumes it, and a running one's pauses it", async () => {
  let state: BotSessionState = { kind: "paused", since: 1, by: "phone" };
  const { calls } = botStoreIpc(botFixture(), {
    "bots:live:summary": (botId) => ({ botId, preview: null, updatedAt: null, state, needsYou: false, lastReplyAt: null }),
    "bots:unpause": () => (state = { kind: "idle" }),
    "bots:pause": () => (state = { kind: "paused", since: 2, by: "mac" }),
  });
  // As in the app window: main's `bots:changed` re-reads the Bot's summary.
  const Sync = () => {
    useBotNotificationsSync(useQueryClient());
    return null;
  };
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1", sidebar: <Sync /> });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:live:summary")));
  await openMenu("More for Planner");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Resume Bot" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:unpause").map((call) => call.args), [["bot-1"]]));

  act(() => emitBotTestNotification("bots:changed", { botId: "bot-1", session: state }));
  await openMenu("More for Planner");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pause Bot" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:pause").map((call) => call.args), [["bot-1"]]));
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

  const model = await screen.findByRole("button", { name: "AI model" });
  assert.match(model.textContent ?? "", /Writer/u);
  assert.ok(screen.getByRole("button", { name: "Model for photos" }));
  assert.equal(screen.queryByRole("combobox", { name: "AI service" }), null);
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

test("Advanced names only the model in its control, says what it reads under the label, and saves a new choice", async () => {
  const { accessUpdates } = advancedIpc();
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const model = await screen.findByRole("button", { name: "AI model" });
  assert.doesNotMatch(model.textContent ?? "", /Text only|Reads images/u);
  assert.ok(screen.getByText("Text only"), "the capability is the row's description");

  fireEvent.click(model);
  fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  assert.equal(screen.queryByRole("button", { name: "Model for photos" }), null, "Seer reads images");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(accessUpdates.length, 1));
  const sent = (accessUpdates[0] as { access: { modelId?: string; visionModel?: unknown } }).access;
  assert.equal(sent.modelId, "model-vision");
  assert.equal(sent.visionModel, null, "a model that reads images clears the stale photo model");
});

function advancedIpc() {
  const accessUpdates: unknown[] = [];
  // Like main: a save answers with the saved access view alone, and the next read returns it.
  let access: Record<string, unknown> = { botId: "bot-1", revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" };
  const store = botStoreIpc(botFixture(), {
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access,
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:updateBotAccess": (input) => {
      accessUpdates.push(input);
      const { access: update } = input as { access: { accessMode: string; custom?: unknown } };
      access = {
        botId: "bot-1",
        revision: `${String(access.revision)}+`,
        policyEpoch: "e",
        summary: "",
        accessMode: update.accessMode,
        ...(update.custom ? { custom: update.custom } : {}),
      };
      return access;
    },
    "bots:getTelegramBinding": () => null,
  });
  return { ...store, accessUpdates };
}

test("Advanced saves access with the toolbar's one Save, then has nothing left to save, and opens again on the saved choice", async () => {
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

  // Back to the Profile and into Advanced again: the page opens on what was saved.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Instructions" });
  await openMenu("More for Planner");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Advanced" }));
  const reopened = await screen.findByRole("radiogroup", { name: "What it can use" });
  assert.equal(within(reopened).getByRole("radio", { name: "Only what I choose" }).getAttribute("aria-checked"), "true");
});

test("Advanced turns on web search for an Everything Bot that doesn't have it yet", async () => {
  const store = advancedIpc();
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const web = await screen.findByRole("switch", { name: "Allow web search" });
  assert.equal(web.getAttribute("aria-checked"), "false", "an existing Bot is never opted in silently");
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);

  fireEvent.click(web);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(store.accessUpdates.length, 1));
  const sent = (store.accessUpdates[0] as { access: { accessMode: string; webSearchEnabled?: boolean } }).access;
  assert.equal(sent.accessMode, "full");
  assert.equal(sent.webSearchEnabled, true);

  // Custom access grants web search as one of its own choices instead.
  const access = screen.getByRole("radiogroup", { name: "What it can use" });
  fireEvent.click(within(access).getByRole("radio", { name: "Only what I choose" }));
  await screen.findByRole("switch", { name: "Allow Mail" });
  assert.equal(screen.queryByRole("switch", { name: "Allow web search" }), null);
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

test("an inline name edit shows at once, before the save answers, and goes back if the save fails", async () => {
  let answer: () => void = () => undefined;
  let fail = false;
  // The store answers the held save like main would: the saved Bot is what `bots:get` reads next.
  let stored = botFixture();
  installBotTestIpc({
    "bots:list": () => [stored],
    "bots:get": () => stored,
    "bots:update": (input) => {
      if (fail) throw new Error("Error invoking remote method 'bots:update': Error: Bots are starting.");
      return new Promise<BotDefinition>((resolve) => {
        answer = () => {
          stored = { ...stored, ...(input as Record<string, unknown>), revision: "rev-2" };
          resolve(stored);
        };
      });
    },
  });
  const { queryClient } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Trip Planner" } });
  fireEvent.blur(name);
  await waitFor(() => assert.equal(queryClient.getQueryData<BotDefinition>(["bot", "bot-1"])?.name, "Trip Planner"));
  assert.equal(name.disabled, false, "the field stays usable while the save is in flight");
  assert.ok(screen.getAllByText("Trip Planner").length >= 1);
  answer();
  await waitFor(() => assert.equal(queryClient.getQueryData<BotDefinition>(["bot", "bot-1"])?.revision, "rev-2"));

  fail = true;
  fireEvent.change(name, { target: { value: "Broken" } });
  fireEvent.blur(name);
  // A failed save puts the stored name back.
  await waitFor(() => assert.equal(name.value, "Trip Planner"));
  assert.equal(queryClient.getQueryData<BotDefinition>(["bot", "bot-1"])?.name, "Trip Planner");
});

test("clearing the subtitle sends an update without one, and the cache drops it", async () => {
  const store = botStoreIpc(botFixture({ description: "Plans trips" }));
  const { queryClient } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  const subtitle = (await screen.findByRole("textbox", { name: "Subtitle" })) as HTMLInputElement;
  assert.equal(subtitle.value, "Plans trips");
  fireEvent.change(subtitle, { target: { value: "" } });
  fireEvent.blur(subtitle);
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal("description" in store.updates[0]!, false);
  await waitFor(() => assert.equal(queryClient.getQueryData<BotDefinition>(["bot", "bot-1"])?.description, undefined));
  assert.equal(store.current().description, undefined);
  assert.equal(subtitle.value, "");
});

test("two edits in flight that both fail leave the confirmed Bot, whichever answers first", async () => {
  const answers: Array<(error: Error) => void> = [];
  botStoreIpc(botFixture(), {
    "bots:update": () => new Promise<BotDefinition>((_resolve, reject) => answers.push(reject)),
  });
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(["bots", "active"], [botFixture()]);
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1", queryClient });
  const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
  const subtitle = screen.getByRole("textbox", { name: "Subtitle" }) as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Unsaved first" } });
  fireEvent.blur(name);
  fireEvent.change(subtitle, { target: { value: "Unsaved second" } });
  fireEvent.blur(subtitle);
  await waitFor(() => assert.equal(answers.length, 2));
  // Both edits show while they are in flight.
  const shown = () => queryClient.getQueryData<BotDefinition>(["bot", "bot-1"])!;
  assert.equal(shown().name, "Unsaved first");
  assert.equal(shown().description, "Unsaved second");
  answers[0]!(new Error("Error invoking remote method 'bots:update': Error: Bots are starting."));
  // The first failure keeps the second edit on screen.
  await waitFor(() => assert.equal(shown().name, "Planner"));
  assert.equal(shown().description, "Unsaved second");
  answers[1]!(new Error("Error invoking remote method 'bots:update': Error: Bots are starting."));
  await waitFor(() => assert.equal(shown().description, "Plans trips"));
  assert.equal(shown().name, "Planner");
  await waitFor(() => assert.equal(name.value, "Planner"));
  assert.equal(subtitle.value, "Plans trips");
  const list = queryClient.getQueryData<BotDefinition[]>(["bots", "active"]);
  assert.equal(list?.find((row) => row.id === "bot-1")?.name, "Planner");
});

test("a failed edit keeps a newer Bot that another device saved meanwhile, in the Profile and the list", async () => {
  let reject: (error: Error) => void = () => undefined;
  // `bots:list` and `bots:get` read the store; the held update never writes it.
  let stored = botFixture();
  installBotTestIpc({
    "bots:list": () => [stored],
    "bots:get": () => stored,
    "bots:update": () => new Promise<BotDefinition>((_resolve, rejectUpdate) => (reject = rejectUpdate)),
  });
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(["bots", "active"], [botFixture()]);
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1", queryClient });
  const subtitle = (await screen.findByRole("textbox", { name: "Subtitle" })) as HTMLInputElement;
  fireEvent.change(subtitle, { target: { value: "Unsaved subtitle" } });
  fireEvent.blur(subtitle);
  const shown = () => queryClient.getQueryData<BotDefinition>(["bot", "bot-1"])!;
  await waitFor(() => assert.equal(shown().description, "Unsaved subtitle"));

  // A phone renames the Bot; main's `bots:changed` rereads the Bot and the list.
  stored = botFixture({ name: "Renamed on phone", revision: "rev-2" });
  await queryClient.invalidateQueries({ queryKey: ["bots"] });
  await queryClient.invalidateQueries({ queryKey: ["bot", "bot-1"] });
  await waitFor(() => assert.equal(shown().name, "Renamed on phone"));

  reject(new Error("Error invoking remote method 'bots:update': Error: Bots are starting."));
  await waitFor(() => assert.equal(shown().description, "Plans trips"));
  assert.equal(shown().name, "Renamed on phone");
  await waitFor(() =>
    assert.equal(queryClient.getQueryData<BotDefinition[]>(["bots", "active"])?.find((row) => row.id === "bot-1")?.name, "Renamed on phone"),
  );
  await waitFor(() => assert.equal(subtitle.value, "Plans trips"));
});

test("a Bot already in the list opens its Profile without a loading skeleton", async () => {
  installBotTestIpc({
    "bots:list": () => [botFixture()],
    // The Bot's own read never answers: the list is enough to show it.
    "bots:get": () => new Promise<never>(() => undefined),
  });
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(["bots", "active"], [botFixture()]);
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1", queryClient });
  assert.ok(await screen.findByRole("textbox", { name: "Name" }));
  assert.equal(screen.queryByRole("status", { name: "Loading Bot" }), null);
});
