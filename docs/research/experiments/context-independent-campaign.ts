/** Independent seeded policy-equivalence campaign, run via context-independent-campaign.py.
 * Baseline preparation: python3 docs/research/experiments/prepare-context-compaction-baseline.py
 * Optional fifth argument selects an equally corrected baseline; generation logic is unchanged.
 * Each worker is bounded by its parent process; no sessions, inference or network.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { compactGenerationContext as candidate, estimateStaticContextTokens, type GenerationContextOptions } from "../../../main/services/generation-context.js";
const baselinePath = resolve(process.argv[5] ?? "tmp/research/generation-context-before-scaling.ts");
const baseline: typeof candidate = (await import(pathToFileURL(baselinePath).href)).compactGenerationContext;
const initialSeed = Number(process.argv[2] ?? 260920811);
const count = Number(process.argv[3] ?? 120);
const outputDirectory = resolve(process.argv[4] ?? "tmp/research/independent-campaign");
mkdirSync(outputDirectory, { recursive: true });
let randomState = initialSeed >>> 0;
function random(n: number): number { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) % n; }
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const outputs = createHash("sha256");
const coverage: Record<string, number> = {};
const note = (name: string) => { coverage[name] = (coverage[name] ?? 0) + 1; };
let checks = 0;
function assistant(text: string, index: number): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "independent", model: "model", timestamp: index, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function topology(messages: AgentMessage[]) {
  const objects: AgentMessage[] = [], slots: number[] = [];
  const identities = new Map<AgentMessage, number>();
  for (const message of messages) { let id = identities.get(message); if (id === undefined) { id = objects.length; identities.set(message, id); objects.push(message); } slots.push(id); }
  return { objects, slots };
}
function fixture(index: number) {
  const messages: AgentMessage[] = [];
  const aliases: AssistantMessage[] = [];
  const mode = index % 6;
  const shared = assistant("alias " + "证据😀".repeat(random(80)), 1);
  const words = ["", "x", "e\u0301🧪证据\n", "false\nFAILED\n", "x ".repeat(40)];
  const resultSizes = [0, 1, 3, 7, 31, 127, 1023, 4095, 8001, 32001];
  const emitCustom = (serial: number) => {
    const variant = random(3);
    if (variant === 0) messages.push({ role: "custom", customType: "offline-fixture", content: [{ type: "text", text: "Custom evidence " + "x".repeat(random(400)) }], display: false, timestamp: serial });
    if (variant === 1) messages.push({ role: "bashExecution", command: "printf fixture", output: "external command observation " + "x".repeat(random(700)), exitCode: 0, cancelled: false, truncated: false, timestamp: serial });
    if (variant === 2) messages.push({ role: "branchSummary", summary: "Retain branch constraint " + "x".repeat(random(250)), fromId: "fixture", timestamp: serial });
    note(["custom", "bashExecution", "branchSummary"][variant]);
  };
  if (index % 2 === 0) messages.push({ role: "system", content: "Initial trusted policy", sections: { alpha: "a", beta: "b" }, timestamp: 0 });
  if (index % 3 === 0) { messages.push({ role: "compactionSummary", summary: "CHECKPOINT-ORIGINAL-417", tokensBefore: 120000, timestamp: 0 }); note("checkpointPrefix"); }
  emitCustom(0);
  if (mode === 0) { messages.push(shared); aliases.push(shared); note("anchorInPreservedPrefix"); }
  const turns = mode >= 4 ? 1 : 2 + random(9);
  let serial = 2;
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: "user", content: turn === turns - 1 ? "ACTIVE-REQUEST-719" : `Prior request ${turn}`, timestamp: serial++ });
    const batches = 2 + random(mode >= 4 ? 16 : 5);
    for (let batch = 0; batch < batches; batch++) {
      if ((batch + turn) % 3 === 0) {
        messages.push({ role: "system", content: batch % 2 ? "Appended rule" : "", sections: { alpha: batch % 2 ? null : `revision ${turn}/${batch}`, beta: words[random(words.length)], gamma: batch % 2 ? "new rule" : null }, timestamp: serial++ }); note("systemSectionDeleteReplace");
      }
      if (mode < 4 && (batch === 1 || (mode === 2 && batch === batches - 1))) { messages.push(shared); aliases.push(shared); }
      const answer = assistant(words[random(words.length)].repeat(random(30)), serial++);
      if (batch % 4 === 0) answer.content.push({ type: "thinking", thinking: "reason ".repeat(random(100)) });
      const fanout = mode === 5 ? 15 + random(35) : random(6);
      const results: AgentMessage[] = [];
      for (let call = 0; call < fanout; call++) {
        const id = `${initialSeed}-${index}-${turn}-${batch}-${call}`;
        answer.content.push({ type: "toolCall", id, name: call % 5 === 0 ? "browser_snapshot" : "inspect", arguments: { path: `证据/${call}.txt`, options: { multiline: "a\nb", nested: [turn, batch, call] } } });
        const length = resultSizes[random(resultSizes.length)];
        const body = words[2].repeat(Math.ceil(length / words[2].length)).slice(0, length);
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [{ type: "text", text: body }];
        if (call % 4 === 0) { content.push({ type: "image", mimeType: "image/png", data: "offline-fixture" }); note("imageResults"); }
        if (call % 7 === 0) content.push({ type: "text", text: "\n[Output preview. Read retained output with read_tool_output handle=12345678-1234-4234-8234-123456789abc; offsets are UTF-16 characters. Retained 50000 of 50000 characters, for up to 7 days subject to storage limits.]" });
        results.push({ role: "toolResult", toolCallId: id, toolName: call % 5 === 0 ? "browser_snapshot" : "inspect", content, isError: call % 3 === 0, timestamp: serial++ });
      }
      if (fanout) { answer.stopReason = "toolUse"; note(mode === 5 ? "highFanout" : "mixedFanout"); }
      messages.push(answer, ...results);
      if (batch % 2 === 0) emitCustom(serial++);
    }
  }
  if (aliases.length) { shared.usage.input = 500 + random(90000); shared.usage.totalTokens = shared.usage.input; note(`anchorAliases-${Math.min(aliases.length, 4)}`); }
  else {
    const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
    for (const at of [0, Math.floor(assistants.length / 2), assistants.length - 1]) {
      const anchor = assistants[at]; anchor.usage.input = 500 + random(90000); anchor.usage.cacheRead = random(3000); anchor.usage.output = random(300); anchor.usage.totalTokens = anchor.usage.input + anchor.usage.cacheRead + anchor.usage.output;
    }
    note("multipleUsageAnchors");
  }
  const tools: AgentTool[] = [{ name: "inspect", label: "Inspect", description: "x".repeat(random(1000)), parameters: Type.Object({ query: Type.String({ description: "schema " + words[2].repeat(random(100)) }) }), execute: async () => { throw new Error("No tool is executed in this campaign"); } }];
  const options: GenerationContextOptions = { contextWindow: [8192, 16000, 32768][random(3)], systemPrompt: getCurrentSystemPrompt(messages), tools, providerId: index % 9 === 0 ? "switched-provider" : "independent", modelId: "model", retainsSystemUpdates: index % 2 === 0, supportsImages: index % 3 !== 0 };
  const minimum = estimateStaticContextTokens(options) + 250;
  const budget = minimum + random(Math.max(1, Math.floor(options.contextWindow / 2) - minimum));
  options.compactionReserveTokens = options.contextWindow - budget;
  return { messages, options, mode };
}
function check(index: number, variant: string, messages: AgentMessage[], options: GenerationContextOptions) {
  const before = hash(topology(messages));
  const expected = baseline(messages, options), actual = candidate(messages, options);
  try {
    assert.deepEqual(actual, expected);
    assert.deepEqual(topology(actual.messages).slots, topology(expected.messages).slots);
    assert.equal(hash(topology(messages)), before);
    assert.ok(actual.estimatedTokensAfter <= actual.inputBudgetTokens);
    const calls = actual.messages.flatMap(m => m.role === "assistant" ? m.content.flatMap(p => p.type === "toolCall" ? [[p.id, p.name]] : []) : []);
    const results = actual.messages.flatMap(m => m.role === "toolResult" ? [[m.toolCallId, m.toolName]] : []);
    assert.deepEqual(calls, results, "complete ordered tool-call/result pairs");
    if (!actual.usedContextFallback) assert.ok(actual.messages.some(m => m.role === "user" && m.content === "ACTIVE-REQUEST-719"));
  } catch (error) {
    const failure = { initialSeed, randomState, index, variant, options: { ...options, tools: options.tools.map(({ execute: _execute, ...tool }) => tool) }, ...topology(messages), expected, actual, reason: error instanceof Error ? error.message : String(error) };
    const path = resolve(outputDirectory, `failure-${initialSeed}-${index}-${variant}.json`);
    writeFileSync(path, JSON.stringify(failure, null, 2));
    console.error(JSON.stringify({ status: "counterexample", path, initialSeed, index, variant }));
    process.exit(2);
  }
  checks++; outputs.update(hash(actual));
  note(actual.usedContextFallback ? "fallback" : "retainedContext");
  if (actual.removedCurrentTurnMessages) note("activeBatchRemoval");
  if (actual.removedHistoryMessages) note("historyRemoval");
  if (actual.compactedToolResults) note("resultReplacement");
  return expected;
}
const started = performance.now();
for (let index = 0; index < count; index++) {
  const { messages, options } = fixture(index);
  const result = check(index, "base", messages, options);
  const minimum = estimateStaticContextTokens(options) + 150;
  for (const delta of [-1, 0, 1]) {
    const budget = Math.max(minimum, result.estimatedTokensAfter + delta);
    check(index, `boundary${delta}`, messages, { ...options, compactionReserveTokens: options.contextWindow - budget });
  }
}
console.log(JSON.stringify({ status: "passed", initialSeed, finalRandomState: randomState >>> 0, fixtures: count, checks, elapsedMs: performance.now() - started, coverage, outputSha256: outputs.digest("hex"), baselineSha256: createHash("sha256").update(readFileSync(baselinePath)).digest("hex"), candidateSha256: createHash("sha256").update(readFileSync(resolve("main/services/generation-context.ts"))).digest("hex"), limitations: "Synthetic valid-shape context data; no decoding of illustrative image bytes or real model calls. Baseline policy plus recovery-marker fix is independent of optimized production. Aliases and source order are preserved in failure artifacts." }));
