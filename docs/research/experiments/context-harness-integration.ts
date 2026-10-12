/** Offline real managed-harness composition probe, not a live model benchmark.
 * Prepare: python3 docs/research/experiments/prepare-context-compaction-baseline.py
 * One bounded child: node --max-old-space-size=512 --import tsx docs/research/experiments/context-harness-integration.ts --case '{"kind":"active","batches":20,"resultChars":128}' tmp/research/generation-context-before-scaling.ts
 * Parent runner supplies process wall deadline; this module performs no external effects.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, createInitialSystemMessage, toToolDeclaration, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { PiAgentRuntimeHarness } from "../../../main/services/pi-agent-runtime-harness.js";
import { InMemorySessionRepo } from "../../../main/services/pi-session-repository-port.js";
import { createPiSessionPort } from "../../../main/services/pi-session-port.js";
import { appendPiMessages } from "../../../main/services/pi-compaction-session-store.js";
import { convertToLlm } from "../../../main/services/pi-legacy-harness.js";
import { assertGenerationContextCapacity, type createGenerationContextTransform, type GenerationContextTransform } from "../../../main/services/generation-context.js";
interface Input { kind: "active" | "historical"; batches: number; resultChars: number; automaticSummary?: boolean; staticChars?: number; userChars?: number; toolRoundtrip?: boolean; observeOutcome?: boolean; persistSystem?: boolean; }
const input = JSON.parse(process.argv[3]) as Input;
const modulePath = resolve(process.argv[4] ?? "main/services/generation-context.ts");
const factory = (await import(pathToFileURL(modulePath).href)).createGenerationContextTransform as typeof createGenerationContextTransform;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "timestamp").map(([key, item]) => [key, stable(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const core = createFauxCore({ api: "aiden-context-research-faux", provider: "aiden-context-research", models: [{ id: "fixture", contextWindow: 16_000, maxTokens: 4_000 }] });
const model = core.getModel();
const systemPrompt = "Preserve evidence and complete the current task.".padEnd(input.staticChars ?? 0, "s");
const userPrompt = "CURRENT-INVESTIGATION-47".padEnd(input.userChars ?? 0, "u");
const seed: AgentMessage[] = [{ role: "user", content: userPrompt, timestamp: 1 }];
for (let index = 0; index < input.batches; index += 1) {
  if (input.kind === "historical" && index > 0) seed.push({ role: "user", content: `historical-turn-${index}`, timestamp: index * 3 + 1 });
  const id = `historical-call-${index}`;
  const response: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id, name: "echo", arguments: {} }], api: model.api, provider: model.provider, model: model.id,
    stopReason: "toolUse", timestamp: index * 3 + 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  seed.push(response, { role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text: `EVIDENCE-${index}:`.padEnd(input.resultChars, "x") }], isError: false, timestamp: index * 3 + 3 });
}
if (input.kind === "historical") seed.push({ role: "user", content: "CURRENT-INVESTIGATION-47: complete with durable history", timestamp: input.batches * 3 + 4 });
let toolCalls = 0;
const echo: AgentTool = { name: "echo", label: "Echo", description: "Return deterministic local evidence.", parameters: Type.Object({}), execute: async () => {
  toolCalls += 1; return { content: [{ type: "text", text: "NEW-EVIDENCE-91" }], details: null };
} };
if (input.persistSystem) {
  const system = createInitialSystemMessage(systemPrompt, [toToolDeclaration(echo)]); assert.ok(system); seed.unshift(system);
}
const seedHash = hash(seed);
assertGenerationContextCapacity({ contextWindow: model.contextWindow, systemPrompt, tools: [echo] });
core.setResponses([
  ...(input.toolRoundtrip === false ? [] : [fauxAssistantMessage([fauxToolCall("echo", {}, { id: "new-evidence-call" })], { stopReason: "toolUse", timestamp: 1_000_001 })]),
  fauxAssistantMessage("FINAL-RESULT-73", { timestamp: 1_000_002 }),
]);
const summary = fauxProvider({ api: model.api, provider: model.provider, models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] });
const summaryRequests: string[] = [];
const summaryEvidence: { roles: string[]; textChars: number; containsUser: boolean; containsToolEvidence: boolean; emptyConversation: boolean }[] = [];
const lifecycle: string[] = [];
const projections: { tokens: number; historyMessages: number; shouldCompact: boolean }[] = [];
summary.setResponses(Array.from({ length: 8 }, () => (context) => {
  summaryRequests.push(hash(context)); lifecycle.push("summary-request");
  const text = context.messages.map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n")).join("\n");
  summaryEvidence.push({ roles: context.messages.map((message) => message.role), textChars: text.length, containsUser: text.includes("CURRENT-INVESTIGATION-47"), containsToolEvidence: text.includes("EVIDENCE-"), emptyConversation: /<conversation>\s*<\/conversation>/u.test(text) });
  return fauxAssistantMessage("Retain the investigation objective, evidence references, and completed tool work. Continue the current request.", { timestamp: 1_000_000 });
}));
const models = createModels(); models.setProvider(summary.provider);
const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: "context-integration-fixture" }));
const inner = factory({ contextWindow: model.contextWindow, systemPrompt, tools: [echo], providerId: model.provider, modelId: model.id });
const transformDurations: number[] = [];
const transformHashes: { input: string; output: string }[] = [];
const transform: GenerationContextTransform = Object.assign(async (messages: AgentMessage[], signal?: AbortSignal) => {
  lifecycle.push("context-transform");
  const before = hash(messages);
  const start = performance.now();
  const result = await inner(messages, signal);
  transformDurations.push(performance.now() - start);
  transformHashes.push({ input: before, output: hash(result) });
  return result;
}, { takeLastEmergencyProjection: () => inner.takeLastEmergencyProjection() });
const requestHashes: string[] = [];
const faults: { source: string; message: string }[] = [];
const harness = new PiAgentRuntimeHarness({
  convertToLlm, transformContext: transform,
  onFault: (fault) => faults.push({ source: fault.source, message: fault.error.message }),
  onContextProjection: (projection) => projections.push({ tokens: projection.contextTokens, historyMessages: projection.compressibleHistoryMessages, shouldCompact: projection.shouldCompact }),
  streamFn: (requestModel, context, options) => { requestHashes.push(hash(context)); lifecycle.push("foreground-request"); return core.streamSimple(requestModel, context, options); },
  initialState: { systemPrompt, thinkingLevel: "off", tools: [echo], messages: seed, model },
  durability: { session, initialMessages: seed, appendMessages: appendPiMessages, compaction: { models, model, thinkingLevel: "off", retryDelayMs: 0, ...(input.automaticSummary === false ? { settings: { enabled: false } } : {}) } },
});
const started = performance.now();
const outcome = await harness.runManaged({ kind: "continue-durable-tail" });
const harnessMs = performance.now() - started;
const entries = await session.getEntries();
const journalMessages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
assert.equal(hash(seed), seedHash, "caller seed mutated");
assert.deepEqual(stable(journalMessages.slice(0, seed.length)), stable(seed), "original durable evidence was rewritten or removed");
if (!input.observeOutcome) {
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(core.state.callCount, input.toolRoundtrip === false ? 1 : 2);
  assert.equal(toolCalls, input.toolRoundtrip === false ? 0 : 1);
  assert.ok(JSON.stringify(outcome).includes("FINAL-RESULT-73"));
  if (input.toolRoundtrip !== false) assert.ok(journalMessages.some((message) => message.role === "toolResult" && message.toolCallId === "new-evidence-call"));
}
console.log(JSON.stringify({ ...input, status: "completed", node: process.version, platform: process.platform, arch: process.arch,
  capacityChecked: true, moduleSha256: createHash("sha256").update(readFileSync(modulePath)).digest("hex"), harnessMs, transformMs: transformDurations.reduce((a, b) => a + b, 0), transformDurations,
  peakRssKiB: process.resourceUsage().maxRSS, seedMessages: seed.length, seedHash, journalMessages: journalMessages.length, preservedSeedHash: hash(journalMessages.slice(0, seed.length)), journalPayloadHash: hash(journalMessages),
  providerCalls: core.state.callCount, toolCalls, lifecycle, projections, faults, summaryCalls: summary.state.callCount, requestHashes, summaryRequests, summaryEvidence, transformHashes, outcomeHash: hash(outcome), outcomeKind: outcome.kind, outcome: stable(outcome),
  normalization: "Only timestamp object fields omitted from evidence hashes; tool-call IDs/content/order/usage retained. Journal random entry IDs are excluded by hashing message payloads.",
  measurement: "runManaged includes initial journal seeding, preflight, transforms, fake provider steps, tool dispatch and journal flush; excludes fixture/session/harness construction and post-run assertions. Fake summary compaction uses normal lifecycle, enabled by default; automaticSummary=false explicitly selects the supported disabled setting in both arms. No real model/network/effects." }));
