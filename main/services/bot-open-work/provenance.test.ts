import assert from "node:assert/strict";
import test from "node:test";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { resolveBotOpenWorkOrigin } from "./provenance.js";
import { issueBotRoutineInputOrigin, isIssuedBotRoutineInputOrigin } from "../bot-runtime/bot-input-entry.js";
function call(kind = "pi.user", request = "person-request", data?: unknown): BotToolCall {
  return { signal: new AbortController().signal, callId: "tool", runRequestIds: async () => [request], submissions: async () => [{ id: 1, type: "input", status: "placed", requestId: request, entry: 2, conversationId: 3 }], entries: async () => [{ id: 2, kind, ...(data ? { data } : {}), model: [{ role: "user", content: [{ type: "text", text: "Explicit task" }], timestamp: 0 }] }], memo: async (_name: string, candidate: unknown) => candidate } as unknown as BotToolCall;
}
test("only a current placed host input becomes the source, ignoring old routine notices", async () => {
  const current = call(); const previous = current.entries;
  current.entries = async () => [{ id: 99, kind: "aiden.bot-notice", data: { notice: "routine", requestId: "routine:old:fire" } } as never, ...await previous()];
  const origin = await resolveBotOpenWorkOrigin("bot:one", current, undefined, async () => { throw new Error("person is not a routine"); });
  assert.deepEqual(origin.source, { kind: "person", submissionId: "1", entryId: "2" });
  current.submissions = async () => [{ id: 1, type: "input", status: "done", requestId: "person-request", entry: 2, answer: 4 } as never];
  await assert.rejects(resolveBotOpenWorkOrigin("bot:one", current, undefined, async () => undefined), /no longer active/u);
});
test("forged prefixes, hidden inputs and absent accepted routine receipts cannot create tasks", async () => {
  await assert.rejects(resolveBotOpenWorkOrigin("bot:one", call("pi.user", "routine:fake:fire"), undefined, async () => undefined), /provenance/u);
  await assert.rejects(resolveBotOpenWorkOrigin("bot:one", call("aiden.routine-input", "routine:fake:fire"), undefined, async () => undefined), /accepted/u);
  const hidden = call(); const entries = hidden.entries; hidden.entries = async () => [...await entries(), { kind: "aiden.bot-notice", data: { notice: "hidden_input", requestId: "person-request" } } as never];
  await assert.rejects(resolveBotOpenWorkOrigin("bot:one", hidden, undefined, async () => undefined), /Hidden/u);
  await assert.rejects(resolveBotOpenWorkOrigin("bot:one", call("tool.fyi"), undefined, async () => undefined), /cannot/u);
});
test("manual routine origin is durable host data, but ordinary senders cannot mint an issued origin", async () => {
  const issued = issueBotRoutineInputOrigin({ version: 1, botId: "bot:one", routineId: "routine-one", runId: "routine:routine-one:manual-one", kind: "manual" });
  assert.equal(isIssuedBotRoutineInputOrigin(issued), true); assert.equal(isIssuedBotRoutineInputOrigin({ ...issued }), false);
  const restored = JSON.parse(JSON.stringify(issued));
  const origin = await resolveBotOpenWorkOrigin("bot:one", call("aiden.routine-input", issued.runId, { routineOrigin: restored }), undefined, async (botId, requestId, _submission, stored) => stored?.botId === botId && stored.runId === requestId ? { routineId: stored.routineId, runId: stored.runId } : undefined);
  assert.equal(origin.source.kind, "routine");
  await assert.rejects(resolveBotOpenWorkOrigin("bot:other", call("aiden.routine-input", issued.runId, { routineOrigin: restored }), undefined, async () => ({ routineId: issued.routineId, runId: issued.runId })), /another request/u);
});
