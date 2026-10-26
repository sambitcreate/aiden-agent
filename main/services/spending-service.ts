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
  parseSpendingDocument,
  SpendingLedger,
  spendingBlockMessage,
  type SpendingBlock,
  type SpendingDocument,
  type SpendingOwner,
} from "./spending-core.js";
import { terminalMessage, terminalStream } from "./usage-limit-stream.js";

export const SPENDING_FILE = "spending.json";
const SAVE_DEBOUNCE_MS = 500;

export interface SpendingPersistence {
  load(): Promise<unknown>;
  save(document: SpendingDocument): Promise<void>;
}

export interface SpendingServiceDependencies {
  persistence: SpendingPersistence;
  /** Settings → Limits & spending, read at every check. */
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
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: SpendingServiceDependencies) {}

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  /** Load what an earlier run saved. Never fails: a bad file starts from nothing spent. */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      try {
        this.ledger.load(parseSpendingDocument(await this.dependencies.persistence.load()));
      } catch (error) {
        this.dependencies.onError?.(error);
      }
    })();
    return this.loading;
  }

  async settings(): Promise<SpendingLimitsSettings> {
    try {
      const value = await this.dependencies.settings();
      return value === undefined ? {} : (parseSpendingLimitsSettings(value) ?? {});
    } catch (error) {
      this.dependencies.onError?.(error);
      return {};
    }
  }

  /** The limit the next request would break, if any. */
  async block(owner: SpendingOwner): Promise<SpendingBlock | undefined> {
    await this.ready();
    return this.ledger.block(owner, await this.settings(), this.now());
  }

  /** The refusal text for the owner's next request, if it is over a limit. */
  async refusal(owner: SpendingOwner, botName?: string): Promise<string | undefined> {
    const block = await this.block(owner);
    return block ? spendingBlockMessage(block, botName) : undefined;
  }

  async record(owner: SpendingOwner, usd: number): Promise<void> {
    await this.ready();
    if (!this.ledger.record(owner, usd, await this.settings(), this.now())) return;
    this.changed(owner.kind, owner.id);
  }

  async status(kind: "chat" | "bot", id: string): Promise<SpendingStatusView | undefined> {
    await this.ready();
    return this.ledger.status(kind, id, await this.settings(), this.now());
  }

  async allowMore(kind: "chat" | "bot", id: string): Promise<SpendingStatusView | undefined> {
    await this.ready();
    const before = this.ledger.status(kind, id, await this.settings(), this.now());
    const after = this.ledger.allowMore(kind, id, await this.settings(), this.now());
    if (after && before && after.extraUsd !== before.extraUsd) this.changed(kind, id);
    return after;
  }

  /** The Bot's own monthly limit: an amount, null for none, undefined for the default. */
  async ownBotLimit(botId: string): Promise<number | null | undefined> {
    await this.ready();
    return this.ledger.ownBotLimit(botId);
  }

  async setBotLimit(botId: string, limit: number | null | undefined): Promise<SpendingStatusView | undefined> {
    await this.ready();
    this.ledger.setBotLimit(botId, limit);
    this.changed("bot", botId);
    return this.ledger.status("bot", botId, await this.settings(), this.now());
  }

  async forgetChat(id: string): Promise<void> {
    await this.ready();
    if (this.ledger.forgetChat(id)) this.scheduleSave();
  }

  async forgetBot(id: string): Promise<void> {
    await this.ready();
    if (this.ledger.forgetBot(id)) this.scheduleSave();
  }

  /** The settings changed: every open chat and Bot re-reads its limit. */
  settingsChanged(): void {
    try {
      this.dependencies.broadcast({ ownerKind: "chat", ownerId: "*" });
      this.dependencies.broadcast({ ownerKind: "bot", ownerId: "*" });
    } catch (error) {
      this.dependencies.onError?.(error);
    }
  }

  /** Write pending changes now, for quit. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.save();
    }
    await this.saving;
  }

  private changed(kind: "chat" | "bot", id: string): void {
    this.scheduleSave();
    try {
      this.dependencies.broadcast({ ownerKind: kind, ownerId: id });
    } catch (error) {
      this.dependencies.onError?.(error);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const document = this.ledger.snapshot();
    this.saving = this.saving
      .then(() => this.dependencies.persistence.save(document))
      .catch((error: unknown) => this.dependencies.onError?.(error));
  }
}

export interface SpendingMeterOptions {
  spending: Pick<SpendingService, "refusal" | "record">;
  owner: SpendingOwner;
  /** Whether this runtime's requests cost money; read once. */
  counts(): Promise<boolean>;
  /**
   * Refuse a request over the limit with an error. Chats leave this off: they
   * end the run after the step instead, so the chat shows no failure.
   */
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
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    const tracked = work.catch(() => undefined).finally(() => pending.delete(tracked));
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
      if (options.refuse) {
        const refusal = await options.spending.refusal(options.owner).catch(() => undefined);
        if (refusal) return terminalStream(terminalMessage(model, "error", refusal));
      }
      const stream = await streamFn(model, context, streamOptions);
      track(stream.result().then(count, () => undefined));
      return stream;
    },
    count,
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
