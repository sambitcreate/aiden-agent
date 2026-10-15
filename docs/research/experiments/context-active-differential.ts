/** Research-only exact differential for ordered tool elision and active batch pruning.
 * node --import tsx docs/research/experiments/context-active-differential.ts <baseline-module> <candidate-module>
 * Final baseline: prepare-context-final-marker-baseline.py, then pass tmp/research/generation-context-before-active-final-marker.ts and main/services/generation-context.ts.
 * Modules must export compactGenerationContext; this script does not modify either.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { compactGenerationContext, GenerationContextOptions } from "../../../main/services/generation-context.js";
const baselinePath = resolve(process.argv[2] ?? "tmp/research/generation-context-before-active.ts");
const candidatePath = resolve(process.argv[3] ?? "tmp/research/generation-context-active-prototype.ts");
const baseline = (await import(pathToFileURL(baselinePath).href)).compactGenerationContext as typeof compactGenerationContext;
const candidate = (await import(pathToFileURL(candidatePath).href)).compactGenerationContext as typeof compactGenerationContext;
let seed = 260920806;
const random = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const lengths = [0, 1, 128, 1_024, 8_000, 40_000];
const windows = [4_096, 8_192, 16_000, 64_000];
const marker = "\n[Output preview. Read retained output with read_tool_output handle=12345678-1234-4234-8234-123456789abc; offsets are UTF-16 characters. Retained 50000 of 50000 characters, for up to 7 days subject to storage limits.]";
const rows: { id: string; inputHash: string; outputHash: string; compacted: number; removed: number; fallback: boolean }[] = [];
function answer(index: number): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-completions", provider: "active-test", model: "fixture", timestamp: index, stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function check(id: string, messages: AgentMessage[], options: GenerationContextOptions) {
  const before = hash(messages);
  const expected = baseline(messages, options);
  const actual = candidate(messages, options);
  assert.deepEqual(actual, expected, `exact active differential ${id}`);
  assert.equal(hash(messages), before, `input mutation ${id}`);
  assert.ok(actual.estimatedTokensAfter <= actual.inputBudgetTokens, `budget ${id}`);
  const calls = actual.messages.flatMap((m) => m.role === "assistant" ? m.content.flatMap((p) => p.type === "toolCall" ? [p.id] : []) : []);
  const results = actual.messages.flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []);
  assert.deepEqual(calls, results, `tool protocol ${id}`);
  rows.push({ id, inputHash: before, outputHash: hash(actual), compacted: actual.compactedToolResults, removed: actual.removedCurrentTurnMessages, fallback: actual.usedContextFallback });
  return actual;
}
for (let caseId = 0; caseId < 460; caseId += 1) {
  const messages: AgentMessage[] = [];
  if (caseId % 2 === 0) {
    const system = createInitialSystemMessage("Stable tool policy", []); assert.ok(system); messages.push(system);
  }
  if (caseId % 5 === 0) messages.push({ role: "compactionSummary", summary: "KEEP-DECISION-17", tokensBefore: 40_000, timestamp: 1 });
  messages.push({ role: "user", content: "CURRENT-TASK-19" + (caseId % 31 === 0 ? " huge user".repeat(8_000) : ""), timestamp: 2 });
  const fanout = caseId >= 400;
  const batches = fanout ? 1 : 3 + random(37);
  const assistants: AssistantMessage[] = [];
  let time = 3;
  for (let batch = 0; batch < batches; batch += 1) {
    if (caseId % 4 === 0) messages.push({ role: "system", content: "", sections: { guidance: `revision-${batch} ${"rule ".repeat(random(80))}` }, timestamp: time++ });
    const model = answer(time++);
    const results: ToolResultMessage[] = [];
    for (let part = 0; part < (fanout ? 50 + caseId - 400 : 1 + random(4)); part += 1) {
      const id = `${caseId}-${batch}-${part}`;
      model.content.push({ type: "toolCall", id, name: "read_file", arguments: { path: `${id}.ts` } });
      const length = lengths[random(lengths.length)];
      const text = (caseId % 3 === 0 ? "证据😀" : "value ").repeat(Math.ceil(length / 3)).slice(0, length) + (part % 3 === 0 ? marker : "");
      results.push({ role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text }, ...(caseId % 11 === 0 ? [{ type: "image" as const, mimeType: "image/png", data: "fixture" }] : [])], isError: part % 4 === 0, timestamp: time++ });
    }
    assistants.push(model); messages.push(model, ...results);
  }
  const window = windows[caseId % windows.length];
  if (caseId % 4 !== 0) {
    const index = [0, Math.floor(assistants.length / 2), assistants.length - 1][caseId % 4 - 1];
    const anchor = assistants[index];
    anchor.usage.input = Math.floor(window * (0.2 + random(250) / 100));
    anchor.usage.totalTokens = anchor.usage.input;
  }
  const options: GenerationContextOptions = { contextWindow: window, systemPrompt: getCurrentSystemPrompt(messages), tools: [], providerId: caseId % 13 === 0 ? "switched" : "active-test", modelId: "fixture", supportsImages: caseId % 2 === 0, retainsSystemUpdates: true };
  check(`mixed-${caseId}`, messages, options);
}
// Independent adversarial oracle: first replacement fits, later tiny-result replacements enlarge context.
const nonmonotone: AgentMessage[] = [{ role: "user", content: "Active task", timestamp: 1 }];
for (let i = 0; i < 11; i += 1) {
  const model = answer(i * 2 + 2); model.content = [{ type: "toolCall", id: `nm-${i}`, name: "read_file", arguments: {} }];
  nonmonotone.push(model, { role: "toolResult", toolCallId: `nm-${i}`, toolName: "read_file", content: [{ type: "text", text: "x".repeat(i === 0 ? 1_200 : i >= 9 ? 4_000 : 1) }], isError: false, timestamp: i * 2 + 3 });
}
const earliest = check("nonmonotone-earliest-fit", nonmonotone, { contextWindow: 8_000, compactionReserveTokens: 5_748, systemPrompt: "", tools: [] });
assert.equal(earliest.compactedToolResults, 1);
assert.equal(earliest.estimatedTokensAfter, 2_088);
assert.equal(earliest.removedCurrentTurnMessages, 0);
assert.equal(earliest.messages[4].role === "toolResult" && earliest.messages[4].content[0].type === "text" ? earliest.messages[4].content[0].text : undefined, "x");
// Aliases must be kept as references, never serialized/cloned before invocation.
for (const placement of ["active", "history", "prefix"] as const) {
  const anchor = answer(1); anchor.content = [{ type: "text", text: "x".repeat(100) }];
  anchor.usage.input = 4_000; anchor.usage.totalTokens = 4_000;
  const messages: AgentMessage[] = placement === "prefix" ? [anchor] : [];
  messages.push({ role: "user", content: "Active request", timestamp: 1 });
  for (let index = 0; index < 7; index += 1) {
    if (placement === "history" && index > 0) messages.push({ role: "user", content: "Next", timestamp: index + 2 });
    const ordinary = answer(index + 2); ordinary.content = [{ type: "text", text: "x".repeat(placement === "history" ? 100 : 1_000) }];
    messages.push(index === 1 || index === 4 ? anchor : ordinary);
  }
  const actual = check(`duplicate-anchor-${placement}`, messages, { contextWindow: 8_000, compactionReserveTokens: placement === "history" ? 7_000 : 6_000,
    systemPrompt: "", tools: [], providerId: "active-test", modelId: "fixture" });
  if (placement === "active") { assert.equal(actual.removedCurrentTurnMessages, 1); assert.equal(actual.estimatedTokensAfter, 1_170); }
  if (placement === "history") { assert.equal(actual.removedHistoryMessages, 2); assert.equal(actual.estimatedTokensAfter, 912); }
}
for (const sections of [undefined, { obsolete: null }]) {
  const messages: AgentMessage[] = [{ role: "system", content: "", sections, timestamp: 1 }, ...nonmonotone,
    { role: "system", content: "", sections, timestamp: 100 }];
  check(`empty-system-${sections ? "deleted" : "plain"}`, messages, { contextWindow: 8_000, compactionReserveTokens: 5_748, systemPrompt: "", tools: [], retainsSystemUpdates: true });
}
console.log(JSON.stringify({ evidenceKind: "exact-active-path-differential", seed: 260920806, cases: rows.length,
  baselineModuleSha256: createHash("sha256").update(await readFile(baselinePath)).digest("hex"), candidateModuleSha256: createHash("sha256").update(await readFile(candidatePath)).digest("hex"),
  replacementCases: rows.filter((r) => r.compacted > 0).length, batchRemovalCases: rows.filter((r) => r.removed > 0).length, fallbackCases: rows.filter((r) => r.fallback).length, outputSetSha256: hash(rows),
  limitations: "Synthetic exact equivalence, includes signed-growth nonmonotonic control, mixed tiny/large/error/image/recovery evidence, system patches, fractional ratios and parallel-result batches; no live model claims." }, null, 2));
