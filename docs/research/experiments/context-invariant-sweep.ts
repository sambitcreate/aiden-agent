/** Offline research probe; no provider calls, persisted chats, or rollout receipts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assertGenerationContextCapacity, compactGenerationContext, projectNextContextUsage } from "../../../main/services/generation-context.js";

let randomState = 260920804;
const random = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x100000000;
};
const integer = (n: number) => Math.floor(random() * n);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const windows = [2048, 4096, 8192, 16000, 32000, 64000, 128000, 272000];
const texts = ["abc def ", "日本語の証拠", "🙂🧪", "e\u0301"];
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const count = Number(process.argv[2] ?? 1000);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 10000);
const totals = { cases: 0, capacityRejected: 0, reduced: 0, fallback: 0, historyRemoved: 0, toolResultsElided: 0, inputMessages: 0 };
const failures: { caseId: number; window: number; message: string; inputDigest: string }[] = [];
const started = performance.now();

function assertPairing(messages: AgentMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      assert.equal(pending.size, 0, "another assistant turn cannot precede outstanding results");
      for (const block of message.content) {
        if (block.type === "toolCall") {
          assert.equal(pending.has(block.id), false, "tool IDs must be unique within a batch");
          pending.add(block.id);
        }
      }
    } else if (message.role === "toolResult") {
      assert.ok(pending.delete(message.toolCallId), "result must match a preceding unresolved call");
    } else if (message.role === "user") {
      assert.equal(pending.size, 0, "user turn cannot split a complete tool batch");
    }
  }
  assert.equal(pending.size, 0, "outbound context must have no unresolved call");
}

for (let caseId = 0; caseId < count; caseId++) {
  const window = windows[caseId % windows.length]!;
  const messages: AgentMessage[] = [];
  const turns = 1 + integer(5);
  let sequence = 0;
  let latestRequest = "";
  for (let turn = 0; turn < turns; turn++) {
    latestRequest = `case-${caseId}-request-${turn}`;
    messages.push({ role: "user", content: latestRequest + " " + texts[integer(texts.length)]!.repeat(integer(500)), timestamp: sequence++ });
    const batches = 1 + integer(5);
    for (let batch = 0; batch < batches; batch++) {
      const callCount = 1 + integer(3);
      const calls = Array.from({ length: callCount }, (_, index) => ({ type: "toolCall" as const, id: `${caseId}-${turn}-${batch}-${index}`, name: "read_file", arguments: { path: `fixture-${index}.txt` } }));
      const measured = caseId % 3 === 0 ? integer(window) : 0;
      const assistant: AssistantMessage = { role: "assistant", content: calls, api: "openai-responses", provider: "research", model: "fixture", stopReason: "toolUse", timestamp: sequence++, usage: { input: measured, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: measured, cost: zeroCost } };
      messages.push(assistant);
      for (const call of calls) {
        const unit = texts[integer(texts.length)]!;
        const output = unit.repeat(integer(caseId % 5 === 0 ? 16000 : 1600));
        messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output }], isError: integer(7) === 0, timestamp: sequence++ });
      }
    }
  }
  const inputDigest = digest(messages);
  const options = { contextWindow: window, systemPrompt: "Retain the latest task and tool protocol.", tools: [], providerId: caseId % 7 === 0 ? "switched-provider" : "research", modelId: "fixture" };
  try {
    assertPairing(messages);
    if (window === 2048) {
      assert.throws(() => assertGenerationContextCapacity(options), /too small for Aiden's active system prompt and tools/u);
      totals.capacityRejected++;
      continue;
    }
    assertGenerationContextCapacity(options);
    const projection = projectNextContextUsage(messages, options);
    assert.ok(Number.isFinite(projection.contextTokens));
    const result = compactGenerationContext(messages, options);
    assert.equal(digest(messages), inputDigest, "projection must never mutate durable originals");
    assertPairing(result.messages);
    assert.ok(Number.isFinite(result.estimatedTokensAfter) && result.estimatedTokensAfter >= 0);
    assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens, "returned context must fit when static context is feasible");
    if (result.usedContextFallback) {
      assert.equal(result.messages.some((message) => message.role === "toolResult"), false);
      assert.equal(result.messages.some((message) => message.role === "assistant"), false);
    } else {
      assert.ok(result.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes(latestRequest)), "latest request must survive unless explicit fallback is used");
    }
    totals.cases++;
    totals.reduced += Number(result.compacted);
    totals.fallback += Number(result.usedContextFallback);
    totals.historyRemoved += Number(result.removedHistoryMessages > 0);
    totals.toolResultsElided += result.compactedToolResults;
    totals.inputMessages += messages.length;
  } catch (error) {
    failures.push({ caseId, window, message: error instanceof Error ? error.message : String(error), inputDigest });
  }
}
console.log(JSON.stringify({ evidenceKind: "synthetic-invariant-sweep", seed: 260920804, windows, requestedCases: count, totals, failures, elapsedMs: performance.now() - started, limitations: "Synthetic valid tool transcripts; no real tokenizer, provider, model quality, live billing, or durable checkpoint execution. No claim that omitted evidence remains useful." }, null, 2));
if (failures.length) process.exitCode = 1;
