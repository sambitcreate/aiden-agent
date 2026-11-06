// The app's one spending ledger: shared by every chat, Bot and helper on this
// Mac, saved to `userData/spending.json`, and mirrored to the windows and
// phones so a chat or Bot can say how close it is to its limit.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  parseSpendingLimitsSettings,
  type SpendingChangedEvent,
  type SpendingLimitsSettings,
  type SpendingStatusView,
} from "../../renderer/shared/spending.js";
import {
  SpendingLedger,
  spendingBlockMessage,
  spendingMonth,
  type SpendingBlock,
  type SpendingDocument,
  type SpendingOwner,
} from "./spending-core.js";
import {
  assertSpendingCapacity,
  normalizeSpendingDispatch,
  normalizeSpendingOwner,
  inspectSpendingUnknownAcknowledgement,
  parseDurableSpendingDocument,
  pendingSpendingDispatch,
  sameSpendingDispatch,
  SPENDING_DISPATCH_LIMITS,
  SpendingDispatchError,
  type SpendingDispatchInput,
  type SpendingDispatchReceipt,
  type SpendingUnknownAcknowledgement,
} from "./spending-dispatch-ledger.js";
import { terminalMessage, terminalStream } from "./usage-limit-stream.js";
export { SpendingDispatchError, issueSpendingUnknownAcknowledgement, type SpendingDispatchInput, type SpendingUnknownAcknowledgement } from "./spending-dispatch-ledger.js";

export const SPENDING_FILE = "spending.json";
export const SPENDING_UNKNOWN_RESUME_MESSAGE = "The prior provider request may have incurred charges, but its cost is unknown. Resume acknowledges that uncertainty and may incur charges again.";

export interface SpendingPersistence {
  load(): Promise<unknown>;
  /** Fresh disk/cache reconciliation after a publication rejected ambiguously. */
  reload?(): Promise<unknown>;
  save(document: SpendingDocument): Promise<void>;
}

export interface SpendingServiceDependencies {
  persistence: SpendingPersistence;
  /** Settings → Context & Limits, read at every check. */
  settings(): Promise<unknown>;
  broadcast(event: SpendingChangedEvent): void;
  now?(): number;
  onError?(error: unknown): void;
}

/** Whether a runtime's requests cost money: a key, not a sign-in, and not a model on this Mac. */
export async function spendCounts(runtime: {
  local: boolean;
  provider: { id: string };
  models: Pick<Models, "checkAuth">;
}): Promise<boolean> {
  if (runtime.local) return false;
  try {
    return (await runtime.models.checkAuth(runtime.provider.id))?.type !== "oauth";
  } catch {
    // An unreadable sign-in state counts: a limit must not be dodged by an error.
    return true;
  }
}

/** One response's cost as Pi priced it. */
export function responseCostUsd(message: { usage?: { cost?: { total?: number } } } | undefined): number {
  const total = message?.usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

export class SpendingService {
  private readonly ledger = new SpendingLedger();
  private loading: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private reconcile = false;

  constructor(private readonly dependencies: SpendingServiceDependencies) {}

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

  /** Unreadable money is never silently replaced by a zero balance. */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      this.ledger.load(parseDurableSpendingDocument(await this.dependencies.persistence.load()));
    })();
    return this.loading;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.ready();
      if (this.reconcile) {
        const load = this.dependencies.persistence.reload ?? this.dependencies.persistence.load;
        this.ledger.load(parseDurableSpendingDocument(await load.call(this.dependencies.persistence)));
        this.reconcile = false;
      }
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async publish(next: SpendingDocument): Promise<void> {
    assertSpendingCapacity(next);
    parseDurableSpendingDocument(next);
    try {
      await this.dependencies.persistence.save(next);
      this.ledger.load(next);
    } catch (error) {
      // A failed directory fsync may follow a committed rename. Do not retry
      // against an assumed predecessor, or acknowledge an undurable charge.
      this.reconcile = true;
      this.dependencies.onError?.(error);
      throw new SpendingDispatchError("storage", "Spending could not be saved. The request outcome must be reconciled before sending more requests.");
    }
  }

  async settings(): Promise<SpendingLimitsSettings> {
    const value = await this.dependencies.settings();
    if (value === undefined) return {};
    const parsed = parseSpendingLimitsSettings(value);
    if (parsed === undefined) throw new SpendingDispatchError("storage", "Spending limits could not be read safely.");
    return parsed;
  }

  async block(owner: SpendingOwner): Promise<SpendingBlock | undefined> {
    return this.serial(async () => {
      const parsed = normalizeSpendingOwner(owner);
      if (pendingSpendingDispatch(this.ledger.snapshot(), parsed)) throw new SpendingDispatchError("uncertain", SPENDING_UNKNOWN_RESUME_MESSAGE);
      return this.ledger.block(parsed, await this.settings(), this.now());
    });
  }

  async refusal(owner: SpendingOwner, botName?: string): Promise<string | undefined> {
    const block = await this.block(owner);
    return block ? spendingBlockMessage(block, botName) : undefined;
  }

  /** Private execution recovery lookup; never projected to clients or models. */
  async pendingDispatch(owner: SpendingOwner): Promise<SpendingDispatchInput | undefined> {
    return this.serial(async () => {
      const pending = pendingSpendingDispatch(this.ledger.snapshot(), normalizeSpendingOwner(owner));
      return pending ? normalizeSpendingDispatch({ dispatchId: pending.dispatchId, owner: pending.owner, providerId: pending.providerId, modelId: pending.modelId, counts: pending.counts }) : undefined;
    });
  }

  /** Exact private recovery proof; a caller cannot edit the live ledger through it. */
  async dispatchReceipt(dispatchId: string): Promise<SpendingDispatchReceipt | undefined> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(dispatchId)) throw new SpendingDispatchError("invalid", "Invalid provider receipt identity.");
    return this.serial(async () => { const receipt = this.ledger.snapshot().dispatches?.[dispatchId]; return receipt ? structuredClone(receipt) : undefined; });
  }

  /** Person-only acknowledgement keeps unknown cost and its consumed identity. */
  async acknowledgeUncertain(token: SpendingUnknownAcknowledgement): Promise<void> {
    const proof = inspectSpendingUnknownAcknowledgement(token);
    await this.serial(async () => {
      const document = this.ledger.snapshot();
      const prior = document.dispatches?.[proof.dispatchId];
      if (!prior || JSON.stringify(prior.owner) !== JSON.stringify(proof.owner)) throw new SpendingDispatchError("conflict", "This uncertain request belongs to different work or root budgets.");
      if (prior.state !== "pending") return;
      prior.state = "acknowledged_unknown";
      prior.acknowledgedAt = this.now();
      await this.publish(document);
      this.changed(prior.owner);
    });
  }

  /** Durable intent and current overlapping budget gates precede provider I/O. */
  async beforeDispatch(value: SpendingDispatchInput): Promise<{ state: "admitted" } | { state: "recorded"; costUsd: number }> {
    const input = normalizeSpendingDispatch(value);
    return this.serial(async () => {
      const document = this.ledger.snapshot();
      const prior = document.dispatches?.[input.dispatchId];
      if (prior) {
        if (!sameSpendingDispatch(prior, input)) throw new SpendingDispatchError("conflict", "This provider dispatch identity belongs to different work.");
        if (prior.state === "recorded") return { state: "recorded", costUsd: prior.costUsd! };
        throw new SpendingDispatchError("uncertain", prior.state === "acknowledged_unknown" ? "This acknowledged request remains consumed and its cost is unknown. Only a new, person-authorized attempt may be sent." : SPENDING_UNKNOWN_RESUME_MESSAGE);
      }
      if (pendingSpendingDispatch(document, input.owner)) throw new SpendingDispatchError("uncertain", SPENDING_UNKNOWN_RESUME_MESSAGE);
      const settings = await this.settings();
      const block = this.ledger.block(input.owner, settings, this.now());
      if (block) throw new SpendingDispatchError("limit", spendingBlockMessage(block));
      if (Object.keys(document.dispatches ?? {}).length >= SPENDING_DISPATCH_LIMITS.receipts) throw new SpendingDispatchError("capacity", "The saved spending journal is full. Preserve it and contact support before sending more requests.");
      document.version = 2;
      document.dispatches ??= {};
      const startedAt = this.now();
      const period = spendingMonth(startedAt, settings.monthStartDay).key;
      const billingPeriods = Object.fromEntries([input.owner, ...(input.owner.budgetScopes ?? [])].filter(scope => scope.kind === "bot").map(scope => [scope.id, period]));
      document.dispatches[input.dispatchId] = { ...input, startedAt, monthStartDay: settings.monthStartDay ?? 1, billingPeriods, state: "pending" };
      await this.publish(document);
      return { state: "admitted" };
    });
  }

  /** Response checkpoint must be durable before this call; it is safe to replay. */
  async afterDispatch(value: SpendingDispatchInput, message: { usage?: { cost?: { total?: number } } } | undefined): Promise<void> {
    const input = normalizeSpendingDispatch(value);
    const amount = input.counts ? message?.usage?.cost?.total : 0;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9) throw new SpendingDispatchError("uncertain", SPENDING_UNKNOWN_RESUME_MESSAGE);
    await this.serial(async () => {
      const document = this.ledger.snapshot();
      const prior = document.dispatches?.[input.dispatchId];
      if (!prior || !sameSpendingDispatch(prior, input)) throw new SpendingDispatchError("conflict", "The provider result has no matching saved dispatch.");
      if (prior.state === "recorded") {
        if (prior.costUsd !== amount) throw new SpendingDispatchError("conflict", "This provider result disagrees with its saved charge.");
        return;
      }
      if (amount > 0 && [input.owner, ...(input.owner.budgetScopes ?? [])].some(scope => scope.kind === "bot") && !prior.billingPeriods) throw new SpendingDispatchError("uncertain", "The prior provider request has no saved billing period. Its charge cannot be assigned reliably. Resume acknowledges that uncertainty and may incur charges again.");
      const ledger = new SpendingLedger(document);
      const settings = { ...await this.settings(), monthStartDay: prior.monthStartDay };
      ledger.record(input.owner, amount, settings, prior.startedAt, prior.billingPeriods);
      prior.state = "recorded";
      prior.costUsd = amount;
      prior.finishedAt = this.now();
      await this.publish(ledger.snapshot());
      this.changed(input.owner);
    });
  }

  /** Legacy callers have no replay identity; their aggregate is still durable. */
  async record(owner: SpendingOwner, usd: number): Promise<void> {
    await this.serial(async () => {
      const parsed = normalizeSpendingOwner(owner);
      const document = this.ledger.snapshot();
      document.version = 2;
      document.dispatches ??= {};
      const next = new SpendingLedger(document);
      if (!next.record(parsed, usd, await this.settings(), this.now())) return;
      await this.publish(next.snapshot());
      this.changed(parsed);
    });
  }

  async status(kind: "chat" | "bot", id: string): Promise<SpendingStatusView | undefined> {
    return this.serial(async () => this.ledger.status(kind, id, await this.settings(), this.now()));
  }

  async allowMore(kind: "chat" | "bot", id: string): Promise<SpendingStatusView | undefined> {
    return (await this.allowMoreIf(kind, id, () => true)).view;
  }

  async allowMoreIf(kind: "chat" | "bot", id: string, current: (view: SpendingStatusView) => boolean): Promise<{ view: SpendingStatusView | undefined; accepted: boolean }> {
    return this.serial(async () => {
      const settings = await this.settings();
      const now = this.now();
      const before = this.ledger.status(kind, id, settings, now);
      if (before === undefined) return { view: undefined, accepted: true };
      if (!current(before)) return { view: before, accepted: false };
      const next = new SpendingLedger(this.ledger.snapshot());
      const after = next.allowMore(kind, id, settings, now);
      if (after && after.extraUsd !== before.extraUsd) {
        await this.publish(next.snapshot());
        this.changed({ kind, id });
      }
      return { view: after, accepted: true };
    });
  }

  async ownBotLimit(botId: string): Promise<number | null | undefined> {
    return this.serial(async () => this.ledger.ownBotLimit(botId));
  }

  async setBotLimit(botId: string, limit: number | null | undefined): Promise<SpendingStatusView | undefined> {
    return this.serial(async () => {
      const next = new SpendingLedger(this.ledger.snapshot());
      next.setBotLimit(botId, limit);
      const settings = await this.settings();
      await this.publish(next.snapshot());
      this.changed({ kind: "bot", id: botId });
      return next.status("bot", botId, settings, this.now());
    });
  }

  async forgetChat(id: string): Promise<void> {
    await this.serial(async () => {
      const next = new SpendingLedger(this.ledger.snapshot());
      if (next.forgetChat(id)) await this.publish(next.snapshot());
    });
  }

  async forgetBot(id: string): Promise<void> {
    await this.serial(async () => {
      const next = new SpendingLedger(this.ledger.snapshot());
      if (next.forgetBot(id)) await this.publish(next.snapshot());
    });
  }

  settingsChanged(): void {
    this.changed({ kind: "chat", id: "*", budgetScopes: [{ kind: "bot", id: "*" }] });
  }

  /** Every mutation is already durable; quit only drains in-flight work. */
  async flush(): Promise<void> { await this.tail; }

  private changed(owner: SpendingOwner): void {
    const seen = new Set<string>();
    for (const scope of [owner, ...(owner.budgetScopes ?? [])]) {
      const key = `${scope.kind}:${scope.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try { this.dependencies.broadcast({ ownerKind: scope.kind, ownerId: scope.id }); }
      catch (error) { this.dependencies.onError?.(error); }
    }
  }
}

export interface SpendingMeterOptions {
  spending: Pick<SpendingService, "refusal" | "record">;
  owner: SpendingOwner;
  /** Whether this runtime's requests cost money; read once. */
  counts(): Promise<boolean>;
  /** Check the owner's current limit immediately before dispatching a request. */
  refuse?: boolean;
}

export interface SpendingMeter {
  /** Wrap Pi's stream function so each response's cost counts toward the owner's limit. */
  wrap(streamFn: StreamFn): StreamFn;
  /** Count one response that did not go through `wrap`, such as a compaction summary. */
  count(message: { usage?: { cost?: { total?: number } } } | undefined): void;
  /** Resolves once every response so far is counted, so a limit check sees it. */
  settled(): Promise<void>;
}

export function createSpendingMeter(options: SpendingMeterOptions): SpendingMeter {
  let counts: Promise<boolean> | undefined;
  let failure: unknown;
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    const tracked = work.catch((error: unknown) => { failure ??= error; }).finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  const count = (message: { usage?: { cost?: { total?: number } } } | undefined) => {
    const cost = responseCostUsd(message);
    if (cost <= 0) return;
    counts ??= options.counts().catch(() => true);
    track(counts.then((yes) => (yes ? options.spending.record(options.owner, cost) : undefined)));
  };
  return {
    wrap: (streamFn) => async (model: Model<Api>, context, streamOptions) => {
      while (pending.size > 0) await Promise.all([...pending]);
      if (failure !== undefined) throw failure;
      if (options.refuse) {
        const refusal = await options.spending.refusal(options.owner);
        if (refusal) return terminalStream(terminalMessage(model, "error", refusal));
      }
      const stream = await streamFn(model, context, streamOptions);
      track(stream.result().then(count, () => undefined));
      return stream;
    },
    count,
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
      if (failure !== undefined) throw failure;
    },
  };
}
