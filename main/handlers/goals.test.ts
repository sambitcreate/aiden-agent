// chats:goal:* against a real GoalLoop with fake chats: the loop's state is
// the oracle for what each handler did.

import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalLoop } from "../services/goal/goal-loop.js";
import {
  GOAL_CLEAR_CHANNEL,
  GOAL_GET_CHANNEL,
  GOAL_PAUSE_CHANNEL,
  GOAL_RESUME_CHANNEL,
  GOAL_SET_CHANNEL,
  registerGoalHandlers,
} from "./goals.js";

function setup() {
  const rounds: string[] = [];
  const loop = new GoalLoop({
    enabled: () => true,
    boot: "boot",
    now: () => 1_000,
    newId: () => "goal-1",
    delay: () => Promise.resolve(),
    setTimer: () => () => {},
    persist: () => {},
    onChange: () => {},
    eligibility: async (chatId) => (chatId === "bot-chat" ? "A Bot's chat can't have a goal." : undefined),
    isChatBusy: () => false,
    helperRunning: () => false,
    jobsRunning: () => false,
    roundActivity: async () => ({ toolCalls: 1, newTextChars: 0 }),
    fallbackContext: async () => ({ providerId: "anthropic", model: "claude" }),
    review: async () => ({ kind: "cancelled" }),
    startRound: async (chatId) => {
      rounds.push(chatId);
      return "started";
    },
    startNoticeRound: async () => ({ kind: "busy" }),
    report: () => {},
    log: () => {},
  });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const inactive = { inactive: true };
  registerGoalHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    loop,
    activeDocument: (event) => {
      if (event === inactive) throw new Error("Goal changes require the active application document.");
    },
  });
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({}, ...args));
  const invokeFrom = (event: unknown, channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, ...args));
  return { invoke, invokeFrom, inactive, rounds };
}

test("set, get, pause, resume and clear drive the chat's goal", async () => {
  const { invoke, rounds } = setup();
  assert.equal(await invoke(GOAL_GET_CHANNEL, "chat-1"), null);
  const set = (await invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", objective: "Ship it", source: "slash" })) as { status: string };
  assert.equal(set.status, "active");
  assert.equal(((await invoke(GOAL_GET_CHANNEL, "chat-1")) as { objective: string }).objective, "Ship it");

  assert.equal(((await invoke(GOAL_PAUSE_CHANNEL, { chatId: "chat-1" })) as { status: string }).status, "paused");
  const resumed = (await invoke(GOAL_RESUME_CHANNEL, { chatId: "chat-1" })) as { status: string; rounds: number };
  assert.deepEqual([resumed.status, resumed.rounds], ["active", 1]);
  assert.deepEqual(rounds, ["chat-1"], "Keep going starts a round in the idle chat");

  await invoke(GOAL_CLEAR_CHANNEL, { chatId: "chat-1" });
  assert.equal(await invoke(GOAL_GET_CHANNEL, "chat-1"), null);
});

test("changes are refused from an inactive document, for malformed input, a phone source, or an ineligible chat", async () => {
  const { invoke, invokeFrom, inactive } = setup();
  await assert.rejects(invokeFrom(inactive, GOAL_SET_CHANNEL, { chatId: "chat-1", objective: "Ship it", source: "slash" }), /active application document/);
  await assert.rejects(invoke(GOAL_SET_CHANNEL, { chatId: "", objective: "Ship it", source: "slash" }), /Invalid chat/);
  await assert.rejects(invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", objective: 7, source: "slash" }), /Say what the goal is/);
  await assert.rejects(invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", objective: "Ship it", source: "phone" }), /Invalid goal source/);
  await assert.rejects(invoke(GOAL_SET_CHANNEL, { chatId: "bot-chat", objective: "Ship it", source: "menu" }), /Bot's chat/);
  await assert.rejects(invoke(GOAL_PAUSE_CHANNEL, "chat-1"), /Invalid request/);
  assert.equal(await invoke(GOAL_GET_CHANNEL, "chat-1"), null);
});
