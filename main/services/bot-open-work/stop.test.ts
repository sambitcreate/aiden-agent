import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBotRegistry } from "../bot-runtime/bot-extension.js";
import { recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "../bot-runtime/test-support/faux.js";
import { inspectLinkedBotWork, stopLinkedBotWork, readLinkedBotWorkEvidence } from "./stop.js";
const ctx = BACKGROUND_CONTEXT;
test("stopping linked A preserves B and person followups without a conversation abort", async (t) => {
  let entered = false;
  const faux = createFauxModels([(_messages, options) => { entered = true; return new Promise((resolve) => { options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("partial", { stopReason: "aborted" })), { once: true }); }); }, fauxAssistantMessage("B answer"), fauxAssistantMessage("person answer")]);
  const harness = await Harness.open(new MemoryStorage(), { models: faux.models, registry: createRegistry() }, ctx); t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  const a = await root.submit({ type: "input", content: "A", requestId: "person-A" }, ctx); await waitFor(() => entered);
  const b = await root.submit({ type: "input", content: "B", requestId: "person-B", whenBusy: "followUp" }, ctx);
  const person = await root.submit({ type: "input", content: "person", requestId: "person-C", whenBusy: "followUp" }, ctx);
  assert.equal((await inspectLinkedBotWork(harness, root.id, String(a.id))).kind, "running");
  assert.equal(await stopLinkedBotWork(harness, root.id, String(a.id), { intentId: "stable-stop", mayContinue: async () => true }), "stopped");
  const aReceipt = await a.status(ctx); assert.equal(aReceipt.status, "unanswered");
  assert.notEqual((await b.status(ctx)).status, "unanswered"); assert.notEqual((await person.status(ctx)).status, "unanswered");
  assert.equal((await b.wait(ctx)).status, "done"); assert.equal((await person.wait(ctx)).status, "done");
  assert.equal(faux.calls(), 3);
  assert.equal((await readLinkedBotWorkEvidence(harness, root.id, String(b.id), "result"))?.text, "B answer");
  assert.equal((await readLinkedBotWorkEvidence(harness, root.id, String(person.id), "result"))?.text, "person answer");
  assert.equal(await stopLinkedBotWork(harness, root.id, String(a.id), { intentId: "stable-stop", mayContinue: async () => true }), "stopped");
  assert.equal(faux.calls(), 3, "replayed Stop never creates another queued model turn");
});
test("withdrawing linked queued B leaves running A and another queued input untouched", async (t) => {
  let release!: () => void, entered = false; const gate = new Promise<void>((resolve) => { release = resolve; });
  const faux = createFauxModels([async () => { entered = true; await gate; return fauxAssistantMessage("A done"); }, fauxAssistantMessage("C done")]);
  const harness = await Harness.open(new MemoryStorage(), { models: faux.models, registry: createRegistry() }, ctx); t.after(async () => { release(); await harness.close(ctx); });
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  const a = await root.submit({ type: "input", content: "A" }, ctx); await waitFor(() => entered);
  const b = await root.submit({ type: "input", content: "B", whenBusy: "followUp" }, ctx), c = await root.submit({ type: "input", content: "C", whenBusy: "followUp" }, ctx);
  assert.equal(await stopLinkedBotWork(harness, root.id, String(b.id)), "stopped"); assert.equal((await a.status(ctx)).status, "placed"); assert.equal((await c.status(ctx)).status, "queued");
  release(); assert.equal((await a.wait(ctx)).status, "done"); assert.equal((await c.wait(ctx)).status, "done"); assert.equal(faux.calls(), 2);
});
test("a mixed active run refuses per-input Stop rather than silently stopping its other input", async (t) => {
  let toolEntered = false, releaseTool!: () => void, requestEntered = false, releaseRequest!: () => void;
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; }), requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const faux = createFauxModels([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }), async () => { requestEntered = true; await requestGate; return fauxAssistantMessage("both done"); }]);
  const registry = createRegistry(); registry.install(defineExtension({ name: "hold", tools: [defineTool({ name: "hold", description: "local barrier", parameters: Type.Object({}), replay: "safe", async execute() { toolEntered = true; await toolGate; return { output: [{ type: "text", text: "done" }] }; } })] }));
  const harness = await Harness.open(new MemoryStorage(), { models: faux.models, registry }, ctx); t.after(async () => { releaseTool(); releaseRequest(); await harness.close(ctx); });
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } }); const a = await root.submit({ type: "input", content: "A" }, ctx); await waitFor(() => toolEntered);
  const steer = await root.submit({ type: "input", content: "steer", whenBusy: "steer" }, ctx); releaseTool(); await waitFor(() => requestEntered);
  assert.equal(await stopLinkedBotWork(harness, root.id, String(a.id)), "mixed_inputs"); assert.equal((await a.status(ctx)).status, "placed"); assert.equal((await steer.status(ctx)).status, "placed"); releaseRequest(); assert.equal((await a.wait(ctx)).status, "done");
});


test("source and result evidence uses original owned entries after the visible context was reset", async (t) => {
  const faux = createFauxModels([fauxAssistantMessage("the actual result")]);
  const harness = await Harness.open(new MemoryStorage(), { models: faux.models, registry: createRegistry() }, ctx); t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  const source = await root.submit({ type: "input", content: "original explicit request" }, ctx); await source.wait(ctx);
  await root.submit({ type: "write", entry: { kind: "proof.reset", head: "self", model: [{ role: "user", content: [{ type: "text", text: "new context" }], timestamp: Date.now() }] } }, ctx);
  const input = await readLinkedBotWorkEvidence(harness, root.id, String(source.id), "source");
  const result = await readLinkedBotWorkEvidence(harness, root.id, String(source.id), "result");
  assert.equal(input?.text, "original explicit request"); assert.equal(result?.text, "the actual result"); assert.notEqual(result?.entryId, input?.entryId);
  assert.equal(await readLinkedBotWorkEvidence(harness, (root.id + 1) as typeof root.id, String(source.id), "source"), undefined);
});


test("Stop on a reopened paused harness does not resume unrelated compaction or its preserved queue", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "aiden-work-paused-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "session.sqlite"); let entered = 0;
  const held = (_messages: unknown, options?: { signal?: AbortSignal }) => { entered++; return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("interrupted", { stopReason: "aborted" })), { once: true }); }); };
  const before = createFauxModels([held, held]);
  const settings = { compaction: { keepRecentTokens: 1 } };
  let harness = await Harness.open(await openNodeSqliteStorage(file), { models: before.models, registry: createRegistry(), settings }, ctx);
  let root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  for (let n = 0; n < 4; n++) await root.submit({ type: "write", entry: { kind: n % 2 ? "pi.assistant" : "pi.user", model: [n % 2 ? fauxAssistantMessage("older history ".repeat(500)) : { role: "user", content: "older history ".repeat(500), timestamp: Date.now() }] } }, ctx);
  const a = await root.submit({ type: "input", content: "A" }, ctx); await waitFor(() => entered === 1);
  const active = await inspectLinkedBotWork(harness, root.id, String(a.id)); assert.equal(active.kind, "running");
  const b = await root.submit({ type: "input", content: "B", whenBusy: "followUp" }, ctx);
  const compaction = await root.compact(undefined, ctx); await waitFor(() => entered === 2);
  await harness.close(ctx);
  const after = createFauxModels([fauxAssistantMessage("must not resume unrelated compaction"), fauxAssistantMessage("must not request B")]); harness = await Harness.open(await openNodeSqliteStorage(file), { models: after.models, registry: createRegistry(), settings }, ctx); t.after(() => harness.close(ctx)); root = await harness.root(ctx);
  assert.equal((await harness.inspect(ctx)).scheduling, "paused");
  assert.equal(await stopLinkedBotWork(harness, root.id, String(a.id), { intentId: "paused-stop", mayContinue: async () => false }), "uncertain", "an abort mark without cleanup acknowledgement is not a confirmed Stop");
  assert.equal((await harness.inspect(ctx)).scheduling, "paused");
  const untouched = await harness.getTask(compaction, ctx); assert.equal(untouched?.state.status, "pending"); assert.equal(untouched?.abortRequested, false);
  if (active.kind !== "running") throw new Error("Expected linked active task");
  const marked = await harness.getTask(Number(active.taskId) as typeof compaction, ctx); assert.equal(marked?.abortRequested, true); assert.notEqual(marked?.state.status, "terminal");
  assert.equal((await (await harness.submission(b.id, ctx))!.status(ctx)).status, "queued"); assert.equal(after.calls(), 0);
  assert.equal(await stopLinkedBotWork(harness, root.id, String(a.id), { intentId: "paused-stop", mayContinue: async () => true }), "uncertain", "even a permissive queue callback cannot resume a paused harness");
  assert.equal((await harness.inspect(ctx)).scheduling, "paused"); assert.equal(after.calls(), 0);
});

test("continued queued requests still pass the Bot spending gate before any provider effect", async (t) => {
  let entered = false, refuse = false;
  const faux = createFauxModels([(_messages, options) => { entered = true; return new Promise((resolve) => { options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("partial", { stopReason: "aborted" })), { once: true }); }); }, fauxAssistantMessage("must be blocked")]);
  const registry = createBotRegistry("bot:one", { ...recordingDeps(), spending: { refusal: async () => refuse ? "Bot budget exhausted" : undefined, record: async () => {} } }); await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: faux.models, registry }, ctx); registry.attachHarness(harness); t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } }); const a = await root.submit({ type: "input", content: "A", requestId: "person-A" }, ctx); await waitFor(() => entered);
  const b = await root.submit({ type: "input", content: "B", requestId: "person-B", whenBusy: "followUp" }, ctx); refuse = true;
  assert.equal(await stopLinkedBotWork(harness, root.id, String(a.id), { intentId: "budget-stop", mayContinue: async () => true }), "stopped");
  assert.equal((await b.wait(ctx)).status, "unanswered"); assert.equal(faux.calls(), 1);
});
