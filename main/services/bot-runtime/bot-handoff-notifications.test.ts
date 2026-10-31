import assert from "node:assert/strict";
import test from "node:test";
import type { BotPendingHandoff } from "../../../renderer/shared/bot-handoffs.js";
import { createBotHandoffs } from "./bot-handoffs.js";
import {
  createBotHandoffNotifier,
  watchBotHandoffs,
  type BotHandoffNotificationOptions,
  type BotHandoffNotifierDeps,
} from "./bot-handoff-notifications.js";

function card(overrides: Partial<BotPendingHandoff> = {}): BotPendingHandoff {
  return {
    botId: "bot:ada",
    waitId: "w-1",
    toolCallId: "call-1",
    kind: "action",
    action: "Enter the 2FA code for your bank",
    source: "tool",
    ...overrides,
  };
}

function setup(overrides: Partial<BotHandoffNotifierDeps> = {}) {
  const shown: BotHandoffNotificationOptions[] = [];
  const opened: string[] = [];
  const errors: string[] = [];
  let focused = false;
  const notifier = createBotHandoffNotifier({
    isAppFocused: () => focused,
    show: (notification) => void shown.push(notification),
    botName: (botId) => (botId === "bot:ada" ? "Ada" : undefined),
    onClick: (botId) => void opened.push(botId),
    onError: (stage) => void errors.push(stage),
    ...overrides,
  });
  return {
    notifier,
    shown,
    opened,
    errors,
    focus(value: boolean) {
      focused = value;
    },
  };
}

test("a card that opens while Aiden is in the background says who needs what, and clicking it opens that Bot's chat", async () => {
  const { notifier, shown, opened } = setup();
  assert.equal(await notifier.opened(card()), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.title, "Ada");
  assert.equal(shown[0]!.body, "Ada needs you to: Enter the 2FA code for your bank");
  shown[0]!.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["bot:ada"]);
});

test("each card is announced once, however often its Bot's cards change", async () => {
  const { notifier, shown } = setup();
  const [first, again] = await Promise.all([notifier.opened(card()), notifier.opened(card())]);
  assert.deepEqual([first, again], [true, false]);
  assert.equal(await notifier.opened(card()), false, "a later change for the same card stays quiet");
  assert.equal(await notifier.opened(card({ waitId: "w-2", action: "Approve the payment" })), true, "a new card is announced");
  assert.deepEqual(
    shown.map((notification) => notification.body),
    ["Ada needs you to: Enter the 2FA code for your bank", "Ada needs you to: Approve the payment"],
  );
});

test("nothing is posted while an Aiden window has focus, or for a Bot that is gone", async () => {
  const { notifier, shown, focus } = setup();
  focus(true);
  assert.equal(await notifier.opened(card()), false, "the card is already in front of the person");
  focus(false);
  assert.equal(await notifier.opened(card({ botId: "bot:gone", waitId: "w-9" })), false);
  assert.deepEqual(shown, []);
});

test("a card answered while the Bot's name loads posts nothing", async () => {
  const handoffs = createBotHandoffs();
  let release: (name: string) => void = () => undefined;
  const { notifier, shown } = setup({
    botName: () => new Promise<string>((resolve) => (release = resolve)),
    isPending: (botId, waitId) => handoffs.get(botId, waitId) !== undefined,
  });
  const asked = handoffs.request({ ...card(), signal: undefined });
  const posting = notifier.opened(handoffs.pending("bot:ada")[0]!);
  handoffs.answer("bot:ada", "w-1", { outcome: "done" });
  await asked;
  release("Ada");
  assert.equal(await posting, false);
  assert.deepEqual(shown, []);
});

test("the body is one line of at most 120 characters", async () => {
  const { notifier, shown } = setup();
  await notifier.opened(card({ action: `Review\nand sign ${"the long contract ".repeat(12)}` }));
  const body = shown[0]!.body;
  assert.equal(body.includes("\n"), false);
  assert.ok([...body].length <= 120, `${[...body].length} characters`);
  assert.ok(body.startsWith("Ada needs you to: Review and sign the long contract"));
  assert.ok(body.endsWith("…"));
});

test("a notification that cannot be shown, or a click that cannot navigate, is reported and never thrown", async () => {
  const broken = setup({
    show: () => {
      throw new Error("notifications are unavailable");
    },
  });
  assert.equal(await broken.notifier.opened(card()), false);
  assert.deepEqual(broken.errors, ["delivery"]);

  const lost = setup({
    onClick: async () => {
      throw new Error("no window");
    },
  });
  await lost.notifier.opened(card());
  lost.shown[0]!.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lost.errors, ["navigation"]);
});

test("watching the hand-offs announces each card as its Bot opens it, once, and nothing after watching stops", async () => {
  const handoffs = createBotHandoffs();
  const { notifier, shown } = setup({ botName: (botId) => ({ "bot:ada": "Ada", "bot:bea": "Bea" })[botId] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const stop = watchBotHandoffs(handoffs, notifier);

  const bank = handoffs.request({ ...card(), signal: undefined });
  await settle();
  assert.deepEqual(shown.map((notification) => notification.body), ["Ada needs you to: Enter the 2FA code for your bank"]);

  // Bea's card opening while Ada's still waits announces Bea's alone.
  const invite = handoffs.request({ ...card({ botId: "bot:bea", waitId: "w-b", action: "Accept the invite" }), signal: undefined });
  await settle();
  // Ada's answer and the next card in the same run: only the new card is announced.
  assert.equal(handoffs.answer("bot:ada", "w-1", { outcome: "done" }), "answered");
  await bank;
  const payment = handoffs.request({ ...card({ waitId: "w-2", action: "Approve the payment" }), signal: undefined });
  await settle();
  assert.deepEqual(
    shown.map((notification) => [notification.title, notification.body]),
    [
      ["Ada", "Ada needs you to: Enter the 2FA code for your bank"],
      ["Bea", "Bea needs you to: Accept the invite"],
      ["Ada", "Ada needs you to: Approve the payment"],
    ],
  );

  stop();
  handoffs.answer("bot:ada", "w-2", { outcome: "skipped" });
  handoffs.answer("bot:bea", "w-b", { outcome: "done" });
  await Promise.all([payment, invite]);
  const later = handoffs.request({ ...card({ waitId: "w-3", action: "Sign the lease" }), signal: undefined });
  await settle();
  assert.equal(shown.length, 3, "nothing is posted once watching stops");
  handoffs.answer("bot:ada", "w-3", { outcome: "done" });
  await later;
});
