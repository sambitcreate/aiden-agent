// Private provider receipts. Amounts and dispatch identities are saved in one
// document so a crash cannot publish a charge without its deduplication fence.
import { parseSpendingDocument, type SpendingDocument, type SpendingOwner, type SpendingOwnerScope } from "./spending-core.js";

export const SPENDING_DISPATCH_LIMITS = { receipts: 20_000, scopes: 16, bytes: 32 * 1024 * 1024 } as const;

export interface SpendingDispatchInput {
  /** Stable task/phase/checkpoint identity, never regenerated on replay. */
  dispatchId: string;
  owner: SpendingOwner;
  providerId: string;
  modelId: string;
  /** False only after the selected runtime proves local or OAuth billing. */
  counts: boolean;
}

export interface SpendingDispatchReceipt extends SpendingDispatchInput {
  startedAt: number;
  /** The billing period at dispatch, so a delayed answer cannot move months. */
  monthStartDay: number;
  /** Exact dispatch-time local billing period for every Bot/root scope. */
  billingPeriods?: Record<string, string>;
  state: "pending" | "recorded" | "acknowledged_unknown";
  costUsd?: number;
  finishedAt?: number;
  acknowledgedAt?: number;
}

/** Only an explicit, current person Resume may issue this host capability. */
export interface SpendingUnknownAcknowledgement { readonly dispatchId: string }
const acknowledgements = new WeakMap<object, { dispatchId: string; owner: SpendingOwner }>();
export function issueSpendingUnknownAcknowledgement(input: { dispatchId: string; owner: SpendingOwner }): SpendingUnknownAcknowledgement {
  if (typeof input.dispatchId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.dispatchId)) throw new SpendingDispatchError("invalid", "Invalid spending acknowledgement.");
  const token = Object.freeze({ dispatchId: input.dispatchId });
  acknowledgements.set(token, { dispatchId: input.dispatchId, owner: normalizeSpendingOwner(input.owner) });
  return token;
}
export function inspectSpendingUnknownAcknowledgement(token: SpendingUnknownAcknowledgement): { dispatchId: string; owner: SpendingOwner } {
  const proof = token && typeof token === "object" ? acknowledgements.get(token) : undefined;
  if (!proof) throw new SpendingDispatchError("invalid", "Unknown spending can only be acknowledged by an explicit person Resume.");
  return structuredClone(proof);
}

export type SpendingDispatchErrorCode = "invalid" | "uncertain" | "conflict" | "capacity" | "storage" | "limit";
export class SpendingDispatchError extends Error {
  constructor(readonly code: SpendingDispatchErrorCode, message: string) {
    super(message);
    this.name = "SpendingDispatchError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !["__proto__", "prototype", "constructor"].includes(value);
}
function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
}
function time(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function scope(value: unknown): SpendingOwnerScope {
  if (!object(value) || !["chat", "bot"].includes(String(value.kind)) || !id(value.id) ||
    Object.keys(value).some(key => !["kind", "id", "run"].includes(key)) ||
    (value.run !== undefined && (value.kind !== "bot" || !id(value.run)))) throw new SpendingDispatchError("invalid", "Invalid spending owner.");
  return value.kind === "chat" ? { kind: "chat", id: value.id } : { kind: "bot", id: value.id, ...(value.run === undefined ? {} : { run: value.run as string }) };
}

/** Canonical scope order makes identity independent of repeated/ordered roots. */
export function normalizeSpendingOwner(value: unknown): SpendingOwner {
  if (!object(value) || Object.keys(value).some(key => !["kind", "id", "run", "budgetScopes"].includes(key))) throw new SpendingDispatchError("invalid", "Invalid spending owner.");
  const { budgetScopes, ...primary } = value;
  const owner = scope(primary);
  if (budgetScopes === undefined) return owner;
  if (!Array.isArray(budgetScopes) || budgetScopes.length > SPENDING_DISPATCH_LIMITS.scopes) throw new SpendingDispatchError("invalid", "Too many spending scopes.");
  const roots = new Map<string, SpendingOwnerScope>();
  for (const entry of budgetScopes) {
    const parsed = scope(entry);
    if (JSON.stringify(parsed) !== JSON.stringify(owner)) roots.set(JSON.stringify(parsed), parsed);
  }
  return { ...owner, ...(roots.size === 0 ? {} : { budgetScopes: [...roots].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry) }) };
}

export function normalizeSpendingDispatch(value: SpendingDispatchInput): SpendingDispatchInput {
  if (!object(value) || Object.keys(value).some(key => !["dispatchId", "owner", "providerId", "modelId", "counts"].includes(key)) ||
    typeof value.dispatchId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.dispatchId) ||
    !id(value.dispatchId) || !id(value.providerId) || !id(value.modelId) || typeof value.counts !== "boolean") {
    throw new SpendingDispatchError("invalid", "Invalid provider dispatch identity.");
  }
  return { dispatchId: value.dispatchId, owner: normalizeSpendingOwner(value.owner), providerId: value.providerId, modelId: value.modelId, counts: value.counts };
}

export function sameSpendingDispatch(receipt: SpendingDispatchReceipt, input: SpendingDispatchInput): boolean {
  return JSON.stringify(normalizeSpendingDispatch({ dispatchId: receipt.dispatchId, owner: receipt.owner, providerId: receipt.providerId, modelId: receipt.modelId, counts: receipt.counts })) === JSON.stringify(input);
}

/** Unresolved effects block the recipient and every overlapping root budget. */
export function pendingSpendingDispatch(document: SpendingDocument, owner: SpendingOwner): SpendingDispatchReceipt | undefined {
  const keys = (value: SpendingOwner) => new Set([value, ...(value.budgetScopes ?? [])].map(entry => `${entry.kind}:${entry.id}`));
  const wanted = keys(owner);
  return Object.values(document.dispatches ?? {}).find(receipt => receipt.state === "pending" && [...keys(receipt.owner)].some(key => wanted.has(key)));
}

/** Strict for durable money; never turn a malformed/newer journal into zero. */
export function parseDurableSpendingDocument(value: unknown): SpendingDocument {
  if (value === undefined) return parseSpendingDocument(undefined);
  if (!object(value) || (value.version !== 1 && value.version !== 2) ||
    Object.keys(value).some(key => !["version", "chats", "bots", "botLimits", "runs", "dispatches", "botPeriods"].includes(key))) throw new SpendingDispatchError("storage", "Saved spending data is unavailable. Restore the last valid backup before sending more requests.");
  const table = (entry: unknown) => {
    if (!object(entry) || Object.keys(entry).length > 20_000 || Object.keys(entry).some(key => !id(key))) throw new SpendingDispatchError("storage", "Saved spending balances are invalid.");
    return Object.values(entry);
  };
  for (const entry of table(value.chats)) if (!object(entry) || !amount(entry.spentUsd) || !amount(entry.extraUsd) || Object.keys(entry).some(key => !["spentUsd", "extraUsd"].includes(key))) throw new SpendingDispatchError("storage", "Saved chat spending is invalid.");
  for (const entry of table(value.bots)) if (!object(entry) || typeof entry.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.period) || !amount(entry.spentUsd) || !amount(entry.extraUsd) || Object.keys(entry).some(key => !["period", "spentUsd", "extraUsd"].includes(key))) throw new SpendingDispatchError("storage", "Saved Bot spending is invalid.");
  for (const entry of table(value.botLimits)) if (entry !== null && (!amount(entry) || entry <= 0 || entry > 100_000)) throw new SpendingDispatchError("storage", "Saved spending limits are invalid.");
  for (const entry of table(value.runs)) if (!amount(entry)) throw new SpendingDispatchError("storage", "Saved routine spending is invalid.");
  const result = parseSpendingDocument(value);
  if (value.version === 1) {
    if (value.dispatches !== undefined || value.botPeriods !== undefined) throw new SpendingDispatchError("storage", "Saved spending journal version is invalid.");
    return result;
  }
  if (!object(value.dispatches) || Object.keys(value.dispatches).length > SPENDING_DISPATCH_LIMITS.receipts) throw new SpendingDispatchError("storage", "Saved provider receipts are invalid.");
  result.version = 2;
  result.dispatches = {};
  result.botPeriods = {};
  if (value.botPeriods !== undefined) {
    if (!object(value.botPeriods) || Object.keys(value.botPeriods).length > 20_000) throw new SpendingDispatchError("storage", "Saved spending periods are invalid.");
    for (const [key, entry] of Object.entries(value.botPeriods)) {
      if (!object(entry) || !id(entry.botId) || typeof entry.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.period) || key !== JSON.stringify([entry.botId, entry.period]) ||
        !amount(entry.spentUsd) || !amount(entry.extraUsd) || Object.keys(entry).some(field => !["botId", "period", "spentUsd", "extraUsd"].includes(field))) throw new SpendingDispatchError("storage", "Saved spending period is invalid.");
      result.botPeriods[key] = { botId: entry.botId, period: entry.period, spentUsd: entry.spentUsd, extraUsd: entry.extraUsd };
    }
  }
  for (const [key, raw] of Object.entries(value.dispatches)) {
    if (!object(raw) || Object.keys(raw).some(field => !["dispatchId", "owner", "providerId", "modelId", "counts", "startedAt", "monthStartDay", "billingPeriods", "state", "costUsd", "finishedAt", "acknowledgedAt"].includes(field))) throw new SpendingDispatchError("storage", "Saved provider receipt is invalid.");
    let input: SpendingDispatchInput;
    try { input = normalizeSpendingDispatch({ dispatchId: raw.dispatchId as string, owner: raw.owner as SpendingOwner, providerId: raw.providerId as string, modelId: raw.modelId as string, counts: raw.counts as boolean }); }
    catch { throw new SpendingDispatchError("storage", "Saved provider receipt identity is invalid."); }
    if (key !== input.dispatchId || !time(raw.startedAt) || typeof raw.monthStartDay !== "number" || !Number.isInteger(raw.monthStartDay) || raw.monthStartDay < 1 || raw.monthStartDay > 28 ||
      !["pending", "recorded", "acknowledged_unknown"].includes(String(raw.state)) ||
      (raw.state === "pending" && (raw.costUsd !== undefined || raw.finishedAt !== undefined || raw.acknowledgedAt !== undefined)) ||
      (raw.state === "acknowledged_unknown" && (raw.costUsd !== undefined || raw.finishedAt !== undefined || !time(raw.acknowledgedAt))) ||
      (raw.acknowledgedAt !== undefined && !time(raw.acknowledgedAt)) ||
      (raw.state === "recorded" && (!amount(raw.costUsd) || !time(raw.finishedAt) || (!input.counts && raw.costUsd !== 0)))) throw new SpendingDispatchError("storage", "Saved provider receipt state is invalid.");
    let billingPeriods: Record<string, string> | undefined;
    if (raw.billingPeriods !== undefined) {
      const bots = new Set([input.owner, ...(input.owner.budgetScopes ?? [])].filter(scope => scope.kind === "bot").map(scope => scope.id));
      if (!object(raw.billingPeriods) || Object.keys(raw.billingPeriods).length !== bots.size || Object.entries(raw.billingPeriods).some(([botId, period]) => !bots.has(botId) || typeof period !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|1\d|2[0-8])$/u.test(period))) throw new SpendingDispatchError("storage", "Saved dispatch billing periods are invalid.");
      billingPeriods = raw.billingPeriods as Record<string, string>;
    }
    result.dispatches[key] = { ...input, startedAt: raw.startedAt, monthStartDay: raw.monthStartDay, ...(billingPeriods ? { billingPeriods: { ...billingPeriods } } : {}), state: raw.state as SpendingDispatchReceipt["state"], ...(raw.state === "recorded" ? { costUsd: raw.costUsd as number, finishedAt: raw.finishedAt as number } : {}), ...(raw.acknowledgedAt === undefined ? {} : { acknowledgedAt: raw.acknowledgedAt as number }) };
  }
  assertSpendingCapacity(result);
  return result;
}

export function assertSpendingCapacity(document: SpendingDocument): void {
  if (Object.keys(document.runs).length > 20_000 || Object.keys(document.chats).length > 20_000 || Object.keys(document.bots).length > 20_000 || Object.keys(document.botPeriods ?? {}).length > 20_000 ||
    Object.keys(document.dispatches ?? {}).length > SPENDING_DISPATCH_LIMITS.receipts || Buffer.byteLength(JSON.stringify(document), "utf8") + 1 > SPENDING_DISPATCH_LIMITS.bytes) {
    throw new SpendingDispatchError("capacity", "The saved spending journal is full. Preserve the journal and contact support before sending more requests.");
  }
}
