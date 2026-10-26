// Spending limits: what each chat, Bot and routine run has spent, and whether
// it may send another request. Pure: the clock, the settings and the saved
// document come in; `spending-service.ts` saves and broadcasts.
//
// A chat's limit covers the whole chat, its helpers included. A Bot's covers
// its month, which starts over on the owner's chosen day in local time; its
// routine runs count toward that month and toward their own per-run limit.
// A request that crosses a limit still counts: the step it belongs to
// finishes, and the next request is refused.

import {
  DEFAULT_SPENDING_MONTH_START_DAY,
  formatUsd,
  isSpendingMonthStartDay,
  parseSpendingLimitUsd,
  spendingState,
  type SpendingLimitsSettings,
  type SpendingStatusView,
} from "../../renderer/shared/spending.js";

export type SpendingOwner =
  | { kind: "chat"; id: string }
  /** `run`: the routine run this request belongs to, when it is one. */
  | { kind: "bot"; id: string; run?: string };

interface ChatSpend {
  spentUsd: number;
  extraUsd: number;
}

interface BotSpend {
  /** The month this spend belongs to, as its first day: "2026-10-01". */
  period: string;
  spentUsd: number;
  extraUsd: number;
}

export interface SpendingDocument {
  version: 1;
  chats: Record<string, ChatSpend>;
  bots: Record<string, BotSpend>;
  /** A Bot's own monthly limit: an amount, or null for no limit. Absent: the default in Settings. */
  botLimits: Record<string, number | null>;
  /**
   * What each recent routine run has spent, by its request id, oldest first.
   * Saved so a run resumed after a restart keeps its balance.
   */
  runs: Record<string, number>;
}

export type SpendingBlock =
  | { kind: "chat"; allowedUsd: number; spentUsd: number }
  | { kind: "bot-month"; allowedUsd: number; spentUsd: number }
  | { kind: "run"; allowedUsd: number; spentUsd: number };

/** Routine runs remembered at once; a run older than these has long ended. */
const RUNS_KEPT = 500;
const MAX_OWNERS = 20_000;

export function emptySpendingDocument(): SpendingDocument {
  return { version: 1, chats: {}, bots: {}, botLimits: {}, runs: {} };
}

/** The Bot month `now` falls in: it starts on `startDay` at local midnight. */
export function spendingMonth(now: number, startDay = DEFAULT_SPENDING_MONTH_START_DAY): { key: string; start: number; end: number } {
  const day = isSpendingMonthStartDay(startDay) ? startDay : DEFAULT_SPENDING_MONTH_START_DAY;
  const at = new Date(now);
  let year = at.getFullYear();
  let month = at.getMonth();
  if (at.getDate() < day) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  const start = new Date(year, month, day).getTime();
  const end = new Date(year, month + 1, day).getTime();
  const key = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { key, start, end };
}

function own(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Ids key plain objects: never one that names a prototype. */
function safeId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && id !== "__proto__" && id !== "constructor" && id !== "prototype";
}

function spent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 1e9) : 0;
}

/** Strict parse of the saved document; a bad entry is dropped, never the file. */
export function parseSpendingDocument(value: unknown): SpendingDocument {
  const document = emptySpendingDocument();
  if (!value || typeof value !== "object" || Array.isArray(value)) return document;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return document;
  const entries = (field: unknown) =>
    field && typeof field === "object" && !Array.isArray(field)
      ? Object.entries(field as Record<string, unknown>).slice(0, MAX_OWNERS)
      : [];
  for (const [id, entry] of entries(input.chats)) {
    if (!safeId(id) || !entry || typeof entry !== "object") continue;
    const chat = entry as Record<string, unknown>;
    document.chats[id] = { spentUsd: spent(chat.spentUsd), extraUsd: spent(chat.extraUsd) };
  }
  for (const [id, entry] of entries(input.bots)) {
    if (!safeId(id) || !entry || typeof entry !== "object") continue;
    const bot = entry as Record<string, unknown>;
    if (typeof bot.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(bot.period)) continue;
    document.bots[id] = { period: bot.period, spentUsd: spent(bot.spentUsd), extraUsd: spent(bot.extraUsd) };
  }
  for (const [id, limit] of entries(input.botLimits)) {
    if (!safeId(id)) continue;
    if (limit === null) document.botLimits[id] = null;
    else {
      const amount = parseSpendingLimitUsd(limit);
      if (amount !== undefined) document.botLimits[id] = amount;
    }
  }
  for (const [id, usd] of entries(input.runs).slice(-RUNS_KEPT)) {
    if (safeId(id) && spent(usd) > 0) document.runs[id] = spent(usd);
  }
  return document;
}

/** What a refused request says, in the chat, the Bot's chat, Telegram or a phone. */
export function spendingBlockMessage(block: SpendingBlock, botName?: string): string {
  const bot = botName?.trim() || "This Bot";
  switch (block.kind) {
    case "chat":
      return `This chat reached its ${formatUsd(block.allowedUsd)} spending limit. Allow more to keep going.`;
    case "bot-month":
      return `${bot} reached its ${formatUsd(block.allowedUsd)} spending limit for this month. Allow more to keep going.`;
    case "run":
      return `This routine run reached its ${formatUsd(block.allowedUsd)} spending limit. The next run starts fresh.`;
  }
}

export class SpendingLedger {
  private document: SpendingDocument;

  constructor(document: SpendingDocument = emptySpendingDocument()) {
    this.document = document;
  }

  load(document: SpendingDocument): void {
    this.document = document;
  }

  snapshot(): SpendingDocument {
    return structuredClone(this.document);
  }

  /** The Bot's monthly limit: its own, else the default. Undefined: no limit. */
  botLimit(botId: string, settings: SpendingLimitsSettings): number | undefined {
    if (own(this.document.botLimits, botId)) return this.document.botLimits[botId] ?? undefined;
    return settings.botMonthUsd;
  }

  /** What the Bot itself set: an amount, null for no limit, undefined for the default. */
  ownBotLimit(botId: string): number | null | undefined {
    return own(this.document.botLimits, botId) ? this.document.botLimits[botId] : undefined;
  }

  setBotLimit(botId: string, limit: number | null | undefined): void {
    if (!safeId(botId)) return;
    if (limit === undefined) delete this.document.botLimits[botId];
    else this.document.botLimits[botId] = limit;
  }

  private botSpend(botId: string, settings: SpendingLimitsSettings, now: number): BotSpend {
    const { key } = spendingMonth(now, settings.monthStartDay);
    const stored = this.document.bots[botId];
    return stored?.period === key ? stored : { period: key, spentUsd: 0, extraUsd: 0 };
  }

  /** Count a request's cost. Zero or less changes nothing. */
  record(owner: SpendingOwner, usd: number, settings: SpendingLimitsSettings, now: number): boolean {
    const cost = spent(usd);
    if (cost === 0 || !safeId(owner.id)) return false;
    if (owner.kind === "chat") {
      const chat = this.document.chats[owner.id] ?? { spentUsd: 0, extraUsd: 0 };
      this.document.chats[owner.id] = { ...chat, spentUsd: chat.spentUsd + cost };
      return true;
    }
    const bot = this.botSpend(owner.id, settings, now);
    this.document.bots[owner.id] = { ...bot, spentUsd: bot.spentUsd + cost };
    if (owner.run !== undefined && safeId(owner.run)) {
      const runs = this.document.runs;
      const run = (own(runs, owner.run) ? runs[owner.run] : 0) + cost;
      delete runs[owner.run];
      runs[owner.run] = run;
      const ids = Object.keys(runs);
      for (const id of ids.slice(0, Math.max(0, ids.length - RUNS_KEPT))) delete runs[id];
    }
    return true;
  }

  /** The limit the next request would break, if any. A routine run checks its Bot's month first. */
  block(owner: SpendingOwner, settings: SpendingLimitsSettings, now: number): SpendingBlock | undefined {
    if (owner.kind === "chat") {
      const limit = settings.chatUsd;
      if (limit === undefined) return undefined;
      const chat = this.document.chats[owner.id] ?? { spentUsd: 0, extraUsd: 0 };
      const allowedUsd = limit + chat.extraUsd;
      return chat.spentUsd >= allowedUsd ? { kind: "chat", allowedUsd, spentUsd: chat.spentUsd } : undefined;
    }
    const limit = this.botLimit(owner.id, settings);
    if (limit !== undefined) {
      const bot = this.botSpend(owner.id, settings, now);
      const allowedUsd = limit + bot.extraUsd;
      if (bot.spentUsd >= allowedUsd) return { kind: "bot-month", allowedUsd, spentUsd: bot.spentUsd };
    }
    if (owner.run !== undefined && settings.routineRunUsd !== undefined) {
      const run = own(this.document.runs, owner.run) ? this.document.runs[owner.run] : 0;
      if (run >= settings.routineRunUsd) return { kind: "run", allowedUsd: settings.routineRunUsd, spentUsd: run };
    }
    return undefined;
  }

  /** What a chat or Bot shows. Undefined when no limit applies to it. */
  status(kind: "chat" | "bot", id: string, settings: SpendingLimitsSettings, now: number): SpendingStatusView | undefined {
    if (kind === "chat") {
      const limitUsd = settings.chatUsd;
      if (limitUsd === undefined) return undefined;
      const chat = this.document.chats[id] ?? { spentUsd: 0, extraUsd: 0 };
      return {
        ownerKind: "chat",
        ownerId: id,
        period: "chat",
        limitUsd,
        extraUsd: chat.extraUsd,
        spentUsd: chat.spentUsd,
        state: spendingState(chat.spentUsd, limitUsd + chat.extraUsd),
      };
    }
    const limitUsd = this.botLimit(id, settings);
    if (limitUsd === undefined) return undefined;
    const bot = this.botSpend(id, settings, now);
    const month = spendingMonth(now, settings.monthStartDay);
    return {
      ownerKind: "bot",
      ownerId: id,
      period: "month",
      limitUsd,
      extraUsd: bot.extraUsd,
      spentUsd: bot.spentUsd,
      state: spendingState(bot.spentUsd, limitUsd + bot.extraUsd),
      periodStart: month.start,
      periodEnd: month.end,
    };
  }

  /**
   * "Allow $X more": raise this chat's limit, or this Bot's month, by the
   * limit once more. Only while it is reached or nearing; undefined when no
   * limit applies.
   */
  allowMore(kind: "chat" | "bot", id: string, settings: SpendingLimitsSettings, now: number): SpendingStatusView | undefined {
    const view = this.status(kind, id, settings, now);
    if (view === undefined || view.state === "under" || !safeId(id)) return view;
    const extraUsd = view.extraUsd + view.limitUsd;
    if (kind === "chat") {
      this.document.chats[id] = { spentUsd: view.spentUsd, extraUsd };
    } else {
      const bot = this.botSpend(id, settings, now);
      this.document.bots[id] = { ...bot, extraUsd };
    }
    return this.status(kind, id, settings, now);
  }

  forgetChat(id: string): boolean {
    if (!own(this.document.chats, id)) return false;
    delete this.document.chats[id];
    return true;
  }

  forgetBot(id: string): boolean {
    const had = own(this.document.bots, id) || own(this.document.botLimits, id);
    delete this.document.bots[id];
    delete this.document.botLimits[id];
    return had;
  }
}
