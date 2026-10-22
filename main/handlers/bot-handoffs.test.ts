import assert from "node:assert/strict";
import test from "node:test";
import { createBotHandoffs } from "../services/bot-runtime/bot-handoffs.js";
import type { BotHandoffOpened } from "../services/bot-runtime/bot-handoff-open.js";
import { BOT_ANSWER_HANDOFF_CHANNEL, BOT_OPEN_HANDOFF_CHANNEL, registerBotHandoffHandlers } from "./bot-handoffs.js";

const WAIT_ID = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c";

interface FakeEvent {
  window: string;
}

function setup(opened: BotHandoffOpened = "external") {
  const handoffs = createBotHandoffs();
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  const opens: Array<{ botId: string; waitId: string; window: string }> = [];
  registerBotHandoffHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    handoffs,
    open: async (botId, waitId, event) => {
      opens.push({ botId, waitId, window: event.window });
      return opened;
    },
  });
  const invoke = (channel: string, input: unknown, event: FakeEvent = { window: "main" }) =>
    Promise.resolve(handlers.get(channel)!(event, input));
  const controller = new AbortController();
  const asked = handoffs.request({
    botId: "bot:chief",
    waitId: WAIT_ID,
    toolCallId: "call-1",
    kind: "action",
    action: "Enter the 2FA code for your bank",
    open: { url: "https://bank.example/verify" },
    source: "tool",
    signal: controller.signal,
  });
  asked.catch(() => undefined);
  return { handoffs, invoke, asked, controller, opens };
}

const answer = (overrides: Record<string, unknown> = {}) => ({ botId: "bot:chief", waitId: WAIT_ID, outcome: "done", ...overrides });

test("bots:answerHandoff settles the card once with the person's note; a repeat or stale wait id is refused", async () => {
  const { invoke, asked, handoffs } = setup();
  assert.deepEqual(await invoke(BOT_ANSWER_HANDOFF_CHANNEL, answer({ note: "Code entered." })), { answered: true });
  assert.deepEqual(await asked, { outcome: "done", note: "Code entered." });
  assert.deepEqual(await invoke(BOT_ANSWER_HANDOFF_CHANNEL, answer({ outcome: "skipped" })), { answered: false });
  assert.deepEqual(await invoke(BOT_ANSWER_HANDOFF_CHANNEL, answer({ waitId: "0000-stale" })), { answered: false });
  assert.deepEqual(handoffs.pending(), []);
});

test("bots:answerHandoff refuses another Bot's card and an answer after the card was withdrawn", async () => {
  const { invoke, controller, handoffs, asked } = setup();
  assert.deepEqual(await invoke(BOT_ANSWER_HANDOFF_CHANNEL, answer({ botId: "bot:other" })), { answered: false });
  assert.equal(handoffs.pending().length, 1, "another Bot cannot settle it");
  controller.abort(new Error("stopped"));
  await assert.rejects(asked, /stopped/u);
  assert.deepEqual(await invoke(BOT_ANSWER_HANDOFF_CHANNEL, answer({ outcome: "skipped" })), { answered: false });
});

test("Skip without a note reaches the Bot as a plain skip", async () => {
  const { invoke, asked } = setup();
  assert.deepEqual(await invoke(BOT_ANSWER_HANDOFF_CHANNEL, answer({ outcome: "skipped" })), { answered: true });
  assert.deepEqual(await asked, { outcome: "skipped" });
});

test("hand-off requests that are not well formed are rejected and leave the card waiting", async () => {
  const { invoke, handoffs } = setup();
  const malformed: unknown[] = [
    null,
    "done",
    [],
    answer({ extra: true }),
    answer({ waitId: "../etc" }),
    answer({ waitId: "" }),
    answer({ waitId: 7 }),
    answer({ botId: "" }),
    answer({ botId: "../bot" }),
    answer({ outcome: "allow" }),
    answer({ outcome: undefined }),
    answer({ note: "" }),
    answer({ note: "   " }),
    answer({ note: 42 }),
    answer({ note: "x".repeat(4_001) }),
  ];
  for (const input of malformed) {
    await assert.rejects(invoke(BOT_ANSWER_HANDOFF_CHANNEL, input), /Invalid bot/u, JSON.stringify(input));
  }
  for (const input of [null, { botId: "bot:chief" }, { botId: "bot:chief", waitId: WAIT_ID, url: "https://evil.example" }]) {
    await assert.rejects(invoke(BOT_OPEN_HANDOFF_CHANNEL, input), /Invalid bot/u, JSON.stringify(input));
  }
  assert.equal(handoffs.pending().length, 1);
});

test("bots:openHandoff opens the card for the window that asked and says where it went", async () => {
  const { invoke, opens } = setup("browser");
  assert.deepEqual(await invoke(BOT_OPEN_HANDOFF_CHANNEL, { botId: "bot:chief", waitId: WAIT_ID }, { window: "chat" }), {
    opened: "browser",
  });
  assert.deepEqual(opens, [{ botId: "bot:chief", waitId: WAIT_ID, window: "chat" }]);
});
