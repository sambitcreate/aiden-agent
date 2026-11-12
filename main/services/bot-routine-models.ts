import { createHash, randomUUID } from "node:crypto";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { BOT_ROUTINE_THINKING_LEVELS, parseBotRoutineModelId, parseBotRoutineModelSave, parseBotRoutineModelSettings, type BotRoutineModelCatalog, type BotRoutineModelChoice, type BotRoutineModelResult, type BotRoutineModelRun, type BotRoutineModelSave, type BotRoutineModelSettings, type BotRoutineThinkingLevel } from "../../renderer/shared/bot-routine-models.js";
import { assertBoundBotProviderModelCurrent, bindBotProviderModel, parseBoundBotProviderModel, type BoundBotProviderModel } from "./bot-capability-bindings.js";
import type { BotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import { createKeyedSerial } from "./bot-routine-notes.js";
import { withBotConnectorTaskScope, type BotConnectorExecutionRestriction } from "./bot-connector-inventory-scope.js";
import { inspectBotPeerInputOrigin, parseBotPeerExecutionBinding, type BotPeerExecutionBinding, type BotPeerInputOrigin, type BotPeerRootBudget } from "./bot-peers/authority.js";
import { botExecutionBudgetOwner, botExecutionRootBudget } from "./bot-peers/budget.js";
import type { BotRoutineInputOrigin } from "./bot-runtime/bot-input-entry.js";
import { normalizeSpendingDispatch, type SpendingDispatchInput } from "./spending-dispatch-ledger.js";

export interface BotRoutineModelLifetime { signal: AbortSignal; assertCurrent(): void | Promise<void> }
export interface BotExecutionModelChoice { binding: BoundBotProviderModel; thinkingLevel: BotRoutineThinkingLevel }
function preparedChoiceHash(identity: { botIncarnation: string; routineIncarnation?: string }, primary: BotExecutionModelChoice, vision: BoundBotProviderModel | undefined, fallback: BotExecutionModelChoice | undefined): string {
  const route = (binding: BoundBotProviderModel) => ({ provider: binding.sourceProviderId, model: binding.sourceModelId });
  const choice = (value: BotExecutionModelChoice) => ({ ...route(value.binding), thinkingLevel: value.thinkingLevel });
  // Credential/availability repairs never change which route was chosen.
  return digest({ identity, primary: choice(primary), vision: vision ? route(vision) : undefined, fallback: fallback ? choice(fallback) : undefined });
}
export class BotRoutineModelPreparationChangedError extends Error {
  readonly name = "BotRoutineModelPreparationChangedError";
  constructor() { super("The prepared event's original model choice changed before ownership was saved."); }
}
export interface BotExecutionClaim {
  version: 1; id: string; botId: string; requestId: string; botIncarnation: string;
  routineId?: string; routineIncarnation?: string; configRevision?: string;
  primary: BotExecutionModelChoice; fallback?: BotExecutionModelChoice;
  vision?: BoundBotProviderModel;
  actual: "primary" | "fallback"; fallbackReason?: "model_unavailable" | "credentials_unavailable";
  admittedAt: number; startedAt?: number; submissionId?: string; scheduledFor?: number; timezone?: string;
  triggerKind?: BotRoutineInputOrigin["kind"]; connectorServerId?: string; connectorRestriction?: BotConnectorExecutionRestriction;
  /** Host-owned budget attribution. Future peer roots extend this, never model input. */
  root: BotPeerRootBudget;
  peer?: BotPeerExecutionBinding;
  /** Write-once root expiry prevents an old tool replay resetting peer limits. */
  peerRoot?: { id: string; expiresAt: number };
  /** Accepted routine notification preference; later edits cannot turn a quiet fire loud. */
  deliveryQuiet?: true;
}
interface Config extends BotRoutineModelSettings { botIncarnation: string; routineIncarnation: string; primary?: BotExecutionModelChoice; fallback?: BotExecutionModelChoice }
interface Receipt { id: string; signature: string; expiresAt: number }
export type BotCostApprovalFacts = { version: 1; botId: string; sourceClaimId: string; sourceRequestId: string; ownerClaimId: string; taskId: string; scopeId: string; requestId: string; submissionId: string; dispatchId: string; costReceiptId: string; fromGeneration: number; toGeneration: number };
type CostApproval = { id: string; issuedAt: number; botIncarnation: string; facts: BotCostApprovalFacts };
/** Only a host-observed transport result may issue this digest, never a SQLite hint. */
export type BotProviderResponseFacts = { version: 1; botId: string; claimId: string; requestId: string; taskId: string; scopeId: string; memoKey: string; dispatchId: string; envelopeDigest: string; responseDigest: string };
export type BotProviderResponseSlot = Omit<BotProviderResponseFacts, "envelopeDigest" | "responseDigest">;
interface FinancialRoot { root: BotPeerRootBudget; botIncarnation: string }
type ResponseEvidence = { botIncarnation: string; facts: BotProviderResponseFacts; dispatch: SpendingDispatchInput; observed: boolean; financialRoot?: FinancialRoot; retired?: true; reportedCostUsd?: number };
interface State { version: 1; configs: Config[]; claims: BotExecutionClaim[]; receipts: Receipt[]; costApprovals: CostApproval[]; responseEvidence: ResponseEvidence[] }
export interface BotRoutineModelServiceOptions {
  /** Production uses the authenticated, rollback-fenced capability document. */
  persistence: { read(): Promise<string | null>; write(previous: string | null, next: string, assertCurrent: () => Promise<void>, isCurrent: () => boolean): Promise<void> };
  identity(botId: string, routineId?: string): Promise<{ botIncarnation: string; routineIncarnation?: string }>;
  snapshot(retained?: readonly { sourceProviderId: string; sourceModelId: string }[]): Promise<BotCapabilityCatalogSnapshot>;
  metadata(providerId: string, modelId: string): Promise<Model<Api>>;
  defaultChoice(botId: string): Promise<BotExecutionModelChoice>;
  deliveryQuiet?(botId:string,routineId:string):Promise<boolean>;
  companionChoice?(botId: string): Promise<BoundBotProviderModel | undefined>;
  now?(): number;
  changed?(botId: string): void;
}
/** Issued only after private store lookup/current host ownership; copied JSON cannot mint a grant. */
export interface BotRoutineModelGrant { readonly claimId: string }
const issuedGrants = new WeakMap<object, { claim: BotExecutionClaim; binding: BoundBotProviderModel; assertCurrent(): Promise<void> }>();
export function inspectBotRoutineModelGrant(value: unknown): { claim: BotExecutionClaim; binding: BoundBotProviderModel; assertCurrent(): Promise<void> } {
  const proof = value && typeof value === "object" ? issuedGrants.get(value) : undefined;
  if (!proof) throw new Error("Routine model authority was not issued by the host."); return proof;
}
export class BotRoutineModelUnavailableError extends Error {
  readonly name = "BotRoutineModelUnavailableError";
  constructor(readonly reason: "model_unavailable" | "credentials_unavailable", message = "This routine's selected model is unavailable. Review its Model settings.") { super(message); }
}
class BotRoutineModelSelectionError extends Error {}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
function freezeDeep<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); } return value; }
function choicePublic(value: BotExecutionModelChoice): BotRoutineModelChoice { return { providerId: value.binding.providerOption.id, modelId: value.binding.modelOption.id, thinkingLevel: value.thinkingLevel }; }
function executableLevels(model: Model<Api>): BotRoutineThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}
export function botRoutineModelThinkingLevels(model: Model<Api>): BotRoutineThinkingLevel[] { return executableLevels(model); }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function parseCostApprovalFacts(value: BotCostApprovalFacts): BotCostApprovalFacts {
  if (!value || Object.keys(value).sort().join(",") !== "botId,costReceiptId,dispatchId,fromGeneration,ownerClaimId,requestId,scopeId,sourceClaimId,sourceRequestId,submissionId,taskId,toGeneration,version" || value.version !== 1 || !/^[1-9][0-9]{0,31}$/u.test(value.taskId) || !/^[1-9][0-9]{0,31}$/u.test(value.submissionId) || !/^cost_[a-f0-9]{64}$/u.test(value.costReceiptId) || !validTime(value.fromGeneration) || value.toGeneration !== value.fromGeneration + 1 || !Number.isSafeInteger(value.toGeneration)) throw new Error("Invalid private cost approval.");
  for (const id of [value.botId, value.sourceClaimId, value.sourceRequestId, value.ownerClaimId, value.scopeId, value.requestId, value.dispatchId]) parseBotRoutineModelId(id);
  return { version: 1, botId: value.botId, sourceClaimId: value.sourceClaimId, sourceRequestId: value.sourceRequestId, ownerClaimId: value.ownerClaimId, taskId: value.taskId, scopeId: value.scopeId, requestId: value.requestId, submissionId: value.submissionId, dispatchId: value.dispatchId, costReceiptId: value.costReceiptId, fromGeneration: value.fromGeneration, toGeneration: value.toGeneration };
}
function parseResponseFacts(value: BotProviderResponseFacts): BotProviderResponseFacts {
  if (!value || Object.keys(value).sort().join(",") !== "botId,claimId,dispatchId,envelopeDigest,memoKey,requestId,responseDigest,scopeId,taskId,version" || value.version !== 1 || !/^[1-9][0-9]{0,31}$/u.test(value.taskId) || !/^aiden\.execution\.response\.[a-f0-9]{64}$/u.test(value.memoKey) || !/^[a-f0-9]{64}$/u.test(value.envelopeDigest) || !/^[a-f0-9]{64}$/u.test(value.responseDigest)) throw new Error("Invalid protected provider response evidence.");
  for (const id of [value.botId, value.claimId, value.requestId, value.scopeId, value.dispatchId]) parseBotRoutineModelId(id);
  return { version: 1, botId: value.botId, claimId: value.claimId, requestId: value.requestId, taskId: value.taskId, scopeId: value.scopeId, memoKey: value.memoKey, dispatchId: value.dispatchId, envelopeDigest: value.envelopeDigest, responseDigest: value.responseDigest };
}
function parseFinancialRoot(value: FinancialRoot): FinancialRoot {
  if (!value || Object.keys(value).sort().join(",") !== "botIncarnation,root" || typeof value.botIncarnation !== "string" || !value.botIncarnation || !value.root || Object.keys(value.root).some((key) => !["botId", "requestId", "routineRunId"].includes(key))) throw new Error("Invalid saved financial root.");
  for (const id of [value.root.botId, value.root.requestId, ...(value.root.routineRunId !== undefined ? [value.root.routineRunId] : [])]) parseBotRoutineModelId(id);
  return clone(value);
}
function validReportedCost(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9; }
function parsePrivateChoice(value: unknown): BotExecutionModelChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid private routine model choice.");
  const row = value as BotExecutionModelChoice;
  if (Object.keys(row).some((key) => key !== "binding" && key !== "thinkingLevel") || !BOT_ROUTINE_THINKING_LEVELS.includes(row.thinkingLevel)) throw new Error("Invalid private routine model choice.");
  return { binding: parseBoundBotProviderModel(row.binding), thinkingLevel: row.thinkingLevel };
}
export function createBotRoutineModelService(options: BotRoutineModelServiceOptions) {
  const serial = createKeyedSerial(), clock = options.now ?? Date.now;
  const now = () => { const value = clock(); if (!validTime(value)) throw new Error("The routine model clock is invalid."); return value; };
  const revokedBots = new Set<string>();
  const loaded = new WeakMap<State, string | null>();
  async function load(): Promise<State> {
    const bytes = await options.persistence.read();
      if (bytes === null) { const state: State = { version: 1, configs: [], claims: [], receipts: [], costApprovals: [], responseEvidence: [] }; loaded.set(state, null); return state; }
      if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Unsafe routine model storage.");
      const value = JSON.parse(bytes) as State;
      if (!["claims,configs,receipts,version", "claims,configs,costApprovals,receipts,version", "claims,configs,costApprovals,receipts,responseEvidence,version"].includes(Object.keys(value).sort().join(",")) || value.version !== 1 || !Array.isArray(value.configs) || value.configs.length > 1024 || !Array.isArray(value.claims) || value.claims.length > 4096 || !Array.isArray(value.receipts) || value.receipts.length > 512 || value.costApprovals !== undefined && (!Array.isArray(value.costApprovals) || value.costApprovals.length > 4096) || value.responseEvidence !== undefined && (!Array.isArray(value.responseEvidence) || value.responseEvidence.length > 4096)) throw new Error("Invalid routine model storage.");
      value.costApprovals ??= [];
      value.responseEvidence ??= [];
      for (const evidence of value.responseEvidence) {
        if (!evidence.botIncarnation || typeof evidence.observed !== "boolean" || Object.keys(evidence).some((key) => !["botIncarnation", "dispatch", "facts", "observed", "financialRoot", "retired", "reportedCostUsd"].includes(key)) || evidence.retired !== undefined && evidence.retired !== true || evidence.retired && !evidence.financialRoot || evidence.reportedCostUsd !== undefined && (!evidence.observed || !validReportedCost(evidence.reportedCostUsd))) throw new Error("Invalid saved response evidence.");
        evidence.facts = parseResponseFacts(evidence.facts); evidence.dispatch = normalizeSpendingDispatch(evidence.dispatch); if (evidence.facts.dispatchId !== evidence.dispatch.dispatchId || evidence.dispatch.owner.kind !== "bot" || evidence.dispatch.owner.id !== evidence.facts.botId) throw new Error("The saved response evidence belongs to another dispatch.");
        if (evidence.financialRoot) evidence.financialRoot = parseFinancialRoot(evidence.financialRoot);
      }
      if (new Set(value.responseEvidence.map((row) => digest(responseSlot(row.facts)))).size !== value.responseEvidence.length) throw new Error("Duplicate saved response evidence.");
      for (const approval of value.costApprovals) { if (!approval.id || !validTime(approval.issuedAt) || !approval.botIncarnation || Object.keys(approval).sort().join(",") !== "botIncarnation,facts,id,issuedAt") throw new Error("Invalid saved cost approval."); parseCostApprovalFacts(approval.facts); }
      if (new Set(value.costApprovals.map((row) => row.id)).size !== value.costApprovals.length) throw new Error("Duplicate saved cost approvals.");
      for (const config of value.configs) {
        parseBotRoutineModelSettings({ botId: config.botId, routineId: config.routineId, revision: config.revision, selection: config.selection, updatedAt: config.updatedAt, ...(config.lastMutationId ? { lastMutationId: config.lastMutationId } : {}) });
        if (!config.botIncarnation || !config.routineIncarnation || config.selection.mode === "selected" && (!config.primary || !config.selection.primary)) throw new Error("Invalid routine model grant anchors.");
        if (config.primary) config.primary = parsePrivateChoice(config.primary); if (config.fallback) config.fallback = parsePrivateChoice(config.fallback);
        if (config.selection.mode === "inherit" ? config.primary || config.fallback : digest(config.selection.primary) !== digest(choicePublic(config.primary!)) || Boolean(config.selection.fallback) !== Boolean(config.fallback) || config.fallback && digest(config.selection.fallback) !== digest(choicePublic(config.fallback))) throw new Error("The routine's public choice and private grant disagree.");
      }
      for (const claim of value.claims) {
        if (claim.version !== 1 || !claim.id || !claim.botId || !claim.requestId || !claim.botIncarnation || !validTime(claim.admittedAt) || !claim.root || (!claim.peer && claim.root.botId !== claim.botId) || typeof claim.root.requestId !== "string" || !["primary", "fallback"].includes(claim.actual) || claim.actual === "fallback" && !claim.fallback) throw new Error("Invalid execution model claim.");
        if (claim.deliveryQuiet !== undefined && claim.deliveryQuiet !== true) throw new Error("Invalid accepted notification preference.");
        if (claim.peer) { claim.peer = parseBotPeerExecutionBinding(claim.peer); if (claim.peer.recipientBotId !== claim.botId || digest(claim.peer.root) !== digest(claim.root)) throw new Error("The peer claim has a different protected root."); }
        if (claim.peerRoot) { if (Object.keys(claim.peerRoot).sort().join(",") !== "expiresAt,id" || !validTime(claim.peerRoot.expiresAt)) throw new Error("Invalid protected peer root expiry."); parseBotRoutineModelId(claim.peerRoot.id); }
        claim.primary = parsePrivateChoice(claim.primary); if (claim.fallback) claim.fallback = parsePrivateChoice(claim.fallback);
        if (claim.vision) claim.vision = parseBoundBotProviderModel(claim.vision);
      }
      if (new Set(value.claims.map((claim) => claim.id)).size !== value.claims.length || value.receipts.some((receipt) => !receipt.id || !/^[a-f0-9]{64}$/u.test(receipt.signature) || !validTime(receipt.expiresAt))) throw new Error("Invalid routine model receipts.");
      loaded.set(value, bytes); return value;
  }
  async function saveState(state: State, current: () => Promise<void>, isCurrent: () => boolean = () => true): Promise<void> { const next = JSON.stringify(state); if (Buffer.byteLength(next) + state.responseEvidence.filter((row) => !row.observed).length * 48 + state.responseEvidence.filter((row) => !row.retired).length * 16 > 4 * 1024 * 1024) throw new Error("Protected provider response storage is full. No prior evidence was discarded."); await options.persistence.write(loaded.get(state) ?? null, next, current, isCurrent); loaded.set(state, next); }
  async function lifetimeCurrent(lifetime: BotRoutineModelLifetime): Promise<void> { lifetime.signal.throwIfAborted(); await lifetime.assertCurrent(); lifetime.signal.throwIfAborted(); }
  async function anchors(botId: string, routineId?: string) { parseBotRoutineModelId(botId); if (routineId) parseBotRoutineModelId(routineId); if (revokedBots.has(botId)) throw new Error("This Bot is being deleted."); const identity = await options.identity(botId, routineId); if (!identity.botIncarnation || routineId && !identity.routineIncarnation || revokedBots.has(botId)) throw new Error("This routine no longer exists."); return identity; }
  function publicConfig(value: Config): BotRoutineModelSettings { return { botId: value.botId, routineId: value.routineId, revision: value.revision, selection: clone(value.selection), updatedAt: value.updatedAt, ...(value.lastMutationId ? { lastMutationId: value.lastMutationId } : {}) }; }
  function currentConfig(state: State, botId: string, routineId: string, identity: Awaited<ReturnType<typeof anchors>>): Config {
    return state.configs.find((config) => config.botId === botId && config.routineId === routineId && config.botIncarnation === identity.botIncarnation && config.routineIncarnation === identity.routineIncarnation) ?? { botId, routineId, revision: `inherit_${digest({ botId, routineId, ...identity })}`, selection: { mode: "inherit" }, updatedAt: 0, botIncarnation: identity.botIncarnation, routineIncarnation: identity.routineIncarnation! };
  }
  async function bind(choice: BotRoutineModelChoice, snapshot: BotCapabilityCatalogSnapshot): Promise<BotExecutionModelChoice> {
    const binding = bindBotProviderModel({ ...choice, catalogRevision: snapshot.catalog.revision, snapshot });
    const model = await options.metadata(binding.sourceProviderId, binding.sourceModelId);
    if (!executableLevels(model).includes(choice.thinkingLevel)) throw new BotRoutineModelSelectionError("This model does not support the selected thinking level.");
    return { binding, thinkingLevel: choice.thinkingLevel };
  }
  /**
   * The Bot's own model has no thinking setting of its own, so an inherited
   * choice takes the nearest level that model supports rather than one it
   * would refuse. Unreadable metadata leaves the choice for the run to refuse.
   */
  async function inheritedChoice(botId: string): Promise<BotExecutionModelChoice> {
    const choice = await options.defaultChoice(botId);
    let model: Model<Api>;
    try { model = await options.metadata(choice.binding.sourceProviderId, choice.binding.sourceModelId); } catch { return choice; }
    const thinkingLevel = clampThinkingLevel(model, choice.thinkingLevel);
    return thinkingLevel === choice.thinkingLevel || !executableLevels(model).includes(thinkingLevel) ? choice : { ...choice, thinkingLevel };
  }
  async function read(botId: string, routineId: string): Promise<BotRoutineModelSettings> { return serial("store", async () => publicConfig(currentConfig(await load(), botId, routineId, await anchors(botId, routineId)))); }
  async function catalog(botId: string, routineId: string): Promise<BotRoutineModelCatalog> {
    await anchors(botId, routineId); const state = await load(), config = currentConfig(state, botId, routineId, await anchors(botId, routineId));
    const snapshot = await options.snapshot([config.primary, config.fallback].filter((item): item is BotExecutionModelChoice => Boolean(item)).map(({ binding }) => ({ sourceProviderId: binding.sourceProviderId, sourceModelId: binding.sourceModelId })));
    const providers = await Promise.all(snapshot.resources.providers.map(async (provider) => ({ ...provider.option, models: await Promise.all(provider.models.map(async (model) => {
      let thinkingLevels: BotRoutineThinkingLevel[] = [], available = model.option.available;
      try { thinkingLevels = executableLevels(await options.metadata(provider.sourceId, model.sourceId)); } catch { available = false; }
      return { ...model.option, supportsImages: model.option.supportsImages === true, available, thinkingLevels };
    })) })));
    for (const retained of [config.primary, config.fallback]) {
      if (!retained) continue;
      let provider = providers.find((row) => row.id === retained.binding.providerOption.id);
      if (!provider) { provider = { ...retained.binding.providerOption, available: false, models: [] }; providers.unshift(provider); }
      if (!provider.models.some((row) => row.id === retained.binding.modelOption.id)) provider.models.unshift({ ...retained.binding.modelOption, available: false, supportsImages: retained.binding.modelOption.supportsImages === true, thinkingLevels: [retained.thinkingLevel] });
    }
    const retainedIds = new Set([config.primary, config.fallback].map((choice) => choice?.binding.modelOption.id));
    while (providers.reduce((count, row) => count + row.models.length, 0) > 512) { const row = [...providers].reverse().find((provider) => provider.models.some((model) => !retainedIds.has(model.id))); if (!row) throw new Error("Too many retained routine choices."); const index = row.models.length - 1 - [...row.models].reverse().findIndex((model) => !retainedIds.has(model.id)); row.models.splice(index, 1); }
    while (providers.length > 64) { const index = (() => { const reverse = [...providers].reverse().findIndex((row) => !row.models.some((model) => retainedIds.has(model.id))); return reverse < 0 ? -1 : providers.length - 1 - reverse; })(); if (index < 0) throw new Error("Too many retained routine providers."); providers.splice(index, 1); }
    return { revision: snapshot.catalog.revision, providers };
  }
  async function save(raw: BotRoutineModelSave, lifetime: BotRoutineModelLifetime): Promise<BotRoutineModelResult> {
    let input: BotRoutineModelSave;
    try { input = parseBotRoutineModelSave(raw); if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) throw new Error("Routine model change is too large."); } catch { return { ok: false, code: "invalid", error: "Review the routine's model selection." }; }
    return serial("store", async () => {
      try {
        await lifetimeCurrent(lifetime); const identity = await anchors(input.botId, input.routineId), state = await load();
        const config = currentConfig(state, input.botId, input.routineId, identity), signature = digest(input), receipt = state.receipts.find((row) => row.id === input.mutationId);
        if (receipt) return receipt.signature === signature ? { ok: true, settings: publicConfig(config), mutationId: input.mutationId, replayed: true } : { ok: false, code: "conflict", error: "This action identity was already used for another change.", settings: publicConfig(config) };
        if (config.revision !== input.expectedRevision) return { ok: false, code: "conflict", error: "The routine's model settings changed. Review them and try again.", settings: publicConfig(config) };
        state.receipts = state.receipts.filter((row) => row.expiresAt > now()); if (state.receipts.length >= 512) return { ok: false, code: "history_full", error: "Recent routine changes are still protected. Try again later." };
        const snapshot = await options.snapshot([config.primary, config.fallback].filter((choice): choice is BotExecutionModelChoice => Boolean(choice)).map(({ binding }) => ({ sourceProviderId: binding.sourceProviderId, sourceModelId: binding.sourceModelId }))); await lifetimeCurrent(lifetime);
        if (snapshot.catalog.revision !== input.catalogRevision) return { ok: false, code: "conflict", error: "Model choices changed. Refresh the choices and try again.", settings: publicConfig(config) };
        let choices: Pick<Config, "primary" | "fallback"> = {};
        if (input.selection.mode === "selected") choices = { primary: await bind(input.selection.primary, snapshot), ...(input.selection.fallback ? { fallback: await bind(input.selection.fallback, snapshot) } : {}) };
        const next: Config = { ...config, ...choices, revision: randomUUID(), selection: clone(input.selection), updatedAt: now(), lastMutationId: input.mutationId };
        if (input.selection.mode === "inherit") { delete next.primary; delete next.fallback; }
        else if (!input.selection.fallback) delete next.fallback;
        state.configs = state.configs.filter((row) => !(row.botId === input.botId && row.routineId === input.routineId)); state.configs.push(next);
        state.receipts.push({ id: input.mutationId, signature, expiresAt: now() + 86_400_000 });
        const current = async () => { await lifetimeCurrent(lifetime); const actual = await anchors(input.botId, input.routineId); if (JSON.stringify(actual) !== JSON.stringify(identity)) throw new Error("Routine ownership changed."); };
        await saveState(state, current, () => !lifetime.signal.aborted); await current(); options.changed?.(input.botId);
        return { ok: true, settings: publicConfig(next), mutationId: input.mutationId, replayed: false };
      } catch (error) { return error instanceof BotRoutineModelSelectionError ? { ok: false, code: "invalid", error: error.message } : { ok: false, code: "unavailable", error: "The model change could not be confirmed. Retry this same action to check its outcome." }; }
    });
  }
  /** Deny-only fingerprint: ordinary event storage never supplies a model binding. */
  async function prepareRoutineClaim(botId: string, routineId: string): Promise<string> {
    return serial("store", async () => {
      const state = await load(), identity = await anchors(botId, routineId), config = currentConfig(state, botId, routineId, identity);
      const primary = config.selection.mode === "selected" ? config.primary! : await inheritedChoice(botId);
      const vision = await options.companionChoice?.(botId), fallback = config.fallback;
      return preparedChoiceHash(identity, primary, vision, fallback);
    });
  }

  async function claim(botId: string, input: { requestId: string; peerOrigin?: BotPeerInputOrigin; routineOrigin?: BotRoutineInputOrigin; connectorServerId?: string; connectorRestriction?: BotConnectorExecutionRestriction; scheduledFor?: number; timezone?: string; retryOf?: string; expectedChoiceHash?: string }): Promise<BotExecutionClaim> {
    parseBotRoutineModelId(input.requestId);
    const peer = input.peerOrigin ? inspectBotPeerInputOrigin(input.peerOrigin) : undefined;
    if (peer && (peer.botId !== botId || peer.requestId !== input.requestId || input.routineOrigin || input.retryOf)) throw new Error("Peer execution requires its exact host delivery.");
    await peer?.assertCurrent();
    const execute = () => serial("store", async () => {
      const state = await load();
      const resumed = peer?.modelFrom ? state.claims.find((row) => row.botId === botId && row.id === peer.modelFrom!.claimId && row.requestId === peer.modelFrom!.requestId) : undefined;
      if (peer?.binding.kind === "return" && (!resumed || peer.modelFrom?.botId !== botId || digest(botExecutionRootBudget(resumed)) !== digest(peer.binding.root))) throw new Error("The peer return has no original frozen execution choice.");
      const identity = await anchors(botId, resumed?.routineId ?? input.routineOrigin?.routineId);
      if (resumed && (resumed.botIncarnation !== identity.botIncarnation || resumed.routineIncarnation !== identity.routineIncarnation)) throw new Error("The original peer execution owner changed.");
      const connectorRestriction = peer?.binding.watch?.restriction ?? input.connectorRestriction;
      const connectorServerId = connectorRestriction?.binding.serverId ?? input.connectorServerId;
      const existing = state.claims.find((row) => row.botId === botId && row.requestId === input.requestId && row.botIncarnation === identity.botIncarnation);
      if (existing) { if (existing.routineId !== (resumed?.routineId ?? input.routineOrigin?.routineId) || existing.connectorServerId !== connectorServerId || digest(existing.connectorRestriction) !== digest(connectorRestriction) || digest(existing.peer) !== digest(peer?.binding)) throw new Error("This admitted request has different execution facts."); await peer?.assertCurrent(); return clone(existing); }
      if (state.claims.length >= 4096) throw new Error("Saved execution choices are full. No admitted work was discarded.");
      const config = input.routineOrigin ? currentConfig(state, botId, input.routineOrigin.routineId, identity) : undefined;
      const original = input.retryOf ? state.claims.find((row) => row.botId === botId && row.requestId === input.retryOf && row.routineId === input.routineOrigin?.routineId && row.botIncarnation === identity.botIncarnation && row.routineIncarnation === identity.routineIncarnation) : undefined;
      if (input.retryOf && (!original || input.routineOrigin?.kind !== "retry")) throw new Error("The retry has no original accepted model binding.");
      const primary = resumed ? resumed.actual === "fallback" ? resumed.fallback! : resumed.primary : original?.primary ?? (config?.selection.mode === "selected" ? config.primary! : await inheritedChoice(botId));
      const vision = resumed ? resumed.vision : original ? original.vision : await options.companionChoice?.(botId);
      const fallback = resumed ? undefined : original ? original.fallback : config?.fallback;
      const deliveryQuiet = resumed ? resumed.deliveryQuiet : original ? original.deliveryQuiet : input.routineOrigin && await options.deliveryQuiet?.(botId,input.routineOrigin.routineId) ? true : undefined;
      if (input.expectedChoiceHash !== undefined && (!/^[a-f0-9]{64}$/u.test(input.expectedChoiceHash) || peer || original ||
        preparedChoiceHash(identity, primary, vision, fallback) !== input.expectedChoiceHash)) throw new BotRoutineModelPreparationChangedError();
      const next: BotExecutionClaim = { version: 1, id: randomUUID(), botId, requestId: input.requestId, ...identity, primary: clone(primary), ...(vision ? { vision: clone(vision) } : {}), ...(fallback ? { fallback: clone(fallback) } : {}), actual: resumed ? "primary" : original?.actual ?? "primary", ...(!resumed && original?.fallbackReason ? { fallbackReason: original.fallbackReason } : {}), admittedAt: now(), ...(deliveryQuiet ? {deliveryQuiet:true as const}:{}), root: peer ? clone(peer.binding.root) : original?.root ?? { botId, requestId: input.requestId, ...(config ? { routineRunId: input.requestId } : {}) }, ...(peer ? { peer: clone(peer.binding) } : {}), ...(resumed?.routineId ? { routineId: resumed.routineId, configRevision: resumed.configRevision } : config ? { routineId: config.routineId, configRevision: original?.configRevision ?? config.revision, triggerKind: input.routineOrigin!.kind } : {}), ...((original?.connectorServerId ?? connectorServerId) ? { connectorServerId: original?.connectorServerId ?? connectorServerId } : {}), ...((original?.connectorRestriction ?? connectorRestriction) ? { connectorRestriction: clone((original?.connectorRestriction ?? connectorRestriction)!) } : {}), ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }), ...(input.timezone ? { timezone: input.timezone } : {}) };
      state.claims.push(next); await saveState(state, async () => { await peer?.assertCurrent(); if (JSON.stringify(await anchors(botId, next.routineId)) !== JSON.stringify(identity)) throw new Error("Execution ownership changed."); }); return clone(next);
    });
    return peer ? withBotConnectorTaskScope(peer.binding.watch?.restriction, peer.binding.watch?.restriction.binding.serverId, execute) : execute();
  }
  async function getClaim(botId: string, claimId: string, requestId: string): Promise<BotExecutionClaim> {
    const state = await load(), claim = state.claims.find((row) => row.id === claimId && row.botId === botId && row.requestId === requestId); if (!claim) throw new Error("This execution's model binding is unavailable.");
    const identity = await anchors(botId, claim.routineId); if (identity.botIncarnation !== claim.botIncarnation || identity.routineIncarnation !== claim.routineIncarnation) throw new Error("This execution's owner changed."); return clone(claim);
  }
  async function grant(botId: string, claimId: string, requestId: string): Promise<BotRoutineModelGrant> {
    const claim = await getClaim(botId, claimId, requestId), selected = claim.actual === "fallback" ? claim.fallback! : claim.primary;
    const assertCurrent = async () => {
      const actual = await getClaim(botId, claimId, requestId); if (digest(actual.primary) !== digest(claim.primary) || actual.actual !== claim.actual) throw new Error("Execution model authority changed.");
      const snapshot = await options.snapshot([{ sourceProviderId: selected.binding.sourceProviderId, sourceModelId: selected.binding.sourceModelId }]);
      const provider = snapshot.resources.providers.find((row) => row.sourceId === selected.binding.sourceProviderId);
      if (provider?.exactFingerprint === selected.binding.providerExactFingerprint && provider.option.available && !provider.models.some((row) => row.sourceId === selected.binding.sourceModelId && row.option.available)) throw new BotRoutineModelUnavailableError("model_unavailable");
      assertBoundBotProviderModelCurrent(selected.binding, snapshot);
    };
    await assertCurrent(); freezeDeep(claim); const token = Object.freeze({ claimId }); issuedGrants.set(token, Object.freeze({ claim, binding: selected.binding, assertCurrent })); return token;
  }
  async function updateClaim(botId: string, id: string, update: (claim: BotExecutionClaim) => void): Promise<void> { return serial("store", async () => { const state = await load(), claim = state.claims.find((row) => row.botId === botId && row.id === id); if (!claim) throw new Error("Execution model binding disappeared."); const before = await anchors(botId, claim.routineId); if (before.botIncarnation !== claim.botIncarnation || before.routineIncarnation !== claim.routineIncarnation) throw new Error("Execution owner changed."); update(claim); await saveState(state, async () => { if (JSON.stringify(await anchors(botId, claim.routineId)) !== JSON.stringify(before)) throw new Error("Execution owner changed."); }); }); }
  async function approvalOwners(state: State, facts: BotCostApprovalFacts): Promise<string> {
    let incarnation = "";
    for (const id of [facts.sourceClaimId, facts.ownerClaimId]) { const claim = state.claims.find((row) => row.botId === facts.botId && row.id === id); if (!claim || id === facts.sourceClaimId && claim.requestId !== facts.sourceRequestId) throw new Error("The cost approval has no protected execution owner."); const current = await anchors(facts.botId, claim.routineId); if (current.botIncarnation !== claim.botIncarnation || current.routineIncarnation !== claim.routineIncarnation) throw new Error("The cost approval owner changed."); incarnation = current.botIncarnation; }
    return incarnation;
  }
  async function responseOwner(state: State, facts: BotProviderResponseFacts): Promise<BotExecutionClaim> {
    const claim = state.claims.find((row) => row.botId === facts.botId && row.id === facts.claimId && row.requestId === facts.requestId);
    if (!claim || (await anchors(facts.botId)).botIncarnation !== claim.botIncarnation) throw new Error("The provider response has no current protected Bot owner.");
    return claim;
  }
  function responseSlot(facts: BotProviderResponseFacts): BotProviderResponseSlot { const { envelopeDigest: _envelope, responseDigest: _response, ...slot } = facts; return slot; }
  function assertResponseDispatch(claim: BotExecutionClaim, facts: BotProviderResponseFacts, dispatch: SpendingDispatchInput): void {
    const owner = botExecutionBudgetOwner(claim);
    const selected = claim.actual === "fallback" ? claim.fallback! : claim.primary;
    if (dispatch.dispatchId !== facts.dispatchId || digest(dispatch.owner) !== digest(owner) || ![selected.binding, claim.vision].some((binding) => binding?.sourceProviderId === dispatch.providerId && binding.sourceModelId === dispatch.modelId)) throw new Error("The provider response does not match its admitted dispatch owner and model.");
  }
  function financialRoot(state: State, claim: BotExecutionClaim): FinancialRoot {
    const root = botExecutionRootBudget(claim), owner = state.claims.find((row) => row.botId === root.botId && row.requestId === root.requestId && digest(botExecutionRootBudget(row)) === digest(root));
    if (!owner) throw new Error("The provider reservation has no protected original root.");
    return { root, botIncarnation: owner.botIncarnation };
  }
  function assertReservedFinancialOwner(state: State, evidence: ResponseEvidence): void {
    // A transport observation settles an already admitted obligation. Deletion
    // may revoke execution while this publication owns the store lock; it must
    // not erase the amount before the reservation can be retired.
    if (evidence.retired) return;
    const claim = state.claims.find((row) => row.botId === evidence.facts.botId && row.id === evidence.facts.claimId && row.requestId === evidence.facts.requestId && row.botIncarnation === evidence.botIncarnation);
    if (!claim) throw new Error("The provider response has no original protected financial owner.");
    assertResponseDispatch(claim, evidence.facts, evidence.dispatch);
  }
  async function financialEvidenceOwner(state: State, evidence: ResponseEvidence): Promise<void> {
    // Retirement removes executable claims, while retaining only the original
    // financial reservation and authenticated response digests/amount.
    if (evidence.retired) return;
    const claim = await responseOwner(state, evidence.facts);
    if (claim.botIncarnation !== evidence.botIncarnation) throw new Error("The provider response owner changed.");
  }
  return { read, catalog, save, claim, getClaim, grant, prepareRoutineClaim,
    async observedResponse(botId: string, claimId: string, taskId: string, responseDigest: string): Promise<boolean> { const state = await load(), evidence = state.responseEvidence.find((row) => row.observed && row.facts.botId === botId && row.facts.claimId === claimId && row.facts.taskId === taskId && row.facts.responseDigest === responseDigest); if (!evidence || evidence.retired) return false; return (await responseOwner(state, evidence.facts)).botIncarnation === evidence.botIncarnation; },
    async reservePeerRoot(botId: string, claimId: string, requestId: string): Promise<{ id: string; expiresAt: number }> { return serial("store", async () => {
      const state = await load(), source = state.claims.find((row) => row.botId === botId && row.id === claimId && row.requestId === requestId); if (!source) throw new Error("The peer source has no protected execution claim.");
      const identity = await anchors(botId, source.routineId); if (identity.botIncarnation !== source.botIncarnation || identity.routineIncarnation !== source.routineIncarnation) throw new Error("The peer source owner changed.");
      if (source.peer) return { id: source.peer.rootId, expiresAt: source.peer.expiresAt };
      const root = state.claims.find((row) => row.botId === source.root.botId && row.requestId === source.root.requestId && row.botIncarnation === source.botIncarnation); if (!root) throw new Error("The original peer budget root disappeared.");
      if (root.peerRoot) return clone(root.peerRoot);
      root.peerRoot = { id: randomUUID(), expiresAt: now() + 86_400_000 };
      await saveState(state, async () => { if ((await anchors(botId, source.routineId)).botIncarnation !== identity.botIncarnation) throw new Error("The peer source owner changed."); }); return clone(root.peerRoot);
    }); },
    async claimByRequest(botId: string, requestId: string): Promise<BotExecutionClaim | undefined> { const state=await load(), identity=await anchors(botId); const claim=state.claims.find(row=>row.botId===botId&&row.requestId===requestId&&row.botIncarnation===identity.botIncarnation); return claim ? getClaim(botId,claim.id,claim.requestId) : undefined; },
    async reserveResponseEvidence(raw: BotProviderResponseSlot, input: SpendingDispatchInput): Promise<void> { return serial("store", async () => {
      const facts = parseResponseFacts({ ...raw, envelopeDigest: "0".repeat(64), responseDigest: "0".repeat(64) }), dispatch = normalizeSpendingDispatch(input), state = await load(), claim = await responseOwner(state, facts); assertResponseDispatch(claim, facts, dispatch);
      const existing = state.responseEvidence.find((row) => digest(responseSlot(row.facts)) === digest(responseSlot(facts)));
      if (existing) { if (digest(existing.dispatch) !== digest(dispatch) || existing.retired) throw new Error("This response reservation belongs to another dispatch."); if (existing.observed) throw new Error("This provider response was already observed, but its saved body is unavailable. Dismiss this task and send a new request."); return; }
      if (state.responseEvidence.length >= 4096) throw new Error("Protected provider response history is full. No prior evidence was discarded.");
      // Fixed-width digest placeholders reserve all eventual publication bytes.
      state.responseEvidence.push({ botIncarnation: claim.botIncarnation, facts, dispatch, observed: false, financialRoot: financialRoot(state, claim) });
      if (Buffer.byteLength(JSON.stringify(state)) > 4 * 1024 * 1024) throw new Error("Protected provider response storage is full. No request was sent.");
      await saveState(state, async () => { await responseOwner(state, facts); });
    }); },
    async recordResponseEvidence(raw: BotProviderResponseFacts, input: SpendingDispatchInput, reportedCostUsd?: number): Promise<void> { return serial("store", async () => {
      if (reportedCostUsd !== undefined && !validReportedCost(reportedCostUsd)) throw new Error("Invalid protected provider reported cost.");
      const facts = parseResponseFacts(raw), dispatch = normalizeSpendingDispatch(input), state = await load();
      const existing = state.responseEvidence.find((row) => digest(responseSlot(row.facts)) === digest(responseSlot(facts)));
      if (!existing || digest(existing.dispatch) !== digest(dispatch)) throw new Error("This provider response has no matching protected pre-dispatch owner and model reservation.");
      assertReservedFinancialOwner(state, existing);
      if (existing.observed) { if (digest(existing.facts) !== digest(facts) || existing.reportedCostUsd !== reportedCostUsd) throw new Error("An observed provider response cannot be replaced."); return; }
      existing.facts = facts; existing.observed = true;
      if (reportedCostUsd !== undefined) existing.reportedCostUsd = reportedCostUsd;
      await saveState(state, async () => { assertReservedFinancialOwner(state, existing); });
    }); },
    async responseEvidence(raw: BotProviderResponseFacts): Promise<SpendingDispatchInput | undefined> {
      const facts = parseResponseFacts(raw), state = await load(), evidence = state.responseEvidence.find((row) => row.observed && digest(row.facts) === digest(facts)); if (!evidence) return undefined;
      await financialEvidenceOwner(state, evidence); return clone(evidence.dispatch);
    },
    /** Amount-only recovery can settle an authentic charge even if SQLite lost its body. */
    async responseCosts(botId: string, taskId: string, scopeId: string): Promise<{ dispatch: SpendingDispatchInput; reportedCostUsd: number }[]> {
      parseBotRoutineModelId(botId); parseBotRoutineModelId(scopeId); if (!/^[1-9][0-9]{0,31}$/u.test(taskId)) throw new Error("Invalid financial response task.");
      const state = await load(), rows = state.responseEvidence.filter((row) => row.observed && row.reportedCostUsd !== undefined && row.facts.botId === botId && row.facts.taskId === taskId && row.facts.scopeId === scopeId);
      for (const row of rows) await financialEvidenceOwner(state, row);
      return rows.map((row) => ({ dispatch: clone(row.dispatch), reportedCostUsd: row.reportedCostUsd! }));
    },
    /** A live owner/root can settle a known orphan amount without the deleted Bot's SQL file. */
    async responseCostForDispatch(claim: BotExecutionClaim, input: SpendingDispatchInput): Promise<{ dispatch: SpendingDispatchInput; reportedCostUsd: number } | undefined> {
      const live = await getClaim(claim.botId, claim.id, claim.requestId), dispatch = normalizeSpendingDispatch(input), root = botExecutionRootBudget(live);
      if (live.botIncarnation !== claim.botIncarnation || digest(root) !== digest(botExecutionRootBudget(claim))) throw new Error("The financial recovery owner changed.");
      const state = await load(), rows = state.responseEvidence.filter((row) => row.observed && row.reportedCostUsd !== undefined && digest(row.dispatch) === digest(dispatch) && (dispatch.owner.id === live.botId ? !row.retired && row.botIncarnation === live.botIncarnation : row.retired && root.botId === live.botId && row.financialRoot?.botIncarnation === live.botIncarnation && row.financialRoot.root.botId === live.botId));
      if (!rows.length) return undefined;
      if (new Set(rows.map((row) => row.reportedCostUsd)).size !== 1) throw new Error("The authenticated provider amounts disagree for this dispatch.");
      return { dispatch: clone(dispatch), reportedCostUsd: rows[0]!.reportedCostUsd! };
    },
    /** The actual live Bot may review its old obligation under its original scopes. */
    async ownedResponseReservation(claim: BotExecutionClaim, input: SpendingDispatchInput): Promise<string | undefined> {
      const live = await getClaim(claim.botId, claim.id, claim.requestId), dispatch = normalizeSpendingDispatch(input);
      if (live.botIncarnation !== claim.botIncarnation || digest(botExecutionRootBudget(live)) !== digest(botExecutionRootBudget(claim))) throw new Error("The financial recovery owner changed.");
      if (dispatch.owner.kind !== "bot" || dispatch.owner.id !== live.botId) return undefined;
      const state = await load(), rows = state.responseEvidence.filter((row) => !row.retired && row.botIncarnation === live.botIncarnation && digest(row.dispatch) === digest(dispatch));
      if (!rows.length) return undefined;
      return digest(rows.map((row) => ({ botIncarnation: row.botIncarnation, facts: responseSlot(row.facts), dispatch: row.dispatch })).sort((left, right) => digest(left).localeCompare(digest(right))));
    },
    /** Exact retired child obligation reviewed by its original root Bot, even after the old task is gone. */
    async retiredResponseReservation(claim: BotExecutionClaim, input: SpendingDispatchInput): Promise<string | undefined> {
      const live = await getClaim(claim.botId, claim.id, claim.requestId);
      if (live.botIncarnation !== claim.botIncarnation || digest(botExecutionRootBudget(live)) !== digest(botExecutionRootBudget(claim))) throw new Error("The financial recovery owner changed.");
      const root = botExecutionRootBudget(live), dispatch = normalizeSpendingDispatch(input);
      if (root.botId !== live.botId || dispatch.owner.kind !== "bot" || dispatch.owner.id === live.botId) return undefined;
      const state = await load(), rows = state.responseEvidence.filter((row) => row.retired && row.financialRoot?.botIncarnation === live.botIncarnation && row.financialRoot.root.botId === live.botId && digest(row.dispatch) === digest(dispatch));
      if (!rows.length) return undefined;
      return digest(rows.map((row) => ({ botIncarnation: row.botIncarnation, facts: responseSlot(row.facts), dispatch: row.dispatch, financialRoot: row.financialRoot })).sort((left, right) => digest(left).localeCompare(digest(right))));
    },
    async approveCost(raw: BotCostApprovalFacts): Promise<string> { return serial("store", async () => { const facts = parseCostApprovalFacts(raw), state = await load(), botIncarnation = await approvalOwners(state, facts), existing = state.costApprovals.find((row) => row.botIncarnation === botIncarnation && digest(row.facts) === digest(facts)); if (existing) return existing.id; if (state.costApprovals.length >= 4096) throw new Error("Protected cost approvals are full. No prior approval was discarded."); const id = randomUUID(); state.costApprovals.push({ id, issuedAt: now(), botIncarnation, facts }); await saveState(state, async () => { if (await approvalOwners(state, facts) !== botIncarnation) throw new Error("The cost approval owner changed."); }); return id; }); },
    async verifyCostApproval(id: string, raw: BotCostApprovalFacts): Promise<boolean> { const facts = parseCostApprovalFacts(raw), state = await load(), approval = state.costApprovals.find((row) => row.id === id && digest(row.facts) === digest(facts)); if (!approval) return false; return approval.botIncarnation === await approvalOwners(state, facts); },
    async recordSubmission(botId: string, id: string, submissionId: string) { await updateClaim(botId, id, (claim) => { if (claim.submissionId && claim.submissionId !== submissionId) throw new Error("Execution submission mismatch."); claim.submissionId = submissionId; }); },
    /**
     * A person's or Bot's message refused before it was submitted holds no work
     * yet, so its claim is dropped and a retry of the same request binds the
     * Bot's current model. Routine, peer and started claims are never dropped.
     */
    async releaseUnsubmittedClaim(botId: string, id: string, requestId: string) {
      await serial("store", async () => {
        const state = await load(), index = state.claims.findIndex((row) => row.botId === botId && row.id === id && row.requestId === requestId), claim = state.claims[index];
        if (!claim || claim.startedAt !== undefined || claim.submissionId !== undefined || claim.routineId !== undefined || claim.peer || claim.peerRoot || claim.root.botId !== botId || claim.root.requestId !== requestId) return;
        if (state.costApprovals.some((row) => row.facts.ownerClaimId === id || row.facts.sourceClaimId === id) || state.responseEvidence.some((row) => row.facts.claimId === id)) return;
        state.claims.splice(index, 1); await saveState(state, async () => {});
      });
    },
    async started(botId: string, id: string) { await updateClaim(botId, id, (claim) => { claim.startedAt ??= now(); }); },
    async selectFallback(botId: string, id: string, reason: "model_unavailable" | "credentials_unavailable") { await updateClaim(botId, id, (claim) => { if (claim.startedAt || !claim.fallback) throw new Error("Fallback is not available for dispatched work."); claim.actual = "fallback"; claim.fallbackReason = reason; }); },
    async readRuns(botId: string, routineId: string): Promise<BotRoutineModelRun[]> {
      const identity = await anchors(botId, routineId), state = await load();
      return state.claims.filter((row) => !row.peer && row.botId === botId && row.routineId === routineId && row.botIncarnation === identity.botIncarnation && row.routineIncarnation === identity.routineIncarnation).sort((a, b) => b.admittedAt - a.admittedAt).slice(0, 64).map((row) => { const selected = row.actual === "fallback" ? row.fallback! : row.primary; return { runId: row.requestId, admittedAt: row.admittedAt, triggerKind: row.triggerKind!, model: { chosen: choicePublic(row.primary), actual: choicePublic(selected), providerLabel: selected.binding.providerOption.label, modelLabel: selected.binding.modelOption.label, chosenProviderLabel: row.primary.binding.providerOption.label, chosenModelLabel: row.primary.binding.modelOption.label, ...(row.fallbackReason ? { fallbackReason: row.fallbackReason } : {}) }, ...(row.submissionId ? { submissionId: row.submissionId } : {}), ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }), ...(row.scheduledFor === undefined ? {} : { scheduledFor: row.scheduledFor }), ...(row.timezone ? { timezone: row.timezone } : {}) }; });
    },
    forgetBot(botId: string) { revokedBots.add(botId); return serial("store", async () => { const state = await load(); state.configs = state.configs.filter((row) => row.botId !== botId); state.costApprovals = state.costApprovals.filter((row) => row.facts.botId !== botId); for (const row of state.responseEvidence.filter((row) => row.facts.botId === botId)) { const owner = state.claims.find((claim) => claim.id === row.facts.claimId && claim.botId === botId && claim.requestId === row.facts.requestId); if (!row.financialRoot && owner) row.financialRoot = financialRoot(state, owner); if (!row.financialRoot) throw new Error("The retired provider obligation has no protected original root."); row.retired = true; } state.claims = state.claims.filter((row) => row.botId !== botId); await saveState(state, async () => {}); }); },
  };
}
export type BotRoutineModelService = ReturnType<typeof createBotRoutineModelService>;
