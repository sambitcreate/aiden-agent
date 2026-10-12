/** Compare optimization output with an equally corrected sequential baseline.
 * Final preparation: python3 docs/research/experiments/prepare-context-final-marker-baseline.py
 * Final comparison: node --import tsx docs/research/experiments/context-compaction-differential.ts tmp/research/generation-context-before-scaling-final-marker.ts main/services/generation-context.ts
 * Explicit old module arguments preserve earlier historical comparisons.
 * The snapshot retains sequential pruning; imports may be relocated.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { compactGenerationContext, type GenerationContextOptions } from "../../../main/services/generation-context.js";
const baselinePath = resolve(process.argv[2] ?? "tmp/research/generation-context-before-scaling.ts");
const baseline = await import(pathToFileURL(baselinePath).href) as { compactGenerationContext: typeof compactGenerationContext };
const candidateCompactor: typeof compactGenerationContext = process.argv[3]
  ? (await import(pathToFileURL(resolve(process.argv[3])).href)).compactGenerationContext
  : compactGenerationContext;
let state = 260920805;
const random = (bound: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % bound; };
const texts = ["plain abc ", "证据😀", "e\u0301 and punctuation:{}", "abc\nline\n"];
const windows = [4_096, 8_192, 16_000, 24_000, 64_000, 128_000];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rows = [];
let pruningCases = 0;
let fallbackCases = 0;
function answer(text: string, time: number): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "differential", model: "fixture", stopReason: "stop", timestamp: time,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const started = performance.now();
for (let caseId = 0; caseId < 1_500; caseId += 1) {
  const messages: AgentMessage[] = [];
  if (caseId % 3 === 0) {
    const system = createInitialSystemMessage("Original system constraint", []); assert.ok(system); messages.push(system);
  }
  if (caseId % 5 === 0) messages.push({ role: "compactionSummary", summary: "KEEP-CHECKPOINT-417", tokensBefore: 100_000, timestamp: 1 });
  if (caseId % 11 === 0) messages.push(answer("Leading assistant outside user boundaries", 1));
  const turns = caseId < 4 ? caseId : 3 + random(35);
  let time = 2;
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: `user-${turn} ${texts[random(texts.length)].repeat(random(250))}`, timestamp: time++ });
    if (caseId % 4 === 0) messages.push({ role: "system", content: "", sections: { guidance: `revision-${turn} ${"guidance ".repeat(random(150))}` }, timestamp: time++ });
    const response = answer(`answer-${turn} ${texts[random(texts.length)].repeat(random(350))}`, time++);
    if (caseId % 7 === 0) {
      const id = `call-${caseId}-${turn}`;
      response.content = [{ type: "toolCall", id, name: "read_file", arguments: { path: `${turn}.ts` } }];
      response.stopReason = "toolUse";
      messages.push(response, { role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text: texts[random(texts.length)].repeat(random(2_000)) }], isError: turn % 4 === 0, timestamp: time++ });
    } else messages.push(response);
  }
  messages.push({ role: "user", content: "ACTIVE-REQUEST-719" + (caseId % 17 === 0 ? " oversized attachment".repeat(8_000) : ""), timestamp: time++ });
  if (caseId % 9 === 0) {
    const pending = answer("", time++);
    pending.content = [{ type: "toolCall", id: "active-call", name: "read_file", arguments: { path: "active.ts" } }];
    pending.stopReason = "toolUse";
    messages.push(pending, { role: "toolResult", toolCallId: "active-call", toolName: "read_file", content: [{ type: "text", text: "current evidence ".repeat(8_000) }], isError: false, timestamp: time++ });
  }
  const assistants = messages.filter((message): message is AssistantMessage => message.role === "assistant");
  const window = windows[caseId % windows.length];
  if (assistants.length && caseId % 2 === 0) {
    const anchor = assistants[[0, Math.floor(assistants.length / 2), assistants.length - 1][caseId % 3]];
    anchor.usage.input = Math.floor(window * (0.1 + random(140) / 100));
    anchor.usage.totalTokens = anchor.usage.input;
  }
  const options: GenerationContextOptions = { contextWindow: window, systemPrompt: getCurrentSystemPrompt(messages), tools: [],
    providerId: caseId % 13 === 0 ? "switched" : "differential", modelId: "fixture", retainsSystemUpdates: caseId % 2 === 0 };
  // Reserve neighbors exercise decisions close to exact integral boundaries.
  if (caseId % 10 === 0) options.compactionReserveTokens = Math.floor(window * 0.3) + caseId % 3 - 1;
  const before = hash(messages);
  const expected = baseline.compactGenerationContext(messages, options);
  const actual = candidateCompactor(messages, options);
  assert.deepEqual(actual, expected, `exact baseline equivalence case ${caseId}`);
  assert.equal(hash(messages), before, `input mutation case ${caseId}`);
  assert.ok(actual.estimatedTokensAfter <= actual.inputBudgetTokens, `budget case ${caseId}`);
  if (!actual.usedContextFallback) assert.ok(actual.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("ACTIVE-REQUEST-719")));
  pruningCases += Number(actual.removedHistoryMessages > 0);
  fallbackCases += Number(actual.usedContextFallback);
  rows.push({ caseId, inputHash: before, outputHash: hash(actual), removedHistoryMessages: actual.removedHistoryMessages });
}
// Explicit adjacent input budgets expose off-by-one prefix choices.
const boundaryMessages: AgentMessage[] = [];
for (let index = 0; index < 7; index += 1) {
  boundaryMessages.push({ role: "user", content: "u".repeat(8_000), timestamp: index * 2 + 1 }, answer("a".repeat(8_000), index * 2 + 2));
}
boundaryMessages.push({ role: "user", content: "active", timestamp: 20 });
const boundaryOptions = { contextWindow: 64_000, systemPrompt: "boundary", tools: [] };
const boundaryTokens = baseline.compactGenerationContext(boundaryMessages, boundaryOptions).estimatedTokensBefore;
for (const offset of [-1, 0, 1]) {
  const options = { ...boundaryOptions, compactionReserveTokens: 64_000 - boundaryTokens + offset };
  const expected = baseline.compactGenerationContext(boundaryMessages, options);
  const actual = candidateCompactor(boundaryMessages, options);
  assert.deepEqual(actual, expected, `exact-fit neighbor ${offset}`);
  rows.push({ caseId: 1_500 + offset + 1, inputHash: hash(boundaryMessages), outputHash: hash(actual), removedHistoryMessages: actual.removedHistoryMessages });
}
// Preserve in-memory aliases: serialization would hide indexOf anchor jumps.
for (const placement of ["history", "prefix", "active"] as const) for (const budget of [500, 1_000, 2_000, 4_000]) {
  const anchor = answer("x".repeat(100), 1); anchor.usage.input = 4_000; anchor.usage.totalTokens = 4_000;
  const messages: AgentMessage[] = placement === "prefix" ? [anchor] : [];
  messages.push({ role: "user", content: "Active request", timestamp: 1 });
  for (let index = 0; index < 7; index += 1) {
    if (placement !== "active" && index > 0) messages.push({ role: "user", content: "Next", timestamp: index + 2 });
    messages.push(index === 1 || index === 4 ? anchor : answer("x".repeat(placement === "active" ? 1_000 : 100), index + 2));
  }
  const options = { contextWindow: 8_000, compactionReserveTokens: 8_000 - budget, systemPrompt: "", tools: [], providerId: "differential", modelId: "fixture" };
  const before = hash(messages);
  const expected = baseline.compactGenerationContext(messages, options);
  const actual = candidateCompactor(messages, options);
  assert.deepEqual(actual, expected, `alias ${placement} budget ${budget}`);
  assert.equal(hash(messages), before);
  pruningCases += Number(actual.removedHistoryMessages > 0);
  fallbackCases += Number(actual.usedContextFallback);
  rows.push({ caseId: rows.length, inputHash: before, outputHash: hash(actual), removedHistoryMessages: actual.removedHistoryMessages });
}
console.log(JSON.stringify({ evidenceKind: "exact-baseline-differential", seed: 260920805, cases: rows.length, pruningCases, fallbackCases,
  baselineModuleSha256: createHash("sha256").update(await readFile(baselinePath)).digest("hex"),
  candidateModuleSha256: createHash("sha256").update(await readFile(resolve(process.argv[3] ?? "main/services/generation-context.ts"))).digest("hex"),
  outputSetSha256: hash(rows), elapsedMs: performance.now() - started,
  coverage: ["zero and matching/mismatched usage", "anchor at first/middle/last assistant", "leading checkpoint/system/non-user prefix", "system section revisions", "tool batches and error results", "active large tool result", "Unicode", "zero/few/many historical turns", "oversized active user fallback", "reserve boundary neighbors", "exact total-input budget -1/0/+1", "duplicate anchor identity in history/prefix/active"],
  limitations: "Synthetic valid histories and exact old-code comparison; no real-model quality or billed-token inference." }, null, 2));
