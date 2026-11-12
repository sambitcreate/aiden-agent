import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, createAssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";
import { createBotRoutineModelService, inspectBotRoutineModelGrant, type BotProviderResponseFacts, type BotCostApprovalFacts, type BotRoutineModelLifetime } from "./bot-routine-models.js";
import { buildBotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import { bindBotCustomSelection, bindBotProviderModel, createBotCapabilityOpaqueIdMint } from "./bot-capability-bindings.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import { createBotCapabilityOpaqueKeyStore } from "./bot-capability-key-store.js";
import { createBotCapabilityStateCheckpoint, type BotCapabilityBootstrapMarkerState } from "./bot-capability-state-checkpoint.js";
import { createBotSessionService } from "./bot-runtime/bot-session-service.js";
import { recordingDeps } from "./bot-runtime/test-support/fixtures.js";
import { acknowledgeBotExecutionUnknown, botExecutionSpendingOwner, botExecutionUnknownCostReceipt, recordKnownBotExecutionCost, recordKnownBotExecutionResponse, botExecutionAccountableResponse, botExecutionInputSpendingRefusal } from "./bot-runtime/bot-execution-spending.js";
import { botExecutionScope, type BotExecutionPort } from "./bot-runtime/bot-execution.js";
import { issueBotRoutineInputOrigin } from "./bot-runtime/bot-input-entry.js";
import { issueBotPeerInputOrigin } from "./bot-peers/authority.js";
import { SpendingService } from "./spending-service.js";
import { emptySpendingDocument } from "./spending-core.js";
import { parseBotRoutineModelCatalog, parseBotRoutineModelResult, parseBotRoutineModelRuns } from "../../renderer/shared/bot-routine-models.js";
const fp = (text: string) => createHash("sha256").update(text).digest("hex");
const lifetime = (): BotRoutineModelLifetime => ({ signal: new AbortController().signal, assertCurrent() {} });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-routine-models-")); t.after(() => rm(root, { recursive: true, force: true }));
  let anchor: string | null = null, marker: BotCapabilityBootstrapMarkerState | null = null;
  const open = async () => {
    const store = createBotCapabilityStore({ root: () => root, checkpoint: createBotCapabilityStateCheckpoint({ root: () => root, keyStore: createBotCapabilityOpaqueKeyStore({ root: () => root }), anchor: { load: async () => anchor, store: async (value, expected) => { assert.equal(anchor, expected); anchor = value; } }, bootstrapMarker: { load: async () => marker, store: async (value, expected) => { assert.deepEqual(marker, expected); marker = value; } }, inspectInitialBootstrap: async () => "clean" as const }) }); await store.initialize(); return store;
  };
  const store = await open(); let quiet = false, routinePresent = true, connection = "one", defaultAvailable = true, botIncarnation = "bot-one", routineIncarnation = "routine-one", defaultCalls = 0, now = 1_000, failAfterPublish = false, defaultNeedsThinking = false, metadataFails = false;
  let heldPersistence: { stage: "read" | "write"; entered(): void; released: Promise<void> } | undefined;
  const pausePersistence = async (stage: "read" | "write") => { const held = heldPersistence; if (held?.stage !== stage) return; heldPersistence = undefined; held.entered(); await held.released; };
  const holdNextPersistence = (stage: "read" | "write") => {
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    heldPersistence = { stage, entered, released }; return { entered: entry, release };
  };
  const models = createModels(), faux = fauxProvider({ provider: "proof", models: [{ id: "A", reasoning: true }, { id: "D", reasoning: false }] }); models.setProvider(faux.provider);
  const snapshot = () => buildBotCapabilityCatalogSnapshot({ inventory: { providers: [{ sourceId: "proof", label: "Proof", available: true, connectionFingerprint: fp(connection), models: [ { sourceId: "A", label: "Specialist A", available: true, modelFingerprint: fp("A") }, { sourceId: "D", label: "Default D", available: defaultAvailable, modelFingerprint: fp("D") } ] }], fileScopes: [{ sourceId: "full", label: "Full Mac", available: false, kind: "full_mac", scopeFingerprint: fp("full") }, { sourceId: "home", label: "Bot folder", available: false, kind: "bot_home", scopeFingerprint: fp("home") }], shell: { available: false, shellFingerprint: fp("shell") }, connections: [], skills: [], otherCapabilities: [] }, notice: { version: "bot-full-access-v1", requiresAcknowledgement: true }, mintOpaqueId: createBotCapabilityOpaqueIdMint(Buffer.alloc(32, 7)) });
  const initial = snapshot(), provider = initial.catalog.providers[0]!, a = provider.models.find((row) => row.label === "Specialist A")!, d = provider.models.find((row) => row.label === "Default D")!;
  const custom = { providerId: provider.id, modelId: d.id, fileScopeIds: [], connectionIds: [], skillIds: [], otherCapabilityIds: [], shellEnabled: false };
  await store.acknowledgeNotice("desktop", { version: "bot-full-access-v1", decision: "customize_first", confirmedForeground: true });
  await store.createBotPolicy({ botId: "bot:one", catalog: initial.catalog, access: { accessMode: "custom", catalogRevision: initial.catalog.revision, custom }, binding: bindBotCustomSelection({ selection: custom, catalogRevision: initial.catalog.revision, snapshot: initial }) });
  const service = createBotRoutineModelService({ persistence: { read: async () => { await pausePersistence("read"); return store.getRoutineModelsState(); }, write: async (...args) => { await pausePersistence("write"); await store.saveRoutineModelsState(...args); if (failAfterPublish) { failAfterPublish = false; throw new Error("lost response after protected publication"); } } }, identity: async (botId, routineId) => { if (!["bot:one", "bot:two", "bot:three"].includes(botId) || routineId && (!routinePresent || routineId !== "routine:one")) throw new Error("Unknown owner"); return { botIncarnation: botId === "bot:one" ? botIncarnation : botId === "bot:two" ? "bot-two" : "bot-three", ...(routineId ? { routineIncarnation } : {}) }; }, snapshot: async () => snapshot(), metadata: async (_provider, id) => { if (metadataFails) throw new Error("model metadata unreadable"); const model = models.getModel("proof", id)!; return id === "D" && defaultNeedsThinking ? { ...model, reasoning: true, thinkingLevelMap: { off: null } } : model; }, deliveryQuiet: async () => quiet, defaultChoice: async () => { defaultCalls++; if (!defaultAvailable) throw new Error("default unavailable"); return { binding: bindBotProviderModel({ providerId: provider.id, modelId: d.id, catalogRevision: snapshot().catalog.revision, snapshot: snapshot() }), thinkingLevel: "off" }; }, now: () => now });
  const saveA = async () => service.save({ botId: "bot:one", routineId: "routine:one", mutationId: randomUUID(), expectedRevision: (await service.read("bot:one", "routine:one")).revision, catalogRevision: (await service.catalog("bot:one", "routine:one")).revision, selection: { mode: "selected", primary: { providerId: provider.id, modelId: a.id, thinkingLevel: "high" } } }, lifetime());
  return { root, store, open, service, snapshot, saveA, provider, a, d, models, faux, holdNextPersistence, get defaultCalls() { return defaultCalls; }, setQuiet(value:boolean) {quiet=value;}, unavailableDefault() { defaultAvailable = false; }, defaultNeedsThinking() { defaultNeedsThinking = true; }, failMetadata(value: boolean) { metadataFails = value; }, rotate() { connection = "two"; }, recreate() { routineIncarnation = "routine-two"; }, removeRoutine() { routinePresent = false; }, recreateBot() { botIncarnation = "bot-two"; }, tick() { now++; }, loseResponse() { failAfterPublish = true; } };
}
test("a prepared choice refuses model, thinking and fallback drift while credential repair and existing ownership retain their routes", async t => {
  const f = await fixture(t);
  const origin = (id: string) => ({ version: 1 as const, botId: "bot:one", routineId: "routine:one", runId: id, kind: "event" as const });
  const inherited = await f.service.prepareRoutineClaim("bot:one", "routine:one");
  f.rotate();
  const repaired = await f.service.claim("bot:one", { requestId: "credential-repair", routineOrigin: origin("credential-repair"), expectedChoiceHash: inherited });
  assert.equal(repaired.primary.binding.sourceModelId, "D");
  assert.equal(repaired.primary.binding.connectionFingerprint, fp("two"));
  assert.equal((await f.saveA()).ok, true);
  const selected = await f.service.prepareRoutineClaim("bot:one", "routine:one");
  const frozen = await f.service.claim("bot:one", { requestId: "already-owned", routineOrigin: origin("already-owned"), expectedChoiceHash: selected });
  for (const selection of [
    { mode: "inherit" as const },
    { mode: "selected" as const, primary: { providerId: f.provider.id, modelId: f.a.id, thinkingLevel: "off" as const } },
    { mode: "selected" as const, primary: { providerId: f.provider.id, modelId: f.a.id, thinkingLevel: "high" as const }, fallback: { providerId: f.provider.id, modelId: f.d.id, thinkingLevel: "off" as const } },
  ]) {
    const saved = await f.service.save({ botId: "bot:one", routineId: "routine:one", mutationId: randomUUID(), expectedRevision: (await f.service.read("bot:one", "routine:one")).revision, catalogRevision: (await f.service.catalog("bot:one", "routine:one")).revision, selection }, lifetime());
    assert.equal(saved.ok, true);
    await assert.rejects(f.service.claim("bot:one", { requestId: "not-owned", routineOrigin: origin("not-owned"), expectedChoiceHash: selected }), { name: "BotRoutineModelPreparationChangedError" });
    assert.equal(await f.service.claimByRequest("bot:one", "not-owned"), undefined);
    assert.deepEqual(await f.service.claim("bot:one", { requestId: "already-owned", routineOrigin: origin("already-owned"), expectedChoiceHash: selected }), frozen);
  }
});

test("an inherited choice takes the lowest thinking level the Bot's model supports when it cannot think off", async t => {
  const f = await fixture(t);
  f.defaultNeedsThinking();
  const chat = await f.service.claim("bot:one", { requestId: "chat-turn" });
  assert.equal(chat.primary.binding.sourceModelId, "D");
  assert.equal(chat.primary.thinkingLevel, "minimal");
  const origin = { version: 1 as const, botId: "bot:one", routineId: "routine:one", runId: "event-run", kind: "event" as const };
  const prepared = await f.service.prepareRoutineClaim("bot:one", "routine:one");
  const routine = await f.service.claim("bot:one", { requestId: "event-run", routineOrigin: origin, expectedChoiceHash: prepared });
  assert.equal(routine.primary.thinkingLevel, "minimal");
});
test("a message refused before submission drops its claim, so the same request binds the repaired default; routine and submitted claims stay", async t => {
  const f = await fixture(t);
  f.defaultNeedsThinking(); f.failMetadata(true);
  const execution: BotExecutionPort = {
    claim: (botId, input) => f.service.claim(botId, input), getClaim: (...args) => f.service.getClaim(...args), recordSubmission: (...args) => f.service.recordSubmission(...args), selectFallback: (...args) => f.service.selectFallback(...args), releaseUnsubmittedClaim: (...args) => f.service.releaseUnsubmittedClaim(...args),
    async resolve(_botId, claim) {
      const model = f.models.getModel("proof", claim.primary.binding.sourceModelId)!;
      if (claim.primary.thinkingLevel === "off") throw new Error("This model cannot turn thinking off.");
      return { model, models: f.models, imageInput: false, reserveResponse: async () => {}, sealResponse: async () => {}, revalidate: async () => {}, release() {} };
    },
  };
  const runtime = await createBotSessionService({ profileDir: f.root, models: f.models, execution, extension: recordingDeps(), knownBotIds: async () => new Set(["bot:one"]), resolveModel: async () => ({ provider: "proof", modelId: "D" }), settings: { compaction: { enabled: false }, retry: { enabled: false } } }); t.after(() => runtime.shutdown());
  await assert.rejects(runtime.send("bot:one", { requestId: "phone-send", text: "hello" }), { name: "BotSessionError", reason: "model_error" });
  assert.equal(await f.service.claimByRequest("bot:one", "phone-send"), undefined);
  f.failMetadata(false); f.faux.setResponses([fauxAssistantMessage("hello back")]);
  const sent = await runtime.send("bot:one", { requestId: "phone-send", text: "hello" });
  assert.equal(sent.deduped, false);
  assert.equal((await f.service.claimByRequest("bot:one", "phone-send"))?.primary.thinkingLevel, "minimal");

  const origin = { version: 1 as const, botId: "bot:one", routineId: "routine:one", runId: "event-run", kind: "event" as const };
  const routine = await f.service.claim("bot:one", { requestId: "event-run", routineOrigin: origin });
  await f.service.releaseUnsubmittedClaim("bot:one", routine.id, routine.requestId);
  assert.deepEqual(await f.service.claimByRequest("bot:one", "event-run"), routine);
  const submitted = await f.service.claim("bot:one", { requestId: "submitted-turn" });
  await f.service.recordSubmission("bot:one", submitted.id, "7");
  await f.service.releaseUnsubmittedClaim("bot:one", submitted.id, submitted.requestId);
  assert.equal((await f.service.claimByRequest("bot:one", "submitted-turn"))?.submissionId, "7");
});
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

test("retired delegated financial obligations remain exact, recoverable and incapable of restoring deleted execution authority", async (t) => {
  for (const routine of [false, true]) await t.test(routine ? "original routine cap" : "person attribution has no routine cap", async (t) => {
    const f = await fixture(t), requestId = routine ? "routine:one:root" : "person:root";
    const root = await f.service.claim("bot:one", { requestId, ...(routine ? { routineOrigin: { version: 1, botId: "bot:one", routineId: "routine:one", runId: requestId, kind: "manual" as const } } : {}) });
    const origin = issueBotPeerInputOrigin({ origin: { version: 1, exchangeId: "exchange", deliveryId: "delivery", kind: "request" }, botId: "bot:two", requestId: "child", peerName: "Root Bot", async assertCurrent() {}, binding: { version: 1, exchangeId: "exchange", deliveryId: "delivery", rootId: "root", pairId: "pair", pairGeneration: 1, kind: "request", senderBotId: "bot:one", recipientBotId: "bot:two", depth: 1, expiresAt: 86_400_000, sourceClaimId: root.id, sourceRequestId: root.requestId, root: root.root } });
    const child = await f.service.claim("bot:two", { requestId: "child", peerOrigin: origin });
    const facts: BotProviderResponseFacts = { version: 1, botId: child.botId, claimId: child.id, requestId: child.requestId, taskId: "12", scopeId: "scope", memoKey: `aiden.execution.response.${fp("retired memo")}`, dispatchId: "retired-dispatch", envelopeDigest: fp("late envelope"), responseDigest: fp("late response") };
    const { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts, dispatch = { dispatchId: facts.dispatchId, owner: botExecutionSpendingOwner(child), providerId: "proof", modelId: "D", counts: true };
    let document = emptySpendingDocument(); const spending = new SpendingService({ persistence: { load: async () => document, save: async (next) => { document = next; } }, settings: async () => ({ botMonthUsd: 1, routineRunUsd: 0.5 }), now: () => Date.UTC(2026, 10, 3), broadcast() {} });
    await f.service.reserveResponseEvidence(slot, dispatch); await spending.beforeDispatch(dispatch);
    const childPerson = await f.service.claim(child.botId, { requestId: "new-child-person-task" });
    await assert.rejects(botExecutionUnknownCostReceipt(spending, child.botId, childPerson, "9", "scope"), /another owner or root budget/u);
    const actualOwnerReceipt = await botExecutionUnknownCostReceipt(spending, child.botId, childPerson, "9", "scope", f.service); assert.equal(actualOwnerReceipt?.dispatchId, dispatch.dispatchId, "the actual Bot can review its dismissed peer task's authenticated original scopes");
    assert.equal(await f.service.responseCostForDispatch(root, dispatch), undefined);
    await assert.rejects(botExecutionUnknownCostReceipt(spending, root.botId, root, "7", "scope", f.service), /another active Bot/u);
    await assert.rejects(acknowledgeBotExecutionUnknown(spending, root.botId, root, dispatch.dispatchId, f.service), /another active Bot/u);
    await f.service.forgetBot(child.botId); await spending.forgetBot(child.botId);
    const stored = JSON.parse((await f.store.getRoutineModelsState())!) as { claims: { botId: string }[]; responseEvidence: { retired?: boolean; primary?: unknown; message?: unknown }[] };
    assert.equal(stored.claims.some((row) => row.botId === child.botId), false); assert.equal(stored.responseEvidence[0]!.retired, true); assert.equal(stored.responseEvidence[0]!.primary, undefined); assert.equal(stored.responseEvidence[0]!.message, undefined);
    await assert.rejects(f.service.getClaim(child.botId, child.id, child.requestId)); await assert.rejects(f.service.grant(child.botId, child.id, child.requestId)); await assert.rejects(f.service.claim(child.botId, { requestId: child.requestId }));
    const laterRootTask = await f.service.claim(root.botId, { requestId: "another-root" });
    assert.equal((await botExecutionUnknownCostReceipt(spending, root.botId, laterRootTask, "8", "scope", f.service))?.dispatchId, dispatch.dispatchId, "the original root Bot can review its exact retired obligation from a later task");
    const unrelated = await f.service.claim("bot:three", { requestId: "different-root-bot" });
    assert.equal(await f.service.retiredResponseReservation(unrelated, dispatch), undefined);
    await assert.rejects(acknowledgeBotExecutionUnknown(spending, unrelated.botId, unrelated, dispatch.dispatchId, f.service), /another active Bot/u);
    await assert.rejects(botExecutionUnknownCostReceipt(spending, root.botId, { ...root, botIncarnation: "forged-lifetime" }, "7", "scope", f.service), /owner changed/u);
    const receipt = await botExecutionUnknownCostReceipt(spending, root.botId, root, "7", "scope", f.service); assert.equal(receipt?.dispatchId, dispatch.dispatchId); assert.deepEqual(await botExecutionUnknownCostReceipt(spending, root.botId, root, "7", "scope", f.service), receipt);
    assert.notEqual((await botExecutionUnknownCostReceipt(spending, root.botId, root, "7", "other-scope", f.service))?.costReceiptId, receipt?.costReceiptId);
    await acknowledgeBotExecutionUnknown(spending, root.botId, root, dispatch.dispatchId, f.service); assert.equal((await spending.dispatchReceipt(dispatch.dispatchId))?.state, "acknowledged_unknown");
    const next = { ...dispatch, dispatchId: "new-live-root-dispatch", owner: botExecutionSpendingOwner(root) }; await spending.beforeDispatch(next); await acknowledgeBotExecutionUnknown(spending, root.botId, root, dispatch.dispatchId, f.service); assert.equal((await spending.dispatchReceipt(next.dispatchId))?.state, "pending", "old exact recovery cannot acknowledge another active request");
    await f.service.recordResponseEvidence(facts, dispatch, 0.6); assert.equal(await f.service.observedResponse(child.botId, child.id, facts.taskId, facts.responseDigest), false, "financial proof cannot become a peer terminal admission");
    const costs = await f.service.responseCosts(child.botId, facts.taskId, facts.scopeId); assert.equal(costs.length, 1); const orphanCost = await f.service.responseCostForDispatch(root, dispatch); assert.deepEqual(orphanCost, costs[0]); assert.equal(await f.service.responseCostForDispatch(unrelated, dispatch), undefined); for (let repeat = 0; repeat < 2; repeat++) await recordKnownBotExecutionCost(spending, orphanCost!.dispatch, orphanCost!.reportedCostUsd);
    assert.equal((await spending.dispatchReceipt(dispatch.dispatchId))?.state, "recorded"); assert.equal((await spending.status("bot", root.botId))?.spentUsd, 0.6); assert.equal((await spending.status("bot", child.botId))?.spentUsd, 0.6);
    assert.deepEqual(document.runs, routine ? { [requestId]: 0.6 } : {}); assert.equal((await spending.dispatchReceipt(next.dispatchId))?.state, "pending");
    await assert.rejects(f.service.recordResponseEvidence(facts, dispatch, 0.2), /cannot be replaced/u); await assert.rejects(f.service.recordResponseEvidence({ ...facts, responseDigest: fp("forged late result") }, dispatch, 0.6), /cannot be replaced/u);
    f.recreateBot(); await assert.rejects(f.service.retiredResponseReservation(root, dispatch), /owner changed/u);
  });
});

test("known protected cost is bounded and authenticated independently of a missing SQL body, and old dispatch slots cannot be sent again", async (t) => {
  const f = await fixture(t), owner = await f.service.claim("bot:one", { requestId: "known-source" }), response = fauxAssistantMessage("private result body"); response.usage.cost.total = 0.25;
  const facts: BotProviderResponseFacts = { version: 1, botId: owner.botId, claimId: owner.id, requestId: owner.requestId, taskId: "12", scopeId: "scope", memoKey: `aiden.execution.response.${fp("known memo")}`, dispatchId: "known-dispatch", envelopeDigest: fp("known envelope"), responseDigest: fp(JSON.stringify(response)) };
  const { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts, dispatch = { dispatchId: facts.dispatchId, owner: botExecutionSpendingOwner(owner), providerId: "proof", modelId: "D", counts: true };
  await f.service.reserveResponseEvidence(slot, dispatch); for (const invalid of [-1, NaN, Infinity, 1e9 + 1]) await assert.rejects(f.service.recordResponseEvidence(facts, dispatch, invalid), /reported cost/u);
  await f.service.recordResponseEvidence(facts, dispatch, 0.25); await assert.rejects(f.service.reserveResponseEvidence(slot, dispatch), /already observed/u);
  assert.deepEqual(await f.service.responseCosts(owner.botId, facts.taskId, "other-scope"), []); assert.deepEqual(await f.service.responseCosts(owner.botId, "13", facts.scopeId), []);
  f.rotate(); f.unavailableDefault(); assert.deepEqual(await f.service.responseCosts(owner.botId, facts.taskId, facts.scopeId), [{ dispatch, reportedCostUsd: 0.25 }]);
  const saved = await readFile(path.join(f.root, "bot-capabilities.json"), "utf8"), forged = JSON.parse(saved) as { routineModels: string }, state = JSON.parse(forged.routineModels) as { responseEvidence: { reportedCostUsd: number }[] }; state.responseEvidence[0]!.reportedCostUsd = 0; forged.routineModels = JSON.stringify(state); await writeFile(path.join(f.root, "bot-capabilities.json"), JSON.stringify(forged)); await assert.rejects(f.open());
  await writeFile(path.join(f.root, "bot-capabilities.json"), saved); await f.open(); await f.service.forgetBot(owner.botId);
  let document = emptySpendingDocument(); const spending = new SpendingService({ persistence: { load: async () => document, save: async (next) => { document = next; } }, settings: async () => ({ botMonthUsd: 1 }), broadcast() {} }); await spending.beforeDispatch(dispatch);
  await recordKnownBotExecutionResponse(spending, owner.botId, dispatch.dispatchId, response, (await f.service.responseEvidence(facts))!, facts.responseDigest); await recordKnownBotExecutionCost(spending, dispatch, 0.25); assert.equal((await spending.status("bot", owner.botId))?.spentUsd, 0.25);
});

test("an authentic observed cost survives deletion before sealing and during protected publication without retaining execution authority", async (t) => {
  for (const boundary of ["retired", "read", "write"] as const) await t.test(boundary, async (t) => {
    const f = await fixture(t), claim = await f.service.claim("bot:one", { requestId: "observed-before-delete" });
    const facts: BotProviderResponseFacts = { version: 1, botId: claim.botId, claimId: claim.id, requestId: claim.requestId, taskId: "12", scopeId: "scope", memoKey: `aiden.execution.response.${fp("delete-race")}`, dispatchId: "observed-before-delete", envelopeDigest: fp("observed envelope"), responseDigest: fp("observed response") };
    const { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts, dispatch = { dispatchId: facts.dispatchId, owner: botExecutionSpendingOwner(claim), providerId: "proof", modelId: "D", counts: true };
    await f.service.reserveResponseEvidence(slot, dispatch);
    if (boundary === "retired") { await f.service.forgetBot(claim.botId); await f.service.recordResponseEvidence(facts, dispatch, 0.25); }
    else {
      const barrier = f.holdNextPersistence(boundary); t.after(barrier.release);
      const publication = f.service.recordResponseEvidence(facts, dispatch, 0.25); await barrier.entered;
      const deletion = f.service.forgetBot(claim.botId);
      await assert.rejects(f.service.grant(claim.botId, claim.id, claim.requestId), /being deleted/u);
      barrier.release(); await publication; await deletion;
    }
    assert.deepEqual(await f.service.responseCosts(claim.botId, facts.taskId, facts.scopeId), [{ dispatch, reportedCostUsd: 0.25 }]);
    await f.service.recordResponseEvidence(facts, dispatch, 0.25);
    await assert.rejects(f.service.recordResponseEvidence(facts, dispatch, 0.5), /cannot be replaced/u);
    await assert.rejects(f.service.recordResponseEvidence({ ...facts, requestId: "another-request" }, dispatch, 0.25), /reservation/u);
    await assert.rejects(f.service.grant(claim.botId, claim.id, claim.requestId)); await assert.rejects(f.service.claim(claim.botId, { requestId: claim.requestId }));
    assert.equal(await f.service.observedResponse(claim.botId, claim.id, facts.taskId, facts.responseDigest), false);
    const state = JSON.parse((await f.store.getRoutineModelsState())!) as { claims: unknown[]; responseEvidence: { retired?: boolean; reportedCostUsd?: number }[] };
    assert.deepEqual(state.claims, []); assert.equal(state.responseEvidence.length, 1); assert.equal(state.responseEvidence[0]!.retired, true); assert.equal(state.responseEvidence[0]!.reportedCostUsd, 0.25);
  });
});

test("an accepted quiet routine keeps that preference through retry after future settings become loud",async t=>{
 const f=await fixture(t);f.setQuiet(true);const origin={version:1 as const,botId:"bot:one",routineId:"routine:one",runId:"routine:one:quiet",kind:"scheduled" as const},first=await f.service.claim("bot:one",{requestId:origin.runId,routineOrigin:origin});assert.equal(first.deliveryQuiet,true);f.setQuiet(false);const replay=await f.service.claim("bot:one",{requestId:origin.runId,routineOrigin:origin}),retry=await f.service.claim("bot:one",{requestId:"routine:one:quiet:retry",retryOf:origin.runId,routineOrigin:{...origin,runId:"routine:one:quiet:retry",kind:"retry"}}),later=await f.service.claim("bot:one",{requestId:"routine:one:later",routineOrigin:{...origin,runId:"routine:one:later"}});assert.equal(replay.deliveryQuiet,true);assert.equal(retry.deliveryQuiet,true);assert.equal(later.deliveryQuiet,undefined);
});

test("a live root Bot can review its retired delegate's exact cost after Dismiss and removal of the original routine", async (t) => {
  for (const removeRoutine of [false, true]) await t.test(removeRoutine ? "routine removed" : "initiating task dismissed", async (t) => {
    const f = await fixture(t), originalRequest = "original-root-task", rootOrigin = removeRoutine ? issueBotRoutineInputOrigin({ version: 1, botId: "bot:one", routineId: "routine:one", runId: originalRequest, kind: "manual" }) : undefined;
    const root = await f.service.claim("bot:one", { requestId: originalRequest, ...(rootOrigin ? { routineOrigin: rootOrigin } : {}) });
    const peerOrigin = issueBotPeerInputOrigin({ origin: { version: 1, exchangeId: "lifecycle-exchange", deliveryId: "lifecycle-delivery", kind: "request" }, botId: "bot:two", requestId: "delegated-provider-task", peerName: "Root Bot", async assertCurrent() {}, binding: { version: 1, exchangeId: "lifecycle-exchange", deliveryId: "lifecycle-delivery", rootId: "lifecycle-root", pairId: "lifecycle-pair", pairGeneration: 1, kind: "request", senderBotId: root.botId, recipientBotId: "bot:two", depth: 1, expiresAt: 86_400_000, sourceClaimId: root.id, sourceRequestId: root.requestId, root: root.root } });
    const child = await f.service.claim("bot:two", { requestId: "delegated-provider-task", peerOrigin });
    const lateResponse = fauxAssistantMessage("late authentic delegated result"); lateResponse.usage.cost.total = 0.25;
    const facts: BotProviderResponseFacts = { version: 1, botId: child.botId, claimId: child.id, requestId: child.requestId, taskId: "123", scopeId: "deleted-child-scope", memoKey: `aiden.execution.response.${fp("lifecycle-child-memo")}`, dispatchId: "lifecycle-child-dispatch", envelopeDigest: fp("lifecycle-child-envelope"), responseDigest: fp(JSON.stringify(lateResponse)) };
    const { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts, originalDispatch = { dispatchId: facts.dispatchId, owner: botExecutionSpendingOwner(child), providerId: "proof", modelId: "D", counts: true };
    let document = emptySpendingDocument(); const spending = new SpendingService({ persistence: { load: async () => structuredClone(document), save: async (next) => { document = structuredClone(next); } }, settings: async () => ({ botMonthUsd: 1, routineRunUsd: 0.5 }), broadcast() {} });
    await f.service.reserveResponseEvidence(slot, originalDispatch); await spending.beforeDispatch(originalDispatch);
    let acknowledgements = 0; const calls: string[] = [];
    const reconcilePending = async (claim: import("./bot-routine-models.js").BotExecutionClaim) => { const pending = await spending.pendingDispatch(botExecutionSpendingOwner(claim)); if (pending) { const proof = await f.service.responseCostForDispatch(claim, pending); if (proof) await recordKnownBotExecutionCost(spending, proof.dispatch, proof.reportedCostUsd); } };
    const execution: BotExecutionPort = {
      claim: (botId, input) => f.service.claim(botId, input), getClaim: (...args) => f.service.getClaim(...args), recordSubmission: (...args) => f.service.recordSubmission(...args), selectFallback: (...args) => f.service.selectFallback(...args),
      hasUnknown: async (_bot, claim) => { await reconcilePending(claim); return Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(claim))); },
      unknownDispatch: async (_bot, claim) => { await reconcilePending(claim); return (await spending.pendingDispatch(botExecutionSpendingOwner(claim)))?.dispatchId; },
      unknownCostReceipt: async (botId, claim, submissionId, scopeId) => { await reconcilePending(claim); return botExecutionUnknownCostReceipt(spending, botId, claim, submissionId, scopeId, f.service); },
      async approveCost(approval) { const source = await f.service.getClaim(approval.botId, approval.sourceClaimId, approval.sourceRequestId), receipt = await botExecutionUnknownCostReceipt(spending, approval.botId, source, approval.submissionId, approval.scopeId, f.service); if (receipt?.dispatchId !== approval.dispatchId || receipt.costReceiptId !== approval.costReceiptId) throw new Error("The exact retired cost changed."); return f.service.approveCost(approval); },
      verifyCostApproval: (...args) => f.service.verifyCostApproval(...args),
      acknowledgeUnknown: async (botId, claim, expected) => { const id = await acknowledgeBotExecutionUnknown(spending, botId, claim, expected, f.service); if (id) acknowledgements++; return id !== undefined; },
      verifyResponse: async (response) => Boolean(await f.service.responseEvidence(response)),
      async reconcileResponseCosts(botId, taskId, scopeId) { for (const proof of await f.service.responseCosts(botId, taskId, scopeId)) await recordKnownBotExecutionCost(spending, proof.dispatch, proof.reportedCostUsd); },
      async recordKnownResponse(response, message) { const proof = await f.service.responseEvidence(response); if (proof) await recordKnownBotExecutionResponse(spending, response.botId, response.dispatchId, message, proof, response.responseDigest); },
      async resolve(botId, claim, signal) {
        const grant = await f.service.grant(botId, claim.id, claim.requestId), selected = claim.primary.binding.sourceModelId, model = f.models.getModel("proof", selected)!, dispatch = (dispatchId: string) => ({ dispatchId, owner: botExecutionSpendingOwner(claim), providerId: "proof", modelId: selected, counts: true });
        const models = new Proxy(f.models, { get(target, key) { if (key === "streamSimple") return (() => { calls.push(botExecutionScope()!.claim.requestId); const message = fauxAssistantMessage("new task completed after exact financial review"); message.usage.cost.total = 0.1; const events = createAssistantMessageEventStream(); queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(message); }); return events; }) as Models["streamSimple"]; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } });
        return { model, models, imageInput: false, revalidate: async () => { signal.throwIfAborted(); await f.service.grant(botId, grant.claimId, claim.requestId); }, release() {}, beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); }, afterDispatch: (id, message) => spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(message)), reserveResponse: (reservation) => f.service.reserveResponseEvidence(reservation, dispatch(reservation.dispatchId)), sealResponse: (response, amount) => f.service.recordResponseEvidence(response, dispatch(response.dispatchId), amount) };
      },
    };
    const runtime = await createBotSessionService({ profileDir: f.root, models: f.models, execution, extension: recordingDeps(), knownBotIds: async () => new Set([root.botId]), resolveModel: async () => ({ provider: "proof", modelId: "D" }), settings: { compaction: { enabled: false }, retry: { enabled: false } }, spendingRefusal: (botId) => botExecutionInputSpendingRefusal(spending, botId) }); t.after(() => runtime.shutdown());
    const interrupted = async () => { for (let n = 0; n < 100 && (await runtime.routineState(root.botId)).kind !== "interrupted"; n++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal((await runtime.routineState(root.botId)).kind, "interrupted"); };
    const old = await runtime.send(root.botId, { requestId: originalRequest, text: "original delegated task", ...(rootOrigin ? { routineOrigin: rootOrigin } : {}) }); await interrupted();
    await f.service.forgetBot(child.botId); const oldStatus = await runtime.executionResumeStatus(root.botId); assert.equal(oldStatus.requiresUnknownCostAcknowledgement, true);
    await runtime.dismiss(root.botId, "dismiss-original-root-task"); assert.equal((await runtime.routineState(root.botId)).kind, "idle");
    if (removeRoutine) { f.removeRoutine(); await assert.rejects(f.service.grant(root.botId, root.id, root.requestId), /Unknown owner/u); }
    const fresh = await runtime.send(root.botId, { requestId: "new-person-root-task", text: "a new person request after reviewing the retired delegation" }); await interrupted();
    const status = await runtime.executionResumeStatus(root.botId); assert.equal(status.requiresUnknownCostAcknowledgement, true); assert.notEqual(status.costReceiptId, oldStatus.costReceiptId); assert.equal(status.interruptedSubmissionId, fresh.submissionId); assert.deepEqual(calls, []);
    await assert.rejects(runtime.resume(root.botId, "ordinary-without-cost-review"));
    await assert.rejects(runtime.resume(root.botId, "stale-source-consent", { acknowledgeUnknownCost: true, expectedSubmissionId: old.submissionId, expectedCostReceiptId: oldStatus.costReceiptId! }));
    await assert.rejects(runtime.resume(root.botId, "stale-receipt-on-new-source", { acknowledgeUnknownCost: true, expectedSubmissionId: fresh.submissionId, expectedCostReceiptId: oldStatus.costReceiptId! })); assert.equal(acknowledgements, 0); assert.deepEqual(calls, []);
    await runtime.resume(root.botId, "fresh-exact-retired-cost-review", { acknowledgeUnknownCost: true, expectedSubmissionId: fresh.submissionId, expectedCostReceiptId: status.costReceiptId! });
    assert.equal((await runtime.awaitReply(root.botId, fresh.submissionId, new AbortController().signal)).kind, "completed"); assert.equal(acknowledgements, 1); assert.deepEqual(calls, ["new-person-root-task"]);
    assert.equal((await spending.dispatchReceipt(originalDispatch.dispatchId))?.state, "acknowledged_unknown"); assert.deepEqual((await spending.dispatchReceipt(originalDispatch.dispatchId))?.owner, originalDispatch.owner); assert.equal(Object.keys(document.dispatches!).length, 2);
    await f.service.recordResponseEvidence(facts, originalDispatch, 0.25); const freshClaim = await f.service.claimByRequest(root.botId, "new-person-root-task"); assert.ok(freshClaim); const proof = await f.service.responseCostForDispatch(freshClaim, originalDispatch); assert.ok(proof);
    await recordKnownBotExecutionCost(spending, proof.dispatch, proof.reportedCostUsd); await recordKnownBotExecutionCost(spending, proof.dispatch, proof.reportedCostUsd);
    assert.equal((await spending.status("bot", root.botId))?.spentUsd, 0.35); assert.equal((await spending.status("bot", child.botId))?.spentUsd, 0.25); assert.deepEqual(document.runs, removeRoutine ? { [originalRequest]: 0.25 } : {}); assert.equal(Object.keys(document.dispatches!).length, 2); await assert.rejects(f.service.grant(child.botId, child.id, child.requestId));
    f.recreateBot(); const recreated = await f.service.claim(root.botId, { requestId: "recreated-root-bot" }); assert.equal(await f.service.retiredResponseReservation(recreated, originalDispatch), undefined); await assert.rejects(f.service.retiredResponseReservation(freshClaim, originalDispatch), /owner changed/u);
  });
});
