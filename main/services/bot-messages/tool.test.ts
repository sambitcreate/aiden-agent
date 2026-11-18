import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord/json";
import { createMessageBotTool } from "./tool.js";
import { messageBotCandidate } from "./candidate.js";
import type { BotMessagePost } from "./courier.js";
test("delivery memo and actual run request ids survive replay", async () => {
  const posted: BotMessagePost[] = [];
  const memos = new Map<string, JsonValue>();
  const tool = createMessageBotTool(
    "A",
    {
      roster: async () => [],
      post: async (input) => {
        posted.push(input);
        return { status: "sent", deliveryId: input.deliveryId, to: { id: "B", name: "Bee" } };
      },
    },
    {
      memo: async <T extends JsonValue>(key: string, candidate: T) => {
        if (!memos.has(key)) memos.set(key, candidate);
        return memos.get(key) as T;
      },
      runRequestIds: async () => ["bot:J:1:00112233-4455-4677-8899-aabbccddeeff"],
      signal: new AbortController().signal,
    },
  );
  await tool.execute("one", { bot: "B", message: "hello" });
  await tool.execute("one", { bot: "B", message: "hello" });
  assert.equal(posted[0]!.deliveryId, posted[1]!.deliveryId);
  assert.deepEqual(posted[0]!.runRequestIds, ["bot:J:1:00112233-4455-4677-8899-aabbccddeeff"]);
});
test("refusals are error results and refresh descriptions list eligible peers only", async () => {
  const deps = {
    roster: async () =>
      ["A", "B", "C"].map((id) => ({
        id,
        name: `Bot ${id}`,
        purpose: "helper",
        acceptsMessages: id !== "C",
        sendsMessages: true,
      })),
    post: async () => ({
      status: "refused" as const,
      code: "ambiguous_bot" as const,
      message: "Use an id",
      bots: ["Bee", "Bee"],
    }),
  };
  const candidate = await messageBotCandidate("A", deps);
  assert.ok(candidate.tool.description.includes("Bot B"));
  assert.ok(!candidate.tool.description.includes("Bot A"));
  assert.ok(!candidate.tool.description.includes("Bot C"));
  const result = await candidate.bind!({
    callId: "call",
    signal: new AbortController().signal,
    memo: async (_key, value) => value,
    runRequestIds: async () => [undefined],
    entries: async () => [],
    submissions: async () => [],
    appendEntry: async () => undefined,
  }).execute("call", { bot: "Bee", message: "x" });
  assert.equal(result.isError, true);
  assert.equal(
    (
      result.details as {
        code: string;
      }
    ).code,
    "ambiguous_bot",
  );
});


test("captured declaration identities avoid availability reads and leave posting authoritative", async () => {
  const candidate = await messageBotCandidate("A", {
    descriptionRoster: [{ id: "B", name: "Bee", purpose: "Review", acceptsMessages: true, sendsMessages: true }],
    roster: async () => { throw new Error("Declaration must not discover availability"); },
    post: async () => ({ status: "refused", code: "bot_paused", message: "Paused now" }),
  });
  assert.ok(candidate.tool.description.includes("Bee"));
  const result = await candidate.bind!({
    callId: "call", signal: new AbortController().signal,
    memo: async (_key, value) => value, runRequestIds: async () => ["person"],
    entries: async () => [], submissions: async () => [], appendEntry: async () => undefined,
  }).execute("call", { bot: "B", message: "Review" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { code: string }).code, "bot_paused");
});
