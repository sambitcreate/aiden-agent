// Spend accounting for the Auto judge (plan §3.2): every judge call shows in
// usage as "approval-judge", and its cost counts toward the run's spending
// limit, through the same meter a chat's replies use.

import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";

import { createSpendingMeter } from "../spending-service.js";
import type { SpendingOwner } from "../spending-core.js";
import type { StoredProvider } from "../types.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { createApprovalJudge } from "./judge.js";
import { approvalJudgeComplete } from "./model-complete.js";

const provider: StoredProvider = {
  id: "openrouter",
  kind: "openai",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  models: ["judge-1"],
  needsKey: true,
  deployment: "hosted",
};
const model = { id: "judge-1", name: "Judge 1", api: "openai-completions", provider: "openrouter" } as unknown as Model<Api>;

function reply(text: string, costUsd: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 120, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 121, cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd } },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

function streams(message: AssistantMessage | Error): Pick<Models, "streamSimple"> {
  return {
    streamSimple: (() => ({
      result: async () => {
        if (message instanceof Error) throw message;
        return message;
      },
    })) as unknown as Models["streamSimple"],
  };
}

test("a judged action's cost counts toward the chat's limit and shows in usage", async () => {
  const usage: UsageRequestRecord[] = [];
  const recorded: Array<{ owner: SpendingOwner; usd: number }> = [];
  const owner: SpendingOwner = { kind: "chat", id: "chat-1" };
  const meter = createSpendingMeter({
    spending: { record: async (to, usd) => void recorded.push({ owner: to, usd }), refusal: async () => undefined },
    owner,
    counts: async () => true,
  });
  const judge = createApprovalJudge({
    complete: approvalJudgeComplete(
      { model, provider, streams: streams(reply("PASS", 0.0004)) },
      { recordUsage: (record) => void usage.push(record), countSpend: (message) => meter.count(message) },
    ),
  });

  const first = await judge.judge({ effect: "send:a", action: "send to a", request: "send it to a" });
  assert.equal(first.verdict, "pass");
  // A cached verdict costs nothing more.
  await judge.judge({ effect: "send:a", action: "send to a", request: "send it to a" });
  await meter.settled();

  assert.deepEqual(recorded, [{ owner, usd: 0.0004 }]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.source, "approval-judge");
  assert.equal(usage[0]!.status, "completed");
  assert.equal(usage[0]!.costUsd, 0.0004);
});

test("a failed judge call is still listed in usage, and defers", async () => {
  const usage: UsageRequestRecord[] = [];
  let spent = 0;
  const judge = createApprovalJudge({
    complete: approvalJudgeComplete(
      { model, provider, streams: streams(new Error("network")) },
      { recordUsage: (record) => void usage.push(record), countSpend: () => { spent += 1; } },
    ),
  });
  const verdict = await judge.judge({ effect: "x", action: "x", request: "y" });
  assert.equal(verdict.verdict, "defer");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.source, "approval-judge");
  assert.equal(usage[0]!.status, "failed");
  assert.equal(spent, 0);
});

test("a provider error reply is charged as reported, then defers", async () => {
  const usage: UsageRequestRecord[] = [];
  const counted: AssistantMessage[] = [];
  const judge = createApprovalJudge({
    complete: approvalJudgeComplete(
      { model, provider, streams: streams(reply("", 0.0001, "error")) },
      { recordUsage: (record) => void usage.push(record), countSpend: (message) => void counted.push(message) },
    ),
  });
  assert.equal((await judge.judge({ effect: "x", action: "x", request: "y" })).verdict, "defer");
  assert.equal(counted.length, 1);
  assert.equal(usage[0]!.source, "approval-judge");
});
