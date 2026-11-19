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
const call = {
  callId: "call",
  signal: new AbortController().signal,
  memo: async <T extends JsonValue>(_key: string, value: T) => value,
  runRequestIds: async () => [undefined],
  entries: async () => [],
  submissions: async () => [],
  appendEntry: async () => undefined,
};
const peers = (ids: string[], paused: string[] = []) =>
  ids.map((id) => ({ id, name: `Bot ${id}`, purpose: "helper", acceptsMessages: !paused.includes(id), sendsMessages: true }));

test("refusals are error results", async () => {
  const candidate = await messageBotCandidate("A", {
    roster: async () => peers(["A", "B"]),
    post: async () => ({
      status: "refused" as const,
      code: "ambiguous_bot" as const,
      message: "Use an id",
      bots: ["Bee", "Bee"],
    }),
  });
  const result = await candidate.bind!(call).execute("call", { bot: "Bee", message: "x" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { code: string }).code, "ambiguous_bot");
});

test("the declaration is the same whatever the roster, and list returns the Bots that accept messages", async () => {
  const unexpectedPost = async (): Promise<never> => {
    throw new Error("Listing must not send");
  };
  const rosters = [peers([]), peers(["A", "B"]), peers(["A", "B", "C", "D"], ["C"])];
  const declared = await Promise.all(
    rosters.map(async (roster) => {
      const { tool } = await messageBotCandidate("A", { roster: async () => roster, post: unexpectedPost });
      return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
    }),
  );
  assert.equal(new Set(declared).size, 1, "one declaration for every roster");
  assert.ok(!declared[0]!.includes("Bot B"), "no peer is named in the declaration");

  const roster = rosters[2]!;
  const candidate = await messageBotCandidate("A", { roster: async () => roster, post: unexpectedPost });
  const listed = await candidate.bind!(call).execute("call", { action: "list" });
  assert.equal(listed.isError, undefined);
  assert.deepEqual((listed.details as { bots: Array<{ id: string }> }).bots.map((b) => b.id), ["B", "D"]);

  const alone = await messageBotCandidate("A", { roster: async () => peers(["A"]), post: unexpectedPost });
  const none = await alone.bind!(call).execute("call", { action: "list" });
  assert.deepEqual((none.details as { bots: unknown[] }).bots, []);
  assert.match(JSON.stringify(none.content), /No other Bot accepts messages/);
});

test("a send without a target or a message is refused before posting", async () => {
  const candidate = await messageBotCandidate("A", {
    roster: async () => peers(["A", "B"]),
    post: async () => {
      throw new Error("Unexpected send");
    },
  });
  await assert.rejects(candidate.bind!(call).execute("call", { message: "hi" }), /needs both "bot" and "message"/);
});

test("building the declaration reads no availability and posting stays authoritative", async () => {
  const candidate = await messageBotCandidate("A", {
    roster: async () => { throw new Error("Declaration must not discover availability"); },
    post: async () => ({ status: "refused", code: "bot_paused", message: "Paused now" }),
  });
  const result = await candidate.bind!(call).execute("call", { bot: "B", message: "Review" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { code: string }).code, "bot_paused");
});
