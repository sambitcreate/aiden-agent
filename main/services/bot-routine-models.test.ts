import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createBotRoutineModelService, inspectBotRoutineModelGrant, type BotProviderResponseFacts, type BotCostApprovalFacts, type BotRoutineModelLifetime } from "./bot-routine-models.js";
import { buildBotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import { bindBotCustomSelection, bindBotProviderModel, createBotCapabilityOpaqueIdMint } from "./bot-capability-bindings.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import { createBotCapabilityOpaqueKeyStore } from "./bot-capability-key-store.js";
import { createBotCapabilityStateCheckpoint, type BotCapabilityBootstrapMarkerState } from "./bot-capability-state-checkpoint.js";
import { createBotSessionService } from "./bot-runtime/bot-session-service.js";
import { recordingDeps } from "./bot-runtime/test-support/fixtures.js";
import { botExecutionSpendingOwner } from "./bot-runtime/bot-execution-spending.js";
import { parseBotRoutineModelCatalog, parseBotRoutineModelResult, parseBotRoutineModelRuns } from "../../renderer/shared/bot-routine-models.js";
const fp = (text: string) => createHash("sha256").update(text).digest("hex");
const lifetime = (): BotRoutineModelLifetime => ({ signal: new AbortController().signal, assertCurrent() {} });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-routine-models-")); t.after(() => rm(root, { recursive: true, force: true }));
  let anchor: string | null = null, marker: BotCapabilityBootstrapMarkerState | null = null;
  const open = async () => {
    const store = createBotCapabilityStore({ root: () => root, checkpoint: createBotCapabilityStateCheckpoint({ root: () => root, keyStore: createBotCapabilityOpaqueKeyStore({ root: () => root }), anchor: { load: async () => anchor, store: async (value, expected) => { assert.equal(anchor, expected); anchor = value; } }, bootstrapMarker: { load: async () => marker, store: async (value, expected) => { assert.deepEqual(marker, expected); marker = value; } }, inspectInitialBootstrap: async () => "clean" as const }) }); await store.initialize(); return store;
  };
  const store = await open(); let connection = "one", defaultAvailable = true, botIncarnation = "bot-one", routineIncarnation = "routine-one", defaultCalls = 0, now = 1_000, failAfterPublish = false;
  const models = createModels(), faux = fauxProvider({ provider: "proof", models: [{ id: "A", reasoning: true }, { id: "D", reasoning: false }] }); models.setProvider(faux.provider);
  const snapshot = () => buildBotCapabilityCatalogSnapshot({ inventory: { providers: [{ sourceId: "proof", label: "Proof", available: true, connectionFingerprint: fp(connection), models: [ { sourceId: "A", label: "Specialist A", available: true, modelFingerprint: fp("A") }, { sourceId: "D", label: "Default D", available: defaultAvailable, modelFingerprint: fp("D") } ] }], fileScopes: [{ sourceId: "full", label: "Full Mac", available: false, kind: "full_mac", scopeFingerprint: fp("full") }, { sourceId: "home", label: "Bot folder", available: false, kind: "bot_home", scopeFingerprint: fp("home") }], shell: { available: false, shellFingerprint: fp("shell") }, connections: [], skills: [], otherCapabilities: [] }, notice: { version: "bot-full-access-v1", requiresAcknowledgement: true }, mintOpaqueId: createBotCapabilityOpaqueIdMint(Buffer.alloc(32, 7)) });
  const initial = snapshot(), provider = initial.catalog.providers[0]!, a = provider.models.find((row) => row.label === "Specialist A")!, d = provider.models.find((row) => row.label === "Default D")!;
  const custom = { providerId: provider.id, modelId: d.id, fileScopeIds: [], connectionIds: [], skillIds: [], otherCapabilityIds: [], shellEnabled: false };
  await store.acknowledgeNotice("desktop", { version: "bot-full-access-v1", decision: "customize_first", confirmedForeground: true });
  await store.createBotPolicy({ botId: "bot:one", catalog: initial.catalog, access: { accessMode: "custom", catalogRevision: initial.catalog.revision, custom }, binding: bindBotCustomSelection({ selection: custom, catalogRevision: initial.catalog.revision, snapshot: initial }) });
  const service = createBotRoutineModelService({ persistence: { read: () => store.getRoutineModelsState(), write: async (...args) => { await store.saveRoutineModelsState(...args); if (failAfterPublish) { failAfterPublish = false; throw new Error("lost response after protected publication"); } } }, identity: async (botId, routineId) => { if (botId !== "bot:one" || routineId && routineId !== "routine:one") throw new Error("Unknown owner"); return { botIncarnation, ...(routineId ? { routineIncarnation } : {}) }; }, snapshot: async () => snapshot(), metadata: async (_provider, id) => models.getModel("proof", id)!, defaultChoice: async () => { defaultCalls++; if (!defaultAvailable) throw new Error("default unavailable"); return { binding: bindBotProviderModel({ providerId: provider.id, modelId: d.id, catalogRevision: snapshot().catalog.revision, snapshot: snapshot() }), thinkingLevel: "off" }; }, now: () => now });
  const saveA = async () => service.save({ botId: "bot:one", routineId: "routine:one", mutationId: randomUUID(), expectedRevision: (await service.read("bot:one", "routine:one")).revision, catalogRevision: (await service.catalog("bot:one", "routine:one")).revision, selection: { mode: "selected", primary: { providerId: provider.id, modelId: a.id, thinkingLevel: "high" } } }, lifetime());
  return { root, store, open, service, snapshot, saveA, provider, a, d, models, faux, get defaultCalls() { return defaultCalls; }, unavailableDefault() { defaultAvailable = false; }, rotate() { connection = "two"; }, recreate() { routineIncarnation = "routine-two"; }, recreateBot() { botIncarnation = "bot-two"; }, tick() { now++; }, loseResponse() { failAfterPublish = true; } };
}
test("explicit routine grant admits its model while Custom default stays unavailable and unchanged; forged/cross-owner/recreated grants fail", async (t) => {
  const f = await fixture(t); assert.equal((await f.saveA()).ok, true); f.unavailableDefault();
  const claim = await f.service.claim("bot:one", { requestId: "routine:one:fire", routineOrigin: { version: 1, botId: "bot:one", routineId: "routine:one", runId: "routine:one:fire", kind: "manual" } });
  assert.equal(f.defaultCalls, 0); const token = await f.service.grant("bot:one", claim.id, claim.requestId);
  const admitted = await f.store.admit({ audienceId: "desktop", botId: "bot:one", snapshot: f.snapshot(), routineModelGrant: token });
  assert.equal(admitted.modelAuthority?.binding.sourceModelId, "A"); assert.equal((await f.store.getBotBinding("bot:one"))?.provider.sourceModelId, "D"); admitted.lease.release();
  await assert.rejects(f.store.admit({ audienceId: "desktop", botId: "bot:one", snapshot: f.snapshot() }));
  assert.throws(() => inspectBotRoutineModelGrant({ ...token }), /not issued/u);
  await assert.rejects(f.store.admit({ audienceId: "desktop", botId: "bot:other", snapshot: f.snapshot(), routineModelGrant: token }));
  f.recreate(); await assert.rejects(f.service.grant("bot:one", claim.id, claim.requestId), /owner changed/u);
});
test("claimed choices survive future settings edits, receipt replay returns current settings, and unknown publication is positively identifiable", async (t) => {
  const f = await fixture(t); assert.equal((await f.saveA()).ok, true);
  const origin = { version: 1 as const, botId: "bot:one", routineId: "routine:one", runId: "routine:one:original", kind: "scheduled" as const };
  const original = await f.service.claim("bot:one", { requestId: origin.runId, routineOrigin: origin, scheduledFor: 500, timezone: "America/New_York" });
  const first = await f.service.read("bot:one", "routine:one"), command = { botId: "bot:one", routineId: "routine:one", mutationId: randomUUID(), expectedRevision: first.revision, catalogRevision: (await f.service.catalog("bot:one", "routine:one")).revision, selection: { mode: "inherit" as const } };
  f.loseResponse(); const unknown = await f.service.save(command, lifetime()); assert.equal(unknown.ok, false); if (!unknown.ok) assert.equal(unknown.code, "unavailable");
  assert.equal((await f.service.read("bot:one", "routine:one")).lastMutationId, command.mutationId);
  assert.equal((await f.service.claim("bot:one", { requestId: origin.runId, routineOrigin: { ...origin, kind: "catch_up" } })).primary.binding.sourceModelId, "A");
  const retry = await f.service.claim("bot:one", { requestId: "routine:one:retry", retryOf: origin.runId, routineOrigin: { ...origin, runId: "routine:one:retry", kind: "retry" } }); assert.equal(retry.primary.binding.sourceModelId, "A"); assert.deepEqual(retry.root, original.root);
  assert.equal((await f.service.save({ ...command, mutationId: randomUUID(), expectedRevision: (await f.service.read("bot:one", "routine:one")).revision, selection: { mode: "selected", primary: { providerId: f.provider.id, modelId: f.a.id, thinkingLevel: "high" }, fallback: { providerId: f.provider.id, modelId: f.d.id, thinkingLevel: "off" } } }, lifetime())).ok, true);
  const laterRetry = await f.service.claim("bot:one", { requestId: "routine:one:retry-later", retryOf: origin.runId, routineOrigin: { ...origin, runId: "routine:one:retry-later", kind: "retry" } }); assert.equal(laterRetry.fallback, undefined, "a retry cannot acquire a newly configured fallback");
  f.tick(); assert.equal((await f.saveA()).ok, true);
  const replay = parseBotRoutineModelResult(await f.service.save(command, lifetime())); assert.equal(replay.ok, true); if (replay.ok) { assert.equal(replay.replayed, true); assert.equal(replay.settings.selection.mode, "selected"); }
  const runs = parseBotRoutineModelRuns(await f.service.readRuns("bot:one", "routine:one")); assert.equal(runs.length, 3); assert.equal(runs.find((row) => row.runId === origin.runId)?.timezone, "America/New_York"); assert.equal(runs[0]!.model.chosenModelLabel, "Specialist A");
});
test("protected grant edits, rollback and lost storage cannot mint access or silently inherit the default", async (t) => {
  const f = await fixture(t), file = path.join(f.root, "bot-capabilities.json"), before = await readFile(file, "utf8");
  assert.equal((await f.saveA()).ok, true); const accepted = await readFile(file, "utf8"), altered = JSON.parse(accepted) as { routineModels: string };
  altered.routineModels = altered.routineModels.replace("Specialist A", "Forged grant"); await writeFile(file, JSON.stringify(altered)); await assert.rejects(f.open());
  await writeFile(file, before); await assert.rejects(f.open());
  await writeFile(file, accepted); const restored = await f.open(); assert.ok(await restored.getRoutineModelsState());
  await rm(file); await assert.rejects(f.open());
});
test("model-only catalog and credential drift preserve exact host-issued authority", async (t) => {
  const f = await fixture(t); const catalog = parseBotRoutineModelCatalog(await f.service.catalog("bot:one", "routine:one")); assert.deepEqual(catalog.providers[0]!.models.find((row) => row.id === f.a.id)?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
  assert.equal((await f.saveA()).ok, true); const claim = await f.service.claim("bot:one", { requestId: "routine:one:manual", routineOrigin: { version: 1, botId: "bot:one", routineId: "routine:one", runId: "routine:one:manual", kind: "manual" } });
  const grant = await f.service.grant("bot:one", claim.id, claim.requestId); f.rotate(); await assert.rejects(inspectBotRoutineModelGrant(grant).assertCurrent()); await assert.rejects(f.service.grant("bot:one", claim.id, claim.requestId));
});

test("cost approval authority is sealed against task/receipt retargeting, profile edits and Bot recreation", async (t) => {
  const f = await fixture(t); await f.saveA();
  const source = await f.service.claim("bot:one", { requestId: "person-source" }), owner = await f.service.claim("bot:one", { requestId: "routine:one:fire", routineOrigin: { version: 1, botId: "bot:one", routineId: "routine:one", runId: "routine:one:fire", kind: "manual" } });
  const facts: BotCostApprovalFacts = { version: 1, botId: "bot:one", sourceClaimId: source.id, sourceRequestId: source.requestId, ownerClaimId: owner.id, taskId: "12", scopeId: randomUUID(), requestId: randomUUID(), submissionId: "7", dispatchId: `aiden_bot_${fp("dispatch")}`, costReceiptId: `cost_${fp("cost")}`, fromGeneration: 0, toGeneration: 1 };
  const id = await f.service.approveCost(facts); assert.equal(await f.service.approveCost(facts), id); assert.equal(await f.service.verifyCostApproval(id, Object.fromEntries(Object.entries(facts).reverse()) as BotCostApprovalFacts), true);
  assert.equal(await f.service.verifyCostApproval(id, { ...facts, taskId: "13" }), false); assert.equal(await f.service.verifyCostApproval(id, { ...facts, dispatchId: `aiden_bot_${fp("new dispatch")}`, costReceiptId: `cost_${fp("new cost")}` }), false); assert.equal(await f.service.verifyCostApproval(id, { ...facts, submissionId: "8" }), false); assert.equal(await f.service.verifyCostApproval(id, { ...facts, botId: "bot:other" }), false);
  const file = path.join(f.root, "bot-capabilities.json"), saved = await readFile(file, "utf8"), forged = JSON.parse(saved) as { routineModels: string }, state = JSON.parse(forged.routineModels) as { costApprovals: { facts: BotCostApprovalFacts }[] };
  assert.equal(state.costApprovals.length, 1); state.costApprovals[0]!.facts.costReceiptId = `cost_${fp("attacker cost")}`; forged.routineModels = JSON.stringify(state); await writeFile(file, JSON.stringify(forged)); await assert.rejects(f.open());
  await writeFile(file, saved); await f.open(); assert.equal(await f.service.verifyCostApproval(id, facts), true); f.recreateBot(); await assert.rejects(f.service.verifyCostApproval(id, facts), /owner changed/u);
});


test("protected response evidence binds the observed envelope, memo, task, dispatch and Bot without requiring fresh model authority", async (t) => {
  const f = await fixture(t); const owner = await f.service.claim("bot:one", { requestId: "accepted-source" });
  const facts: BotProviderResponseFacts = { version: 1, botId: "bot:one", claimId: owner.id, requestId: owner.requestId, taskId: "12", scopeId: randomUUID(), memoKey: `aiden.execution.response.${fp("memo")}`, dispatchId: `aiden_bot_${fp("dispatch")}`, envelopeDigest: fp("actual provider result envelope"), responseDigest: fp("actual provider result") };
  const dispatch = { dispatchId: facts.dispatchId, owner: { kind: "bot" as const, id: "bot:one" }, providerId: "proof", modelId: "D", counts: true };
  const { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts;
  await f.service.reserveResponseEvidence(slot, dispatch); assert.equal(await f.service.responseEvidence(facts), undefined); await f.service.recordResponseEvidence(facts, dispatch); await f.service.recordResponseEvidence(facts, dispatch); assert.deepEqual(await f.service.responseEvidence(facts), dispatch);
  for (const changed of [{ taskId: "13" }, { memoKey: `aiden.execution.response.${fp("other memo")}` }, { envelopeDigest: fp("edited result") }, { responseDigest: fp("edited message") }, { claimId: "forged-claim" }, { botId: "bot:other" }]) assert.equal(await f.service.responseEvidence({ ...facts, ...changed }), undefined);
  await assert.rejects(f.service.recordResponseEvidence(facts, { ...dispatch, modelId: "A" }), /model/u); await assert.rejects(f.service.recordResponseEvidence(facts, { ...dispatch, owner: { kind: "bot", id: "bot:other" } }), /owner/u);
  const file = path.join(f.root, "bot-capabilities.json"), saved = await readFile(file, "utf8"), forged = JSON.parse(saved) as { routineModels: string }, state = JSON.parse(forged.routineModels) as { responseEvidence: { facts: BotProviderResponseFacts }[] };
  assert.equal(state.responseEvidence.length, 1); assert.equal(forged.routineModels.includes("actual provider result"), false); state.responseEvidence[0]!.facts.responseDigest = fp("forged zero cost result"); forged.routineModels = JSON.stringify(state); await writeFile(file, JSON.stringify(forged)); await assert.rejects(f.open()); await writeFile(file, saved); await f.open();
  f.rotate(); f.unavailableDefault(); assert.deepEqual(await f.service.responseEvidence(facts), dispatch, "a previously observed charge does not need new inference authority"); f.recreateBot(); await assert.rejects(f.service.responseEvidence(facts), /owner/u);
});


test("full protected response capacity refuses fresh streams and deferred polls before provider effects", async (t) => {
  for (const deferred of [false, true]) await t.test(deferred ? "deferred poll" : "fresh stream", async (t) => {
    const f = await fixture(t); let streams = 0, polls = 0;
    const fill = async () => { const previous = (await f.store.getRoutineModelsState())!, state = JSON.parse(previous) as { responseEvidence: { facts: BotProviderResponseFacts; observed: boolean }[] }; const template = state.responseEvidence[0]!; assert.ok(template); for (let index = state.responseEvidence.length; index < 4096; index++) state.responseEvidence.push({ ...structuredClone(template), observed: false, facts: { ...template.facts, memoKey: `aiden.execution.response.${fp(`reserved poll ${index}`)}`, envelopeDigest: "0".repeat(64), responseDigest: "0".repeat(64) } }); await f.store.saveRoutineModelsState(previous, JSON.stringify(state), async () => {}, () => true); };
    if (!deferred) { const owner = await f.service.claim("bot:one", { requestId: "seeded-existing-work" }), facts: BotProviderResponseFacts = { version: 1, botId: "bot:one", claimId: owner.id, requestId: owner.requestId, taskId: "12", scopeId: randomUUID(), memoKey: `aiden.execution.response.${fp("seed")}`, dispatchId: `aiden_bot_${fp("seed")}`, envelopeDigest: fp("existing evidence"), responseDigest: fp("existing response") }, { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts, dispatch = { dispatchId: facts.dispatchId, owner: { kind: "bot" as const, id: "bot:one" }, providerId: "proof", modelId: "D", counts: false }; await f.service.reserveResponseEvidence(slot, dispatch); await f.service.recordResponseEvidence(facts, dispatch); await fill(); assert.deepEqual(await f.service.responseEvidence(facts), dispatch); }
    if (deferred) { const delayed = fauxProvider({ provider: "proof", models: [{ id: "A" }, { id: "D" }], deferred: { pendingFetches: 0, pollAfterMs: 1 } }); delayed.setResponses([fauxAssistantMessage("delayed provider response")]); f.models.setProvider(delayed.provider); }
    const transport = new Proxy(f.models, { get(target, key) { if (key === "streamSimple") return ((...args: Parameters<typeof target.streamSimple>) => { streams++; return target.streamSimple(...args); }); if (key === "fetchDeferred") return ((...args: Parameters<typeof target.fetchDeferred>) => { polls++; return target.fetchDeferred(...args); }); const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } });
    const service = await createBotSessionService({ profileDir: f.root, models: f.models, extension: recordingDeps(), knownBotIds: async () => new Set(["bot:one"]), resolveModel: async () => ({ provider: "proof", modelId: "D" }), settings: { compaction: { enabled: false }, stream: { deferred }, retry: { enabled: false } }, execution: { claim: (botId, input) => f.service.claim(botId, input), getClaim: (botId, id, requestId) => f.service.getClaim(botId, id, requestId), selectFallback: async () => { throw new Error("No fallback"); }, verifyResponse: async (facts) => Boolean(await f.service.responseEvidence(facts)), async resolve(_botId, claim) { const model = f.models.getModel("proof", "D")!, dispatch = (id: string) => ({ dispatchId: id, owner: botExecutionSpendingOwner(claim), providerId: "proof", modelId: "D", counts: false }); return { model, models: transport, imageInput: false, revalidate: async () => {}, release() {}, reserveResponse: (slot) => f.service.reserveResponseEvidence(slot, dispatch(slot.dispatchId)), async sealResponse(facts) { await f.service.recordResponseEvidence(facts, dispatch(facts.dispatchId)); if (deferred) await fill(); } }; } } }); t.after(() => service.shutdown());
    await service.send("bot:one", { requestId: "new-work", text: "A new request must fit protected bookkeeping before any provider effect" }); for (let n = 0; n < 200 && (await service.routineState("bot:one")).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await service.routineState("bot:one")).kind, "interrupted"); assert.equal(streams, deferred ? 1 : 0); assert.equal(polls, 0); const stored = JSON.parse((await f.store.getRoutineModelsState())!) as { responseEvidence: unknown[] }; assert.equal(stored.responseEvidence.length, 4096);
  });
});
