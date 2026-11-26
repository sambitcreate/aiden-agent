import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { BotChatRoute } from "../bot-chat-route";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";
import { EMPTY_BOT_BUBBLE_STATE, type BotBubbleState } from "../../shared/bot-bubbles";
import type { BotLiveSnapshot } from "../../shared/bot-live";
import { botBubbleStore } from "../../lib/bot-bubbles-api";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const BUBBLED: BotBubbleState = {
  ...EMPTY_BOT_BUBBLE_STATE,
  host: "overlay",
  bubbles: [{ botId: "bot-1", placement: { side: "right", y: 0.4, displayId: null } }],
};

const SNAPSHOT: BotLiveSnapshot = {
  botId: "bot-1",
  epoch: "epoch-1",
  seq: 0,
  entries: [{ id: "a1", type: "assistant", text: "Here is your plan.", toolCalls: [], stopReason: "stop" }],
  partial: null,
  state: { kind: "idle" },
  question: null,
  activity: null,
  queued: [],
};

async function mountChat(state: BotBubbleState, handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => SNAPSHOT,
    "bots:live:unsubscribe": () => undefined,
    "bots:pendingApprovals": () => [],
    "bots:bubbles:state": () => state,
    ...handlers,
  });
  // The window already knows main's bubble state (as the Aiden window does from startup).
  botBubbleStore.accept(state);
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  return calls;
}

test("a bubbled Bot's chat shows the bubble card instead of the chat, without opening its live feed", async () => {
  const calls = await mountChat(BUBBLED);
  assert.ok(await screen.findByText("Planner is in a bubble"));
  assert.ok(screen.getByRole("button", { name: "Planner settings" }), "the header and its menus stay");
  assert.equal(screen.queryByText("Here is your plan."), null);
  assert.equal(screen.queryByPlaceholderText("Ask Planner"), null, "no composer while the chat lives in its bubble");
  assert.equal(calls.some((call) => call.channel === "bots:live:subscribe"), false);
});

test("Bring back here and Open bubble ask main to bring the chat back or open its bubble", async () => {
  const calls = await mountChat(BUBBLED, {
    "bots:bubbles:bringBack": () => ({ ...BUBBLED, bubbles: [] }),
    "bots:bubbles:open": () => ({ ...BUBBLED, openBotId: "bot-1" }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open bubble" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.channel === "bots:bubbles:open")?.args, [{ botId: "bot-1" }]));
  fireEvent.click(screen.getByRole("button", { name: "Bring back here" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.channel === "bots:bubbles:bringBack")?.args, [{ botId: "bot-1" }]));
  // Main's answer says the Bot is no longer bubbled: its chat is back here.
  assert.ok(await screen.findByText("Here is your plan."));
});

test("with bubbles turned off, a Bot left in the list still shows its chat here", async () => {
  await mountChat({ ...BUBBLED, host: "off" });
  assert.ok(await screen.findByText("Here is your plan."));
  assert.equal(screen.queryByText("Planner is in a bubble"), null);
});

test("a bubbled Bot's side panel opens no live feed either", async () => {
  const calls = await mountChat(BUBBLED);
  await screen.findByText("Planner is in a bubble");
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  assert.ok(await screen.findByRole("tab", { name: "Activity" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.some((call) => call.channel === "bots:live:subscribe"), false);
});

test("while bubbled, the ••• menu knows the Bot is paused from its summary", async () => {
  await mountChat(BUBBLED, {
    "bots:live:summary": () => ({ botId: "bot-1", preview: null, updatedAt: null, state: { kind: "paused" }, needsYou: false, lastReplyAt: null }),
  });
  await screen.findByText("Planner is in a bubble");
  await new Promise((resolve) => setTimeout(resolve, 20));
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  assert.ok(await screen.findByRole("menuitem", { name: /Resume Bot/u }));
});
