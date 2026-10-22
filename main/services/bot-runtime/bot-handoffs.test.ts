import assert from "node:assert/strict";
import test from "node:test";
import type { BotHandoffAnswer, BotPendingHandoff } from "../../../renderer/shared/bot-handoffs.js";
import { createBotHandoffs, type BotHandoffRequest } from "./bot-handoffs.js";

function request(overrides: Partial<BotHandoffRequest> = {}): BotHandoffRequest {
  return {
    botId: "bot:ada",
    waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
    toolCallId: "call-1",
    kind: "action",
    action: "Enter the 2FA code for your bank",
    source: "tool",
    signal: undefined,
    ...overrides,
  };
}

function recordSettled(handoffs: ReturnType<typeof createBotHandoffs>) {
  const settled: Array<{ waitId: string; answer: BotHandoffAnswer | null }> = [];
  handoffs.onSettled((prompt, answer) => settled.push({ waitId: prompt.waitId, answer }));
  return settled;
}

test("the first valid answer settles the card; a second answer, another Bot's or a missing wait is refused", async () => {
  const handoffs = createBotHandoffs();
  const settled = recordSettled(handoffs);
  const asked = handoffs.request(request({ why: "Only you get the code.", open: { url: "https://bank.example/2fa" } }));

  assert.deepEqual(handoffs.pending("bot:ada"), [
    {
      botId: "bot:ada",
      waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
      toolCallId: "call-1",
      kind: "action",
      action: "Enter the 2FA code for your bank",
      why: "Only you get the code.",
      open: { url: "https://bank.example/2fa" },
      source: "tool",
    },
  ]);
  assert.equal(handoffs.get("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c")?.action, "Enter the 2FA code for your bank");
  assert.equal(handoffs.get("bot:other", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c"), undefined, "another Bot cannot see it");
  assert.equal(JSON.stringify(handoffs.pending()).includes("signal"), false, "the signal is not part of the card");

  assert.equal(handoffs.answer("bot:other", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", { outcome: "done" }), "not_waiting");
  assert.equal(handoffs.answer("bot:ada", "no-such-wait", { outcome: "done" }), "not_waiting");
  const outcomes = [
    handoffs.answer("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", { outcome: "done", note: " Code entered. " }),
    handoffs.answer("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", { outcome: "skipped" }),
  ];
  assert.deepEqual(outcomes, ["answered", "not_waiting"]);
  assert.deepEqual(await asked, { outcome: "done", note: "Code entered." });
  assert.deepEqual(handoffs.pending(), []);
  assert.deepEqual(settled, [
    { waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", answer: { outcome: "done", note: "Code entered." } },
  ]);
});

test("an answer that is not Done or Skip keeps the card waiting", async () => {
  const handoffs = createBotHandoffs();
  const asked = handoffs.request(request());
  for (const value of [{ outcome: "allow" }, { outcome: "done", note: "" }, { outcome: "done", extra: 1 }, "done", null]) {
    assert.equal(handoffs.answer("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", value), "invalid", JSON.stringify(value));
  }
  assert.equal(handoffs.pending().length, 1, "refused answers leave the card waiting");
  assert.equal(handoffs.answer("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", { outcome: "skipped" }), "answered");
  assert.deepEqual(await asked, { outcome: "skipped" });
});

test("a password-or-code card takes no note: whatever is typed with the answer would reach the Bot", async () => {
  const handoffs = createBotHandoffs();
  const credentials = handoffs.request(
    request({
      action: "Enter a password or 2FA code, or change account security",
      source: "rule",
      rule: { id: "locked.credentials", label: "Enter a password or 2FA code, or change account security" },
    }),
  );
  const waitId = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c";
  for (const outcome of ["done", "skipped"] as const) {
    assert.equal(handoffs.answer("bot:ada", waitId, { outcome, note: "481 516" }), "invalid", outcome);
  }
  assert.equal(handoffs.pending().length, 1, "the card still waits for Done or Skip");
  assert.equal(handoffs.answer("bot:ada", waitId, { outcome: "done" }), "answered");
  assert.deepEqual(await credentials, { outcome: "done" });

  // A note still goes with any other card, a money rule's included.
  const payment = handoffs.request(
    request({ source: "rule", rule: { id: "locked.money", label: "Move money or enter card details" }, action: "Move money or enter card details" }),
  );
  assert.equal(handoffs.answer("bot:ada", waitId, { outcome: "done", note: "Paid, reference 4471." }), "answered");
  assert.deepEqual(await payment, { outcome: "done", note: "Paid, reference 4471." });
});

test("Stop withdraws the card: the wait rejects with the abort reason and a late answer records nothing", async () => {
  const handoffs = createBotHandoffs();
  const settled = recordSettled(handoffs);
  const controller = new AbortController();
  const asked = handoffs.request(request({ signal: controller.signal }));
  const reason = new Error("stopped by the person");
  controller.abort(reason);
  await assert.rejects(asked, (error) => error === reason);
  assert.deepEqual(handoffs.pending(), []);
  assert.equal(handoffs.answer("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", { outcome: "done" }), "not_waiting");
  assert.deepEqual(settled, [{ waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", answer: null }]);

  const already = new AbortController();
  already.abort();
  await assert.rejects(handoffs.request(request({ waitId: "w-2", signal: already.signal })));
  assert.deepEqual(handoffs.pending(), [], "an already-stopped turn never shows a card");
  assert.equal(settled.length, 1, "nothing settles for a card that never opened");
});

test("asking again under the same wait id withdraws the stale card, and only the new one can be answered", async () => {
  const handoffs = createBotHandoffs();
  const settled = recordSettled(handoffs);
  const stale = handoffs.request(request({ toolCallId: "call-old" }));
  const fresh = handoffs.request(request({ toolCallId: "call-new" }));
  await assert.rejects(stale, /asked again/u);
  assert.deepEqual(
    handoffs.pending().map((prompt) => prompt.toolCallId),
    ["call-new"],
  );
  assert.equal(handoffs.answer("bot:ada", "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", { outcome: "done" }), "answered");
  assert.deepEqual(await fresh, { outcome: "done" });
  assert.deepEqual(
    settled.map((entry) => entry.answer),
    [null, { outcome: "done" }],
  );
});

test("cards are listed oldest first per Bot, and a listener that throws changes nothing", async () => {
  const handoffs = createBotHandoffs();
  const changes: string[] = [];
  handoffs.onChange(() => {
    throw new Error("a broken listener");
  });
  const stop = handoffs.onChange((botId) => changes.push(botId));
  handoffs.onSettled(() => {
    throw new Error("another broken listener");
  });
  const first = handoffs.request(request({ waitId: "w-1" }));
  const other = handoffs.request(request({ botId: "bot:bea", waitId: "w-2" }));
  const second = handoffs.request(request({ waitId: "w-3", rule: { id: "money", label: "Move money" }, source: "rule" }));
  assert.deepEqual(
    handoffs.pending("bot:ada").map((prompt: BotPendingHandoff) => prompt.waitId),
    ["w-1", "w-3"],
  );
  assert.deepEqual(handoffs.pending("bot:ada")[1]!.rule, { id: "money", label: "Move money" });
  assert.equal(handoffs.pending().length, 3);
  assert.deepEqual(changes, ["bot:ada", "bot:bea", "bot:ada"]);

  assert.equal(handoffs.answer("bot:ada", "w-1", { outcome: "done" }), "answered");
  assert.deepEqual(await first, { outcome: "done" }, "the answer arrives despite throwing listeners");
  stop();
  handoffs.answer("bot:bea", "w-2", { outcome: "skipped" });
  handoffs.answer("bot:ada", "w-3", { outcome: "skipped" });
  await Promise.all([other, second]);
  assert.deepEqual(changes, ["bot:ada", "bot:bea", "bot:ada", "bot:ada"], "an unsubscribed listener hears nothing");
});
