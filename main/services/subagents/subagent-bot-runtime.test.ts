import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, lazyStream, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_PROVIDER_ID } from "../codex-provider.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { SpendingService } from "../spending-service.js";
import type { SpendingDocument } from "../spending-core.js";
import { ElectronSubagentInferenceIsolation } from "./subagent-inference-process.js";
import { SubagentInferenceProcessOwner, type KillableInferenceProcess } from "./subagent-inference-process-core.js";
import { compactAssistantMessageEvent, SUBAGENT_INFERENCE_PROTOCOL_VERSION, type SubagentInferenceStartMessage } from "./subagent-inference-protocol.js";
import { registerSubagentProviderAuthority } from "./subagent-runtime-authority.js";
import { SubagentRuntimeRegistry } from "./child-agent-runtime.js";
import { SubagentSupervisor } from "./subagent-supervisor.js";
import { runSubagentChild } from "./subagent-child-runner.js";

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function runtime(provider = "fixture-selected"): ResolvedModelRuntime {
  const model: Model<Api> = { id: "selected-A", name: "Selected A", provider, api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"], contextWindow: 64_000, maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const models = new Proxy(createModels(), { get(target, key) {
    if (key === "getAuth") return async () => ({ auth: { apiKey: "synthetic-selected-key", headers: { "x-selected-account": "account-A" } }, env: { PI_CACHE_RETENTION: "selected" } });
    const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value;
  } });
  return { model, models, provider: { id: provider, label: "Selected provider", kind: "openai", models: [model.id], baseUrl: model.baseUrl, needsKey: true, deployment: "hosted" }, apiKey: "synthetic-selected-key", headers: undefined,
    streams: { streamSimple: () => { throw new Error("The unisolated transport must never be used."); } } };
}

class AnsweringProcess extends EventEmitter implements KillableInferenceProcess {
  alive = true;
  private request?: SubagentInferenceStartMessage;
  constructor(private readonly capture: (request: SubagentInferenceStartMessage) => void) { super(); }
  isLaunchVerified() { return true; }
  verifyReadyIdentity(token: string) { return token === "synthetic-owner"; }
  postMessage(raw: unknown) {
    const message = raw as { kind: string; requestId: string };
    if (message.kind === "start") {
      const request = raw as SubagentInferenceStartMessage; this.request = request; this.capture(request);
      queueMicrotask(() => this.emit("message", { kind: "ready", version: SUBAGENT_INFERENCE_PROTOCOL_VERSION, requestId: message.requestId, launchToken: "synthetic-owner" }));
    } else if (message.kind === "ready-ack") {
      const answer = fauxAssistantMessage("Selected child completed its bounded inspection.");
      answer.api = this.request!.model.api; answer.provider = this.request!.model.provider; answer.model = this.request!.model.id;
      answer.usage.cost = { input: 0.4, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 };
      queueMicrotask(() => this.emit("message", { kind: "event", version: SUBAGENT_INFERENCE_PROTOCOL_VERSION, requestId: message.requestId, sequence: 0, event: compactAssistantMessageEvent({ type: "done", reason: "stop", message: answer }) }));
    } else if (message.kind === "terminal-ack" || message.kind === "cancel") this.exit();
  }
  private exit() { if (!this.alive) return; this.alive = false; queueMicrotask(() => this.emit("exit", 0)); }
  terminate() { this.exit(); return true; }
  killHard() { this.exit(); }
  hasExited() { return !this.alive; }
  onMessage(listener: (value: unknown) => void) { this.on("message", listener); return () => this.off("message", listener); }
  onExit(listener: (code: number | null) => void) { this.on("exit", listener); return () => this.off("exit", listener); }
  onError(listener: (error: Error) => void) { this.on("process-error", listener); return () => this.off("process-error", listener); }
}

function isolation() {
  const requests: SubagentInferenceStartMessage[] = [];
  const owner = new SubagentInferenceProcessOwner(async () => new AnsweringProcess(request => requests.push(request)), { termGraceMs: 1, killGraceMs: 1 });
  return { requests, isolated: new ElectronSubagentInferenceIsolation(owner) };
}

for (const auth of ["codex", "key", "headers"] as const) test(`revocation during awaited ${auth} preparation sends no worker request`, async t => {
  const f = isolation(); t.after(() => f.isolated.shutdown());
  const source = runtime(auth === "codex" ? OPENAI_CODEX_PROVIDER_ID : undefined), entered = gate(), hold = gate();
  let current = true, preparations = 0;
  registerSubagentProviderAuthority(source, { revalidate: async () => { if (!current) throw new Error("The originating authority was revoked."); } });
  if (auth === "codex") source.prepareIsolatedStream = async model => { preparations++; entered.release(); await hold.promise; return { model, options: { apiKey: "synthetic-codex-key" }, signal: new AbortController().signal, observeResult() {} }; };
  else if (auth === "key") source.models = new Proxy(source.models, { get(target, key) { if (key === "getAuth") return async () => { preparations++; entered.release(); await hold.promise; return { auth: { apiKey: "synthetic-selected-key" } }; }; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } });
  const wrapped = f.isolated.wrap(source);
  const response = wrapped.models.streamSimple(source.model, { messages: [] }, auth === "headers" ? { transformHeaders: async headers => { preparations++; entered.release(); await hold.promise; return headers; } } : {}).result();
  await entered.promise; current = false; hold.release();
  const answer = await response;
  assert.equal(answer.stopReason, "error");
  assert.equal(preparations, 1);
  assert.equal(f.requests.length, 0, "neither credential payload nor provider request crossed worker IPC after revocation");
});

test("an already-ended Codex lease or a changed prepared model reaches no worker", async t => {
  for (const mode of ["ended", "switched"] as const) await t.test(mode, async t => {
    const f = isolation(); t.after(() => f.isolated.shutdown());
    const source = runtime(OPENAI_CODEX_PROVIDER_ID), lease = new AbortController();
    registerSubagentProviderAuthority(source, { revalidate: async () => {} });
    if (mode === "ended") lease.abort(new Error("Prepared credential lease ended"));
    source.prepareIsolatedStream = async model => ({ model: mode === "switched" ? { ...model, id: "unreviewed-B" } : model, options: { apiKey: "synthetic-selected-key" }, signal: lease.signal, observeResult() {} });
    const answer = await f.isolated.wrap(source).models.streamSimple(source.model, { messages: [] }).result();
    assert.equal(answer.stopReason, mode === "ended" ? "aborted" : "error");
    assert.equal(f.requests.length, 0);
  });
});

test("selected source auth beats ambient/options credentials and its authority signal cancels before worker I/O", async t => {
  const f = isolation(); t.after(() => f.isolated.shutdown());
  const source = runtime(), cancelled = new AbortController();
  registerSubagentProviderAuthority(source, { signal: cancelled.signal, revalidate: async () => {} });
  const answer = await f.isolated.wrap(source).models.streamSimple(source.model, { messages: [] }, { apiKey: "synthetic-ambient-key", headers: { "x-selected-account": "account-B" }, env: { PI_CACHE_RETENTION: "ambient" }, transformHeaders: async headers => ({ ...headers, "x-selected-account": "account-C" }) }).result();
  assert.equal(answer.stopReason, "stop");
  assert.equal(f.requests[0]?.options.apiKey, "synthetic-selected-key");
  assert.equal(f.requests[0]?.options.headers?.["x-selected-account"], "account-A");
  assert.equal(f.requests[0]?.options.env?.PI_CACHE_RETENTION, "selected");
  cancelled.abort(new Error("Selected grant ended"));
  const refused = await f.isolated.wrap(source).models.streamSimple(source.model, { messages: [] }).result();
  assert.equal(refused.stopReason, "aborted");
  assert.equal(f.requests.length, 1);
});

test("supervisor child isolation is transformed last, retains selected thinking and charges Bot/root once", async t => {
  const f = isolation(); const source = runtime();
  registerSubagentProviderAuthority(source, { revalidate: async () => {} });
  let stored: SpendingDocument | undefined, ordinaryCharges = 0, transforms = 0;
  let transformedChild: string | undefined, registeredChild: string | undefined;
  const spending = new SpendingService({ persistence: { load: async () => stored, save: async value => { stored = structuredClone(value); } }, settings: async () => ({ botMonthUsd: 10, routineRunUsd: 1 }), broadcast() {} });
  const registry = new SubagentRuntimeRegistry(undefined, undefined, { inferenceIsolation: f.isolated, spending: { refusal: async () => undefined, record: async () => { ordinaryCharges++; } } });
  t.after(() => registry.shutdown());
  const owner = { kind: "bot" as const, id: "recipient-bot", run: "recipient-run", budgetScopes: [{ kind: "bot" as const, id: "root-bot", run: "root-run" }] };
  const supervisor = new SubagentSupervisor({ generationId: "selected-parent", chatId: "parent-chat", workspaceId: "parent-workspace", runtime: source, thinkingLevel: "high", workspaceRoot: "/unused", permission: "ask", inheritedCeiling: [],
    transformRuntime: (isolated, identity) => {
      transforms++;
      transformedChild = identity.childId;
      const stream: Models["streamSimple"] = (model, context, options) => lazyStream(model, async () => {
        const input = { dispatchId: identity.childId, owner, providerId: source.provider.id, modelId: source.model.id, counts: true };
        await spending.beforeDispatch(input);
        const events = isolated.models.streamSimple(model, context, options);
        const message = await events.result(); await spending.afterDispatch(input, message);
        const output = createAssistantMessageEventStream(); output.push({ type: "done", reason: "stop", message }); return output;
      });
      const models = new Proxy(isolated.models, { get(target, key) { if (key === "streamSimple") return stream; const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } });
      return { ...isolated, models, streams: { streamSimple: stream } };
    },
    runChild: input => runSubagentChild({ ...input, dependencies: { createChild: spec => { const child = registry.create(spec); registeredChild = child.childId; return child; }, buildTools: async () => [] } }),
  });
  const result = await supervisor.execute({ tasks: [{ role: "scout", label: "Bound child", task: "Inspect the bounded synthetic input." }] });
  assert.match(result, /completed/u);
  assert.equal(transforms, 1);
  assert.equal(transformedChild, registeredChild, "accounting receives the actual allocated child identity, independent of callback order");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.model.id, "selected-A");
  assert.equal(f.requests[0]?.options.reasoning, "high");
  assert.equal((await spending.status("bot", "recipient-bot"))?.spentUsd, 0.4);
  assert.equal((await spending.status("bot", "root-bot"))?.spentUsd, 0.4);
  assert.equal(stored?.runs["root-run"], 0.4);
  assert.equal(Object.keys(stored?.dispatches ?? {}).length, 1);
  assert.equal(ordinaryCharges, 0, "the ordinary chat meter must not add a duplicate charge");
});
