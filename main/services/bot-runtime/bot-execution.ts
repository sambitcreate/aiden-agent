/** Pin-specific Pi 1.4 public RegistryReader adapter. No shared AgentDoc mutation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createAssistantMessageEventStream, lazyStream, type Api, type AssistantMessage, type Model, type Models } from "@earendil-works/pi-ai";
import { CompactionTask, GenerationTask, ToolTask, LiveDoc, defineDoc, defineTask, type Harness, type RegistryReader, type RegistrySnapshot, type Task, type TaskId, type TaskRuntime, type Tx, type SubmissionId } from "@earendil-works/pi-durable";
import { withBotConnectorTaskScope, type BotConnectorExecutionRestriction } from "../bot-connector-inventory-scope.js";
import { BotRoutineModelUnavailableError, type BotCostApprovalFacts, type BotExecutionClaim, type BotProviderResponseFacts, type BotProviderResponseSlot } from "../bot-routine-models.js";
import { parseBotRoutineModelId } from "../../../renderer/shared/bot-routine-models.js";
import { SpendingDispatchError } from "../spending-dispatch-ledger.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import type { BotRoutineThinkingLevel } from "../../../renderer/shared/bot-routine-models.js";
import { withImageReferences } from "./bot-images.js";
import { botExecutionAccountableResponse } from "./bot-execution-spending.js";
import { BOT_PEER_INPUT_KIND } from "./bot-input-entry.js";
import { parseBotPeerInputOrigin } from "../bot-peers/authority.js";
import { BotCostReceiptScopeDoc } from "./bot-resume-operations.js";

export const BOT_EXECUTION_INPUT_KEY = "executionClaimId";
type BotCostConsent = { version: 1; requestId: string; submissionId: string; dispatchId: string; costReceiptId: string; sourceClaimId: string; sourceRequestId: string; scopeId: string; approvalId: string; fromGeneration: number; toGeneration: number };
export function botCostApprovalFacts(botId: string, taskId: string, ownerClaimId: string, consent: Omit<BotCostConsent, "approvalId">): BotCostApprovalFacts { return { version: 1, botId, sourceClaimId: consent.sourceClaimId, sourceRequestId: consent.sourceRequestId, ownerClaimId, taskId, scopeId: consent.scopeId, requestId: consent.requestId, submissionId: consent.submissionId, dispatchId: consent.dispatchId, costReceiptId: consent.costReceiptId, fromGeneration: consent.fromGeneration, toGeneration: consent.toGeneration }; }
export const BotExecutionDoc = defineDoc({ kind: "aiden.execution-binding", version: 1, scope: "task", initial: (): { claimId?: string; requestId?: string; sourceInputs?: number[]; dispatchGeneration?: number; dispatchIds?: string[]; operations?: { key: string; requestFingerprint: string }[]; costConsent?: BotCostConsent; costDecision?: BotCostConsent; blocked?: { kind: "spending_unknown" | "unavailable"; message: string } } => ({}), checkpointWhen: () => false });
export interface BotExecutionRuntime {
  model: Model<Api>;
  models: Models;
  imageInput: boolean;
  signal?: AbortSignal;
  providerRuntime?: ResolvedModelRuntime;
  thinkingLevel?: BotRoutineThinkingLevel;
  revalidate(): Promise<void>;
  release(): void;
  /** Durable accounting hooks run for generation, compaction and summary helpers. */
  beforeDispatch?(dispatchId: string): Promise<void>;
  afterDispatch?(dispatchId: string, message: AssistantMessage): Promise<void>;
  /** Called only for a fresh transport observation, before writing a SQL hint. */
  sealResponse?(facts: BotProviderResponseFacts, reportedCostUsd?: number): Promise<void>;
  /** Reserves bounded protected publication capacity before any new I/O. */
  reserveResponse?(slot: BotProviderResponseSlot): Promise<void>;
  /** Exact private receipt; never a budget increase or a new dispatch grant. */
  isDispatchSettled?(dispatchId: string): Promise<boolean>;
  started?(): Promise<void>;
}
export interface BotExecutionScope { botId: string; claim: BotExecutionClaim; taskId: string; scopeId?: string; requestIds: string[]; runtime: BotExecutionRuntime; registrySnapshot?: RegistrySnapshot; active?(): boolean; bindHelperRuntime?(kind: string, runtime: BotExecutionRuntime): Models }
const scope = new AsyncLocalStorage<BotExecutionScope>();
export function botExecutionScope(botId?: string): BotExecutionScope | undefined { const current = scope.getStore(); return current?.active?.() === false ? undefined : botId === undefined || current?.botId === botId ? current : undefined; }
/** A detached learning review admits its own default, rather than borrowing a completed task's model lease. */
export function withoutBotExecutionScope<T>(operation: () => T): T { return scope.exit(operation); }
export interface BotExecutionPort {
  claim(botId: string, input: { requestId: string; routineOrigin?: import("./bot-input-entry.js").BotRoutineInputOrigin; peerOrigin?: import("../bot-peers/authority.js").BotPeerInputOrigin; connectorServerId?: string; connectorRestriction?: BotConnectorExecutionRestriction; scheduledFor?: number; timezone?: string; retryOf?: string }): Promise<BotExecutionClaim>;
  getClaim(botId: string, claimId: string, requestId: string): Promise<BotExecutionClaim>;
  resolve(botId: string, claim: BotExecutionClaim, signal: AbortSignal): Promise<BotExecutionRuntime>;
  selectFallback(botId: string, claimId: string, reason: "model_unavailable" | "credentials_unavailable"): Promise<void>;
  recordSubmission?(botId: string, claimId: string, submissionId: string): Promise<void>;
  /** Exact private receipt identity captured before durable person consent. */
  unknownDispatch?(botId: string, claim: BotExecutionClaim): Promise<string | undefined>;
  unknownCostReceipt?(botId: string, claim: BotExecutionClaim, submissionId: string, scopeId: string): Promise<{ dispatchId: string; costReceiptId: string } | undefined>;
  approveCost?(facts: BotCostApprovalFacts): Promise<string>;
  verifyCostApproval?(approvalId: string, facts: BotCostApprovalFacts): Promise<boolean>;
  acknowledgeUnknown?(botId: string, claim: BotExecutionClaim, expectedDispatchId?: string): Promise<boolean | "recorded">;
  hasUnknown?(botId: string, claim: BotExecutionClaim): Promise<boolean>;
  dismissed?(botId: string, claim: BotExecutionClaim): Promise<void>;
  verifyResponse?(facts: BotProviderResponseFacts): Promise<boolean>;
  reconcileResponseCosts?(botId: string, taskId: string, scopeId: string): Promise<void>;
  recordKnownResponse?(facts: BotProviderResponseFacts, message: AssistantMessage): Promise<void>;
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined { const present = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))]; return present.length === 0 ? undefined : present.length === 1 ? present[0] : AbortSignal.any(present); }
class BotExecutionImageError extends Error { constructor() { super("This run's selected model cannot read its attached images. Choose an image model or configure an image companion before resuming."); } }
function hasUserImages(messages: readonly import("@earendil-works/pi-ai").Message[]): boolean { return messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image")); }
function companionOffered(claim: BotExecutionClaim): boolean { return Boolean(claim.vision && botExecutionScope(claim.botId)?.registrySnapshot?.tools().some(({ tool }) => tool.name === "inspect_image")); }
function claimScope<T>(claim: BotExecutionClaim, operation: () => Promise<T>): Promise<T> { return withBotConnectorTaskScope(claim.connectorRestriction, claim.connectorServerId, operation); }
export async function withBotExecutionAdmission<T>(botId: string, claim: BotExecutionClaim, port: BotExecutionPort, operation: () => Promise<T>, options: { allowFallback?: boolean } = {}): Promise<T> {
  const run = async () => {
    let active = true;
    let execution: BotExecutionRuntime;
    try { execution = await port.resolve(botId, claim, new AbortController().signal); }
    catch (error) {
      if (!options.allowFallback || !(error instanceof BotRoutineModelUnavailableError) || !claim.fallback || claim.startedAt || claim.actual !== "primary") throw error;
      await port.selectFallback(botId, claim.id, error.reason); claim = await port.getClaim(botId, claim.id, claim.requestId); execution = await port.resolve(botId, claim, new AbortController().signal);
    }
    try { return await scope.run({ botId, claim, taskId: "admission", requestIds: [claim.requestId], runtime: execution, active: () => active }, operation); }
    finally { active = false; execution.release(); }
  };
  return claimScope(claim, run);
}
export async function stampBotExecutionTask(tx: Tx, taskId: TaskId, claim: BotExecutionClaim): Promise<void> {
  const binding = await tx.doc(BotExecutionDoc, taskId); binding.claimId = claim.id; binding.requestId = claim.requestId;
}
/** Background reviews own an explicit default claim, separate from any live turn. */
export function createBotBackgroundExecutionModels(claim: BotExecutionClaim, execution: BotExecutionRuntime): Models {
  let sequence = 0;
  const selected = claim.actual === "fallback" ? claim.fallback! : claim.primary;
  const stream: Models["streamSimple"] = (model, messages, options) => {
    if (model.provider !== execution.model.provider || model.id !== execution.model.id) throw new Error("Background work cannot switch its admitted model.");
    const dispatchId = `aiden_bot_${fingerprint({ claim: claim.id, sequence: sequence++ })}`;
    options = { ...options, signal: combinedSignal(options?.signal, execution.signal) };
    return lazyStream(model, async () => {
      await execution.revalidate(); await execution.beforeDispatch?.(dispatchId); await execution.revalidate(); await execution.started?.();
      options?.signal?.throwIfAborted();
      const events = execution.models.streamSimple(model, messages, { ...options, reasoning: selected.thinkingLevel === "off" ? undefined : selected.thinkingLevel });
      let recorded: Promise<AssistantMessage> | undefined;
      const finish = (message: AssistantMessage) => recorded ??= (async () => { await execution.afterDispatch?.(dispatchId, message); return message; })();
      return proxyBound(events, { [Symbol.asyncIterator]: async function* () { for await (const event of events) { if (event.type === "done") await finish(event.message); else if (event.type === "error") await finish(event.error); yield event; } }, result: async () => finish(await events.result()) });
    });
  };
  return proxyBound(execution.models, { streamSimple: stream, completeSimple: ((...args) => stream(...args).result()) as Models["completeSimple"], fetchDeferred: async () => { throw new Error("Background reviews do not submit deferred requests."); }, cancelDeferred: async () => { throw new Error("Background reviews have no deferred request to cancel."); } });
}
function proxyBound<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, { get(object, key) { if (key in overrides) return overrides[key]; const value = Reflect.get(object, key, object) as unknown; return typeof value === "function" ? value.bind(object) : value; } });
}
function responseFacts(botId: string, taskId: string, scopeId: string, memoKey: string, raw: unknown): BotProviderResponseFacts | undefined {
  if (!/^aiden\.execution\.response\.[a-f0-9]{64}$/u.test(memoKey) || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const receipt = raw as { version?: unknown; claimId?: unknown; requestId?: unknown; dispatchId?: unknown; message?: unknown };
  if (receipt.version !== 2 || !receipt.message || typeof receipt.message !== "object") return undefined;
  try { return { version: 1, botId, taskId, scopeId, memoKey, claimId: parseBotRoutineModelId(receipt.claimId), requestId: parseBotRoutineModelId(receipt.requestId), dispatchId: parseBotRoutineModelId(receipt.dispatchId), envelopeDigest: fingerprint(raw), responseDigest: fingerprint(receipt.message) }; } catch { return undefined; }
}
export async function reconcileBotExecutionResponses(botId: string, taskId: string, scopeId: string, memos: Readonly<Record<string, JsonValue>> | undefined, port: BotExecutionPort): Promise<void> {
  await port.reconcileResponseCosts?.(botId,taskId,scopeId);
  for (const [key, raw] of Object.entries(memos ?? {})) {
    const facts = responseFacts(botId, taskId, scopeId, key, raw);
    if (facts && await port.verifyResponse?.(facts)) await port.recordKnownResponse?.(facts, (raw as unknown as { message: AssistantMessage }).message);
  }
}
/** Every call is checked against the invocation-owned model; prepared work cannot retarget. */
function executionModels<I, S, R, H extends object>(runtime: TaskRuntime<I, S, R, H>, execution: BotExecutionRuntime, claim: BotExecutionClaim, kind: string, phase: string, checkpoint: unknown, context: Context, dispatchGeneration: number, responseScopeId: string, port: BotExecutionPort, block: (error: unknown) => Promise<never>, settledDeferredTerminal: () => void, verifyCostApproval: NonNullable<BotExecutionPort["verifyCostApproval"]>): Models {
  const exact = (model: Model<Api>) => { if (model.provider !== execution.model.provider || model.id !== execution.model.id) throw new Error("Prepared request does not match its admitted model."); };
  const state = checkpoint as { attempt?: number; pollAt?: number; handle?: unknown };
  let callIndex = 0;
  const deferred = new Map<string, { dispatchId: string; polls: number }>();
  const operation = (requestFingerprint: string, previousDispatch?: string, poll?: number) => {
    const index = previousDispatch ? undefined : callIndex++;
    const operationKey = fingerprint({ botId: claim.botId, claim: claim.id, taskId: runtime.taskId, kind, phase, attempt: state.attempt ?? 1, index, ...(previousDispatch ? { previousDispatch, pollAt: state.pollAt, poll } : {}) });
    let dispatchId = previousDispatch ?? `aiden_bot_${fingerprint({ operationKey, dispatchGeneration })}`;
    const key = (id: string) => `aiden.execution.response.${fingerprint({ dispatchId: id, phase, pollAt: state.pollAt, poll })}`;
    let memoKey = key(dispatchId);
    type Receipt = { version: 2; claimId: string; requestId: string; dispatchId: string; operationKey: string; requestFingerprint: string; memoScope: string; generation: number; message: AssistantMessage };
    const memoScope = fingerprint({ phase, pollAt: state.pollAt, poll });
    const matching = (value: unknown): value is Receipt => Boolean(value && typeof value === "object" && (value as Receipt).version === 2 && (value as Receipt).claimId === claim.id && (value as Receipt).requestId === claim.requestId && (value as Receipt).operationKey === operationKey && (value as Receipt).requestFingerprint === requestFingerprint && (value as Receipt).memoScope === memoScope && (value as Receipt).message);
    const verified = async (name: string, receipt: unknown): Promise<boolean> => { const facts = responseFacts(claim.botId, String(runtime.taskId), responseScopeId, name, receipt); return Boolean(facts && await port.verifyResponse?.(facts)); };
    const saved = async (): Promise<AssistantMessage | undefined> => {
      await runtime.commit(async (tx) => {
        const binding = await tx.doc(BotExecutionDoc, runtime.taskId); binding.operations ??= [];
        const existing = binding.operations.find((row) => row.key === operationKey);
        if (existing && existing.requestFingerprint !== requestFingerprint) throw new Error("A replayed provider operation has a different saved request body.");
        if (!existing) { if (binding.operations.length >= 256) throw new Error("This task's provider operation history is full."); binding.operations.push({ key: operationKey, requestFingerprint }); }
        return undefined;
      }, context);
      const receipt = await runtime.memo<JsonValue>(memoKey, context);
      if (receipt !== undefined) { if (!matching(receipt) || !await verified(memoKey, receipt)) throw new Error("The saved provider response has no authentic evidence for its exact request."); return receipt.message; }
      if (!previousDispatch) {
        const candidates = Object.entries((await runtime.getTask(runtime.taskId, context))?.memos ?? {}).filter(([name, value]) => name.startsWith("aiden.execution.response.") && matching(value)).map(([name, value]) => ({ name, receipt: value as unknown as Receipt })).sort((a, b) => b.receipt.generation - a.receipt.generation);
        for (const candidate of candidates) {
          const known = botExecutionAccountableResponse(candidate.receipt.message), amount = known?.usage?.cost?.total;
          if (known && known.stopReason !== "deferred" && known.stopReason !== "pending" && typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && await verified(candidate.name, candidate.receipt)) { dispatchId = candidate.receipt.dispatchId; memoKey = candidate.name; return known; }
        }
      }
      return undefined;
    };
    let recorded: Promise<AssistantMessage> | undefined;
    const remember = (message: AssistantMessage, observed = true): Promise<AssistantMessage> => recorded ??= (async () => {
    // Publish only a digest/identity in the authenticated authority store.
    // SQLite remains an untrusted content hint, even after an owner Resume.
    const envelope = JSON.parse(JSON.stringify({ version: 2, claimId: claim.id, requestId: claim.requestId, dispatchId, operationKey, requestFingerprint, memoScope, generation: dispatchGeneration, message })) as JsonValue;
    let receipt: Receipt;
    try {
      if (observed) { const facts = responseFacts(claim.botId, String(runtime.taskId), responseScopeId, memoKey, envelope); if (!facts || !execution.sealResponse) throw new Error("This provider result has no protected evidence publisher."); const reported = message.stopReason === "pending" || message.stopReason === "deferred" ? undefined : botExecutionAccountableResponse(message)?.usage?.cost?.total;
        const amount = typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : undefined;
        await execution.sealResponse(facts,amount); }
      const saved = await runtime.memo(memoKey, envelope, context);
      if (!matching(saved) || !await verified(memoKey, saved)) throw new Error("The stored provider result has no authentic evidence for its exact request.");
      receipt = saved;
    } catch (error) { return block(error); }
    const stored = receipt.message as AssistantMessage;
    if (stored.deferred) { const key = fingerprint(stored.deferred); if (!deferred.has(key)) deferred.set(key, { dispatchId, polls: 0 }); }
    if (previousDispatch && (stored.stopReason === "error" || stored.stopReason === "aborted") && !botExecutionAccountableResponse(stored)) {
      const decision = (await runtime.snapshot(BotExecutionDoc, runtime.taskId, context))?.costDecision;
      const scope = await runtime.snapshot(BotCostReceiptScopeDoc, runtime.conversationId, context);
      const acknowledged = decision?.dispatchId === dispatchId && decision.scopeId === scope?.nonce && decision.toGeneration === decision.fromGeneration + 1 && dispatchGeneration >= decision.fromGeneration && Boolean(await verifyCostApproval(decision.approvalId, botCostApprovalFacts(claim.botId, String(runtime.taskId), claim.id, decision)));
      if (acknowledged || await execution.isDispatchSettled?.(dispatchId)) {
        // The terminal provider outcome remains an error/abort. Its cost is
        // still unknown (or independently recorded); no synthetic zero charge
        // is written and the existing deferred job is not polled again.
        settledDeferredTerminal(); return stored;
      }
    }
    if (stored.stopReason !== "deferred" && stored.stopReason !== "pending") { try { await execution.afterDispatch?.(dispatchId, stored); } catch (error) { return block(error); } }
    return stored;
    })();
    const reserve = async () => { if (!execution.reserveResponse) throw new Error("This provider request has no protected response reservation."); await execution.reserveResponse({ version: 1, botId: claim.botId, claimId: claim.id, requestId: claim.requestId, taskId: String(runtime.taskId), scopeId: responseScopeId, memoKey, dispatchId }); };
    return { dispatchId, saved, remember, reserve };
  };
  const originatingDispatch = async (handle: unknown): Promise<string> => {
    const prior = deferred.get(fingerprint(handle)); if (prior) return prior.dispatchId;
    if (state.handle === undefined || fingerprint(state.handle) !== fingerprint(handle)) throw new Error("This deferred response has no admitted dispatch.");
    for (const [key, raw] of Object.entries((await runtime.getTask(runtime.taskId, context))?.memos ?? {})) {
      const facts = responseFacts(claim.botId, String(runtime.taskId), responseScopeId, key, raw);
      const receipt = raw as { message?: AssistantMessage } | undefined;
      if (facts && facts.claimId === claim.id && facts.requestId === claim.requestId && receipt?.message?.deferred && fingerprint(receipt.message.deferred) === fingerprint(handle) && await port.verifyResponse?.(facts)) return facts.dispatchId;
    }
    throw new Error("The deferred handle has no authentic originating receipt.");
  };
  const stream: Models["streamSimple"] = (model, messages, options) => {
    exact(model);
    const selected = claim.actual === "fallback" ? claim.fallback! : claim.primary;
    const thinking = execution.thinkingLevel ?? selected.thinkingLevel;
    options = { ...options, reasoning: thinking === "off" ? undefined : thinking, signal: combinedSignal(options?.signal, runtime.signal, execution.signal) };
    const { apiKey: _key, headers: _headers, env: _env, signal: _signal, telemetry: _telemetry, sessionId: _session, ...requestOptions } = options;
    // Message timestamps are host bookkeeping, not provider-visible content.
    const body = { ...messages, messages: messages.messages.map(({ timestamp: _timestamp, ...message }) => message) };
    const { dispatchId, saved, remember, reserve } = operation(fingerprint({ model: { provider: model.provider, id: model.id }, messages: body, options: requestOptions }));
    return lazyStream(model, async () => {
      try { await execution.revalidate(); } catch (error) { return block(error); }
      let previous: AssistantMessage | undefined; try { previous = await saved(); } catch (error) { return block(error); }
      if (previous) { const response = await remember(previous, false), events = createAssistantMessageEventStream(); events.end(response); return events; }
      if (!execution.imageInput && hasUserImages(messages.messages)) {
        if (!companionOffered(claim)) return block(new BotExecutionImageError());
        messages = { ...messages, messages: withImageReferences(messages.messages) };
      }
      try {
        await reserve();
        await runtime.commit(async (tx) => { const binding = await tx.doc(BotExecutionDoc, runtime.taskId); binding.dispatchIds ??= []; if (!binding.dispatchIds.includes(dispatchId)) { if (binding.dispatchIds.length >= 256) throw new Error("This task's provider receipt history is full."); binding.dispatchIds.push(dispatchId); } return undefined; }, context);
        await execution.beforeDispatch?.(dispatchId); await execution.revalidate(); await execution.started?.();
      } catch (error) { return block(error); }
      options?.signal?.throwIfAborted();
      const events = execution.models.streamSimple(model, messages, options);
      return proxyBound(events, {
        [Symbol.asyncIterator]: async function* () { for await (const event of events) { if (event.type === "done") await remember(event.message); else if (event.type === "error") await remember(event.error); yield event; } },
        result: async () => remember(await events.result()),
      });
    });
  };
  return proxyBound(execution.models, {
    getModel: (provider: string, modelId: string) => provider === execution.model.provider && modelId === execution.model.id ? execution.model : undefined,
    streamSimple: stream,
    completeSimple: ((...args) => stream(...args).result()) as Models["completeSimple"],
    fetchDeferred: (async (model, handle, options) => {
      exact(model);
      const prior = deferred.get(fingerprint(handle));
      if (!prior && (state.handle === undefined || fingerprint(state.handle) !== fingerprint(handle))) throw new Error("This deferred response has no admitted dispatch.");
      try {
      await execution.revalidate();
      // Recovery authenticates the original handle/dispatch association too.
      const dispatchId = await originatingDispatch(handle);
      const { saved, remember, reserve } = operation(fingerprint({ model: { provider: model.provider, id: model.id }, handle }), dispatchId, prior ? ++prior.polls : undefined);
      const previous = await saved(); if (previous) return remember(previous, false);
      // This polls the already admitted dispatch. It must not open a second
      // budget reservation, or the legitimate pending receipt would block it.
      await reserve();
      const signal = combinedSignal(options?.signal, runtime.signal, execution.signal); signal?.throwIfAborted();
      return remember(await execution.models.fetchDeferred(model, handle, { ...options, signal }));
      } catch (error) { return block(error); }
    }) as Models["fetchDeferred"],
    cancelDeferred: (async (model, handle, options) => { exact(model); await execution.revalidate(); await originatingDispatch(handle); const signal = combinedSignal(options?.signal, runtime.signal, execution.signal); signal?.throwIfAborted(); await execution.models.cancelDeferred(model, handle, { ...options, signal }); }) as Models["cancelDeferred"],
  });
}
export function createBotExecutionRegistry(botId: string, registry: RegistryReader, port: BotExecutionPort, options: { prepareRegistry?(): Promise<RegistrySnapshot>; onBlocked?(claim: BotExecutionClaim, message: string, kind: "spending_unknown" | "unavailable"): Promise<void> } = {}) {
  let harness: Harness | undefined;
  async function resolveSources<I, S, R, H extends object>(runtime: TaskRuntime<I, S, R, H>, ids: readonly number[], context: Context): Promise<BotExecutionClaim> {
    if (!harness || ids.length === 0 || ids.length > 64) throw new Error("This execution has no admitted input binding.");
    const claims: BotExecutionClaim[] = [];
    for (const id of ids) {
      const input = await (await harness.submission(id as SubmissionId, context))?.status(context);
      if (!input || input.type !== "input" || input.conversationId !== runtime.conversationId || input.status === "queued" || !input.requestId || input.entry === undefined) throw new Error("The execution source does not match its placed input.");
      const entry = await runtime.entry(input.entry, context), data = entry?.data;
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data[BOT_EXECUTION_INPUT_KEY] !== "string") throw new Error("This input's execution choice is missing. Send it again after reviewing its model.");
      const selected = await port.getClaim(botId, data[BOT_EXECUTION_INPUT_KEY], input.requestId);
      if (selected.submissionId && selected.submissionId !== String(input.id)) throw new Error("The source input differs from its protected submission receipt.");
      if (selected.peer) { const origin = parseBotPeerInputOrigin(data.peerOrigin); if (entry?.kind !== BOT_PEER_INPUT_KIND || data.peerRequestId !== input.requestId || !origin || origin.exchangeId !== selected.peer.exchangeId || origin.deliveryId !== selected.peer.deliveryId || origin.kind !== selected.peer.kind) throw new Error("The peer input lost its exact typed host provenance."); }
      else if (entry?.kind === BOT_PEER_INPUT_KIND || data.peerOrigin !== undefined) throw new Error("This peer input has no protected delegation authority.");
      if (!selected.submissionId && port.recordSubmission) { await port.recordSubmission(botId, selected.id, String(input.id)); selected.submissionId = String(input.id); }
      claims.push(selected);
    }
    const claim = claims[0]!;
    if (claims.some((item) => item.id !== claim.id)) throw new Error("Inputs with distinct execution bindings cannot share a model request.");
    return claim;
  }
  function wrap<I, S extends { phase: string }, R, H extends object>(original: Task<I, S, R, H>): Task<I, S, R, H> {
    async function invoke(task: Parameters<typeof original.definition.abort>[0], runtime: TaskRuntime<I, S, R, H>, context: Context, phase: string, handler: typeof original.definition.abort) {
      let binding = await runtime.snapshot(BotExecutionDoc, runtime.taskId, context);
      if (!binding?.sourceInputs?.length && !binding?.claimId) {
        const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
        if (original.definition.name !== GenerationTask.definition.name || live?.run?.taskId !== runtime.taskId) throw new Error("A task is missing its durable execution binding.");
        binding = { sourceInputs: [...live.run.inputs] };
      }
      let claim: BotExecutionClaim;
      if (binding.sourceInputs?.length) claim = await resolveSources(runtime, binding.sourceInputs, context);
      else {
        if (!binding.claimId || !binding.requestId) throw new Error("A background task has no bound model provenance.");
        claim = await port.getClaim(botId, binding.claimId, binding.requestId);
      }
      await runtime.commit(async (tx) => { const durable = await tx.doc(BotExecutionDoc, runtime.taskId); durable.claimId = claim.id; durable.requestId = claim.requestId; durable.sourceInputs = binding.sourceInputs ?? []; return undefined; }, context);
      const block = async (error: unknown): Promise<never> => {
        if (!options.onBlocked || runtime.signal.aborted) throw error;
        const unknown = error instanceof SpendingDispatchError && error.code === "uncertain";
        const message = error instanceof SpendingDispatchError || error instanceof BotExecutionImageError ? error.message : "This run's saved model or access is unavailable. Review its settings before resuming.";
        await runtime.commit(async (tx) => { (await tx.doc(BotExecutionDoc, runtime.taskId)).blocked = { kind: unknown ? "spending_unknown" : "unavailable", message }; return undefined; }, context);
        await options.onBlocked(claim, message, unknown ? "spending_unknown" : "unavailable");
        await new Promise<void>((resolve) => { if (runtime.signal.aborted) resolve(); else runtime.signal.addEventListener("abort", () => resolve(), { once: true }); });
        throw runtime.signal.reason ?? new Error("This run is waiting for the person.");
      };
      // Accounting is an offline consequence of an already known response;
      // it must not depend on credentials still being usable for new work.
      await runtime.commit(async (tx) => { const saved = await tx.doc(BotCostReceiptScopeDoc, runtime.conversationId); if (saved.nonce === "") saved.nonce = randomUUID(); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(saved.nonce)) throw new Error("This execution's response evidence scope is unavailable."); return undefined; }, context);
      const responseScopeId = (await runtime.snapshot(BotCostReceiptScopeDoc, runtime.conversationId, context))!.nonce;
      try { await reconcileBotExecutionResponses(botId, String(runtime.taskId), responseScopeId, (await runtime.getTask(runtime.taskId, context))?.memos, port); }
      catch (error) { return block(error); }
      let execution: BotExecutionRuntime;
      const resolve = () => claimScope(claim, () => port.resolve(botId, claim, runtime.signal));
      try { execution = await resolve(); }
      catch (error) {
        if (phase === "abort") throw error;
        // Only a typed setup failure before prepare may select a separately
        // approved fallback. Prepared, dispatched, authority and budget errors
        // never reach this branch.
        if (!(error instanceof BotRoutineModelUnavailableError) || phase !== "prepare" && phase !== "select" || !claim.fallback || claim.startedAt || claim.actual !== "primary") return block(error);
        await port.selectFallback(botId, claim.id, error.reason); claim = await port.getClaim(botId, claim.id, claim.requestId); execution = await resolve();
      }
      const selected = claim.actual === "fallback" ? claim.fallback! : claim.primary;
      const prepared = task.state.checkpoint as S & { model?: { provider: string; modelId: string }; thinkingLevel?: string };
      if (prepared.model && (prepared.model.provider !== execution.model.provider || prepared.model.modelId !== execution.model.id || prepared.thinkingLevel !== undefined && prepared.thinkingLevel !== selected.thinkingLevel)) { execution.release(); throw new Error("Prepared model settings disagree with the durable execution choice."); }
      let settledTerminal = false;
      const verifyCostApproval = port.verifyCostApproval ?? (async () => false);
      const boundModels = executionModels(runtime, execution, claim, original.definition.name, phase, task.state.checkpoint, context, binding.dispatchGeneration ?? 0, responseScopeId, port, block, () => { settledTerminal = true; }, verifyCostApproval);
      const scoped = proxyBound(runtime, {
        agent: async (at: Context) => ({ ...await runtime.agent(at), model: { provider: execution.model.provider, modelId: execution.model.id }, thinkingLevel: selected.thinkingLevel }),
        models: boundModels,
        get settings() { const settings = runtime.settings; return settledTerminal ? { ...settings, retry: { ...settings.retry, enabled: false }, compaction: { ...settings.compaction, enabled: false, modelOverrides: {} } } : settings; },
        commit: ((change, at) => runtime.commit(async (tx, current) => {
          const generations: { id: TaskId; conversationId: typeof runtime.conversationId }[] = [];
          const decorated = proxyBound(tx, { createTask: (async (definition, input, options) => {
            const id = await tx.createTask(definition, input, options), kind = definition.definition.name;
            if (kind === GenerationTask.definition.name) generations.push({ id, conversationId: options.conversationId ?? runtime.conversationId });
            else if (kind === ToolTask.definition.name || kind === CompactionTask.definition.name) { const child = await tx.doc(BotExecutionDoc, id); child.claimId = claim.id; child.requestId = claim.requestId; child.sourceInputs = binding!.sourceInputs ?? []; }
            return id;
          }) as Tx["createTask"] });
          const next = await change(decorated, current);
          for (const created of generations) {
            const final = await tx.doc(LiveDoc, created.conversationId);
            if (final.run?.taskId !== created.id || !final.run.inputs.length) throw new Error("New generation has no exact staged input owner.");
            const child = await tx.doc(BotExecutionDoc, created.id); child.sourceInputs = [...final.run.inputs];
          }
          return next;
        }, at)) as TaskRuntime<I, S, R, H>["commit"],
      });
      let active = true;
      const helpers: BotExecutionRuntime[] = [];
      const helperNames = new Set<string>();
      const owned: BotExecutionScope = { botId, claim, taskId: String(runtime.taskId), scopeId: responseScopeId, requestIds: [claim.requestId], runtime: { ...execution, models: boundModels }, active: () => active,
        bindHelperRuntime(kind, helper) { if (!active || helperNames.has(kind)) throw new Error("The helper's originating task ended or its identity was reused."); helperNames.add(kind); helpers.push(helper); return executionModels(runtime, helper, claim, `${original.definition.name}:${kind}`, phase, task.state.checkpoint, context, binding.dispatchGeneration ?? 0, responseScopeId, port, block, () => { settledTerminal = true; }, verifyCostApproval); },
      };
      const run = () => scope.run(owned, async () => {
        await execution.revalidate();
        if (phase !== "abort") { try { owned.registrySnapshot = await options.prepareRegistry?.(); } catch (error) { return block(error); } }
        if (!execution.imageInput && original.definition.name === GenerationTask.definition.name && phase === "prepare" && !companionOffered(claim)) {
          for (const id of binding.sourceInputs ?? []) { const source = await (await harness!.submission(id as SubmissionId, context))?.status(context); const entry = source?.entry === undefined ? undefined : await runtime.entry(source.entry, context); if (entry?.model && hasUserImages(entry.model)) return block(new BotExecutionImageError()); }
        }
        await handler(task, scoped, context);
        if ((phase === "abort" || settledTerminal) && original.definition.name === GenerationTask.definition.name) await port.dismissed?.(botId, claim);
      });
      try { await claimScope(claim, run); }
      finally { active = false; for (const helper of helpers) helper.release(); execution.release(); }
    }
    const phases = Object.fromEntries(Object.entries(original.definition.phases).map(([phase, handler]) => [phase, (task: Parameters<typeof original.definition.abort>[0], runtime: TaskRuntime<I, S, R, H>, context: Context) => invoke(task, runtime, context, phase, handler as typeof original.definition.abort)])) as typeof original.definition.phases;
    return defineTask({ ...original.definition, phases, abort: async (task, runtime, context) => {
      try { await invoke(task, runtime, context, "abort", original.definition.abort); }
      catch (error) {
        if (runtime.signal.aborted) throw error;
        // Revoked credentials cannot cancel a provider-side handle. Settle the
        // exact local task without consulting replacement or ambient auth.
        await original.definition.abort(task, proxyBound(runtime, { models: proxyBound(runtime.models, { getModel: () => undefined }) }), context);
        if (original.definition.name === GenerationTask.definition.name) {
          const saved = await runtime.snapshot(BotExecutionDoc, runtime.taskId, context);
          if (saved?.claimId && saved.requestId) { const claim = await port.getClaim(botId, saved.claimId, saved.requestId).catch(() => undefined); if (claim) await port.dismissed?.(botId, claim); }
        }
      }
    } });
  }
  const replacements = new Map([wrap(GenerationTask), wrap(ToolTask), wrap(CompactionTask)].map((task) => [task.definition.name, task]));
  return {
    snapshot() { const original = registry.snapshot(), selected = () => botExecutionScope(botId)?.registrySnapshot ?? original; return { installed: () => selected().installed(), extension: (name: string) => selected().extension(name), tools: () => selected().tools(), sections: () => selected().sections(), tasks: () => original.tasks().map((task) => replacements.get(task.definition.name) ?? task), task: (name: string) => replacements.get(name) ?? original.task(name) }; },
    subscribe: registry.subscribe.bind(registry),
    attachHarness(value: Harness) { harness = value; },
  } satisfies RegistryReader & { attachHarness(harness: Harness): void };
}
