import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, createModels, getCurrentTools, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { PiAgentRuntimeHarness } from "../pi-agent-runtime-harness.js";
import { createGenerationContextTransform } from "../generation-context.js";
import { createPiSessionPort } from "../pi-session-port.js";
import { InMemorySessionRepo } from "../pi-session-repository-port.js";
import { appendPiMessages } from "../pi-compaction-session-store.js";
import { convertToLlm } from "../pi-legacy-harness.js";
import { createPiTurnContextPreparation } from "../pi-turn-context.js";

import {
  ATTENDED_TOOL_FAILURE_RECOVERY_REPLY,
  advanceAttendedToolErrorState,
  attendedToolRecoveryMessage,
  recoverAttendedToolErrorContext,
  recordAttendedToolArguments,
} from "./tool-loop-guard.js";

test("identical failures stop even with unrelated successes; independent failures can progress", () => {
  const first = advanceAttendedToolErrorState(undefined, [{ isError: true, toolName: "one" }]);
  assert.equal(first.shouldStop, false);
  const second = advanceAttendedToolErrorState(first, [{ isError: true, toolName: "two" }, { isError: false }]);
  assert.equal(second.shouldStop, false);
  const success = advanceAttendedToolErrorState(second, [{ isError: false }]);
  assert.equal(advanceAttendedToolErrorState(success, [{ isError: true, toolName: "one" }]).shouldStop, true);
});

test("changed arguments remain bounded and denied actions terminate immediately", () => {
  let state;
  for (let i = 0; i < 8; i++) {
    state = advanceAttendedToolErrorState(state, [{ isError: true, toolName: "read", toolCallId: "call" }], [{ id: "call", name: "read", arguments: { path: `file${i}` } }]);
    assert.equal(state.shouldStop, i === 7);
  }
  assert.equal(advanceAttendedToolErrorState(undefined, [{ isError: true, content: [{ type: "text", text: "The user denied this action." }] }]).shouldStop, true);
});

test("repeated attended tool errors recover with one host-directed text-only turn", () => {
  const context = recoverAttendedToolErrorContext(
    {
      messages: [{ role: "system", content: "Aiden", timestamp: 0 }, { role: "user", content: "Create a briefing", timestamp: 1 }],
      tools: [{ name: "schedule_task" } as never],
    },
    2,
  );
  assert.deepEqual(context.tools, []);
  assert.deepEqual(context.messages[context.messages.length - 1], {
    role: "user",
    content: attendedToolRecoveryMessage(),
    timestamp: 2,
  });
  assert.match(attendedToolRecoveryMessage(), /exactly this text/iu);
  assert.match(
    attendedToolRecoveryMessage(),
    new RegExp(ATTENDED_TOOL_FAILURE_RECOVERY_REPLY, "u"),
  );
  assert.doesNotMatch(attendedToolRecoveryMessage(), /MCP|automation|project|validation/iu);
});

test("managed attended recovery publishes removed schemas before emergency context reduction", async () => {
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
  let recoveries = 0;
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
    prepareNextTurnWithContext: createPiTurnContextPreparation({
      prepareContext: async (context) => context,
      attended: true,
      generationOptions,
      onRecovery: () => { recoveries += 1; },
    }),
    streamFn: (_model, context) => {
      const text = JSON.stringify(context);
      requests.push({ tools: getCurrentTools(context.messages).map((item) => item.name), hasOriginalIntent: text.includes("ORIGINAL_USER_INTENT_47"),
        hasRecoveryInstruction: text.includes("Tool recovery reached its failure or permission limit"), messages: context.messages.length });
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
  assert.equal(recoveries, 1);
  assert.deepEqual(requests[2].tools, []);
  assert.equal(requests[2].hasRecoveryInstruction, true);
  assert.ok(journalMessages.some((message) => message.role === "user" && message.content === user.content), "original journal evidence remains durable");
  assert.equal(requests[2].hasOriginalIntent, true, "a fitting original request survives text-only recovery");
  assert.equal(summary.state.callCount, 0, "removed schemas cannot trigger unnecessary hidden summaries");
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(projections[2].tools, 0);
  assert.equal(projections[2].shouldCompact, false);
  assert.deepEqual(reductions, []);
});


test("turn preparation preserves unchanged identity and forwards cancellation and preparation errors", async () => {
  const context: AgentContext = { messages: [], tools: [] };
  const generationOptions = { contextWindow: 16_000, systemPrompt: "unchanged", tools: [] };
  const controller = new AbortController();
  const failure = new Error("instruction refresh failed");
  let rejectPreparation = false;
  let observedSignal: AbortSignal | undefined;
  let recoveries = 0;
  const prepare = createPiTurnContextPreparation({
    attended: true, generationOptions,
    prepareContext: async (value, signal) => {
      observedSignal = signal;
      if (rejectPreparation) throw failure;
      return value;
    },
    onRecovery: () => { recoveries += 1; },
  });
  const turn = { context, message: fauxAssistantMessage("done"), newMessages: [], toolResults: [] };
  assert.equal(await prepare(turn, controller.signal), undefined);
  assert.equal(observedSignal, controller.signal);
  assert.equal(generationOptions.systemPrompt, "unchanged", "identity-preserving preparation does not republish");
  rejectPreparation = true;
  await assert.rejects(async () => prepare(turn, controller.signal), (error) => error === failure);
  assert.equal(recoveries, 0);
});

test("unattended preparation publishes trusted policy changes without applying the attended error guard", async () => {
  const context: AgentContext = { messages: [], tools: [] };
  const generationOptions = { contextWindow: 16_000, systemPrompt: "old", tools: [] };
  const prepare = createPiTurnContextPreparation({
    attended: false, generationOptions,
    prepareContext: async (value) => ({ ...value, messages: [{ role: "system", content: "revised policy", timestamp: 1 }] }),
    onRecovery: () => assert.fail("unattended calls do not trigger attended recovery"),
  });
  const turn = { context, message: fauxAssistantMessage("done"), newMessages: [],
    toolResults: [{ role: "toolResult" as const, toolCallId: "failed", toolName: "broken", content: [{ type: "text" as const, text: "error" }], isError: true, timestamp: 1 }] };
  for (let index = 0; index < 3; index += 1) {
    const update = await prepare(turn);
    assert.equal(update?.context?.messages.length, 1);
    assert.equal(generationOptions.systemPrompt, "revised policy");
  }
});

test("unfingerprintable failures do not alias and terminal state stays bounded", () => {
  let state;
  for (let i = 0; i < 12; i++) {
    state = advanceAttendedToolErrorState(state, [{ isError: true, toolName: "edit", toolCallId: "call" }], [{ id: "call", name: "edit", arguments: { text: String(i).repeat(17000) } }]);
    assert.equal(state.shouldStop, i >= 7);
    assert.ok(state.failures.size <= 8);
    assert.ok(state.totalFailures <= 8);
  }
});

test("real attended harness stops refused/cancelled actions and normalized repeated calls", async () => {
  for (const reason of ["The user declined this automation. Do not retry it.", "The action was cancelled before approval.", "normalized failure"]) {
    const core = createFauxCore({ api: "guard-fixture", provider: "guard-fixture", models: [{ id: "fixture", contextWindow: 16000, maxTokens: 4000 }] });
    const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: `guard-${reason.length}` }));
    let effects = 0;
    let requests = 0;
    const tools: AgentTool[] = [{ name: "action", label: "Action", description: "Fixture action", parameters: Type.Object({ value: Type.String() }),
      prepareArguments: () => ({ value: "normalized" }),
      execute: async () => { effects++; return { content: [{ type: "text", text: reason }], details: null, isError: true }; },
    }];
    const model = core.getModel();
    const models = createModels(); models.setProvider(fauxProvider({ api: model.api, provider: model.provider, models: [{ id: model.id, contextWindow: 16000, maxTokens: 4000 }] }).provider);
    const generationOptions = { contextWindow: 16000, systemPrompt: "Fixture", tools };
    const initialMessages: AgentMessage[] = [{ role: "user", content: "Perform fixture action", timestamp: 1 }];
    const harness = new PiAgentRuntimeHarness({
      convertToLlm,
      initialState: { systemPrompt: "Fixture", thinkingLevel: "off", tools, messages: initialMessages, model },
      durability: { session, initialMessages, appendMessages: appendPiMessages, compaction: { models, model, thinkingLevel: "off", settings: { enabled: false } } },
      prepareNextTurnWithContext: createPiTurnContextPreparation({ attended: true, generationOptions, prepareContext: async (context) => context, onRecovery: () => {} }),
      streamFn: (_model, context) => {
        requests++;
        assert.ok(requests <= 4);
        const next = getCurrentTools(context.messages).length
          ? fauxAssistantMessage([fauxToolCall("action", { value: `variant${requests}` }, { id: `call${requests}` })], { stopReason: "toolUse" })
          : fauxAssistantMessage("Stopped.");
        const message = { ...next, api: model.api, provider: model.provider, model: model.id };
        const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: next.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end(message); return stream;
      },
    });
    const outcome = await harness.runManaged({ kind: "continue-durable-tail" });
    assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
    assert.equal(effects, reason === "normalized failure" ? 2 : 1, reason);
    assert.equal(requests, effects + 1);
  }
});

test("unhashable validated arguments never fall back to identical raw provider arguments", () => {
  let state;
  for (let i = 0; i < 2; i++) {
    const call = { id: `call-${i}`, name: "edit", arguments: { template: "same" } };
    recordAttendedToolArguments(call, { text: String(i).repeat(17000) });
    state = advanceAttendedToolErrorState(state, [{ isError: true, toolName: "edit", toolCallId: call.id }], [call]);
    assert.equal(state.shouldStop, false);
  }
});
