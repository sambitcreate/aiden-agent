import { installBotTestIpc, type BotTestIpcCall } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { BotRoutine } from "../../../main/services/scheduled-bot-routines";
import type { BotLiveSnapshot } from "../../shared/bot-live";
import type { BotDefinition, BotUpdateInput } from "../../shared/bots";
import { botWakeUpWhen } from "../../shared/bot-wake-ups";
import { BotChatRoute } from "../bot-chat-route";
import { BotsView } from "../bots-view";
import { BOT_PANEL_OPEN_KEY, BOT_PANEL_TAB_KEY } from "./bot-panel-context";
import { mountWithBotRouter } from "./test-providers";
import { botFixture, catalogFixture } from "./test-fixtures";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const FIRE_AT = Math.floor((Date.now() + 2 * 60 * 60_000) / 60_000) * 60_000;
const WHEN = botWakeUpWhen(FIRE_AT, Date.now());

function wakeUpRoutine(overrides: Partial<BotRoutine> = {}): BotRoutine {
  return {
    id: "wake-1",
    botId: "bot-1",
    name: "Wake-up",
    prompt: "Ask whether the flight got rebooked.",
    schedule: { kind: "once", date: "2026-10-28", time: "15:10" },
    timezone: "UTC",
    label: "Once",
    enabled: true,
    nextRunAt: FIRE_AT,
    pendingFireCount: 0,
    wakeUp: { setAt: Date.now() },
    updatedAt: 1,
    ...overrides,
  };
}

function snapshot(): BotLiveSnapshot {
  return {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 0,
    entries: [
      { id: "u1", type: "user", text: "Can you check on my flight later?" },
      {
        id: "a1",
        type: "assistant",
        text: "I'll look again in two hours.",
        toolCalls: [],
        stopReason: "stop",
      },
      { id: "w1", type: "wake_up", wakeUpId: "wake-1", fireAt: FIRE_AT },
    ],
    partial: null,
    state: { kind: "idle" },
    question: null,
    activity: null,
    queued: [],
  } as BotLiveSnapshot;
}

const callsTo = (calls: BotTestIpcCall[], channel: string) =>
  calls.filter((call) => call.channel === channel);

/** The Bot's routines behind the fake IPC: deleting one removes it, as main does. */
function routinesIpc(initial: BotRoutine[]) {
  let routines = initial;
  return {
    "bots:routines:list": () => routines,
    "bots:routines:delete": (input: unknown) => {
      routines = routines.filter(
        (routine) => routine.id !== (input as { id: string }).id,
      );
    },
  };
}

test("the chat shows a waiting wake-up as one line, and Cancel deletes that wake-up", async () => {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => snapshot(),
    ...routinesIpc([wakeUpRoutine()]),
  });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, {
    initialPath: "/bots/bot-1/chat",
  });

  const cancel = await screen.findByRole("button", {
    name: `Cancel wake-up ${WHEN}`,
  });
  fireEvent.click(cancel);

  await waitFor(() =>
    assert.deepEqual(
      callsTo(calls, "bots:routines:delete").map((call) => call.args),
      [[{ botId: "bot-1", id: "wake-1" }]],
    ),
  );
  assert.ok(await screen.findByText(`Wake-up ${WHEN} (cancelled)`));
  assert.equal(
    screen.queryByRole("button", { name: `Cancel wake-up ${WHEN}` }),
    null,
  );
});

test("a wake-up that already fired or was cancelled elsewhere has no Cancel in the chat", async () => {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => snapshot(),
    ...routinesIpc([]),
  });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, {
    initialPath: "/bots/bot-1/chat",
  });

  assert.ok(await screen.findByText(`Wake-up ${WHEN}`));
  await waitFor(() =>
    assert.ok(callsTo(calls, "bots:routines:list").length > 0),
  );
  assert.equal(screen.queryByRole("button", { name: /Cancel wake-up/u }), null);
});

test("the Routines tab lists a wake-up with its note and when, and Cancel removes it without opening the editor", async () => {
  const daily: BotRoutine = {
    ...wakeUpRoutine({
      id: "r-daily",
      name: "Morning brief",
      prompt: "Brief me.",
      label: "Every day at 8:00 AM",
    }),
    schedule: { kind: "daily", time: "08:00" },
    wakeUp: undefined,
  };
  const calls = installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => snapshot(),
    ...routinesIpc([daily, wakeUpRoutine()]),
  });
  await mountRoutinesTab();

  const list = await screen.findByRole("list", { name: "Routines" });
  assert.ok(within(list).getByText("Ask whether the flight got rebooked."));
  assert.ok(within(list).getByText(WHEN));
  assert.ok(
    within(list).getByRole("button", { name: /^Morning brief\b/u }),
    "an ordinary routine still opens its editor",
  );

  fireEvent.click(within(list).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    assert.deepEqual(
      callsTo(calls, "bots:routines:delete").map((call) => call.args),
      [[{ botId: "bot-1", id: "wake-1" }]],
    ),
  );
  await waitFor(() =>
    assert.equal(
      within(list).queryByText("Ask whether the flight got rebooked."),
      null,
    ),
  );
  assert.equal(
    screen.queryByRole("dialog"),
    null,
    "Cancel never opens the routine editor",
  );
});

test("a wake-up turned off before it fired can still be cancelled from the Routines tab, but not one mid-fire", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => snapshot(),
    ...routinesIpc([
      wakeUpRoutine({ id: "wake-off", prompt: "Turned off early.", enabled: false, nextRunAt: undefined }),
      wakeUpRoutine({ id: "wake-firing", prompt: "Firing now.", enabled: false, nextRunAt: undefined, pendingFireCount: 1 }),
    ]),
  });
  await mountRoutinesTab();

  const list = await screen.findByRole("list", { name: "Routines" });
  assert.ok(within(list).getByText("Firing now."));
  const cancels = within(list).getAllByRole("button", { name: "Cancel" });
  assert.equal(cancels.length, 1);
  fireEvent.click(cancels[0]!);
  await waitFor(() =>
    assert.deepEqual(
      callsTo(calls, "bots:routines:delete").map((call) => call.args),
      [[{ botId: "bot-1", id: "wake-off" }]],
    ),
  );
});

/** The Bot's chat with its panel open on Routines. */
async function mountRoutinesTab() {
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "true");
  localStorage.setItem(BOT_PANEL_TAB_KEY, "routines");
  await mountWithBotRouter(null, { initialPath: "/bots/bot-1/chat" });
}

test("the Advanced tab's daily check-ins switch, on by default, turns the Bot's own wake-ups off at once", async () => {
  let bot: BotDefinition = botFixture();
  const updates: BotUpdateInput[] = [];
  installBotTestIpc({
    "bots:list": () => [bot],
    "bots:get": () => bot,
    "bots:update": (input) => {
      const update = input as BotUpdateInput;
      updates.push(update);
      const { id: _id, expectedRevision: _revision, ...fields } = update;
      bot = { ...bot, ...fields, revision: `${bot.revision}+` };
      return bot;
    },
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:getBotAccess": () => ({
      access: {
        botId: "bot-1",
        revision: "acc-1",
        policyEpoch: "e",
        summary: "",
        accessMode: "full",
      },
      modelSelection: { providerId: "prov-text", modelId: "model-text" },
    }),
    "bots:getTelegramBinding": () => null,
    "bots:routines:list": () => [],
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });

  const toggle = await screen.findByRole("switch", {
    name: "Daily check-ins on unfinished work",
  });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);

  await waitFor(() => assert.equal(updates.length, 1));
  assert.equal(updates[0]?.selfWakeUps, false);
  await waitFor(() =>
    assert.equal(
      screen
        .getByRole("switch", { name: "Daily check-ins on unfinished work" })
        .getAttribute("aria-checked"),
      "false",
    ),
  );
  assert.equal(screen.queryByRole("region", { name: "Unsaved changes" }), null, "it saves on its own, with no Save to press");
});
