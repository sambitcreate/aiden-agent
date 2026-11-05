import assert from "node:assert/strict";
import { analyticsSettled, captureAnalyticsEvents } from "../analytics/test-support.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type Models } from "@earendil-works/pi-ai";
import { AgentDoc, CompactionTask, Harness, createRegistry, defineExtension, defineTool, hook, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { botExecutionScope, createBotBackgroundExecutionModels, createBotExecutionRegistry, reconcileBotExecutionResponses, type BotExecutionPort } from "./bot-execution.js";
import { BotRoutineModelUnavailableError, type BotExecutionClaim, type BotProviderResponseFacts } from "../bot-routine-models.js";
import { waitFor } from "./test-support/faux.js";
import { createBotSessionService, type BotSessionRuntime } from "./bot-session-service.js";
import { countingTool, recordingDeps } from "./test-support/fixtures.js";
import { SpendingDispatchError } from "../spending-dispatch-ledger.js";
import { SpendingService, SPENDING_UNKNOWN_RESUME_MESSAGE } from "../spending-service.js";
import { emptySpendingDocument } from "../spending-core.js";
import { acknowledgeBotExecutionUnknown, botExecutionAccountableResponse, botExecutionInputSpendingRefusal, botExecutionSpendingOwner, botExecutionUnknownCostReceipt, isBotExecutionDispatchSettled, recordKnownBotExecutionResponse } from "./bot-execution-spending.js";
import { DataStore } from "../data-store.js";
import { createBotExecutionIssues } from "./bot-execution-issues.js";
import { createBotIssueService } from "../bot-issues/service.js";
import { createBotIssueStore } from "../bot-issues/store.js";
import type { JsonValue } from "@earendil-works/chord";
import { botConnectorExecutionRestriction, botConnectorInventoryServer, withBotConnectorExecutionRestriction } from "../bot-connector-inventory-scope.js";
import { existingOrConnectMcpClient } from "../mcp-connector-client-boundary.js";
import { assertBotExecutionConnectorSource } from "./bot-execution-source.js";
import { issueBotRoutineInputOrigin } from "./bot-input-entry.js";
import type { BotConnectorWatchBinding } from "../bot-routine-events/connector-types.js";
import { openProtectedRoutineClaims, killAfterRoutineReceipt, claimTestModule } from "../bot-routine-model-claim-test-support.js";
import { openModelExecutionFixture } from "./test-support/model-execution-fixture.js";
import { createBotDispatchCoordinator } from "./bot-dispatch-coordinator.js";
import { openConsentBoundaryFixture } from "./test-support/consent-boundary-fixture.js";
import { visionCandidate } from "./bot-tool-candidates.js";
import { botImageReference } from "./bot-images.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { BotResumeOperationsDoc, BotCostReceiptScopeDoc, botCostReceiptScope, consumeBotResumeOperation } from "./bot-resume-operations.js";
import { BotExecutionDoc } from "./bot-execution.js";
const ctx = BACKGROUND_CONTEXT;
// Synthetic issuer persists across in-process harness reopen; protected-store cases use the real issuer.
const responseProofs = new Map<string, Set<string>>();
async function recordSavedResponse(spending: SpendingService, facts: BotProviderResponseFacts, message: import("@earendil-works/pi-ai").AssistantMessage) {
  const row = await spending.dispatchReceipt(facts.dispatchId); if (!row) return;
  await recordKnownBotExecutionResponse(spending, facts.botId, facts.dispatchId, message, { dispatchId: row.dispatchId, owner: row.owner, providerId: row.providerId, modelId: row.modelId, counts: row.counts }, facts.responseDigest);
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function reviewedCost(service: BotSessionRuntime, submissionId?: string) {
  const status = await service.executionResumeStatus("bot:one"); assert.equal(status.requiresUnknownCostAcknowledgement, true); assert.match(status.costReceiptId ?? "", /^cost_[a-f0-9]{64}$/u); if (submissionId) assert.equal(status.interruptedSubmissionId, submissionId);
  return { acknowledgeUnknownCost: true as const, expectedSubmissionId: status.interruptedSubmissionId!, expectedCostReceiptId: status.costReceiptId! };
}
function claim(name: string, thinkingLevel: "off" | "low" | "high"): BotExecutionClaim {
  return { version: 1, id: name, botId: "bot:one", requestId: name, botIncarnation: "one", primary: { thinkingLevel, binding: { providerOption: { id: "provider", label: "Proof", available: true }, modelOption: { id: name, label: name, available: true }, sourceProviderId: "proof", sourceModelId: name, connectionFingerprint: "1".repeat(64), providerExactFingerprint: "2".repeat(64), modelFingerprint: "3".repeat(64), modelExactFingerprint: "4".repeat(64) } }, actual: "primary", admittedAt: 1, root: { botId: "bot:one", requestId: name } };
}
async function environment(file: string, states: { toolGate?: ReturnType<typeof gate>; toolEntered?: boolean; compactGate?: ReturnType<typeof gate>; compactEntered?: boolean; deferred?: {pendingFetches: number; pollAfterMs: number} } = {}, settings: HarnessSettings = {}) {
  const faux = fauxProvider({ provider: "proof", ...(states.deferred ? { deferred: states.deferred } : {}), models: [{ id: "A", reasoning: true, contextWindow: 512, maxTokens: 128 }, { id: "B", reasoning: true, contextWindow: 200_000, maxTokens: 8_000 }, { id: "D", reasoning: false, contextWindow: 200_000, maxTokens: 8_000 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const calls: { model: string; thinking: string; owner?: string }[] = [], charges: { owner: string; id: string }[] = [];
  const original = models.streamSimple.bind(models);
  const recorded = new Proxy(models, { get(target, key) { if (key === "streamSimple") return ((model, messages, options) => { calls.push({ model: model.id, thinking: options?.reasoning ?? "off", owner: botExecutionScope()?.claim.id }); return original(model, messages, options); }) as Models["streamSimple"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } });
  const claims = [claim("A", "high"), claim("B", "low"), claim("D", "off")];
  const costApprovals = new Map<string, string>();
  const proofs = responseProofs.get(file) ?? new Set<string>(); responseProofs.set(file, proofs);
  const port: BotExecutionPort = {
    verifyResponse: async (facts) => proofs.has(JSON.stringify(facts)),
    approveCost: async (facts) => { const id = `approval-${costApprovals.size}`; costApprovals.set(id, JSON.stringify(facts)); return id; },
    verifyCostApproval: async (id, facts) => costApprovals.get(id) === JSON.stringify(facts),
    claim: async (_bot, input) => claims.find((row) => row.requestId === input.requestId)!,
    getClaim: async (_bot, id, requestId) => { const value = claims.find((row) => row.id === id && row.requestId === requestId); if (!value) throw new Error("Missing private claim"); return value; },
    selectFallback: async () => { throw new Error("No fallback configured"); },
    resolve: async (_bot, bound) => {
      const model = models.getModel("proof", (bound.actual === "fallback" ? bound.fallback! : bound.primary).binding.sourceModelId)!;
      return { model, models: recorded, imageInput: false, reserveResponse: async () => {}, sealResponse: async (facts) => { proofs.add(JSON.stringify(facts)); }, revalidate: async () => {}, release() {}, afterDispatch: async (id) => { charges.push({ owner: bound.id, id }); } };
    },
  };
  const registry = createRegistry();
  if (states.compactGate) registry.install(defineExtension({ name: "compaction-barrier", hooks: [hook(CompactionTask, { beforeCompact: async (_input, _api, context) => { states.compactEntered = true; await Promise.race([states.compactGate!.promise, new Promise<void>((resolve) => context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }))]); return undefined; } })] }));
  registry.install(defineExtension({ name: "proof", tools: [defineTool({ name: "hold", description: "local barrier", parameters: Type.Object({}), replay: "safe", async execute(_args, _api, context) { states.toolEntered = true; if (states.toolGate) await Promise.race([states.toolGate.promise, new Promise<void>((resolve) => { const signal = context.abortSignal; if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); })]); assert.equal(botExecutionScope()?.claim.id, "A"); return { output: [{ type: "text", text: "done" }] }; } })] }));
  const adapted = createBotExecutionRegistry("bot:one", registry, port);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: adapted, settings: { restartLimit: Infinity, ...settings } }, ctx); adapted.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: { provider: "proof", modelId: "D" } } });
  const submit = (name: string) => root.submit({ type: "input", requestId: name, content: name, whenBusy: "followUp", entry: { kind: "proof.input", data: { executionClaimId: name } } }, ctx);
  return { harness, root, faux, calls, charges, submit, port, models };
}
test("real SQLite A tool round, B and person keep immutable models/thinking across reopen and default edits", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "session.sqlite"), states = { toolGate: gate(), toolEntered: false };
  let env = await environment(file, states, { compaction: { enabled: false } });
  env.faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
  const a = await env.submit("A"); await waitFor(() => states.toolEntered); const b = await env.submit("B"), person = await env.submit("D");
  await env.root.configure({ model: { provider: "proof", modelId: "B" }, thinkingLevel: "low" }, ctx);
  await env.harness.close(ctx); assert.deepEqual(env.calls.map(({ model, thinking }) => [model, thinking]), [["A", "high"]]);
  states.toolGate.release(); env = await environment(file, {}, { compaction: { enabled: false } }); t.after(() => env.harness.close(ctx));
  env.faux.setResponses([fauxAssistantMessage("A final"), fauxAssistantMessage("B final"), fauxAssistantMessage("person final")]);
  assert.equal((await env.harness.inspect(ctx)).scheduling, "paused"); assert.equal(env.calls.length, 0); env.harness.resume();
  for (const id of [a.id, b.id, person.id]) assert.equal((await (await env.harness.submission(id, ctx))!.wait(ctx)).status, "done");
  assert.deepEqual(env.calls, [{ model: "A", thinking: "high", owner: "A" }, { model: "B", thinking: "low", owner: "B" }, { model: "D", thinking: "off", owner: "D" }]);
  assert.equal((await env.harness.snapshot(AgentDoc, env.root.id, ctx))?.model?.modelId, "B");
  assert.equal(new Set(env.charges.map((row) => row.id)).size, 3);
});
test("only configured typed predispatch model failure can select fallback; authority, images and budget cannot", async (t) => {
  for (const failure of ["eligible", "unconfigured", "authority", "budget", "image"] as const) await t.test(failure, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-fallback-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "session.sqlite"), {}, { compaction: { enabled: false }, retry: { enabled: false } }); t.after(() => env.harness.close(ctx));
    const selected = await env.port.getClaim("bot:one", "A", "A"); if (failure !== "unconfigured") selected.fallback = claim("B", "low").primary;
    let fallbackChanges = 0; env.port.selectFallback = async (_bot, id, reason) => { assert.equal(id, "A"); fallbackChanges++; selected.actual = "fallback"; selected.fallbackReason = reason; };
    const base = env.port.resolve;
    env.port.resolve = async (...args) => {
      if (args[1].actual === "primary" && ["eligible", "unconfigured"].includes(failure)) throw new BotRoutineModelUnavailableError("model_unavailable");
      if (failure === "authority") throw new Error("Credential grant was revoked");
      const runtime = await base(...args); return failure === "budget" ? { ...runtime, beforeDispatch: async () => { throw new SpendingDispatchError("limit", "Budget exhausted"); } } : runtime;
    };
    env.faux.setResponses([fauxAssistantMessage("fallback answer")]);
    const input = failure === "image" ? await env.root.submit({ type: "input", requestId: "A", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], entry: { kind: "proof.input", data: { executionClaimId: "A" } } }, ctx) : await env.submit("A");
    const result = await input.wait(ctx);
    if (failure === "eligible") { assert.equal(result.status, "done"); assert.equal(fallbackChanges, 1); assert.deepEqual(env.calls, [{ model: "B", thinking: "low", owner: "A" }]); }
    else { assert.equal(result.status, "unanswered"); assert.equal(fallbackChanges, 0); assert.equal(env.calls.length, 0); }
  });
});
test("chosen small context triggers blocking compaction with the same model, thinking and spending owner", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-context-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "session.sqlite"), {}, { compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 30, backgroundTokens: 0 } }); t.after(() => env.harness.close(ctx));
  env.faux.setResponses([fauxAssistantMessage("short summary"), fauxAssistantMessage("A final")]);
  for (let i = 0; i < 4; i++) await env.root.submit({ type: "write", entry: { kind: "proof.seed", model: [{ role: "user", content: "history ".repeat(250), timestamp: i }] } }, ctx);
  assert.equal((await (await env.submit("A")).wait(ctx)).status, "done");
  assert.equal(env.calls.length, 2); assert.ok(env.calls.every((row) => row.model === "A" && row.thinking === "high" && row.owner === "A"));
  assert.equal(env.charges.length, 2); assert.equal(new Set(env.charges.map((row) => row.id)).size, 2); assert.ok(env.charges.every((row) => row.owner === "A"));
});
test("unknown dispatch passively suspends the real SQLite Bot; explicit person Resume advances one durable attempt and preserves queued B", { timeout: 10_000 }, async (t) => {
  const sent = captureAnalyticsEvents(t);
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-paused-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite"), {}, { compaction: { enabled: false } }); await env.harness.close(ctx);
  const blockedGate = gate(), attempts: string[] = [], issues: string[] = []; let acknowledged = false, acknowledgements = 0, defaultResolutions = 0;
  const base = env.port.resolve;
  env.port.resolve = async (...args) => {
    const runtime = await base(...args), selected = args[1];
    return { ...runtime, beforeDispatch: async (id) => { attempts.push(id); if (selected.id === "A" && !acknowledged) { await blockedGate.promise; throw new SpendingDispatchError("uncertain", SPENDING_UNKNOWN_RESUME_MESSAGE); } } };
  };
  env.port.acknowledgeUnknown = async () => { acknowledgements++; acknowledged = true; return true; };
  env.port.unknownDispatch = async () => attempts[0];
  env.port.unknownCostReceipt = async (_bot, _saved, submissionId) => acknowledged ? undefined : { dispatchId: attempts[0]!, costReceiptId: `cost_${createHash("sha256").update(JSON.stringify([submissionId, attempts[0]])).digest("hex")}` };
  let service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => { defaultResolutions++; throw new Error("unrelated default unavailable"); }, knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } }, executionBlocked: async (_bot, _claim, message) => { issues.push(message); } });
  t.after(() => service.shutdown()); env.faux.setResponses([fauxAssistantMessage("A after acknowledgement"), fauxAssistantMessage("B preserved")]);
  const a = await service.send("bot:one", { requestId: "A", text: "A" }); await waitFor(() => attempts.length === 1);
  const b = await service.send("bot:one", { requestId: "B", text: "B", whenBusy: "followUp" }); blockedGate.release();
  for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await service.routineState("bot:one")).kind, "interrupted"); assert.equal(env.calls.length, 0); assert.deepEqual(issues, [SPENDING_UNKNOWN_RESUME_MESSAGE]);
  await service.shutdown(); service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => { defaultResolutions++; throw new Error("unrelated default unavailable"); }, knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } });
  await service.initialize(); assert.equal(env.calls.length, 0); assert.equal((await service.routineState("bot:one")).kind, "interrupted");
  await assert.rejects(service.resume("bot:one", "person-resume"), (error: unknown) => error instanceof Error && "reason" in error && error.reason === "spending_unconfirmed"); assert.equal(acknowledgements, 0); assert.equal((await service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, true);
  const cost = await reviewedCost(service, a.submissionId);
  await assert.rejects(service.resume("bot:one", "person-resume", cost), /different decision/u);
  await service.resume("bot:one", "person-resume-confirmed", cost);
  assert.equal((await service.awaitReply("bot:one", a.submissionId, new AbortController().signal)).kind, "completed"); assert.equal((await service.awaitReply("bot:one", b.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(acknowledgements, 1); assert.notEqual(attempts[0], attempts[1]); assert.deepEqual(env.calls.map(({ model }) => model), ["A", "B"]);
  await service.resume("bot:one", "person-resume-confirmed", cost); assert.equal(acknowledgements, 1); assert.equal(defaultResolutions, 0);
  await analyticsSettled();
  assert.deepEqual(sent, Array.from({ length: 2 }, () => ({ event: "chat_message_sent", props: { provider_id: "custom", model_id: "custom", in_workspace: false, thinking: "other", origin: "bot" } })), "only the two admitted person inputs count, using allowlisted IDs without resolving the unavailable default");
});
test("delayed background A compaction keeps A model, thinking and owner while B streams", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-background-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const states = { compactGate: gate(), compactEntered: false }, aGate = gate(), bGate = gate(); let aEntered = false, bEntered = false;
  const env = await environment(path.join(folder, "session.sqlite"), states, { compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 30, backgroundTokens: 180 } });
  t.after(async () => { states.compactGate.release(); aGate.release(); bGate.release(); await env.harness.close(ctx); });
  env.faux.setResponses([async () => { aEntered = true; await aGate.promise; return fauxAssistantMessage("A final"); }, async () => { bEntered = true; await bGate.promise; return fauxAssistantMessage("B final"); }, fauxAssistantMessage("background A summary")]);
  await env.root.submit({ type: "write", entry: { kind: "proof.seed", model: [{ role: "user", content: "history ".repeat(80), timestamp: 0 }] } }, ctx);
  await env.root.submit({ type: "write", entry: { kind: "proof.recent", model: [{ role: "user", content: "recent ".repeat(25), timestamp: 1 }] } }, ctx);
  const a = await env.submit("A"); await waitFor(() => aEntered && states.compactEntered); const b = await env.submit("B"); aGate.release(); await waitFor(() => bEntered); states.compactGate.release(); await waitFor(() => env.calls.length === 3); bGate.release();
  await a.wait(ctx); await b.wait(ctx);
  assert.deepEqual(env.calls, [{ model: "A", thinking: "high", owner: "A" }, { model: "B", thinking: "low", owner: "B" }, { model: "A", thinking: "high", owner: "A" }]);
  assert.equal(env.charges.filter((row) => row.owner === "A").length, 2); assert.equal(env.charges.filter((row) => row.owner === "B").length, 1);
});
test("queued watch execution restores its exact connector boundary and cannot connect cold or follow a changed account", async (t) => {
  for (const adapter of ["mail", "calendar"] as const) for (const mode of ["cold", "changed"] as const) await t.test(`${adapter}:${mode}`, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-watch-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
    const mail: BotConnectorWatchBinding = { adapter: "imcp-mail-v1", serverId: "selected-mail", connection: { sourceId: "selected-mail", connectionFingerprint: "connection-one", toolsetFingerprint: "tools-one", exactFingerprint: "grant-one", tools: [] }, tools: [], account: "accepted-account", mailbox: "Inbox", labels: { providerLabel: "Mail", accountLabel: "Accepted", resourceLabel: "Inbox" } };
    const accepted: BotConnectorWatchBinding = adapter === "mail" ? mail : {adapter:"composio-calendar-v1",serverId:"preset-composio",connection:{...mail.connection,sourceId:"preset-composio"},tools:[],accountId:"accepted-account",calendarId:"planning@example.test",labels:mail.labels,contract:{revision:"composio-calendar-v1",executorSchemaHash:"a".repeat(64),readSchemaHashes:{listCalendars:"b".repeat(64),listEvents:"c".repeat(64),getEvent:"d".repeat(64)}}};
    const restriction = { routineId: "watch-one", revision: 1, binding: accepted, ...(adapter==="calendar"?{condition:{kind:"calendar"as const,lookAheadMinutes:60,timezone:"UTC"}}:{}) };
    const selected = await env.port.getClaim("bot:one", "B", "B"); selected.connectorRestriction = structuredClone(restriction); selected.connectorServerId = accepted.serverId;
    let live = true, current = structuredClone(accepted.connection), connectAttempts = 0, entered = false; const barrier = gate(), observed: string[] = [];
    const original = env.port.resolve;
    env.port.resolve = async (...args) => {
      if (args[1].id === "B") {
        observed.push(`${botConnectorInventoryServer()}:${((source) => source?.adapter === "imcp-mail-v1" ? source.account : source?.accountId)(botConnectorExecutionRestriction()?.binding)}`);
        assertBotExecutionConnectorSource("bot:one", args[1].connectorRestriction!, { id: "watch-one", botId: "bot:one", enabled: true, updatedAt: 1, connector: { binding: accepted } }, current);
        await existingOrConnectMcpClient({ peek: () => live ? {} : undefined, connect: async () => { connectAttempts++; return {}; } });
      }
      return original(...args);
    };
    env.faux.setResponses([async () => { entered = true; await barrier.promise; return fauxAssistantMessage("A final"); }, fauxAssistantMessage("watch must not dispatch"), fauxAssistantMessage("person stays queued")]);
    const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } });
    t.after(async () => { barrier.release(); await service.shutdown(); });
    await service.send("bot:one", { text: "A", requestId: "A" }); await waitFor(() => entered);
    await withBotConnectorExecutionRestriction(restriction, () => service.send("bot:one", { text: "watch B", requestId: "B", routineOrigin: issueBotRoutineInputOrigin({ version: 1, botId: "bot:one", routineId: "watch-one", runId: "B", kind: "event" }) }));
    const person = await service.send("bot:one", { text: "person", requestId: "D" }); assert.equal(botConnectorInventoryServer(), undefined);
    if (mode === "cold") live = false; else current = { ...current, connectionFingerprint: "replacement-credential" };
    barrier.release();
    for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await service.routineState("bot:one")).kind, "interrupted"); assert.equal(connectAttempts, 0); assert.deepEqual(env.calls.map((row) => row.model), ["A"]);
    assert.deepEqual(observed, [`${accepted.serverId}:accepted-account`, `${accepted.serverId}:accepted-account`]);
    assert.equal((await service.awaitReply("bot:one", person.submissionId, new AbortController().signal)).kind, "interrupted", "unrelated queued input remains unfinished and available for later Resume");
  });
});
test("SIGKILL during A's tool preserves authenticated A/B/person choices and queued order despite later settings edits", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-kill-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "session.sqlite");
  await killAfterRoutineReceipt(t, `
    import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
    import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
    import { openProtectedRoutineClaims } from ${JSON.stringify(claimTestModule("main/services/bot-routine-model-claim-test-support.ts"))};
    import { openModelExecutionFixture } from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/model-execution-fixture.ts"))};
    const {service,select}=await openProtectedRoutineClaims(${JSON.stringify(folder)},'bot:one','routine:one');
    await select('A'); const a=await service.claim('bot:one',{requestId:'run:A',routineOrigin:{version:1,botId:'bot:one',routineId:'routine:one',runId:'run:A',kind:'manual'}});
    await select('B'); const b=await service.claim('bot:one',{requestId:'run:B',routineOrigin:{version:1,botId:'bot:one',routineId:'routine:one',runId:'run:B',kind:'manual'}});
    const person=await service.claim('bot:one',{requestId:'person'});
    const env=await openModelExecutionFixture(${JSON.stringify(file)},service,true);env.faux.setResponses([fauxAssistantMessage([fauxToolCall('hold',{})],{stopReason:'toolUse'})]);
    const submit=(claim)=>env.root.submit({type:'input',requestId:claim.requestId,content:claim.requestId,whenBusy:'followUp',entry:{kind:'aiden.bound-input',data:{executionClaimId:claim.id}}},ctx);
    await submit(a);while(!env.toolEntered())await new Promise(resolve=>setTimeout(resolve,5));await submit(b);await submit(person);
    await env.root.configure({model:{provider:'fixture',modelId:'B'}},ctx);console.log('OWNERSHIP_SAVED');setInterval(()=>{},1000);
  `);
  const protectedClaims = await openProtectedRoutineClaims(folder, "bot:one", "routine:one"); await protectedClaims.select("A");
  const env = await openModelExecutionFixture(file, protectedClaims.service, false); t.after(() => env.harness.close(ctx)); env.faux.setResponses([fauxAssistantMessage("A final"), fauxAssistantMessage("B final"), fauxAssistantMessage("person final")]);
  assert.equal((await env.harness.inspect(ctx)).scheduling, "paused"); assert.equal(env.calls.length, 0); env.harness.resume();
  for (const request of ["run:A", "run:B", "person"]) { const record = await env.root.commit((tx) => tx.submissionByRequest(env.root.id, request), ctx); assert.ok(record); assert.equal((await (await env.harness.submission(record.id, ctx))!.wait(ctx)).status, "done"); }
  assert.deepEqual(env.calls, [{ model: "A", requestId: "run:A" }, { model: "B", requestId: "run:B" }, { model: "A", requestId: "person" }]);
});
test("a prepared request checkpoint recovers its saved choice before any dispatch", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-prepared-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "session.sqlite"); let env = await environment(file, {}, { compaction: { enabled: false } }), reached = false;
  const resolve = env.port.resolve; env.port.resolve = async (...args) => ({ ...await resolve(...args), beforeDispatch: async () => { reached = true; await new Promise<void>((done) => { const signal = args[2]; if (signal.aborted) done(); else signal.addEventListener("abort", () => done(), { once: true }); }); args[2].throwIfAborted(); } });
  const a = await env.submit("A"); await waitFor(() => reached); await env.root.configure({ model: { provider: "proof", modelId: "B" }, thinkingLevel: "low" }, ctx); await env.harness.close(ctx); assert.equal(env.calls.length, 0);
  env = await environment(file, {}, { compaction: { enabled: false } }); t.after(() => env.harness.close(ctx)); env.faux.setResponses([fauxAssistantMessage("prepared A recovered")]); env.harness.resume(); assert.equal((await (await env.harness.submission(a.id, ctx))!.wait(ctx)).status, "done"); assert.deepEqual(env.calls, [{ model: "A", thinking: "high", owner: "A" }]);
});
test("deferred polling retains the saved source and charges only the terminal result", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-deferred-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "session.sqlite"), { deferred: { pendingFetches: 1, pollAfterMs: 1 } }, { compaction: { enabled: false }, stream: { deferred: true } }); t.after(() => env.harness.close(ctx));
  const fetches: string[] = [], original = env.port.resolve; env.port.resolve = async (...args) => { const runtime = await original(...args); return { ...runtime, models: new Proxy(runtime.models, { get(target, key) { if (key === "fetchDeferred") return ((model, handle, options) => { fetches.push(`${model.id}:${botExecutionScope()?.claim.id}`); return target.fetchDeferred(model, handle, options); }) as Models["fetchDeferred"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } }) }; };
  env.faux.setResponses([fauxAssistantMessage("deferred A final")]); const input = await env.submit("A"); await env.root.configure({ model: { provider: "proof", modelId: "B" }, thinkingLevel: "low" }, ctx);
  assert.equal((await input.wait(ctx)).status, "done"); assert.ok(fetches.length >= 2); assert.ok(fetches.every((value) => value === "A:A")); assert.equal(env.calls.length, 1); assert.equal(env.charges.length, 1); assert.equal(env.charges[0]!.owner, "A");
});
test("deferred cancellation uses the original model and refuses replacement credentials", async (t) => {
  for (const revoke of [false, true]) await t.test(revoke ? "revoked" : "current", async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-cancel-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "session.sqlite"), { deferred: { pendingFetches: 1, pollAfterMs: 60_000 } }, { compaction: { enabled: false }, stream: { deferred: true } }); t.after(() => env.harness.close(ctx));
    env.faux.setResponses([fauxAssistantMessage("unready response")]); const input = await env.submit("A");
    for (let n = 0; n < 100 && !(await env.harness.inspect(ctx)).tasks.some(({ record }) => record.kind === "pi.generation" && record.state.status === "sleeping"); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    if (revoke) env.port.resolve = async () => { throw new Error("Original credential grant revoked"); };
    const active = (await env.harness.inspect(ctx)).tasks.find(({ record }) => record.kind === "pi.generation")!; await env.harness.abortTask(active.record.id, ctx);
    assert.equal((await input.wait(ctx)).status, "unanswered"); assert.equal(env.faux.state.cancelledDeferred.length, revoke ? 0 : 1); assert.equal(env.calls.length, 1); assert.equal(env.charges.length, 0);
  });
});
test("person can acknowledge an older dismissed routine's actual unknown receipt while resuming blocked B", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-prior-unknown-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
  const a = await env.port.getClaim("bot:one", "A", "A"), b = await env.port.getClaim("bot:one", "B", "B"); a.routineId = "routine-A"; b.routineId = "routine-B";
  let document = emptySpendingDocument(); const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 2, routineRunUsd: 1 }), broadcast() {} });
  let service!: BotSessionRuntime;
  const interrupted = new Set<string>(), waiting = new Map<string, () => void>();
  const observedInterruption = (submissionId: string) => interrupted.has(submissionId) ? Promise.resolve() : new Promise<void>(resolve => { waiting.set(submissionId, resolve); });
  const issues = createBotIssueService({ store: createBotIssueStore({ profileDir: () => folder }), appendEntry: (botId, kind, data) => service.appendEntry(botId, kind, data as JsonValue), funnel: { deliver: async () => "sent" }, actions: { resumeRoutine: async () => "missing", stopRun: async () => {}, snoozeStall() {}, openSettings() {} }, now: Date.now });
  const issueLifecycle = createBotExecutionIssues(issues, spending);
  let originalId = "", acknowledgements = 0; const base = env.port.resolve;
  env.port.resolve = async (...args) => { const runtime = await base(...args), bound = args[1], owner = botExecutionSpendingOwner(bound), dispatch = (id: string) => ({ dispatchId: id, owner, providerId: "proof", modelId: runtime.model.id, counts: true }); return { ...runtime, beforeDispatch: async (id) => { if (bound.id === "A") originalId = id; await spending.beforeDispatch(dispatch(id)); }, afterDispatch: async (id, message) => { await spending.afterDispatch(dispatch(id), bound.id === "A" ? undefined : { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: 0.4 } } }); await issueLifecycle.settled("bot:one", bound); } }; };
  env.port.hasUnknown = async (_bot, bound) => Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(bound)));
  env.port.unknownDispatch = async (_bot, bound) => (await spending.pendingDispatch(botExecutionSpendingOwner(bound)))?.dispatchId;
  env.port.unknownCostReceipt = (botId, saved, submissionId, scopeId) => botExecutionUnknownCostReceipt(spending, botId, saved, submissionId, scopeId);
  env.port.acknowledgeUnknown = async (botId, bound, expectedDispatchId) => { const actual = await acknowledgeBotExecutionUnknown(spending, botId, bound, expectedDispatchId); if (actual) { acknowledgements++; await issueLifecycle.acknowledged(botId, actual); } return actual !== undefined; };
  env.port.dismissed = (botId, bound) => issueLifecycle.dismissed(botId, bound);
  service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } }, spendingRefusal: (botId) => botExecutionInputSpendingRefusal(spending, botId), executionBlocked: (...args) => issueLifecycle.blocked(...args), onStateChange: (_bot, state) => { if (state.kind === "interrupted") { interrupted.add(state.submissionId); waiting.get(state.submissionId)?.(); } } }); t.after(() => service.shutdown());
  env.faux.setResponses([fauxAssistantMessage("A outcome with unknown cost"), fauxAssistantMessage("B after consent")]);
  const submittedA = await service.send("bot:one", { requestId: "A", text: "A", routineOrigin: issueBotRoutineInputOrigin({ version: 1, botId: "bot:one", routineId: "routine-A", runId: "A", kind: "manual" }) });
  await observedInterruption(submittedA.submissionId);
  assert.equal((await service.routineState("bot:one")).kind, "interrupted"); const obligation = (await issues.list("bot:one", { open: true }))[0]!; assert.equal(obligation.body, SPENDING_UNKNOWN_RESUME_MESSAGE); await service.dismiss("bot:one", "dismiss-A");
  const submitted = await service.send("bot:one", { requestId: "B", text: "B", routineOrigin: issueBotRoutineInputOrigin({ version: 1, botId: "bot:one", routineId: "routine-B", runId: "B", kind: "manual" }) });
  await observedInterruption(submitted.submissionId);
  assert.equal((await service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, true); assert.deepEqual(env.calls.map((row) => row.model), ["A"]);
  assert.deepEqual((await issues.list("bot:one", { open: true })).map((issue) => issue.id), [obligation.id], "B shares the actual saved cost obligation instead of creating another card");
  await assert.rejects(service.resume("bot:one", "resume-B"), (error: unknown) => error instanceof Error && "reason" in error && error.reason === "spending_unconfirmed"); assert.equal(acknowledgements, 0);
  await assert.rejects(service.resume("bot:one", "never-admitted-stale-consent", { acknowledgeUnknownCost: true, expectedSubmissionId: "999999999" })); assert.equal(acknowledgements, 0);
  await service.resume("bot:one", "resume-B-confirmed", await reviewedCost(service, submitted.submissionId)); assert.equal((await service.awaitReply("bot:one", submitted.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(acknowledgements, 1); assert.equal(document.dispatches?.[originalId]?.state, "acknowledged_unknown"); assert.equal(document.dispatches?.[originalId]?.owner.kind, "bot"); const originalOwner = document.dispatches?.[originalId]?.owner; assert.equal(originalOwner?.kind === "bot" ? originalOwner.run : undefined, "A"); assert.equal(document.dispatches?.[originalId]?.costUsd, undefined);
  assert.equal((await spending.status("bot", "bot:one"))?.spentUsd, 0.4); assert.deepEqual(env.calls.map((row) => row.model), ["A", "B"]);
  assert.equal((await issues.list("bot:one", { open: true })).length, 0);
  await issueLifecycle.blocked("bot:one", a, "Model A needs setup.", "unavailable"); await issueLifecycle.blocked("bot:one", b, "Model B needs setup.", "unavailable"); await issueLifecycle.settled("bot:one", b);
  assert.deepEqual((await issues.list("bot:one", { open: true })).map((issue) => issue.dedupeKey), ["execution:A"]); await issueLifecycle.dismissed("bot:one", a); assert.equal((await issues.list("bot:one", { open: true })).length, 0);
});

test("queued B cannot replace A's tool loadout or its companion helper model, thinking and dispatch receipts", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-execution-helper-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
  const entered = gate(), release = gate(); let toolRuns = 0;
  const extension = recordingDeps();
  extension.currentTools = async () => botExecutionScope()?.claim.id !== "A" ? [] : [{ replay: "safe", tool: countingTool("inspect_image", async () => {
    toolRuns++; const owner = botExecutionScope()!;
    const companion = await env.port.resolve("bot:one", await env.port.getClaim("bot:one", "B", "B"), new AbortController().signal);
    const models = owner.bindHelperRuntime!("vision", { ...companion, thinkingLevel: "off", afterDispatch: async (id) => { env.charges.push({ owner: owner.claim.id, id }); } });
    const response = await models.completeSimple(companion.model, { messages: [{ role: "user", content: "Read the image", timestamp: 1 }] });
    assert.equal(response.content[0]?.type === "text" ? response.content[0].text : undefined, "visible evidence");
    return "image inspected";
  }) }];
  const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension, resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } });
  t.after(async () => { release.release(); await service.shutdown(); });
  env.faux.setResponses([async () => { entered.release(); await release.promise; return fauxAssistantMessage([fauxToolCall("inspect_image", { text: "image" })], { stopReason: "toolUse" }); }, fauxAssistantMessage("visible evidence"), fauxAssistantMessage("A final"), fauxAssistantMessage("B final")]);
  const a = await service.send("bot:one", { requestId: "A", text: "A" }); await entered.promise;
  const b = await service.send("bot:one", { requestId: "B", text: "B", whenBusy: "followUp" }); release.release();
  assert.equal((await service.awaitReply("bot:one", a.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal((await service.awaitReply("bot:one", b.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(toolRuns, 1);
  assert.deepEqual(env.calls, [{ model: "A", thinking: "high", owner: "A" }, { model: "B", thinking: "off", owner: "A" }, { model: "A", thinking: "high", owner: "A" }, { model: "B", thinking: "low", owner: "B" }]);
  assert.equal(env.charges.length, 4); assert.equal(new Set(env.charges.map((row) => row.id)).size, 4); assert.deepEqual(env.charges.map((row) => row.owner), ["A", "A", "A", "B"]);
});

test("a deferred helper polls its original dispatch and accounts its terminal result once", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-helper-deferred-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite"), { deferred: { pendingFetches: 1, pollAfterMs: 1 } }); await env.harness.close(ctx);
  const reservations: string[] = [], settled: string[] = [];
  const extension = recordingDeps({ tools: [{ replay: "safe", tool: countingTool("inspect_image", async () => {
    const owner = botExecutionScope()!, companion = await env.port.resolve("bot:one", await env.port.getClaim("bot:one", "B", "B"), new AbortController().signal);
    const helper = owner.bindHelperRuntime!("vision", { ...companion, beforeDispatch: async (id) => { reservations.push(id); }, afterDispatch: async (id) => { settled.push(id); } });
    let response = await helper.completeSimple(companion.model, { messages: [{ role: "user", content: "image", timestamp: 1 }] }, { deferred: true });
    assert.equal(response.stopReason, "deferred");
    while (response.stopReason === "deferred" || response.stopReason === "pending") response = await helper.fetchDeferred(companion.model, response.deferred!);
    assert.equal(response.content[0]?.type === "text" ? response.content[0].text : undefined, "deferred image evidence");
    await assert.rejects(helper.fetchDeferred(companion.model, { ...response.deferred, id: "unadmitted" } as never), /no admitted dispatch/u);
    return "done";
  }) }] });
  const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension, resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } }); t.after(() => service.shutdown());
  env.faux.setResponses([fauxAssistantMessage([fauxToolCall("inspect_image", { text: "image" })], { stopReason: "toolUse" }), fauxAssistantMessage("deferred image evidence"), fauxAssistantMessage("A final")]);
  const a = await service.send("bot:one", { requestId: "A", text: "A" }); assert.equal((await service.awaitReply("bot:one", a.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(reservations.length, 1); assert.deepEqual(settled, reservations); assert.deepEqual(env.calls.map((row) => [row.model, row.owner]), [["A", "A"], ["B", "A"], ["A", "A"]]);
});

test("the scheduler drops the first watch's ambient connector scope before queued person work", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-first-watch-scope-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "session.sqlite")); t.after(() => env.harness.close(ctx));
  const selected = await env.port.getClaim("bot:one", "A", "A"); selected.connectorServerId = "watch-server";
  const entered = gate(), release = gate(), observations: (string | undefined)[] = [];
  env.faux.setResponses([async () => { observations.push(botConnectorInventoryServer()); entered.release(); await release.promise; return fauxAssistantMessage("watch final"); }, () => { observations.push(botConnectorInventoryServer()); return fauxAssistantMessage("person final"); }]);
  const a = await env.submit("A"); await entered.promise; const person = await env.submit("D"); release.release(); await a.wait(ctx); await person.wait(ctx);
  assert.deepEqual(observations, ["watch-server", undefined]);
});

test("provider credentials stay ephemeral through a genuine prepared SQLite request", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-prepared-credentials-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "session.sqlite"), env = await environment(file, {}, { compaction: { enabled: false } });
  const marker = "synthetic-auth-that-must-never-be-checkpointed", entered = gate(), release = gate(); const base = env.port.resolve; let received = false;
  env.port.resolve = async (...args) => { const source = await base(...args); const models = new Proxy(source.models, { get(target, key) { if (key === "streamSimple") return ((model, messages, options) => { received = model.headers?.Authorization === marker; return target.streamSimple(model, messages, options); }) as Models["streamSimple"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } }); return { ...source, models, model: { ...source.model, headers: { Authorization: marker } }, beforeDispatch: async () => { entered.release(); await release.promise; } }; };
  env.faux.setResponses([fauxAssistantMessage("safe response")]); const input = await env.submit("A"); await entered.promise;
  const prepared = (await env.harness.inspect(ctx)).tasks.find(({ record }) => record.kind === "pi.generation")!.record;
  assert.equal((prepared.state.checkpoint as { phase: string }).phase, "request"); assert.equal(JSON.stringify(prepared).includes(marker), false);
  assert.equal((await readFile(file)).includes(Buffer.from(marker)), false);
  release.release(); await input.wait(ctx); assert.equal(received, true); await env.harness.close(ctx);
  assert.equal((await readFile(file)).includes(Buffer.from(marker)), false);
});

test("a saved known response is accounted before revoked-model dismissal can clear its task memo", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-known-response-revoke-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
  let document = emptySpendingDocument(), failCharge = true, revoked = false, providerCalls = 0;
  const response = fauxAssistantMessage("known answer"); response.usage = { ...response.usage, cost: { ...response.usage.cost, total: 0.35 } };
  const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => {
    if (failCharge && Object.values(next.dispatches ?? {}).some((row) => row.state === "recorded")) { failCharge = false; throw new Error("charge storage temporarily unavailable"); }
    document = structuredClone(next);
  } }, settings: async () => ({ botMonthUsd: 2, routineRunUsd: 1 }), broadcast() {} });
  const base = env.port.resolve;
  env.port.resolve = async (...args) => { if (revoked) throw new Error("model credentials revoked"); const source = await base(...args), owner = botExecutionSpendingOwner(args[1]), dispatch = (id: string) => ({ dispatchId: id, owner, providerId: "proof", modelId: source.model.id, counts: true }); const models = new Proxy(source.models, { get(target, key) { if (key === "streamSimple") return (() => { providerCalls++; const events = createAssistantMessageEventStream(); queueMicrotask(() => { events.push({ type: "done", reason: "stop", message: response }); events.end(response); }); return events; }) as Models["streamSimple"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } }); return { ...source, models, beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); }, afterDispatch: async (id, message) => spending.afterDispatch(dispatch(id), message) }; };
  env.port.recordKnownResponse = (facts, message) => recordSavedResponse(spending, facts, message);
  const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } }); t.after(() => service.shutdown());
  await service.send("bot:one", { requestId: "A", text: "A" });
  for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await service.routineState("bot:one")).kind, "interrupted"); assert.ok(await spending.pendingDispatch({ kind: "bot", id: "bot:one" })); assert.equal(providerCalls, 1);
  revoked = true; await service.dismiss("bot:one", "dismiss-after-revocation");
  assert.equal(await spending.pendingDispatch({ kind: "bot", id: "bot:one" }), undefined); assert.equal((await spending.status("bot", "bot:one"))?.spentUsd, 0.35);
  assert.equal(Object.values(document.dispatches ?? {}).filter((row) => row.state === "recorded").length, 1); assert.equal(providerCalls, 1);
});

test("live requests sharing root budgets wait for durable accounting while independent Bots proceed", async () => {
  let document = emptySpendingDocument();
  const accounting = gate(); let awaitingSave = false;
  const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { if (Object.values(next.dispatches ?? {}).some((row) => row.dispatchId === "A" && row.state === "recorded")) { awaitingSave = true; await accounting.promise; } document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 1, routineRunUsd: 1 }), broadcast() {} });
  const coordinator = createBotDispatchCoordinator(), signal = new AbortController().signal;
  const a = { dispatchId: "A", owner: { kind: "bot" as const, id: "root" }, providerId: "proof", modelId: "A", counts: true }, child = { ...a, dispatchId: "child", owner: { kind: "bot" as const, id: "recipient", budgetScopes: [{ kind: "bot" as const, id: "root" }] } };
  const releaseA = await coordinator.acquire("A", ["bot:root"], signal); await spending.beforeDispatch(a);
  let childEntered = false;
  const next = (async () => { const releaseChild = await coordinator.acquire("child", ["bot:recipient", "bot:root"], signal); childEntered = true; await spending.beforeDispatch(child); releaseChild(); })();
  const releaseOther = await coordinator.acquire("other", ["bot:other"], signal); releaseOther();
  const cancelled = new AbortController(), rejected = coordinator.acquire("cancelled", ["bot:root"], cancelled.signal); cancelled.abort(new Error("task stopped")); await assert.rejects(rejected, /task stopped/u);
  const charge = spending.afterDispatch(a, { usage: { cost: { total: 0.25 } } }); await waitFor(() => awaitingSave);
  assert.equal(childEntered, false); accounting.release(); await charge; releaseA(); await next;
  assert.equal(childEntered, true); assert.equal((await spending.status("bot", "root"))?.spentUsd, 0.25); assert.equal(document.dispatches?.cancelled, undefined); assert.equal(document.dispatches?.child?.state, "pending");
});

test("Pi synthetic failure zeros retain unknown metered cost, while successful or unmetered zero receipts settle", async (t) => {
  for (const variant of ["error", "aborted", "success", "unmetered"] as const) await t.test(variant, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-synthetic-cost-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
    let document = emptySpendingDocument(), providerCalls = 0;
    const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 1, routineRunUsd: 1 }), broadcast() {} });
    const response = fauxAssistantMessage(variant === "success" ? "free answer" : "", { stopReason: variant === "success" ? "stop" : variant === "aborted" ? "aborted" : "error", errorMessage: "provider interrupted before reporting usage" });
    const base = env.port.resolve;
    env.port.resolve = async (...args) => { const source = await base(...args), dispatch = (id: string) => ({ dispatchId: id, owner: botExecutionSpendingOwner(args[1]), providerId: "proof", modelId: source.model.id, counts: variant !== "unmetered" });
      const models = new Proxy(source.models, { get(target, key) { if (key === "streamSimple") return (() => { providerCalls++; const events = createAssistantMessageEventStream(); queueMicrotask(() => { if (response.stopReason === "error" || response.stopReason === "aborted") events.push({ type: "error", reason: response.stopReason, error: response }); else events.push({ type: "done", reason: "stop", message: response }); events.end(response); }); return events; }) as Models["streamSimple"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } });
      return { ...source, models, beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); }, afterDispatch: (id, message) => spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(message)) };
    };
    env.port.hasUnknown = async (_bot, bound) => Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(bound)));
    env.port.unknownCostReceipt = (botId, saved, submissionId, scopeId) => botExecutionUnknownCostReceipt(spending, botId, saved, submissionId, scopeId);
    env.port.recordKnownResponse = (facts, message) => recordSavedResponse(spending, facts, message);
    const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false }, retry: { enabled: false } } }); t.after(() => service.shutdown());
    const input = await service.send("bot:one", { requestId: "A", text: "A" });
    if (variant === "error" || variant === "aborted") {
      for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await service.executionResumeStatus("bot:one"); assert.equal(status.requiresUnknownCostAcknowledgement, true); assert.equal(status.interruptedSubmissionId, input.submissionId);
      assert.equal((await spending.pendingDispatch({ kind: "bot", id: "bot:one" }))?.dispatchId, Object.keys(document.dispatches!)[0]);
      await assert.rejects(service.resume("bot:one", "ordinary-resume"), (error: unknown) => error instanceof Error && "reason" in error && error.reason === "spending_unconfirmed");
    } else {
      await service.awaitReply("bot:one", input.submissionId, new AbortController().signal);
      assert.equal(await spending.pendingDispatch({ kind: "bot", id: "bot:one" }), undefined);
      const receipt = Object.values(document.dispatches!)[0]!; assert.equal(receipt.state, "recorded"); assert.equal(receipt.costUsd, 0);
    }
    assert.equal(providerCalls, 1);
  });
});

test("distinct child helper receipts survive interleaving and a reopened completed unsafe tool never relaunches children", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-child-helper-replay-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
  const childOne = gate(), childTwo = gate(), finalStarted = gate(); let toolRuns = 0, helperRuns = 0;
  const extension = recordingDeps({ tools: [{ replay: "unsafe", tool: countingTool("subagent", async () => {
    toolRuns++; const owner = botExecutionScope()!, companion = await env.port.resolve("bot:one", await env.port.getClaim("bot:one", "B", "B"), new AbortController().signal);
    const run = async (childId: string) => { helperRuns++; const models = owner.bindHelperRuntime!(`subagent:${childId}`, { ...companion, release() {}, afterDispatch: async (id) => { env.charges.push({ owner: owner.claim.id, id }); } }); return models.completeSimple(companion.model, { messages: [{ role: "user", content: "same child question", timestamp: 1 }] }); };
    const first = run("child-one"), second = run("child-two");
    const responses = await Promise.all([first, second]); assert.deepEqual(responses.map((response) => response.content[0]?.type === "text" ? response.content[0].text : undefined), ["first child answer", "second child answer"]);
    return "both children completed";
  }) }] });
  const options = { profileDir: folder, models: env.models, execution: env.port, extension, resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } };
  let service = await createBotSessionService(options); t.after(() => service.shutdown());
  env.faux.setResponses([fauxAssistantMessage([fauxToolCall("subagent", { text: "two tasks" })], { stopReason: "toolUse" }), async () => { await childOne.promise; return fauxAssistantMessage("first child answer"); }, async () => { await childTwo.promise; return fauxAssistantMessage("second child answer"); }, async (_messages, streamOptions) => { finalStarted.release(); await new Promise<void>((resolve) => { if (streamOptions?.signal?.aborted) resolve(); else streamOptions?.signal?.addEventListener("abort", () => resolve(), { once: true }); }); return fauxAssistantMessage("cancelled final", { stopReason: "aborted" }); }]);
  const a = await service.send("bot:one", { requestId: "A", text: "A" }); await waitFor(() => helperRuns === 2); childTwo.release(); childOne.release(); await finalStarted.promise;
  assert.equal(new Set(env.charges.map((row) => row.id)).size, 3); await service.shutdown();
  service = await createBotSessionService(options); await service.initialize(); env.faux.setResponses([fauxAssistantMessage("recovered final")]);
  await service.resume("bot:one", "resume-completed-child-tool"); assert.equal((await service.awaitReply("bot:one", a.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(toolRuns, 1); assert.equal(helperRuns, 2); assert.equal(env.calls.filter((row) => row.model === "B").length, 2);
});

test("person Resume after an interrupted unsafe child tool does not restart the child or reuse its provider receipt", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-interrupted-child-tool-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
  const childFinished = gate(); let toolRuns = 0;
  const extension = recordingDeps({ tools: [{ replay: "unsafe", tool: countingTool("subagent", async (_args, signal) => {
    toolRuns++; const owner = botExecutionScope()!, companion = await env.port.resolve("bot:one", await env.port.getClaim("bot:one", "B", "B"), signal!);
    const helper = owner.bindHelperRuntime!("subagent:fixed-child", { ...companion, release() {}, afterDispatch: async (id) => { env.charges.push({ owner: owner.claim.id, id }); } });
    await helper.completeSimple(companion.model, { messages: [{ role: "user", content: "child question", timestamp: 1 }] }); childFinished.release();
    await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
    throw signal?.reason ?? new Error("child tool interrupted");
  }) }] });
  const options = { profileDir: folder, models: env.models, execution: env.port, extension, resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } };
  let service = await createBotSessionService(options); t.after(() => service.shutdown()); env.faux.setResponses([fauxAssistantMessage([fauxToolCall("subagent", { text: "task" })], { stopReason: "toolUse" }), fauxAssistantMessage("child answer")]);
  const a = await service.send("bot:one", { requestId: "A", text: "A" }); await childFinished.promise; const receipt = env.charges.find((row) => row.owner === "A" && row.id !== env.charges[0]!.id)!.id;
  await service.shutdown(); service = await createBotSessionService(options); await service.initialize(); env.faux.setResponses([fauxAssistantMessage("The interrupted child was not rerun.")]);
  await service.resume("bot:one", "resume-interrupted-child"); assert.equal((await service.awaitReply("bot:one", a.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(toolRuns, 1); assert.equal(env.calls.filter((row) => row.model === "B").length, 1); assert.equal(env.charges.filter((row) => row.id === receipt).length, 1);
});

test("actual registry image conversion refuses a text model without a companion and preserves the explicit image helper", async (t) => {
  for (const companion of [false, true]) await t.test(companion ? "explicit companion" : "no companion", async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-source-image-check-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", a = await env.port.getClaim("bot:one", "A", "A"), b = await env.port.getClaim("bot:one", "B", "B");
    if (companion) a.vision = b.primary.binding;
    const extension = recordingDeps(); extension.imageInput = async () => false;
    const vision = visionCandidate({ visionProvider: b.primary.binding } as unknown as BotRuntimeEffectiveAuthority, { revalidateBeforeEffect: async () => {}, dependencies: { recordUsage: async () => {}, resolveRuntime: async () => ({ provider: { id: "proof", kind: "openai", label: "Proof", baseUrl: "https://fixture.invalid", models: ["B"], needsKey: false }, model: { ...env.models.getModel("proof", "B")!, input: ["text", "image"] }, models: env.models, streams: { streamSimple: env.models.streamSimple.bind(env.models) }, apiKey: undefined, headers: undefined }) } });
    extension.currentTools = async () => companion ? [{ ...vision!, replay: "safe" }] : [];
    const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension, resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } }); t.after(() => service.shutdown());
    env.faux.setResponses([messages => { assert.equal(messages.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image")), false); assert.ok(JSON.stringify(messages.messages).includes(botImageReference(image))); return fauxAssistantMessage([fauxToolCall("inspect_image", { imageRef: botImageReference(image), question: "What is visible?" })], { stopReason: "toolUse" }); }, messages => { assert.ok(messages.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image"))); return fauxAssistantMessage("one pixel"); }, fauxAssistantMessage("The image has one pixel.")]);
    const sent = await service.send("bot:one", { requestId: "A", text: "Read this image", attachments: [{ type: "image", mimeType: "image/png", data: image }] });
    if (companion) { assert.equal((await service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed"); assert.equal(env.faux.state.callCount, 3); }
    else { for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal((await service.routineState("bot:one")).kind, "interrupted"); assert.equal(env.faux.state.callCount, 0); }
  });
});

test("real SIGKILL around cost acknowledgement recovers only the saved exact source-bound next-attempt obligation", async (t) => {
  for (const boundary of ["before-ack", "after-ack", "after-generation"] as const) await t.test(boundary, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-consent-store-boundary-")); t.after(() => rm(folder, { recursive: true, force: true }));
    await killAfterRoutineReceipt(t, `
      import assert from 'node:assert/strict';
      import {openConsentBoundaryFixture} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/consent-boundary-fixture.ts"))};
      const env=await openConsentBoundaryFixture(${JSON.stringify(folder)},{firstUnknown:true,crash:${JSON.stringify(boundary)}});
      const sent=await env.service.send('bot:one',{requestId:'person',text:'accepted request'});
      while((await env.service.routineState('bot:one')).kind!=='interrupted')await new Promise(resolve=>setTimeout(resolve,5));
      await assert.rejects(env.service.resume('bot:one','unconfirmed'));
      const cost=await env.service.executionResumeStatus('bot:one');
      await env.service.resume('bot:one','confirmed',{acknowledgeUnknownCost:true,expectedSubmissionId:sent.submissionId,expectedCostReceiptId:cost.costReceiptId});
      setInterval(()=>{},1000);
    `);
    const env = await openConsentBoundaryFixture(folder); t.after(() => env.service.shutdown()); await env.service.initialize();
    const receiptsBefore = Object.values((await env.document.load()).dispatches!); assert.equal(receiptsBefore.length, 1); assert.equal(receiptsBefore[0]!.state, boundary === "before-ack" ? "pending" : "acknowledged_unknown");
    const proof = await env.spending.dispatchReceipt(receiptsBefore[0]!.dispatchId); assert.ok(proof); proof.owner.id = "forged"; assert.equal((await env.spending.dispatchReceipt(proof.dispatchId))?.owner.id, "bot:one");
    const submissionId = (await env.service.submissionForRequest("bot:one", "person"))!;
    await env.service.resume("bot:one", "finish-previous-explicit-decision");
    assert.equal((await env.service.awaitReply("bot:one", submissionId, new AbortController().signal)).kind, "completed"); assert.equal(env.providerCalls(), 1);
    const after = Object.values((await env.document.load()).dispatches!); assert.equal(after.length, 2); assert.equal(after.find((receipt) => receipt.dispatchId === proof.dispatchId)?.state, "acknowledged_unknown"); assert.equal(after.find((receipt) => receipt.dispatchId !== proof.dispatchId)?.costUsd, 0.2); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.2);
    await env.service.resume("bot:one", "replay-finished-decision"); assert.equal(env.providerCalls(), 1); assert.equal(Object.keys((await env.document.load()).dispatches!).length, 2);
  });
});

test("actual Bot and background transports abort on authority revocation and retain unknown aborted cost", async (t) => {
  for (const background of [false, true]) await t.test(background ? "background completion" : "actual Bot service", async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-revoked-stream-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
    const authority = new AbortController(), entered = gate(); let providerSignal: AbortSignal | undefined, providerCalls = 0, document = emptySpendingDocument();
    const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 1 }), broadcast() {} });
    const base = env.port.resolve;
    env.port.resolve = async (...args) => { const source = await base(...args), dispatch = (id: string) => ({ dispatchId: id, owner: botExecutionSpendingOwner(args[1]), providerId: "proof", modelId: source.model.id, counts: true }); const models = new Proxy(source.models, { get(target, key) {
      if (key === "streamSimple") return ((_model, _messages, options) => { providerCalls++; providerSignal = options?.signal; const events = createAssistantMessageEventStream(); const aborted = () => { const response = fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "authority revoked" }); events.push({ type: "error", reason: "aborted", error: response }); events.end(response); }; if (providerSignal?.aborted) aborted(); else providerSignal?.addEventListener("abort", aborted, { once: true }); entered.release(); return events; }) as Models["streamSimple"];
      const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value;
    } }); return { ...source, models, signal: authority.signal, revalidate: async () => authority.signal.throwIfAborted(), beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); }, afterDispatch: (id, response) => spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(response)) }; };
    env.port.hasUnknown = async (_botId, saved) => Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(saved)));
    env.port.unknownCostReceipt = (botId, saved, submissionId, scopeId) => botExecutionUnknownCostReceipt(spending, botId, saved, submissionId, scopeId);
    if (background) {
      const saved = await env.port.getClaim("bot:one", "A", "A"), runtime = await env.port.resolve("bot:one", saved, new AbortController().signal);
      const result = createBotBackgroundExecutionModels(saved, runtime).completeSimple(runtime.model, { messages: [{ role: "user", content: "background review", timestamp: 1 }] });
      await entered.promise; authority.abort(new Error("current credential revoked")); const interrupted = await result; assert.equal(interrupted.stopReason, "error"); assert.match(interrupted.errorMessage ?? "", /unknown/u);
    } else {
      const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false }, retry: { enabled: false } } }); t.after(() => service.shutdown());
      const sent = await service.send("bot:one", { requestId: "A", text: "accepted work" }); await entered.promise; authority.abort(new Error("current credential revoked"));
      for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await service.executionResumeStatus("bot:one"); assert.equal(status.requiresUnknownCostAcknowledgement, true); assert.equal(status.interruptedSubmissionId, sent.submissionId);
    }
    assert.equal(providerSignal?.aborted, true); assert.equal(providerCalls, 1); const receipt = Object.values(document.dispatches!)[0]!; assert.equal(receipt.state, "pending"); assert.equal(receipt.costUsd, undefined);
  });
});

test("deferred poll and cancellation combine the exact authority signal with their task signal", async (t) => {
  for (const operation of ["poll", "cancel"] as const) await t.test(operation, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-revoked-deferred-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "session.sqlite"), { deferred: { pendingFetches: 1, pollAfterMs: operation === "poll" ? 1 : 60_000 } }, { compaction: { enabled: false }, stream: { deferred: true } }); t.after(() => env.harness.close(ctx));
    const authority = new AbortController(), entered = gate(); let providerSignal: AbortSignal | undefined; const base = env.port.resolve;
    env.port.resolve = async (...args) => { const source = await base(...args); const models = new Proxy(source.models, { get(target, key) {
      if (key === (operation === "poll" ? "fetchDeferred" : "cancelDeferred")) return async (_model: unknown, _handle: unknown, options?: { signal?: AbortSignal }) => { providerSignal = options?.signal; entered.release(); await new Promise<void>((resolve) => { if (providerSignal?.aborted) resolve(); else providerSignal?.addEventListener("abort", () => resolve(), { once: true }); }); providerSignal?.throwIfAborted(); };
      const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value;
    } }); return { ...source, models, signal: authority.signal, revalidate: async () => authority.signal.throwIfAborted() }; };
    env.faux.setResponses([fauxAssistantMessage("not yet available")]); const input = await env.submit("A");
    if (operation === "cancel") { let task; for (let n = 0; n < 100 && !task; n++) { task = (await env.harness.inspect(ctx)).tasks.find(({ record }) => record.kind === "pi.generation" && record.state.status === "sleeping"); if (!task) await new Promise((resolve) => setTimeout(resolve, 5)); } assert.ok(task); await env.harness.abortTask(task.record.id, ctx); }
    await entered.promise; authority.abort(new Error("credential lease revoked")); assert.equal(providerSignal?.aborted, true);
    assert.equal((await input.wait(ctx)).status, "unanswered"); assert.equal(env.faux.state.callCount, 1); assert.equal(env.charges.length, 0);
  });
});

test("a legacy known saved response settling around consent is reused without replacement I/O or a second charge", async (t) => {
  for (const boundary of ["during-ack", "after-generation"] as const) await t.test(boundary, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-known-cost-consent-race-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await openConsentBoundaryFixture(folder, { legacyEvidence: true }); t.after(() => env.service.shutdown());
    let recover = false, settleNextPhase = false, dispatchId = "", saved: import("@earendil-works/pi-ai").AssistantMessage | undefined;
    const originalResolve = env.execution.resolve, originalAck = env.execution.acknowledgeUnknown!;
    env.execution.resolve = async (...args) => { const runtime = await originalResolve(...args); return { ...runtime, afterDispatch: async (id, response) => { dispatchId = id; saved = response; if (!recover) throw new SpendingDispatchError("uncertain", SPENDING_UNKNOWN_RESUME_MESSAGE); await runtime.afterDispatch?.(id, response); } }; };
    const record = async () => { const receipt = await env.spending.dispatchReceipt(dispatchId); assert.ok(receipt && saved); await env.spending.afterDispatch({ dispatchId: receipt.dispatchId, owner: receipt.owner, providerId: receipt.providerId, modelId: receipt.modelId, counts: receipt.counts }, saved); };
    env.execution.recordKnownResponse = async () => { if (settleNextPhase) { settleNextPhase = false; await record(); } };
    env.execution.acknowledgeUnknown = async (...args) => { recover = true; if (boundary === "during-ack") { await record(); return "recorded"; } const outcome = await originalAck(...args); settleNextPhase = true; return outcome; };
    const sent = await env.service.send("bot:one", { requestId: "person", text: "one known provider answer" });
    for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await env.service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, true); assert.equal(env.providerCalls(), 1);
    await env.service.resume("bot:one", "reviewed-cost-decision", await reviewedCost(env.service, sent.submissionId));
    assert.equal((await env.service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed");
    assert.equal(env.providerCalls(), 1); const receipts = Object.values((await env.document.load()).dispatches!); assert.equal(receipts.length, 1); assert.equal(receipts[0]!.state, "recorded"); assert.equal(receipts[0]!.costUsd, 0.2); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.2);
  });
});

test("cost consent while polling a deferred request keeps the original handle and dispatch receipt", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-deferred-cost-resume-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite"), { deferred: { pendingFetches: 0, pollAfterMs: 1 } }); await env.harness.close(ctx);
  let document = emptySpendingDocument(), failPoll = true, polls = 0;
  const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 1 }), broadcast() {} });
  const base = env.port.resolve;
  env.port.resolve = async (...args) => { const source = await base(...args), dispatch = (id: string) => ({ dispatchId: id, owner: botExecutionSpendingOwner(args[1]), providerId: "proof", modelId: source.model.id, counts: true }); const models = new Proxy(source.models, { get(target, key) { if (key === "fetchDeferred") return (async (...parameters) => { polls++; if (failPoll) { failPoll = false; throw new SpendingDispatchError("uncertain", SPENDING_UNKNOWN_RESUME_MESSAGE); } return target.fetchDeferred(...parameters); }) as Models["fetchDeferred"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } }); return { ...source, models, beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); }, afterDispatch: (id, response) => spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(response)) }; };
  env.port.hasUnknown = async (_botId, saved) => Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(saved)));
  env.port.unknownDispatch = async (_botId, saved) => (await spending.pendingDispatch(botExecutionSpendingOwner(saved)))?.dispatchId;
  env.port.unknownCostReceipt = (botId, saved, submissionId, scopeId) => botExecutionUnknownCostReceipt(spending, botId, saved, submissionId, scopeId);
  env.port.acknowledgeUnknown = async (botId, saved, expected) => Boolean(await acknowledgeBotExecutionUnknown(spending, botId, saved, expected));
  const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false }, stream: { deferred: true } } }); t.after(() => service.shutdown());
  env.faux.setResponses([fauxAssistantMessage("deferred original answer")]); const sent = await service.send("bot:one", { requestId: "A", text: "one deferred request" });
  for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, true); const original = Object.keys(document.dispatches!)[0]!;
  await service.resume("bot:one", "confirmed-deferred-cost", await reviewedCost(service, sent.submissionId)); assert.equal((await service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(env.faux.state.callCount, 1); assert.equal(polls, 2); assert.deepEqual(Object.keys(document.dispatches!), [original]); assert.equal(document.dispatches?.[original]?.state, "recorded");
});

test("multi-call compaction preserves every earlier known operation across two distinct cost consents and SIGKILL restarts", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-compaction-slots-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const fixture = JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/consent-boundary-fixture.ts"));
  await killAfterRoutineReceipt(t, `
    import assert from 'node:assert/strict'; import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
    import {openConsentBoundaryFixture} from ${fixture};
    const env=await openConsentBoundaryFixture(${JSON.stringify(folder)},{multiCall:{failSlot:1}});
    const conversation=await env.service.conversation('bot:one');
    for(let n=0;n<4;n++)await conversation.submit({type:'write',entry:{kind:'proof.seed',model:[{role:'user',content:'history '.repeat(250),timestamp:n}]}},BACKGROUND_CONTEXT);
    await env.service.send('bot:one',{requestId:'person',text:'compact then answer'});
    while((await env.service.routineState('bot:one')).kind!=='interrupted')await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(await env.effects.load(),['compaction slot 0']);assert.equal(Object.keys((await env.document.load()).dispatches).length,2);
    console.log('OWNERSHIP_SAVED');setInterval(()=>{},1000);
  `);
  await killAfterRoutineReceipt(t, `
    import assert from 'node:assert/strict'; import {openConsentBoundaryFixture} from ${fixture};
    const env=await openConsentBoundaryFixture(${JSON.stringify(folder)},{multiCall:{failSlot:2}});await env.service.initialize();
    const submissionId=await env.service.submissionForRequest('bot:one','person');
    const cost=await env.service.executionResumeStatus('bot:one');
    await env.service.resume('bot:one','consent-slot-one',{acknowledgeUnknownCost:true,expectedSubmissionId:submissionId,expectedCostReceiptId:cost.costReceiptId});
    while((await env.service.routineState('bot:one')).kind!=='interrupted')await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(await env.effects.load(),['compaction slot 0','compaction slot 1']);assert.equal(Object.keys((await env.document.load()).dispatches).length,4);
    console.log('OWNERSHIP_SAVED');setInterval(()=>{},1000);
  `);
  const env = await openConsentBoundaryFixture(folder, { multiCall: {} }); t.after(() => env.service.shutdown()); await env.service.initialize();
  await assert.rejects(env.service.resume("bot:one", "unconfirmed-second-slot"));
  const submissionId = (await env.service.submissionForRequest("bot:one", "person"))!;
  await env.service.resume("bot:one", "consent-slot-two", await reviewedCost(env.service, submissionId));
  assert.equal((await env.service.awaitReply("bot:one", submissionId, new AbortController().signal)).kind, "completed");
  assert.deepEqual(await env.effects.load(), ["compaction slot 0", "compaction slot 1", "compaction slot 2", "final answer"]);
  const receipts = Object.values((await env.document.load()).dispatches!); assert.equal(receipts.length, 6); assert.equal(receipts.filter((receipt) => receipt.state === "recorded").length, 4); assert.equal(receipts.filter((receipt) => receipt.state === "acknowledged_unknown").length, 2); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.4);
});

test("an operation slot cannot reuse a known result or dispatch a changed request body after restart", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-operation-body-")); t.after(() => rm(folder, { recursive: true, force: true }));
  let env = await openConsentBoundaryFixture(folder, { multiCall: { failSlot: 1 } });
  const conversation = await env.service.conversation("bot:one"); for (let n = 0; n < 4; n++) await conversation.submit({ type: "write", entry: { kind: "proof.seed", model: [{ role: "user", content: "history ".repeat(250), timestamp: n }] } }, ctx);
  const sent = await env.service.send("bot:one", { requestId: "person", text: "compact then answer" }); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10)); await env.service.shutdown();
  env = await openConsentBoundaryFixture(folder, { multiCall: { changedFirstBody: true } }); t.after(() => env.service.shutdown()); await env.service.initialize();
  await env.service.resume("bot:one", "consent-does-not-change-body", await reviewedCost(env.service, sent.submissionId)); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await env.service.routineState("bot:one")).kind, "interrupted"); assert.deepEqual(await env.effects.load(), ["compaction slot 0"]); assert.equal(Object.keys((await env.document.load()).dispatches!).length, 2); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.1);
});

test("an accepted ordinary Resume replay after restart observes a later input without resuming it", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-ordinary-resume-receipt-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite")); await env.harness.close(ctx);
  const first = gate(), later = gate();
  const interrupted = (entered: ReturnType<typeof gate>) => async (_messages: unknown, options?: { signal?: AbortSignal }) => { entered.release(); await new Promise<void>((resolve) => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); }); return fauxAssistantMessage("interrupted", { stopReason: "aborted" }); };
  env.faux.setResponses([interrupted(first), fauxAssistantMessage("A finished"), interrupted(later)]);
  const options = { profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } };
  let service = await createBotSessionService(options); const a = await service.send("bot:one", { requestId: "A", text: "A" }); await first.promise; await service.shutdown();
  service = await createBotSessionService(options); await service.initialize(); await service.resume("bot:one", "ordinary-accepted-lost-reply"); assert.equal((await service.awaitReply("bot:one", a.submissionId, new AbortController().signal)).kind, "completed");
  const b = await service.send("bot:one", { requestId: "B", text: "B" }); await later.promise; await service.shutdown();
  service = await createBotSessionService(options); t.after(() => service.shutdown()); await service.initialize(); const calls = env.faux.state.callCount;
  assert.deepEqual(await service.resume("bot:one", "ordinary-accepted-lost-reply"), { kind: "interrupted", submissionId: b.submissionId });
  await assert.rejects(service.resume("bot:one", "ordinary-accepted-lost-reply", { acknowledgeUnknownCost: true, expectedSubmissionId: b.submissionId }), /different decision/u);
  assert.equal(env.faux.state.callCount, calls); assert.equal((await service.routineState("bot:one")).kind, "interrupted");
});

test("an accepted cost Resume replay cannot acknowledge a later unknown cost on the same input after restart", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-cost-resume-receipt-")); t.after(() => rm(folder, { recursive: true, force: true }));
  let env = await openConsentBoundaryFixture(folder, { multiCall: { failSlot: 1 } });
  const conversation = await env.service.conversation("bot:one"); for (let n = 0; n < 4; n++) await conversation.submit({ type: "write", entry: { kind: "proof.seed", model: [{ role: "user", content: "history ".repeat(250), timestamp: n }] } }, ctx);
  const sent = await env.service.send("bot:one", { requestId: "person", text: "compact then answer" }); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10)); await env.service.shutdown();
  env = await openConsentBoundaryFixture(folder, { multiCall: { failSlot: 2 } }); await env.service.initialize(); const body = await reviewedCost(env.service, sent.submissionId);
  await env.service.resume("bot:one", "cost-accepted-lost-reply", body); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10)); const later = (await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" }))!; assert.ok(later); await env.service.shutdown();
  env = await openConsentBoundaryFixture(folder, { multiCall: {} }); t.after(() => env.service.shutdown()); await env.service.initialize();
  assert.deepEqual(await env.service.resume("bot:one", "cost-accepted-lost-reply", body), { kind: "interrupted", submissionId: sent.submissionId });
  assert.equal((await env.spending.dispatchReceipt(later.dispatchId))?.state, "pending"); assert.deepEqual(await env.effects.load(), ["compaction slot 0", "compaction slot 1"]);
  await assert.rejects(env.service.resume("bot:one", "cost-accepted-lost-reply"), /different decision/u);
  await env.service.resume("bot:one", "fresh-cost-decision", await reviewedCost(env.service, sent.submissionId)); assert.equal((await env.service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed"); assert.deepEqual(await env.effects.load(), ["compaction slot 0", "compaction slot 1", "compaction slot 2", "final answer"]);
});

test("SIGKILL after consuming Resume but before effects cannot re-enter the old control or mint consent", async (t) => {
  for (const boundary of ["after-control", "after-approval"] as const) await t.test(boundary, async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-consumed-resume-crash-")); t.after(() => rm(folder, { recursive: true, force: true }));
  await killAfterRoutineReceipt(t, `
    import {openConsentBoundaryFixture} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/consent-boundary-fixture.ts"))};
    const env=await openConsentBoundaryFixture(${JSON.stringify(folder)},{firstUnknown:true,crash:${JSON.stringify(boundary)}});
    const sent=await env.service.send('bot:one',{requestId:'person',text:'accepted request'});
    while((await env.service.routineState('bot:one')).kind!=='interrupted')await new Promise(resolve=>setTimeout(resolve,5));
    const cost=await env.service.executionResumeStatus('bot:one');
    await env.service.resume('bot:one','consumed-before-effects',{acknowledgeUnknownCost:true,expectedSubmissionId:sent.submissionId,expectedCostReceiptId:cost.costReceiptId});
  `);
  const env = await openConsentBoundaryFixture(folder); t.after(() => env.service.shutdown()); await env.service.initialize(); const submissionId = (await env.service.submissionForRequest("bot:one", "person"))!, body = await reviewedCost(env.service, submissionId);
  assert.equal((await env.service.resume("bot:one", "consumed-before-effects", body)).kind, "interrupted"); assert.equal(env.providerCalls(), 0); assert.equal(Object.values((await env.document.load()).dispatches!)[0]!.state, "pending");
  await assert.rejects(env.service.resume("bot:one", "ordinary-cannot-adopt-orphan-approval")); assert.equal(env.providerCalls(), 0);
  await env.service.resume("bot:one", "fresh-after-consumed-crash", body); assert.equal((await env.service.awaitReply("bot:one", submissionId, new AbortController().signal)).kind, "completed"); assert.equal(env.providerCalls(), 1);
  });
});

test("durable Resume receipts protect 24 hours, refuse full or corrupt storage, and cannot be changed by replay", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-resume-retention-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "session.sqlite")); t.after(() => env.harness.close(ctx));
  assert.equal(await consumeBotResumeOperation(env.root, "accepted", undefined, "1", 1_000), "new");
  await env.root.commit(async (tx) => { const doc = await tx.doc(BotResumeOperationsDoc, env.root.id); for (let n = 0; n < 511; n++) doc.receipts.push({ id: `retained-${n}`, signature: "a".repeat(64), source: "1", acceptedAt: 1_000, expiresAt: 86_401_000 }); }, ctx);
  assert.equal(await consumeBotResumeOperation(env.root, "accepted", {}, "2", 86_400_999), "replayed");
  await assert.rejects(consumeBotResumeOperation(env.root, "accepted", { acknowledgeUnknownCost: true, expectedSubmissionId: "2" }, "2", 86_400_999), /different decision/u);
  await assert.rejects(consumeBotResumeOperation(env.root, "new", undefined, "2", 86_400_999), /still protected/u);
  assert.equal((await env.harness.snapshot(BotResumeOperationsDoc, env.root.id, ctx))?.receipts.length, 512);
  assert.equal(await consumeBotResumeOperation(env.root, "new", undefined, "2", 86_401_000), "new"); assert.equal((await env.harness.snapshot(BotResumeOperationsDoc, env.root.id, ctx))?.receipts.length, 1);
  await env.root.commit(async (tx) => { (await tx.doc(BotResumeOperationsDoc, env.root.id)).receipts[0]!.expiresAt = 0; }, ctx);
  await assert.rejects(consumeBotResumeOperation(env.root, "corrupt", undefined, "2", 86_401_001), /unavailable/u); assert.equal(env.faux.state.callCount, 0);
});

test("saved deferred terminal failures settle after exact cost acknowledgement or a late report, without repolling across restart", async (t) => {
  for (const variant of ["aborted", "retryable-error", "overflow-error", "late-known-cost"] as const) await t.test(variant, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-deferred-terminal-consent-")); t.after(() => rm(folder, { recursive: true, force: true }));
    const env = await environment(path.join(folder, "unused.sqlite"), { deferred: { pendingFetches: 0, pollAfterMs: 1 } }); await env.harness.close(ctx);
    const document = new DataStore("spending.json", emptySpendingDocument(), () => folder, { fileMode: 0o600, compact: true });
    const spending = new SpendingService({ persistence: { load: () => document.load(), save: (next) => document.save(next) }, settings: async () => ({ botMonthUsd: 1 }), broadcast() {} });
    const errors = { aborted: "poll aborted without reporting usage", "retryable-error": "429 rate limit, retry later", "overflow-error": "maximum context length exceeded", "late-known-cost": "poll aborted before usage arrived" };
    let polls = 0, acknowledgements = 0; const base = env.port.resolve;
    env.port.resolve = async (...args) => { const source = await base(...args), dispatch = (id: string) => ({ dispatchId: id, owner: botExecutionSpendingOwner(args[1]), providerId: "proof", modelId: source.model.id, counts: true }); const models = new Proxy(source.models, { get(target, key) { if (key === "fetchDeferred") return (async () => { polls++; return fauxAssistantMessage("", { stopReason: variant.endsWith("error") ? "error" : "aborted", errorMessage: errors[variant] }); }) as Models["fetchDeferred"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } }); return { ...source, models, beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); }, afterDispatch: (id, response) => spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(response)), isDispatchSettled: (id) => isBotExecutionDispatchSettled(spending, dispatch(id)) }; };
    env.port.hasUnknown = async (_botId, saved) => Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(saved)));
    env.port.unknownDispatch = async (_botId, saved) => (await spending.pendingDispatch(botExecutionSpendingOwner(saved)))?.dispatchId;
    env.port.unknownCostReceipt = (botId, saved, submissionId, scopeId) => botExecutionUnknownCostReceipt(spending, botId, saved, submissionId, scopeId);
    env.port.acknowledgeUnknown = async (botId, saved, expected) => { const id = await acknowledgeBotExecutionUnknown(spending, botId, saved, expected); if (id) acknowledgements++; return Boolean(id); };
    env.port.recordKnownResponse = (facts, response) => recordSavedResponse(spending, facts, response);
    const options = { profileDir: folder, models: env.models, execution: env.port, extension: recordingDeps(), resolveModel: async () => ({ provider: "proof", modelId: "D" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 30, backgroundTokens: 0 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, stream: { deferred: true } } };
    let service = await createBotSessionService(options); env.faux.setResponses([fauxAssistantMessage("this job must not be polled again")]); const sent = await service.send("bot:one", { requestId: "A", text: "one deferred inference" });
    for (let n = 0; n < 100 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, true); assert.equal(polls, 1); const original = (await spending.pendingDispatch({ kind: "bot", id: "bot:one" }))!; assert.ok(original);
    await service.shutdown(); service = await createBotSessionService(options); t.after(() => service.shutdown()); await service.initialize();
    const body = variant === "late-known-cost" ? {} : await reviewedCost(service, sent.submissionId);
    if (variant === "late-known-cost") { await spending.afterDispatch(original, { usage: { cost: { total: 0.25 } } }); assert.equal((await service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, false); }
    await service.resume("bot:one", "settle-terminal-deferred", body);
    const outcome = await service.awaitReply("bot:one", sent.submissionId, new AbortController().signal); assert.equal(outcome.kind, "failed"); if (outcome.kind === "failed") assert.equal(outcome.detail, errors[variant]);
    assert.equal((await service.routineState("bot:one")).kind, "idle"); assert.equal(polls, 1); assert.equal(env.faux.state.callCount, 1); assert.equal(env.faux.state.cancelledDeferred.length, 0); assert.equal(acknowledgements, variant === "late-known-cost" ? 0 : 1);
    const receipt = (await spending.dispatchReceipt(original.dispatchId))!; assert.equal(receipt.state, variant === "late-known-cost" ? "recorded" : "acknowledged_unknown"); assert.equal(receipt.costUsd, variant === "late-known-cost" ? 0.25 : undefined); assert.equal(Object.keys((await document.load()).dispatches!).length, 1); assert.equal((await spending.status("bot", "bot:one"))?.spentUsd, variant === "late-known-cost" ? 0.25 : 0);
    assert.equal(await isBotExecutionDispatchSettled(spending, { ...original, owner: { kind: "bot", id: "another-bot" } }), false);
    await service.shutdown(); service = await createBotSessionService(options); await service.initialize(); assert.equal((await service.resume("bot:one", "settle-terminal-deferred", body)).kind, "idle"); await service.resume("bot:one", "ordinary-after-terminal"); assert.equal(polls, 1); assert.equal(env.faux.state.callCount, 1);
  });
});

test("a never-submitted old cost dialog cannot acknowledge a newer receipt on the same source after restart", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-exact-cost-cas-")); t.after(() => rm(folder, { recursive: true, force: true }));
  let env = await openConsentBoundaryFixture(folder, { multiCall: { failSlot: 1 } });
  const conversation = await env.service.conversation("bot:one"); for (let n = 0; n < 4; n++) await conversation.submit({ type: "write", entry: { kind: "proof.seed", model: [{ role: "user", content: "history ".repeat(250), timestamp: n }] } }, ctx);
  const sent = await env.service.send("bot:one", { requestId: "person", text: "compact then answer" }); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  const viewedA = await reviewedCost(env.service, sent.submissionId), receiptA = (await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" }))!; await env.service.shutdown();
  env = await openConsentBoundaryFixture(folder, { multiCall: { failSlot: 2 } }); await env.service.initialize(); assert.deepEqual(await reviewedCost(env.service, sent.submissionId), viewedA, "an unchanged receipt is stable across restart");
  await env.service.resume("bot:one", "device-two-reviewed-A", viewedA); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  const viewedB = await reviewedCost(env.service, sent.submissionId), receiptB = (await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" }))!;
  assert.equal(viewedA.expectedSubmissionId, viewedB.expectedSubmissionId); assert.notEqual(viewedA.expectedCostReceiptId, viewedB.expectedCostReceiptId); assert.notEqual(receiptA.dispatchId, receiptB.dispatchId); await env.service.shutdown();
  env = await openConsentBoundaryFixture(folder, { multiCall: {} }); t.after(() => env.service.shutdown()); await env.service.initialize(); assert.deepEqual(await reviewedCost(env.service), viewedB);
  let acknowledgements = 0; const acknowledge = env.execution.acknowledgeUnknown!; env.execution.acknowledgeUnknown = async (...args) => { acknowledgements++; return acknowledge(...args); };
  await assert.rejects(env.service.resume("bot:one", "device-one-never-submitted-dialog-A", viewedA), /cost changed/u);
  assert.equal(acknowledgements, 0); assert.equal((await env.spending.dispatchReceipt(receiptB.dispatchId))?.state, "pending"); assert.deepEqual(await env.effects.load(), ["compaction slot 0", "compaction slot 1"]);
  assert.equal((await env.service.resume("bot:one", "device-one-never-submitted-dialog-A", viewedA)).kind, "interrupted", "an exact consumed replay positively settles the old control without effects");
  await assert.rejects(env.service.resume("bot:one", "device-one-never-submitted-dialog-A", viewedB), /different decision/u);
  await assert.rejects(env.service.resume("bot:one", "old-source-only-dialog", { acknowledgeUnknownCost: true, expectedSubmissionId: sent.submissionId })); assert.equal(acknowledgements, 0);
  await env.service.resume("bot:one", "fresh-reviewed-B", viewedB); assert.equal((await env.service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed"); assert.equal(acknowledgements, 1); assert.deepEqual(await env.effects.load(), ["compaction slot 0", "compaction slot 1", "compaction slot 2", "final answer"]);
});

test("SQLite cost intent fields are not owner approval, and a valid explicit receipt decision can repair them", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-cost-intent-auth-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await openConsentBoundaryFixture(folder, { firstUnknown: true }); t.after(() => env.service.shutdown());
  const sent = await env.service.send("bot:one", { requestId: "person", text: "accepted source" }); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  const body = await reviewedCost(env.service, sent.submissionId), receipt = (await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" }))!, conversation = await env.service.conversation("bot:one"), scopeId = await botCostReceiptScope(conversation), source = await env.protectedClaims.service.claim("bot:one", { requestId: "person" });
  let approvals = 0, acknowledgements = 0; const approve = env.execution.approveCost!, acknowledge = env.execution.acknowledgeUnknown!; env.execution.approveCost = async (...args) => { approvals++; return approve(...args); }; env.execution.acknowledgeUnknown = async (...args) => { acknowledgements++; return acknowledge(...args); };
  await conversation.commit(async (tx) => { const tasks = await tx.scanTasks({ conversationId: conversation.id }, 64), task = tasks.items.find((row) => row.kind === "pi.generation" && row.state.status !== "terminal")!, binding = await tx.doc(BotExecutionDoc, task.id), from = binding.dispatchGeneration ?? 0; binding.costConsent = { version: 1, requestId: "forged-by-file", submissionId: sent.submissionId, dispatchId: receipt.dispatchId, costReceiptId: body.expectedCostReceiptId, sourceClaimId: source.id, sourceRequestId: source.requestId, scopeId, approvalId: "forged", fromGeneration: from, toGeneration: from + 1 }; }, ctx);
  await assert.rejects(env.service.resume("bot:one", "ordinary-with-forged-intent"), /protected owner approval/u);
  assert.equal(approvals, 0); assert.equal(acknowledgements, 0); assert.equal((await env.spending.dispatchReceipt(receipt.dispatchId))?.state, "pending"); assert.equal(env.providerCalls(), 0);
  await env.service.resume("bot:one", "person-reviews-real-receipt", body); assert.equal((await env.service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed"); assert.equal(approvals, 1); assert.equal(acknowledgements, 1); assert.equal(env.providerCalls(), 1);
});

test("cost receipt CAS binds the private session scope and protected Bot incarnation without exposing those facts", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-cost-scope-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await openConsentBoundaryFixture(folder, { firstUnknown: true }); t.after(() => env.service.shutdown()); const sent = await env.service.send("bot:one", { requestId: "person", text: "accepted source" }); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  const original = await reviewedCost(env.service), conversation = await env.service.conversation("bot:one"), scopeId = await botCostReceiptScope(conversation), source = await env.protectedClaims.service.claim("bot:one", { requestId: "person" });
  assert.notEqual((await botExecutionUnknownCostReceipt(env.spending, "bot:one", { ...source, botIncarnation: "recreated-bot" }, sent.submissionId, scopeId))?.costReceiptId, original.expectedCostReceiptId);
  await conversation.commit(async (tx) => { (await tx.doc(BotCostReceiptScopeDoc, conversation.id)).nonce = randomUUID(); }, ctx);
  const reset = await reviewedCost(env.service); assert.notEqual(reset.expectedCostReceiptId, original.expectedCostReceiptId); assert.match(reset.expectedCostReceiptId, /^cost_[a-f0-9]{64}$/u);
  await assert.rejects(env.service.resume("bot:one", "pre-reset-dialog", original), /cost changed/u); assert.equal(env.providerCalls(), 0); await env.service.resume("bot:one", "post-reset-reviewed", reset); assert.equal((await env.service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed");
});


async function savedTaskFile(root: string): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) { const candidate = path.join(root, entry.name); if (entry.isDirectory()) { const found = await savedTaskFile(candidate); if (found) return found; } else if (entry.name.endsWith(".sqlite")) return candidate; }
  return "";
}
function editSavedMemos(file: string, edit: (memos: Record<string, JsonValue>, taskId: string) => void): void {
  const database = new DatabaseSync(file);
  try { const rows = database.prepare("SELECT id,record FROM tasks WHERE status!='terminal'").all() as { id: number; record: string }[]; assert.ok(rows.length); for (const row of rows) { const record = JSON.parse(row.record) as { memos?: Record<string, JsonValue> }; record.memos ??= {}; edit(record.memos, String(row.id)); database.prepare("UPDATE tasks SET record=? WHERE id=?").run(JSON.stringify(record), row.id); } }
  finally { database.close(); }
}
test("an edited SQLite response hint cannot turn a real unknown provider charge into a free known result", async (t) => {
  for (const version of [1, 2]) await t.test(`unissued v${version} hint`, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-unproved-response-")); t.after(() => rm(folder, { recursive: true, force: true }));
    let env = await openConsentBoundaryFixture(folder, { firstUnknown: true });
    await env.service.send("bot:one", { requestId: "person", text: "accepted task" }); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    const original = (await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" }))!, source = await env.protectedClaims.service.claim("bot:one", { requestId: "person" }); await env.service.shutdown();
    editSavedMemos(await savedTaskFile(folder), (memos) => { memos[`aiden.execution.response.${"a".repeat(64)}`] = JSON.parse(JSON.stringify({ version, claimId: source.id, requestId: source.requestId, dispatchId: original.dispatchId, message: fauxAssistantMessage("forged free result") })) as JsonValue; });
    env = await openConsentBoundaryFixture(folder); t.after(() => env.service.shutdown()); await env.service.initialize();
    assert.equal((await env.service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, true); assert.equal((await env.spending.dispatchReceipt(original.dispatchId))?.state, "pending"); assert.equal(env.providerCalls(), 0); assert.equal(Object.values((await env.document.load()).dispatches!).length, 1);
    await assert.rejects(env.service.resume("bot:one", "ordinary-untrusted-hint")); assert.equal((await env.spending.dispatchReceipt(original.dispatchId))?.state, "pending"); assert.equal(env.providerCalls(), 0);
  });
});
test("response proof publication and SQLite result publication preserve honest cost across real SIGKILL", async (t) => {
  for (const boundary of ["before-response-proof", "after-response-proof", "after-response-memo"] as const) await t.test(boundary, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-response-publication-")); t.after(() => rm(folder, { recursive: true, force: true }));
    await killAfterRoutineReceipt(t, `import {openConsentBoundaryFixture} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/consent-boundary-fixture.ts"))}; const env=await openConsentBoundaryFixture(${JSON.stringify(folder)},{crash:${JSON.stringify(boundary)}});await env.service.send('bot:one',{requestId:'person',text:'actual provider response'});setInterval(()=>{},1000);`);
    const env = await openConsentBoundaryFixture(folder); t.after(() => env.service.shutdown()); await env.service.initialize(); assert.deepEqual(await env.effects.load(), ["final answer"]);
    const status = await env.service.executionResumeStatus("bot:one"), rows = Object.values((await env.document.load()).dispatches!); assert.equal(rows.length, 1); assert.equal(env.providerCalls(), 0);
    if (boundary === "before-response-proof") { assert.equal(status.requiresUnknownCostAcknowledgement, true); assert.equal(rows[0]!.state, "pending"); await assert.rejects(env.service.resume("bot:one", "no-automatic-consent")); assert.equal(env.providerCalls(), 0); }
    else {
      assert.equal(status.requiresUnknownCostAcknowledgement, false); assert.equal(rows[0]!.state, "recorded"); assert.equal(rows[0]!.costUsd, 0.2);
      await env.service.resume("bot:one", "reuse-actual-sealed-response");
      for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== (boundary === "after-response-memo" ? "idle" : "interrupted"); n++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await env.service.routineState("bot:one")).kind, boundary === "after-response-memo" ? "idle" : "interrupted"); assert.equal(env.providerCalls(), 0, "neither saved-body reuse nor a missing body may repeat the old provider effect"); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.2); assert.equal(Object.values((await env.document.load()).dispatches!).length, 1);
      if (boundary === "after-response-proof") {
        assert.deepEqual(await env.effects.load(), ["final answer"]); await env.service.dismiss("bot:one", "dismiss-missing-known-answer");
        const fresh = await env.service.send("bot:one", { requestId: "fresh-owner-request", text: "send a new task after reviewing the unavailable saved answer" }); assert.equal((await env.service.awaitReply("bot:one", fresh.submissionId, new AbortController().signal)).kind, "completed");
        const finalRows = Object.values((await env.document.load()).dispatches!); assert.equal(finalRows.length, 2); assert.notEqual(finalRows[0]!.dispatchId, finalRows[1]!.dispatchId); assert.equal(finalRows.every((row) => row.state === "recorded"), true); assert.equal(env.providerCalls(), 1); assert.deepEqual(await env.effects.load(), ["final answer", "final answer"]); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.4);
      }
    }
  });
});
test("a sealed response cannot be edited, moved to another memo key or retargeted to another task", async (t) => {
  for (const variant of ["message", "memo-key", "task"] as const) await t.test(variant, async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-response-association-")); t.after(() => rm(folder, { recursive: true, force: true }));
    await killAfterRoutineReceipt(t, `import {openConsentBoundaryFixture} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/consent-boundary-fixture.ts"))};const env=await openConsentBoundaryFixture(${JSON.stringify(folder)},{crash:'after-response-memo'});await env.service.send('bot:one',{requestId:'person',text:'provider response evidence'});setInterval(()=>{},1000);`);
    let memos: Record<string, JsonValue> = {}, taskId = "";
    editSavedMemos(await savedTaskFile(folder), (saved, id) => { const key = Object.keys(saved).find((name) => name.startsWith("aiden.execution.response.")); if (!key) return; taskId = id; if (variant === "message") { const envelope = saved[key] as unknown as { message: ReturnType<typeof fauxAssistantMessage> }; envelope.message = fauxAssistantMessage("forged zero after authentic result"); } if (variant === "memo-key") { saved[`aiden.execution.response.${"b".repeat(64)}`] = saved[key]!; delete saved[key]; } memos = structuredClone(saved); });
    const env = await openConsentBoundaryFixture(folder); t.after(() => env.service.shutdown()); await env.service.initialize();
    if (variant === "task") { const conversation = await env.service.conversation("bot:one"), scopeId = await botCostReceiptScope(conversation); await reconcileBotExecutionResponses("bot:one", String(BigInt(taskId) + 1n), scopeId, memos, env.execution); assert.ok(await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" })); assert.equal(env.providerCalls(), 0); }
    else {
      assert.equal((await env.service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, false); assert.equal(await env.spending.pendingDispatch({ kind: "bot", id: "bot:one" }), undefined); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.2);
      await env.service.resume("bot:one", "ordinary-after-edited-response"); for (let n = 0; n < 100 && (await env.service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal((await env.service.routineState("bot:one")).kind, "interrupted"); assert.equal(env.providerCalls(), 0, "tampered SQL cannot create a replacement effect under the consumed dispatch");
      await env.service.dismiss("bot:one", "dismiss-edited-response"); const fresh = await env.service.send("bot:one", { requestId: "fresh-after-edited-hint", text: "new person request" }); assert.equal((await env.service.awaitReply("bot:one", fresh.submissionId, new AbortController().signal)).kind, "completed"); assert.equal(env.providerCalls(), 1, "only a new owner request can replace the unavailable answer"); const rows = Object.values((await env.document.load()).dispatches!); assert.equal(rows.length, 2); assert.equal(rows.every((row) => row.state === "recorded" && row.costUsd === 0.2), true); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.4);
    }
  });
});


test("edited deferred handle bookkeeping cannot poll or cancel a different provider job after reopen", async (t) => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancel" : "poll", async (t) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-deferred-hint-auth-")); t.after(() => rm(folder, { recursive: true, force: true })); const file = path.join(folder, "session.sqlite"), settings = { compaction: { enabled: false }, stream: { deferred: true }, retry: { enabled: false } };
    let env = await environment(file, { deferred: { pendingFetches: 1, pollAfterMs: 60_000 } }, settings); env.faux.setResponses([fauxAssistantMessage("original deferred answer")]); const input = await env.submit("A");
    for (let n = 0; n < 100 && !(await env.harness.inspect(ctx)).tasks.some(({ record }) => record.kind === "pi.generation" && record.state.status === "sleeping"); n++) await new Promise((resolve) => setTimeout(resolve, 5)); await env.harness.close(ctx);
    const database = new DatabaseSync(file); try { const row = database.prepare("SELECT id,record FROM tasks WHERE status!='terminal'").get() as { id: number; record: string }, record = JSON.parse(row.record) as { state: { status: string; until?: number; checkpoint: { handle?: Record<string, unknown>; pollAt?: number } }; memos: Record<string, { message?: { deferred?: Record<string, unknown> } }> }; assert.ok(record.state.checkpoint.handle); const forged = { ...record.state.checkpoint.handle, id: "another-account-job" }; record.state.checkpoint.handle = forged; record.state.checkpoint.pollAt = Date.now() - 1; record.state.until = Date.now() - 1; for (const receipt of Object.values(record.memos)) if (receipt?.message?.deferred) receipt.message.deferred = forged; database.prepare("UPDATE tasks SET record=? WHERE id=?").run(JSON.stringify(record), row.id); } finally { database.close(); }
    env = await environment(file, { deferred: { pendingFetches: 1, pollAfterMs: 1 } }, settings); t.after(() => env.harness.close(ctx)); const active = (await env.harness.inspect(ctx)).tasks.find(({ record }) => record.kind === "pi.generation")!;
    if (cancel) await env.harness.abortTask(active.record.id, ctx); else env.harness.resume(); const result = await (await env.harness.submission(input.id, ctx))!.wait(ctx); assert.notEqual(result.status, "done"); assert.equal(env.faux.state.deferredFetchCount, 0); assert.equal(env.faux.state.cancelledDeferred.length, 0); assert.equal(env.calls.length, 0); assert.equal(env.charges.length, 0);
  });
});

test("an authentic deferred amount saved after cost acknowledgement survives SIGKILL, revoked credentials and Dismiss", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-acknowledged-known-recovery-")); t.after(() => rm(folder, { recursive: true, force: true }));
  await killAfterRoutineReceipt(t, `
    import assert from 'node:assert/strict';
    import {writeFile} from 'node:fs/promises';
    import {createModels,fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
    import {openConsentBoundaryFixture} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/consent-boundary-fixture.ts"))};
    import {recordingDeps} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/test-support/fixtures.ts"))};
    import {createBotSessionService} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/bot-session-service.ts"))};
    import {botExecutionSpendingOwner} from ${JSON.stringify(claimTestModule("main/services/bot-runtime/bot-execution-spending.ts"))};
    import {SpendingDispatchError} from ${JSON.stringify(claimTestModule("main/services/spending-service.ts"))};
    const env=await openConsentBoundaryFixture(${JSON.stringify(folder)});await env.service.shutdown();
    const models=createModels(),faux=fauxProvider({provider:'fixture',models:[{id:'A'}],deferred:{pendingFetches:0,pollAfterMs:1}});models.setProvider(faux.provider);faux.setResponses([fauxAssistantMessage('authentic deferred answer')]);
    let polls=0;
    env.execution.resolve=async(_botId,claim)=>{const model=models.getModel('fixture','A'),dispatch=id=>({dispatchId:id,owner:botExecutionSpendingOwner(claim),providerId:'fixture',modelId:'A',counts:true});
      const transport=new Proxy(models,{get(target,key){if(key==='fetchDeferred')return async(...args)=>{if(++polls===1)throw new SpendingDispatchError('uncertain','The first poll ended before reporting cost.');const response=await target.fetchDeferred(...args);return {...response,usage:{...response.usage,cost:{...response.usage.cost,total:0.25}}};};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
      return {model,models:transport,imageInput:false,revalidate:async()=>{},release(){},beforeDispatch:async id=>{await env.spending.beforeDispatch(dispatch(id));},reserveResponse:slot=>env.protectedClaims.service.reserveResponseEvidence(slot,dispatch(slot.dispatchId)),sealResponse:facts=>env.protectedClaims.service.recordResponseEvidence(facts,dispatch(facts.dispatchId)),afterDispatch:async()=>{await writeFile(${JSON.stringify(path.join(folder, "observed-provider-effects.json"))},JSON.stringify({streams:faux.state.callCount,polls}));process.stdout.write('OWNERSHIP_SAVED\\n');await new Promise(()=>{});}};
    };
    const service=await createBotSessionService({profileDir:${JSON.stringify(folder)},models,execution:env.execution,extension:recordingDeps(),resolveModel:async()=>({provider:'fixture',modelId:'A'}),knownBotIds:async()=>new Set(['bot:one']),settings:{compaction:{enabled:false},stream:{deferred:true},retry:{enabled:false}}});
    const sent=await service.send('bot:one',{requestId:'person',text:'accepted deferred work'});while((await service.routineState('bot:one')).kind!=='interrupted')await new Promise(resolve=>setTimeout(resolve,5));
    const status=await service.executionResumeStatus('bot:one');assert.equal(status.requiresUnknownCostAcknowledgement,true);await service.resume('bot:one','reviewed-original-dispatch',{acknowledgeUnknownCost:true,expectedSubmissionId:sent.submissionId,expectedCostReceiptId:status.costReceiptId});setInterval(()=>{},1000);
  `);
  const env = await openConsentBoundaryFixture(folder); t.after(() => env.service.shutdown()); env.execution.resolve = async () => { throw new Error("Original model credentials revoked"); }; await env.service.initialize();
  const before = Object.values((await env.document.load()).dispatches!); assert.equal(before.length, 1); assert.equal(before[0]!.state, "acknowledged_unknown"); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0);
  assert.equal((await env.service.executionResumeStatus("bot:one")).requiresUnknownCostAcknowledgement, false); assert.equal((await env.spending.dispatchReceipt(before[0]!.dispatchId))?.state, "recorded"); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.25);
  await env.service.executionResumeStatus("bot:one"); await env.service.dismiss("bot:one", "dismiss-after-revocation");
  const after = Object.values((await env.document.load()).dispatches!); assert.equal(after.length, 1); assert.equal(after[0]!.costUsd, 0.25); assert.equal((await env.spending.status("bot", "bot:one"))?.spentUsd, 0.25); assert.equal(env.providerCalls(), 0); assert.deepEqual(JSON.parse(await readFile(path.join(folder, "observed-provider-effects.json"), "utf8")), { streams: 1, polls: 2 });
});

test("known-response recovery cannot retarget an acknowledged dispatch, owner or response amount", async () => {
  let document = emptySpendingDocument();
  const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 1 }), broadcast() {} });
  const dispatch = { dispatchId: "acknowledged-original", owner: { kind: "bot" as const, id: "bot:one" }, providerId: "proof", modelId: "A", counts: true };
  await spending.beforeDispatch(dispatch); await acknowledgeBotExecutionUnknown(spending, "bot:one", claim("A", "high"), dispatch.dispatchId);
  const response = fauxAssistantMessage("observed known amount"); response.usage = { ...response.usage, cost: { ...response.usage.cost, total: 0.25 } }; const digest = createHash("sha256").update(JSON.stringify(response)).digest("hex");
  for (const evidence of [{ ...dispatch, dispatchId: "another-dispatch" }, { ...dispatch, owner: { kind: "bot" as const, id: "bot:other" } }, { ...dispatch, providerId: "another-provider" }, { ...dispatch, modelId: "B" }, { ...dispatch, counts: false }, { ...dispatch, owner: { ...dispatch.owner, budgetScopes: [{ kind: "bot" as const, id: "another-root" }] } }]) await assert.rejects(recordKnownBotExecutionResponse(spending, "bot:one", dispatch.dispatchId, response, evidence, digest));
  await assert.rejects(recordKnownBotExecutionResponse(spending, "bot:other", dispatch.dispatchId, response, dispatch, digest)); const edited = { ...response, usage: { ...response.usage, cost: { ...response.usage.cost, total: 0 } } }; await assert.rejects(recordKnownBotExecutionResponse(spending, "bot:one", dispatch.dispatchId, edited, dispatch, digest));
  assert.equal((await spending.dispatchReceipt(dispatch.dispatchId))?.state, "acknowledged_unknown"); assert.equal((await spending.status("bot", "bot:one"))?.spentUsd, 0);
  await recordKnownBotExecutionResponse(spending, "bot:one", dispatch.dispatchId, response, dispatch, digest); await recordKnownBotExecutionResponse(spending, "bot:one", dispatch.dispatchId, response, dispatch, digest);
  assert.equal((await spending.dispatchReceipt(dispatch.dispatchId))?.state, "recorded"); assert.equal((await spending.status("bot", "bot:one"))?.spentUsd, 0.25); assert.equal(Object.keys(document.dispatches!).length, 1);
});

test("Mail source reads remain model-free with a missing Bot default, then queued changed work uses its frozen routine model",{timeout:10000},async t=>{
  const {createModelFreeMailFixture}=await import("../bot-routine-events/imcp-mail-test-support.js"),{readImcpWatch,compareImcpWatch}=await import("../bot-routine-events/connector-watch-imcp.js");
  const folder=await mkdtemp(path.join(os.tmpdir(),"aiden-mail-explicit-model-"));t.after(()=>rm(folder,{recursive:true,force:true}));
  const source=await createModelFreeMailFixture(path.join(folder,"source")),signal=new AbortController().signal;
  const [binding]=await source.host.discover(source.botId,source.serverId,signal,async()=>{});assert.ok(binding);
  const env=await environment(path.join(folder,"unused.sqlite"));await env.harness.close(ctx);let defaultResolutions=0;
  const service=await createBotSessionService({profileDir:folder,models:env.models,execution:env.port,extension:recordingDeps(),resolveModel:async()=>{defaultResolutions++;throw new Error("Bot default unavailable");},knownBotIds:async()=>new Set(["bot:one"]),settings:{compaction:{enabled:false}}});t.after(()=>service.shutdown());
  const read=()=>source.host.withPort("bot:one",binding!,signal,port=>readImcpWatch({kind:"email",account:binding!.account,mailbox:binding!.mailbox,unreadOnly:false},port,Date.parse("2026-11-03T15:00:00Z"),signal));
  const baseline=await read();source.setMessages(["new-message"]);const items=await read();assert.equal(compareImcpWatch("email",{kind:"email",items:baseline},items,Date.parse("2026-11-03T15:00:00Z")).changes.length,1);
  assert.equal(defaultResolutions,0);assert.equal(env.calls.length,0,"finding a Mail change does not query or dispatch a model");
  const restriction={routineId:"watch-one",revision:1,binding:binding!},bound=await env.port.getClaim("bot:one","B","B");bound.connectorRestriction=restriction;bound.connectorServerId=binding!.serverId;
  const barrier=gate();let entered=false;t.after(()=>barrier.release());env.faux.setResponses([async()=>{entered=true;await barrier.promise;return fauxAssistantMessage("Earlier explicit routine A");},fauxAssistantMessage("Selected routine B response")]);
  const a=await service.send("bot:one",{requestId:"A",text:"Earlier routine",routineOrigin:issueBotRoutineInputOrigin({version:1,botId:"bot:one",routineId:"another-routine",runId:"A",kind:"scheduled"})});await waitFor(()=>entered);
  const b=await withBotConnectorExecutionRestriction(restriction,()=>service.send("bot:one",{requestId:"B",text:"A new Mail message arrived",routineOrigin:issueBotRoutineInputOrigin({version:1,botId:"bot:one",routineId:"watch-one",runId:"B",kind:"event"})}));assert.deepEqual(env.calls.map(row=>row.model),["A"]);
  barrier.release();await service.awaitReply("bot:one",a.submissionId,signal);assert.equal((await service.awaitReply("bot:one",b.submissionId,signal)).kind,"completed");assert.deepEqual(env.calls.map(row=>row.model),["A","B"]);assert.equal(defaultResolutions,0);
});

test("Bot-message input keeps host provenance, deadline and approval ownership under immutable execution models", async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiden-message-execution-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = await environment(path.join(folder, "unused.sqlite"), {}, { compaction: { enabled: false } });
  await env.harness.close(ctx);
  const deliveryId = "00112233-4455-4677-8899-aabbccddeeff";
  const requestId = `bot:sender:1:${deliveryId}`;
  const saved = { ...claim("D", "off"), requestId, root: { botId: "bot:one", requestId } };
  env.port.claim = async () => saved;
  env.port.getClaim = async (_bot, id, request) => {
    assert.equal(id, saved.id); assert.equal(request, requestId); return saved;
  };
  const mutate = countingTool("mutate");
  const extension = recordingDeps({ tools: [{ tool: mutate, replay: "unsafe" }], policy: () => ({ allowed: true, approval: { summary: "Change a document" } }) });
  const service = await createBotSessionService({ profileDir: folder, models: env.models, execution: env.port, extension,
    resolveModel: async () => { throw new Error("The unrelated default must not be resolved"); }, knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: { enabled: false } } });
  t.after(() => service.shutdown());
  env.faux.setResponses([fauxAssistantMessage([fauxToolCall("mutate", { text: "allowed" })], { stopReason: "toolUse" }), fauxAssistantMessage("Bot reply")]);
  const metadata = { kind: "request" as const, deliveryId, botId: "sender", botName: "Sender", text: "A clean question", deadline: Date.now() + 60_000 };
  const sent = await service.send("bot:one", { requestId, text: "<bot_message>private host framing</bot_message>", botMessage: metadata, ifIdle: true });
  assert.equal((await service.awaitReply("bot:one", sent.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(mutate.executions.length, 1);
  assert.equal(extension.approvals.length, 1);
  assert.deepEqual(extension.approvals[0]!.owner?.inputs[0]?.botMessage, metadata);
  const conversation = await service.conversation("bot:one"), entries = (await conversation.context(ctx)).entries;
  const input = entries.find(entry => entry.model?.[0]?.role === "user");
  assert.equal(input?.kind, "aiden.bot-message-input");
  assert.equal((input?.data as Record<string, unknown>)?.executionClaimId, saved.id);
  const { projectBotTranscript } = await import("./live-projection.js");
  const projected = projectBotTranscript(entries);
  assert.deepEqual(projected.find(entry => entry.type === "bot_message"), { id: String(input!.id), type: "bot_message", kind: "request", botId: "sender", botName: "Sender", text: "A clean question", at: input!.model![0]!.timestamp });
  assert.equal(projected.some(entry => entry.type === "user"), false);
  const { provenanceOfHistory } = await import("../bot-memory/review.js");
  const owners = await provenanceOfHistory(entries, ids => conversation.commit(tx => Promise.all(ids.map(id => tx.submissionByRequest(conversation.id, id))), ctx));
  assert.ok(entries.filter(entry => entry.model?.[0]?.role === "user" || entry.kind === "pi.assistant").every(entry => owners.get(entry.id) === "unattended"));
  assert.deepEqual(env.calls.map(call => call.model), ["D", "D"]);
});
