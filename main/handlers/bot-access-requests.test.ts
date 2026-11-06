import assert from "node:assert/strict";
import test from "node:test";
import { createBotAccessRequests } from "../services/bot-runtime/bot-access-requests.js";
import { accessRequestPrompt } from "../services/bot-runtime/test-support/access-request-fixtures.js";
import { BOT_ANSWER_ACCESS_REQUEST_CHANNEL, registerBotAccessRequestHandlers } from "./bot-access-requests.js";

function setup() {
  const requests = createBotAccessRequests();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  let failure: string | undefined;
  registerBotAccessRequestHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    answer: async (botId, waitId, choice) => {
      const result = await requests.answer(botId, waitId, choice, async () => {
        if (failure) throw new Error(failure);
      });
      if (result === "invalid") throw new Error("That answer doesn’t match the card.");
      return { answered: result === "answered" };
    },
  });
  const waiting = requests.request(accessRequestPrompt());
  const card = requests.pending()[0]!;
  const input = { botId: card.botId, waitId: card.waitId, choice: "always" };
  const invoke = (value: unknown) => Promise.resolve(handlers.get(BOT_ANSWER_ACCESS_REQUEST_CHANNEL)!(undefined, value));
  return { requests, waiting, card, input, invoke, fail: (message?: string) => { failure = message; } };
}

test("desktop access answers reach the real bridge once, using the attempt id, never the logical request id", async () => {
  const { invoke, input, waiting } = setup();
  assert.deepEqual(await invoke({ ...input, waitId: "logical-access" }), { answered: false });
  assert.deepEqual(await invoke({ ...input, botId: "bot:other" }), { answered: false });
  assert.deepEqual(await invoke(input), { answered: true });
  assert.deepEqual(await waiting, { choice: "always", waitId: input.waitId });
  assert.deepEqual(await invoke(input), { answered: false });
});

test("bots:answerAccessRequest rejects unknown choices, extra keys and invalid bounded ids before answering", async () => {
  const { invoke, input, requests, waiting } = setup();
  for (const invalid of [null, [], "once", { ...input, choice: "allow" }, { ...input, choice: undefined },
    { ...input, grant: {} }, { ...input, authorization: {} }, { ...input, botId: "" },
    { ...input, botId: "../other" }, { ...input, botId: "a".repeat(161) },
    { ...input, waitId: "a".repeat(65) }, { ...input, waitId: "../card" }, { ...input, waitId: "" }]) {
    await assert.rejects(invoke(invalid), /Invalid bot/u);
  }
  assert.equal(requests.pending().length, 1);
  await invoke({ ...input, choice: "not_now" });
  await waiting;
});

test("an invalid answer throws the card message; a failed grant preserves the card for retry", async () => {
  const { invoke, input, requests, waiting, fail } = setup();
  fail("This Bot's access changed. Ask for access again.");
  await assert.rejects(invoke(input), /This Bot's access changed/u);
  assert.equal(requests.pending()[0]?.waitId, input.waitId);
  fail();
  await invoke({ ...input, choice: "not_now" });
  await waiting;

  const whole = createBotAccessRequests();
  const asked = whole.request(accessRequestPrompt({
    target: "whole_mac", label: "your whole Mac", place: undefined, grant: undefined,
    choices: ["not_now", "once"], authorization: {
      policyRevision: "rev-1", requestIds: ["run-1"], target: "whole_mac", root: "/", choices: ["not_now", "once"],
    },
  }));
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotAccessRequestHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    answer: async (botId, waitId, choice) => {
      const result = await whole.answer(botId, waitId, choice, async () => {});
      if (result === "invalid") throw new Error("That answer doesn’t match the card.");
      return { answered: result === "answered" };
    },
  });
  const waitId = whole.pending()[0]!.waitId;
  await assert.rejects(Promise.resolve(handlers.get(BOT_ANSWER_ACCESS_REQUEST_CHANNEL)!(undefined, {
    botId: "bot:a", waitId, choice: "always",
  })), /doesn’t match the card/u);
  assert.equal(whole.pending().length, 1);
  await whole.answer("bot:a", waitId, "not_now", async () => {});
  await asked;
});
