/** Real managed-harness reproduction of captured transform options after tool removal.
 * node --import tsx docs/research/experiments/context-attended-options-recovery.ts > docs/research/experiments/context-attended-options-recovery-results.json
 * Two synthetic failed tools, unreported usage, in-memory session, fake summaries; no provider I/O.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, createModels, getCurrentTools, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { PiAgentRuntimeHarness } from "../../../main/services/pi-agent-runtime-harness.js";
import { createGenerationContextTransform, updateGenerationContextOptions } from "../../../main/services/generation-context.js";
import { recoverAttendedToolErrorContext, advanceAttendedToolErrorState } from "../../../main/services/assistant/tool-loop-guard.js";
import { createPiSessionPort } from "../../../main/services/pi-session-port.js";
import { InMemorySessionRepo } from "../../../main/services/pi-session-repository-port.js";
import { appendPiMessages } from "../../../main/services/pi-compaction-session-store.js";
import { convertToLlm } from "../../../main/services/pi-legacy-harness.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rows = [];
for (const refreshAfterRecovery of [false, true]) {
  const core = createFauxCore({ api: "offline-recovery", provider: "offline-recovery", models: [{ id: "fixture", contextWindow: 16_000, maxTokens: 4_000 }] });
  const model = core.getModel();
  const summary = fauxProvider({ api: model.api, provider: model.provider, models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] });
  summary.setResponses([fauxAssistantMessage("Original user requested evidence. Two tool attempts failed; answer with the prescribed recovery message.")]);
  const models = createModels(); models.setProvider(summary.provider);
  let toolCalls = 0;
  const tool: AgentTool = { name: "broken", label: "Broken", description: "d".repeat(16_000), parameters: Type.Object({}), execute: async () => {
    toolCalls += 1; throw new Error("e".repeat(2_400));
  } };
  const user: AgentMessage = { role: "user", content: "ORIGINAL_USER_INTENT_47 ".padEnd(26_000, "u"), timestamp: 1 };
  const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: "attended-recovery-fixture" }));
  const generationOptions = { contextWindow: model.contextWindow, systemPrompt: "Policy", tools: [tool], providerId: model.provider, modelId: model.id };
  const reductions: { removedHistory: number; before: number; after: number; kind: string }[] = [];
  const transform = createGenerationContextTransform(generationOptions, (result) => reductions.push({ removedHistory: result.removedHistoryMessages, before: result.estimatedTokensBefore, after: result.estimatedTokensAfter, kind: result.emergencyProjection.kind }));
  let consecutiveErrors = 0;
  let recovered = false;
  const requests: { tools: string[]; hasOriginalIntent: boolean; hasRecoveryInstruction: boolean; messages: number }[] = [];
  const projections: { tokens: number; tools: number; shouldCompact: boolean }[] = [];
  const responses = [
    fauxAssistantMessage([fauxToolCall("broken", {}, { id: "failed-1" })], { stopReason: "toolUse", timestamp: 2 }),
    fauxAssistantMessage([fauxToolCall("broken", {}, { id: "failed-2" })], { stopReason: "toolUse", timestamp: 4 }),
    fauxAssistantMessage("I couldn't complete that action after two tool attempts. Review the requested details and try again.", { timestamp: 6 }),
  ];
  const harness = new PiAgentRuntimeHarness({
    convertToLlm, transformContext: transform,
    initialState: { systemPrompt: "Policy", thinkingLevel: "off", tools: [tool], messages: [user], model },
    durability: { session, initialMessages: [user], appendMessages: appendPiMessages,
      compaction: { models, model, thinkingLevel: "off", settings: { enabled: false }, retryDelayMs: 0 } },
    onContextProjection: (projection, options) => projections.push({ tokens: projection.contextTokens, tools: options.tools.length, shouldCompact: projection.shouldCompact }),
    prepareNextTurnWithContext: ({ context, toolResults }) => {
      // Reproduce the caller's existing ordering: no schema/instruction change
      // precedes the attended guard, then recovery removes all executable tools.
      const next = advanceAttendedToolErrorState(consecutiveErrors, toolResults);
      consecutiveErrors = next.consecutiveErrorTurns;
      if (!next.shouldStop) return undefined;
      const recoveredContext = recoverAttendedToolErrorContext(context, 5);
      recovered = true;
      if (refreshAfterRecovery) updateGenerationContextOptions(generationOptions, recoveredContext);
      return { context: recoveredContext };
    },
    streamFn: (_model, context) => {
      const text = JSON.stringify(context);
      requests.push({ tools: getCurrentTools(context.messages).map((item) => item.name), hasOriginalIntent: text.includes("ORIGINAL_USER_INTENT_47"),
        hasRecoveryInstruction: text.includes("Two consecutive tool attempts failed"), messages: context.messages.length });
      const next = responses.shift(); assert.ok(next, "unexpected extra foreground request");
      // Deliberately model a provider that does not report token usage, rather
      // than faux's heuristic usage injection, to isolate captured static cost.
      const message: AssistantMessage = { ...next, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end(message); return stream;
    },
  });
  const outcome = await harness.runManaged({ kind: "continue-durable-tail" });
  const entries = await session.getEntries();
  const journalMessages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(toolCalls, 2);
  assert.equal(requests.length, 3);
  assert.equal(recovered, true);
  assert.deepEqual(requests[2].tools, []);
  assert.equal(requests[2].hasRecoveryInstruction, true);
  assert.ok(journalMessages.some((message) => message.role === "user" && message.content === user.content), "original journal evidence remains durable");
  rows.push({ refreshAfterRecovery, foregroundCalls: requests.length, toolCalls, hiddenSummaryCalls: summary.state.callCount,
    checkpoints: entries.filter((entry) => entry.type === "compaction").length, outcomeKind: outcome.kind,
    outcomeEmergency: outcome.emergencyProjection, requests, projections, reductions, preservedOriginalHash: hash(user) });
}
assert.equal(rows[0].requests[2].hasOriginalIntent, false, "existing ordering must reproduce lost outbound history");
assert.equal(rows[1].requests[2].hasOriginalIntent, true, "refreshing captured options preserves the fitting outbound history");
assert.equal(rows[0].hiddenSummaryCalls, 1);
assert.equal(rows[1].hiddenSummaryCalls, 0);
console.log(JSON.stringify({ evidenceKind: "managed-attended-tool-removal-options-reproduction", generatedAt: new Date().toISOString(), node: process.version, rows,
  limitations: ["Synthetic large tool schema/user fixture with two failed tools and unreported provider usage; prevalence in ordinary attended tool sets is not established.",
    "The candidate arm changes only research host-hook ordering; production remains unchanged.", "Fake foreground and summary streams, in-memory journal, no credential reads/network/effects or actual paid-cost claim."] }, null, 2));
