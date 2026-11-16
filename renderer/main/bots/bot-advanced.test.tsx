import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import type { BotRoutineThinkingLevel } from "../../shared/bot-routine-models";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import { useRouterState } from "@tanstack/react-router";
import { BotsView } from "../bots-view";
import { forgetUnsavedBotSettings } from "./bot-advanced";
import { mountWithBotRouter } from "./test-providers";
import { botFixture, catalogFixture } from "./test-fixtures";

beforeEach(() => {
  localStorage.clear();
  forgetUnsavedBotSettings();
});
afterEach(cleanup);

/**
 * A Bot store, access store and settings behind the fake IPC, so saves
 * round-trip like main: an update without a description clears it, and an
 * access save answers with the saved access view alone.
 */
function settingsIpc(initial: BotDefinition = botFixture(), options: { messaging?: boolean; failUpdates?: boolean; failAccessUpdates?: boolean; thinkingLevels?: Record<string, BotRoutineThinkingLevel[]> } = {}) {
  let bot = initial;
  const updates: BotUpdateInput[] = [];
  const accessUpdates: { access: Record<string, unknown> }[] = [];
  let access: Record<string, unknown> = { botId: bot.id, revision: "acc-1", policyEpoch: "e", summary: "", accessMode: "full" };
  const calls = installBotTestIpc({
    "bots:list": () => [bot],
    "bots:get": () => bot,
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => ({
      botId: bot.id,
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
    }),
    "bots:routines:list": () => [],
    "settings:get": () => ({ botMessaging: options.messaging ?? true }),
    "bots:update": (input) => {
      if (options.failUpdates) throw new Error("Error invoking remote method 'bots:update': Error: Bots are starting.");
      const update = input as BotUpdateInput;
      updates.push(update);
      const { id: _id, expectedRevision: _revision, ...fields } = update;
      const { description: _dropped, ...kept } = bot;
      bot = { ...kept, ...fields, revision: `${bot.revision}+` } as BotDefinition;
      return bot;
    },
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getModelThinkingLevels": (input) => options.thinkingLevels?.[(input as { modelId: string }).modelId] ?? null,
    "bots:getBotAccess": () => ({
      access,
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
      visionModelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    }),
    "bots:updateBotAccess": (input) => {
      if (options.failAccessUpdates) throw new Error("Error invoking remote method 'bots:updateBotAccess': Error: Bots are starting.");
      const sent = input as { access: Record<string, unknown> };
      accessUpdates.push(sent);
      access = { ...access, revision: `${String(access.revision)}+`, accessMode: sent.access.accessMode };
      return access;
    },
    "bots:getTelegramBinding": () => null,
  });
  return { calls, updates, accessUpdates, current: () => bot };
}

/** The Bots page on Bots paths only: the harness mounts its children on every path, Settings too. */
function BotsPagesOnly() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname.startsWith("/bots") ? <BotsView /> : null;
}

/** The Bot's chat with its settings open in the side panel, the way an old Profile link opens them now. */
async function openSettings(path = "/bots/bot-1") {
  const mounted = await mountWithBotRouter(<BotsPagesOnly />, { initialPath: path });
  await screen.findByRole("button", { name: /^Rename /u });
  return mounted;
}

const panel = () => document.getElementById("bot-panel")!;
const saveBar = () => screen.queryByRole("region", { name: "Unsaved changes" });

test("the settings read top to bottom in one order, and nothing waits to be saved", async () => {
  settingsIpc();
  await openSettings();
  await within(panel()).findByRole("heading", { name: "Tools" });
  await within(panel()).findByRole("heading", { name: "Spending" });
  assert.deepEqual(
    within(panel()).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    [
      "Notifications",
      "Open work",
      "Memory",
      "Model",
      "Health",
      "Permissions",
      "Replies",
      "Instructions",
      "How other Bots see it",
      "Tools",
      "Spending",
      "Clear",
    ],
  );
  assert.equal(saveBar(), null);
});

test("renaming in the header waits for Save, which sends only the name and then goes away", async () => {
  const store = settingsIpc();
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Rename Planner" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Ada" } });
  fireEvent.keyDown(name, { key: "Enter" });
  assert.ok(await screen.findByRole("button", { name: "Rename Ada" }), "the header shows the new name at once");
  assert.equal(store.updates.length, 0, "nothing is sent before Save");

  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal(store.updates[0]!.name, "Ada");
  assert.equal(store.accessUpdates.length, 0, "a name save leaves access alone");
  await waitFor(() => assert.equal(saveBar(), null));
});

test("Escape in the name leaves it as it was, with nothing to save", async () => {
  const store = settingsIpc();
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Rename Planner" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Ada" } });
  fireEvent.keyDown(name, { key: "Escape" });
  assert.ok(await screen.findByRole("button", { name: "Rename Planner" }));
  assert.equal(saveBar(), null);
  assert.equal(panel().getAttribute("data-state"), "open", "Escape closed the edit, not the panel");
  assert.equal(store.updates.length, 0);
});

test("an empty name can't be saved, and says why", async () => {
  const store = settingsIpc();
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Rename Planner" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "   " } });
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  assert.ok(await screen.findByText("A Bot needs a name."));
  assert.equal(store.updates.length, 0);
});

test("clearing the subtitle saves the Bot without one", async () => {
  const store = settingsIpc();
  await openSettings();
  fireEvent.change(screen.getByRole("textbox", { name: "Subtitle" }), { target: { value: "" } });
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal(store.current().description, undefined);
});

test("a failed save keeps the edit on screen to try again", async () => {
  settingsIpc(botFixture(), { failUpdates: true });
  await openSettings();
  fireEvent.change(screen.getByRole("textbox", { name: "Subtitle" }), { target: { value: "Books flights" } });
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal((within(saveBar()!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false));
  assert.equal((screen.getByRole("textbox", { name: "Subtitle" }) as HTMLInputElement).value, "Books flights");
});

test("an unsaved edit outlives the settings closing and comes back, saying so; Revert drops it", async () => {
  settingsIpc();
  await openSettings();
  fireEvent.change(screen.getByRole("textbox", { name: "Subtitle" }), { target: { value: "Books flights" } });
  // The chat, its panel and the tab all go away, as when the person leaves for another page.
  cleanup();
  await openSettings();
  assert.equal((await screen.findByRole("textbox", { name: "Subtitle" }) as HTMLInputElement).value, "Books flights");
  assert.ok(screen.getByText("Your unsaved changes are back."));
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Revert" }));
  assert.equal((screen.getByRole("textbox", { name: "Subtitle" }) as HTMLInputElement).value, "Plans trips");
  assert.equal(saveBar(), null);
});

test("a new model waits for Save, and a model that reads images drops the photo model", async () => {
  const store = settingsIpc();
  await openSettings();
  const model = await screen.findByRole("button", { name: "AI model" });
  assert.match(model.textContent ?? "", /Writer/u);
  assert.ok(screen.getByRole("button", { name: "Model for photos" }));
  fireEvent.click(model);
  fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  assert.equal(screen.queryByRole("button", { name: "Model for photos" }), null, "Seer reads images");
  assert.equal(store.accessUpdates.length, 0);
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(store.accessUpdates.length, 1));
  assert.equal(store.accessUpdates[0]!.access.modelId, "model-vision");
  assert.equal(store.accessUpdates[0]!.access.visionModel, null);
  await waitFor(() => assert.equal(saveBar(), null));
});

test("Thinking offers the chosen model's levels, shows the level it will really use, and waits for Save with the model", async () => {
  const store = settingsIpc(botFixture(), {
    thinkingLevels: { "model-text": ["low", "high", "max"], "model-vision": ["off", "low", "medium"] },
  });
  await openSettings();
  const thinking = await screen.findByRole("combobox", { name: "Thinking" });
  assert.match(thinking.textContent ?? "", /Low/u, "Writer can't think Off, so it runs Low");
  assert.ok(screen.getByText("This model can’t use Off, so it uses Low."));
  fireEvent.click(thinking);
  assert.deepEqual(screen.getAllByRole("option").map((option) => option.textContent), ["Low", "High", "Maximum"]);
  fireEvent.click(screen.getByRole("option", { name: "Maximum" }));
  await waitFor(() => assert.match(screen.getByRole("combobox", { name: "Thinking" }).textContent ?? "", /Maximum/u));
  assert.equal(store.updates.length, 0, "nothing saves before Save");

  // The unsaved model's levels apply at once; Seer tops out at Medium.
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  await waitFor(() => assert.match(screen.getByRole("combobox", { name: "Thinking" }).textContent ?? "", /Medium/u));
  assert.ok(screen.getByText("This model can’t use Maximum, so it uses Medium."));

  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(store.accessUpdates.length, 1));
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0]!.thinkingLevel, "max", "the Bot keeps what was asked; the run uses the nearest level the model has");
  assert.equal(store.accessUpdates[0]!.access.modelId, "model-vision");
  await waitFor(() => assert.equal(saveBar(), null));
});

test("a Save whose model write fails keeps the model and thinking level together to try again", async () => {
  const options = { failAccessUpdates: true, thinkingLevels: { "model-text": ["low", "high", "max"], "model-vision": ["off", "low", "medium"] } as Record<string, BotRoutineThinkingLevel[]> };
  const store = settingsIpc(botFixture(), options);
  await openSettings();
  fireEvent.click(await screen.findByRole("button", { name: "AI model" }));
  fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Thinking" }));
  fireEvent.click(screen.getByRole("option", { name: "Medium" }));
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal((within(saveBar()!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false));
  assert.equal(store.updates.length, 0, "the level never lands without its model");
  assert.match(screen.getByRole("button", { name: "AI model" }).textContent ?? "", /Seer/u);
  assert.match(screen.getByRole("combobox", { name: "Thinking" }).textContent ?? "", /Medium/u);

  options.failAccessUpdates = false;
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  // A boolean, so each failed retry doesn't print the whole save bar.
  await waitFor(() => assert.equal(saveBar() === null, true));
  assert.equal(store.accessUpdates[store.accessUpdates.length - 1]!.access.modelId, "model-vision");
  assert.equal(store.current().thinkingLevel, "medium");
});

test("Revert puts the thinking level back with the rest", async () => {
  const store = settingsIpc(botFixture({ thinkingLevel: "high" }), { thinkingLevels: { "model-text": ["low", "high", "max"] } });
  await openSettings();
  fireEvent.click(await screen.findByRole("combobox", { name: "Thinking" }));
  fireEvent.click(screen.getByRole("option", { name: "Low" }));
  fireEvent.click(within(await waitFor(() => saveBar()!)).getByRole("button", { name: "Revert" }));
  await waitFor(() => assert.match(screen.getByRole("combobox", { name: "Thinking" }).textContent ?? "", /High/u));
  assert.equal(saveBar(), null);
  assert.equal(store.updates.length, 0);
});

test("no Thinking row shows while a model's levels are unknown", async () => {
  settingsIpc();
  await openSettings();
  await screen.findByRole("button", { name: "AI model" });
  assert.equal(screen.queryByRole("combobox", { name: "Thinking" }), null);
});

test("Disable a tool narrows the Bot to Custom access on Save", async () => {
  const store = settingsIpc();
  await openSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Disable a tool" }));
  const dialog = await screen.findByRole("dialog", { name: "Disable a tool" });
  fireEvent.click(within(dialog).getByRole("option", { name: /^Mail/u }));
  assert.ok(await screen.findByRole("button", { name: "Turn on Mail" }));
  fireEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(store.accessUpdates.length, 1));
  assert.equal(store.accessUpdates[0]!.access.accessMode, "custom");
  assert.equal(store.updates.length, 0, "an access save leaves the Bot's identity alone");
});

test("When it finishes or needs input saves at once: off sends none a day, on puts the limit back", async () => {
  const store = settingsIpc(botFixture({ interruptions: { quietHours: { enabled: true, start: "22:00", end: "07:00" }, dailyLimit: 8 } }));
  await openSettings();
  const toggle = screen.getByRole("switch", { name: "When it finishes or needs input" });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal(store.updates[0]!.interruptions?.dailyLimit, 0);
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "When it finishes or needs input" }).getAttribute("aria-checked"), "false"));
  fireEvent.click(screen.getByRole("switch", { name: "When it finishes or needs input" }));
  await waitFor(() => assert.equal(store.updates.length, 2));
  assert.equal(store.updates[1]!.interruptions?.dailyLimit, 8);
  assert.equal(saveBar(), null, "switches never wait for Save");
});

test("Quiet hours opens from Notifications and saves each change", async () => {
  const store = settingsIpc();
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Quiet hours" }));
  const dialog = await screen.findByRole("dialog", { name: "Quiet hours" });
  fireEvent.click(within(dialog).getByRole("switch", { name: "Quiet hours" }));
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal(store.updates[0]!.interruptions?.quietHours.enabled, false);
});

test("Can message other Bots shows on only when the Bot both sends and receives, and turning it on sets both", async () => {
  const store = settingsIpc(botFixture({ acceptsBotMessages: false }));
  await openSettings();
  const toggle = screen.getByRole("switch", { name: "Can message other Bots" });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  assert.equal(toggle.getAttribute("aria-checked"), "false", "one direction off shows off");
  assert.equal(store.updates.length, 0, "showing it changes nothing");
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.equal(store.updates[0]!.acceptsBotMessages, true);
  assert.equal(store.updates[0]!.messagesOtherBots, true);
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Can message other Bots" }).getAttribute("aria-checked"), "true"));
  fireEvent.click(screen.getByRole("switch", { name: "Can message other Bots" }));
  await waitFor(() => assert.equal(store.updates.length, 2));
  assert.deepEqual([store.updates[1]!.acceptsBotMessages, store.updates[1]!.messagesOtherBots], [false, false]);
});

test("with Bot messaging off for every Bot, the switch is off-limits and says where to turn it on", async () => {
  settingsIpc(botFixture(), { messaging: false });
  await openSettings();
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Can message other Bots" }).hasAttribute("disabled"), true));
  assert.ok(screen.getByText("Bot messaging is off for every Bot in Settings → Approvals → Advanced."));
});

test("Default look in the look popover puts the default colour and shape back at once", async () => {
  const store = settingsIpc(botFixture({ avatar: { version: 1, color: "coral", shape: "hex" } }));
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Change Planner’s look" }));
  const popover = await screen.findByRole("dialog", { name: "Planner’s look" });
  fireEvent.click(within(popover).getByRole("button", { name: "Default look" }));
  await waitFor(() => assert.equal(store.updates.length, 1));
  assert.deepEqual(store.updates[0]!.avatar, DEFAULT_BOT_AVATAR);
});

test("the Approvals row opens Settings → Approvals, where every Bot's rules live", async () => {
  settingsIpc();
  const { router } = await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Approvals" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.equal((router.state.location.search as { section?: string }).section, "approvals");
});
