// Bot-proposed routines (spec 2026-10-09 §11.3). A Bot never starts recurring
// work on its own: its `routines` tool stores a proposal and shows the person
// an Add routine card; only the person's Accept creates the routine. A
// proposal has a schedule (a scheduled routine) or a trigger (an event
// routine: a file change in the Bot's folder, or the routine's own link).
//
// Revising a waiting card supersedes it: the new content gets a new proposal
// id and card, and the old card settles as replaced. Each id keeps exactly
// one content entry, so a tap on an old card can never add content the
// person didn't see.
//
// Proposals live next to the Bot's session in
// `<profile>/bots/<dir>/routine-proposals.json`, so deleting the Bot erases
// them with its directory. Each proposal and each decision is also a
// conversation entry (`aiden.routine-proposal`, `aiden.routine-proposal-status`)
// that the live projection folds into one card.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BOT_ROUTINE_PROPOSAL_ENTRY_KIND,
  BOT_ROUTINE_PROPOSAL_PENDING_LIMIT,
  BOT_ROUTINE_PROPOSAL_REASON_LIMIT,
  BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND,
  type BotRoutineProposalEntryData,
  type BotRoutineProposalRespondInput,
  type BotRoutineProposalRespondResult,
  type BotRoutineProposalStatus,
  type BotRoutineProposalStatusEntryData,
  BOT_ROUTINE_PROPOSAL_COOLING,
  BOT_ROUTINE_PROPOSAL_DECLINE_REASONS,
  type BotRoutineProposalDecisionSummary,
  type BotRoutineProposalDeclineReason,
  botRoutineProposalWhen,
} from "../../renderer/shared/bot-routine-proposals.js";
import { isPathSafeBotCapabilityId } from "../../renderer/shared/bot-capabilities.js";
import { BOT_LIMITS } from "../../renderer/shared/bots.js";
import {
  formatBotRoutineTriggerLabel,
  parseBotRoutineTrigger,
  type BotRoutineTrigger,
} from "../../renderer/shared/bot-routine-trigger.js";
import type { BotRoutineSchedule } from "../../renderer/shared/bot-routine-schedule.js";
import { botSessionDirectory, createKeyedSerial } from "./bot-routine-notes.js";
import { writeJsonAtomic } from "./durable-fs.js";
import { BOT_EVENT_ROUTINES_MAX, type BotEventRoutineStore } from "./bot-routine-events/store.js";
import {
  BOT_ROUTINE_NAME_LIMIT,
  BOT_ROUTINE_PROMPT_LIMIT,
  botRoutineLabel,
  parseBotRoutineCreate,
  type BotRoutineService,
} from "./scheduled-bot-routines.js";

export const BOT_ROUTINE_PROPOSALS_FILE = "routine-proposals.json";
/** Settled proposals kept on disk (pending ones are always kept). */
const SETTLED_PROPOSALS_KEPT = 50;

export type BotRoutineProposalRecord = BotRoutineProposalEntryData & {
  status: BotRoutineProposalStatus;
  routineId?: string;
  createdAt: number;
  decidedAt?: number;
  declineReason?: BotRoutineProposalDeclineReason;
  /** Settled by the host (a follow-up that expired, a revised card), not by the person: never counts as a decline. */
  settledBy?: "host";
  /** The Bot revised this card into the proposal with this id. */
  supersededBy?: string;
  /**
   * This card replaces the proposal with this id. Saved with the new card,
   * before the old one settles, so a revision cut short (a failed write, a
   * quit) still finishes: the old card can't be accepted and holds no slot.
   */
  revises?: string;
  /** The replacement's card was appended; until then a saved revision replaces nothing. */
  revisionShown?: true;
};

export type BotRoutineProposeResult =
  | { ok: true; proposal: BotRoutineProposalEntryData }
  | { ok: false; code: "too_many_pending" | "invalid" | "cooling_off" | "declined_before"; error: string; until?: number };

export type BotRoutineReviseResult =
  | { ok: true; proposal: BotRoutineProposalEntryData; replaced: string }
  | { ok: false; code: "invalid" | "not_found" | "not_pending" | "declined_before"; error: string };

/** What the Bot proposes: a schedule or a trigger, exactly one. */
export interface BotRoutineProposalInput {
  name: string;
  prompt: string;
  schedule?: unknown;
  trigger?: unknown;
  reason?: string;
  requested?: boolean;
  hostFollowUp?: boolean;
}

/** The answer inside the main process: a just-made link routine's token rides along once, for the desktop to turn into its link. */
export type BotRoutineProposalServiceRespondResult = Omit<BotRoutineProposalRespondResult, "link"> & { token?: string };

type ProposalContent = { name: string; prompt: string } & (
  | { schedule: BotRoutineSchedule; timezone: string }
  | { trigger: BotRoutineTrigger }
);

/** Names compare loosely: case, outer spaces and inner runs of spaces don't matter. */
export function normalizedProposalName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Whether the Bot should hold off suggesting: three of the last five settled
 * suggestions were declined and the newest decline is under a week old, or
 * a suggestion with this name was declined in the last 30 days.
 */
export function proposalBackoff(
  records: readonly BotRoutineProposalRecord[],
  name: string,
  now: number,
): { code: "cooling_off"; until: number } | { code: "declined_before" } | undefined {
  const settledNewestFirst = records
    .filter((record) => record.status !== "pending" && record.decidedAt !== undefined && record.settledBy !== "host")
    .sort((a, b) => b.decidedAt! - a.decidedAt!);
  const window = settledNewestFirst.slice(0, BOT_ROUTINE_PROPOSAL_COOLING.window);
  const dismissed = window.filter((record) => record.status === "dismissed");
  if (dismissed.length >= BOT_ROUTINE_PROPOSAL_COOLING.dismissals) {
    const until = dismissed[0]!.decidedAt! + BOT_ROUTINE_PROPOSAL_COOLING.coolMs;
    if (until > now) return { code: "cooling_off", until };
  }
  const wanted = normalizedProposalName(name);
  const declinedSame = settledNewestFirst.some((record) =>
    record.status === "dismissed" &&
    normalizedProposalName(record.name) === wanted &&
    now - record.decidedAt! < BOT_ROUTINE_PROPOSAL_COOLING.sameNameMs);
  return declinedSame ? { code: "declined_before" } : undefined;
}

export class BotRoutineProposalNotFoundError extends Error {
  readonly code = "routine_proposal_not_found";
  constructor() {
    super("This routine suggestion is no longer available.");
    this.name = "BotRoutineProposalNotFoundError";
  }
}

export interface BotRoutineProposalServiceDependencies {
  profileDir(): string;
  routines: Pick<BotRoutineService, "create" | "findBySourceProposal">;
  /** Event routines; without them a trigger proposal is refused. Accept adds one through `create`. */
  eventRoutines?: Pick<BotEventRoutineStore, "create" | "findBySourceProposal" | "list">;
  defaultTimezone(): string;
  /** Append a display entry to the Bot's conversation (used outside a tool call). */
  appendEntry(botId: string, kind: string, data: Record<string, unknown>): Promise<void>;
  /**
   * The Bot's active conversation entries: the same entries the live
   * projection turns into cards. Accepting reads the proposal from here.
   */
  conversationEntries(botId: string): Promise<readonly { kind: string; data?: unknown }[]>;
  /** A suggestion was answered (follow-ups queue behind the pending limit). */
  onSettled?(botId: string, proposalId: string, status: Exclude<BotRoutineProposalStatus, "pending">): void;
  /** A waiting card was revised into a new one (`replacement`); it was not answered. */
  onRevised?(botId: string, replacedId: string, replacement: BotRoutineProposalEntryData): void;
  now?(): number;
  newId?(): string;
}

function invalid(): never {
  throw new Error("Invalid routine suggestion response.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseBotRoutineProposalId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value.toLowerCase();
}

/** Strict parser for `bots:routineProposals:respond`. */
export function parseBotRoutineProposalRespond(value: unknown): BotRoutineProposalRespondInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (!["botId", "proposalId", "decision"].every((key) => keys.includes(key))) invalid();
  if (!keys.every((key) => key === "botId" || key === "proposalId" || key === "decision" || key === "reason")) invalid();
  if (!isPathSafeBotCapabilityId(fields.botId, BOT_LIMITS.idChars)) invalid();
  if (fields.decision !== "accept" && fields.decision !== "dismiss") invalid();
  if (fields.reason !== undefined) {
    if (fields.decision !== "dismiss") invalid();
    if (!BOT_ROUTINE_PROPOSAL_DECLINE_REASONS.includes(fields.reason as BotRoutineProposalDeclineReason)) invalid();
  }
  return {
    botId: fields.botId,
    proposalId: parseBotRoutineProposalId(fields.proposalId),
    decision: fields.decision,
    ...(fields.reason !== undefined ? { reason: fields.reason as BotRoutineProposalDeclineReason } : {}),
  };
}

function isRecord(value: unknown): value is BotRoutineProposalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.proposalId === "string" &&
    typeof record.name === "string" &&
    typeof record.prompt === "string" &&
    typeof record.label === "string" &&
    typeof record.createdAt === "number" &&
    (record.status === "pending" || record.status === "accepted" || record.status === "dismissed") &&
    (record.revises === undefined || typeof record.revises === "string") &&
    (record.revisionShown === undefined || record.revisionShown === true) &&
    (isObject(record.trigger)
      ? record.schedule === undefined && record.timezone === undefined
      : isObject(record.schedule) && typeof record.timezone === "string")
  );
}

/**
 * The cards still waiting for an answer. A card whose replacement is already
 * saved is not one of them, even before its revision finishes settling it.
 */
function waiting(records: readonly BotRoutineProposalRecord[]): BotRoutineProposalRecord[] {
  const replaced = new Set(records.flatMap((record) =>
    (record.status === "pending" && record.revises && record.revisionShown ? [record.revises] : [])));
  return records.filter((record) =>
    record.status === "pending" &&
    !replaced.has(record.proposalId) &&
    !(record.revises !== undefined && !record.revisionShown));
}

function isObject(value: unknown): value is object {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function entryData(record: BotRoutineProposalRecord): BotRoutineProposalEntryData {
  const base = {
    proposalId: record.proposalId,
    name: record.name,
    prompt: record.prompt,
    label: record.label,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  };
  return record.trigger
    ? { ...base, trigger: record.trigger }
    : { ...base, schedule: record.schedule!, timezone: record.timezone! };
}

function routineText(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const limit = what === "name" ? BOT_ROUTINE_NAME_LIMIT : BOT_ROUTINE_PROMPT_LIMIT;
  if (!text || [...text].length > limit || (what === "prompt" && text.length > limit)) {
    throw new Error(what === "name"
      ? `Give the routine a name of at most ${limit} characters.`
      : "Say what the routine should do, in at most 32 KB.");
  }
  return text;
}

function contentKey(content: ProposalContent): string {
  return JSON.stringify("trigger" in content
    ? [content.name, content.prompt, content.trigger]
    : [content.name, content.prompt, content.schedule, content.timezone]);
}

function settled(record: BotRoutineProposalRecord): BotRoutineProposalRespondResult {
  return {
    status: record.status === "accepted" ? "accepted" : "dismissed",
    ...(record.routineId !== undefined ? { routineId: record.routineId } : {}),
  };
}

export function createBotRoutineProposalService(dependencies: BotRoutineProposalServiceDependencies) {
  const now = dependencies.now ?? Date.now;
  const newId = dependencies.newId ?? randomUUID;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) =>
    path.join(botSessionDirectory(dependencies.profileDir(), botId), BOT_ROUTINE_PROPOSALS_FILE);

  async function load(botId: string): Promise<BotRoutineProposalRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(fileOf(botId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as { proposals?: unknown };
      return Array.isArray(parsed.proposals) ? parsed.proposals.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  async function save(botId: string, records: BotRoutineProposalRecord[]): Promise<void> {
    const pending = records.filter((record) => record.status === "pending");
    const decided = records.filter((record) => record.status !== "pending").slice(-SETTLED_PROPOSALS_KEPT);
    const kept = records.filter((record) => pending.includes(record) || decided.includes(record));
    await writeJsonAtomic(fileOf(botId), { version: 1, proposals: kept }, { mode: 0o600, mkdirMode: 0o700 });
  }

  type Append = (kind: string, data: Record<string, unknown>) => Promise<void>;
  const sessionAppend = (botId: string): Append => (kind, data) => dependencies.appendEntry(botId, kind, data);

  /**
   * What a proposal asks for, validated like the routine it would add: a
   * schedule (run in this Mac's timezone) or a trigger, exactly one.
   */
  async function parseContent(botId: string, input: BotRoutineProposalInput): Promise<ProposalContent> {
    const hasSchedule = input.schedule !== undefined;
    const hasTrigger = input.trigger !== undefined;
    if (hasSchedule === hasTrigger) throw new Error("Give a schedule or a trigger, not both.");
    if (hasSchedule) {
      const parsed = parseBotRoutineCreate({ botId, name: input.name, schedule: input.schedule, prompt: input.prompt });
      return { name: parsed.name, prompt: parsed.prompt, schedule: parsed.schedule, timezone: dependencies.defaultTimezone() };
    }
    if (!dependencies.eventRoutines) throw new Error("Event routines aren't available here.");
    const name = routineText(input.name, "name");
    const prompt = routineText(input.prompt, "prompt");
    const trigger = parseBotRoutineTrigger(input.trigger);
    if ((await dependencies.eventRoutines.list(botId)).length >= BOT_EVENT_ROUTINES_MAX) {
      throw new Error("This Bot has as many event routines as it can keep. The person can remove one in the Bot's profile.");
    }
    return { name, prompt, trigger };
  }

  function recordOf(content: ProposalContent, reason: string | undefined, at: number): BotRoutineProposalRecord {
    const base = {
      proposalId: newId(),
      name: content.name,
      prompt: content.prompt,
      ...(reason ? { reason } : {}),
      status: "pending" as const,
      createdAt: at,
    };
    return "trigger" in content
      ? { ...base, trigger: content.trigger, label: formatBotRoutineTriggerLabel(content.trigger) }
      : { ...base, schedule: content.schedule, timezone: content.timezone, label: botRoutineLabel(content.schedule, content.timezone, at) };
  }

  function cleanReason(value: string | undefined): string | undefined {
    const reason = value?.trim();
    if (reason !== undefined && [...reason].length > BOT_ROUTINE_PROPOSAL_REASON_LIMIT) {
      throw new Error(`The reason is at most ${BOT_ROUTINE_PROPOSAL_REASON_LIMIT} characters.`);
    }
    return reason;
  }

  /** The routine this proposal added, scheduled or event. */
  async function createdFrom(botId: string, proposalId: string): Promise<{ id: string } | undefined> {
    return (await dependencies.routines.findBySourceProposal(botId, proposalId)) ??
      (await dependencies.eventRoutines?.findBySourceProposal(botId, proposalId));
  }

  /**
   * Settle `records[index]`: the card first (status entry, through `append`),
   * then the record. Either write failing leaves the record unsettled, and the
   * next answer or read settles it again; a repeated status entry folds the
   * same way. A revised card is settled by the host and is not an answer.
   */
  async function settle(
    botId: string,
    records: BotRoutineProposalRecord[],
    index: number,
    status: Exclude<BotRoutineProposalStatus, "pending">,
    options: {
      routineId?: string;
      append?: Append;
      declineReason?: BotRoutineProposalDeclineReason;
      settledBy?: "host";
      supersededBy?: string;
    } = {},
  ): Promise<BotRoutineProposalRecord> {
    const { routineId, append = sessionAppend(botId), declineReason, settledBy, supersededBy } = options;
    const record = records[index]!;
    const data: BotRoutineProposalStatusEntryData = {
      proposalId: record.proposalId,
      status,
      ...(routineId !== undefined ? { routineId } : {}),
      ...(status === "dismissed" && supersededBy !== undefined ? { supersededBy } : {}),
    };
    await append(BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND, { ...data });
    const { routineId: _previous, declineReason: _reason, settledBy: _by, supersededBy: _next, ...rest } = record;
    const next = {
      ...rest,
      status,
      ...(routineId !== undefined ? { routineId } : {}),
      ...(status === "dismissed" && declineReason !== undefined ? { declineReason } : {}),
      ...(status === "dismissed" && (settledBy || supersededBy) ? { settledBy: "host" as const } : {}),
      ...(status === "dismissed" && supersededBy !== undefined ? { supersededBy } : {}),
      decidedAt: now(),
    } as BotRoutineProposalRecord;
    records[index] = next;
    await save(botId, records);
    if (next.supersededBy === undefined) {
      try {
        dependencies.onSettled?.(botId, next.proposalId, status);
      } catch {
        // A listener never changes the answer.
      }
    }
    return next;
  }

  /**
   * A routine created from a proposal is the committed answer, whatever the
   * record says: an Add routine cut short after creating it (a failed status
   * write, a quit) settles as accepted rather than staying open or turning
   * into Not added. Must run inside `serial(botId)`. From inside a Bot's
   * tool call, `append` is that call's own write: the Bot's session would wait
   * on a pause or quit that waits for the call.
   */
  async function reconcile(
    botId: string,
    records: BotRoutineProposalRecord[],
    append: Append = sessionAppend(botId),
  ): Promise<BotRoutineProposalRecord[]> {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.status === "accepted") continue;
      const created = await createdFrom(botId, record.proposalId);
      if (created) await settle(botId, records, index, "accepted", { routineId: created.id, append });
    }
    await finishRevisions(botId, records, append);
    return records;
  }

  function revised(botId: string, replacedId: string, replacement: BotRoutineProposalRecord): void {
    try {
      dependencies.onRevised?.(botId, replacedId, entryData(replacement));
    } catch {
      // A listener never changes the card.
    }
  }

  /**
   * Finish revisions cut short. A replacement whose card was shown settles
   * the card it replaces; one saved but never shown (a quit before its card
   * was appended) is dropped, so the original card stays the one to answer.
   * Must run inside `serial(botId)`.
   */
  async function finishRevisions(
    botId: string,
    records: BotRoutineProposalRecord[],
    append: Append = sessionAppend(botId),
  ): Promise<void> {
    const unshown = records.filter((record) => record.revises !== undefined && !record.revisionShown && record.status === "pending");
    if (unshown.length > 0) {
      records.splice(0, records.length, ...records.filter((record) => !unshown.includes(record)));
      await save(botId, records);
    }
    for (const replacement of [...records]) {
      if (replacement.revises === undefined || !replacement.revisionShown) continue;
      const index = records.findIndex((record) => record.proposalId === replacement.revises);
      if (index < 0 || records[index]!.status !== "pending") continue;
      await settle(botId, records, index, "dismissed", { append, supersededBy: replacement.proposalId });
      revised(botId, replacement.revises, replacement);
    }
  }

  /**
   * The proposal exactly as its card shows it, from the conversation entry
   * the live projection renders, never from `routine-proposals.json` (which
   * a Full-access shell can rewrite). A missing, unreadable or ambiguous
   * card is no longer something the person agreed to.
   */
  async function shownProposal(botId: string, proposalId: string): Promise<ProposalContent> {
    const shown = new Map<string, ProposalContent>();
    for (const entry of await dependencies.conversationEntries(botId)) {
      if (entry.kind !== BOT_ROUTINE_PROPOSAL_ENTRY_KIND) continue;
      const data = entry.data as Partial<Record<keyof BotRoutineProposalEntryData, unknown>> | null;
      if (!data || typeof data !== "object" || data.proposalId !== proposalId) continue;
      let proposal: ProposalContent;
      try {
        if (data.trigger !== undefined) {
          if (data.schedule !== undefined || data.timezone !== undefined) throw new Error("both");
          proposal = {
            name: routineText(data.name, "name"),
            prompt: routineText(data.prompt, "prompt"),
            trigger: parseBotRoutineTrigger(data.trigger),
          };
        } else {
          if (typeof data.timezone !== "string") throw new Error("missing timezone");
          const parsed = parseBotRoutineCreate({ botId, name: data.name, schedule: data.schedule, prompt: data.prompt, timezone: data.timezone });
          proposal = { name: parsed.name, prompt: parsed.prompt, schedule: parsed.schedule, timezone: parsed.timezone ?? data.timezone };
        }
      } catch {
        throw new BotRoutineProposalNotFoundError();
      }
      shown.set(contentKey(proposal), proposal);
    }
    if (shown.size !== 1) throw new BotRoutineProposalNotFoundError();
    return [...shown.values()][0]!;
  }

  return {
    /** The newest answered suggestions, for the Bot's `routines list`. */
    async recentDecisions(botId: string): Promise<BotRoutineProposalDecisionSummary[]> {
      return (await load(botId))
        .filter((record) => record.status !== "pending" && record.decidedAt !== undefined && record.settledBy !== "host")
        .sort((a, b) => b.decidedAt! - a.decidedAt!)
        .slice(0, BOT_ROUTINE_PROPOSAL_COOLING.recent)
        .map((record) => ({
          name: record.name,
          label: record.label,
          status: record.status === "accepted" ? "accepted" : "dismissed",
          ...(record.declineReason !== undefined ? { reason: record.declineReason } : {}),
          decidedAt: record.decidedAt!,
        }));
    },

    /** The suggestions still waiting for an answer, for the Bot's `routines list` and `revise`. */
    async pending(botId: string): Promise<Array<{ proposalId: string; name: string; label: string }>> {
      return waiting(await load(botId))
        .map((record) => ({ proposalId: record.proposalId, name: record.name, label: botRoutineProposalWhen(record) }));
    },

    /** How many suggestions wait for an answer. */
    async pendingCount(botId: string): Promise<number> {
      return waiting(await load(botId)).length;
    },

    /** The stored proposals, settling any whose routine already exists. */
    list(botId: string): Promise<BotRoutineProposalRecord[]> {
      return serial(botId, async () => reconcile(botId, await load(botId)));
    },

    /**
     * Validate and store a proposal, then show its card through `append`
     * (the calling tool's own conversation write). At most two wait at once.
     */
    propose(
      botId: string,
      input: BotRoutineProposalInput,
      append: Append = sessionAppend(botId),
    ): Promise<BotRoutineProposeResult> {
      return serial(botId, async () => {
        let content: ProposalContent;
        let reason: string | undefined;
        try {
          content = await parseContent(botId, input);
          reason = cleanReason(input.reason);
        } catch (error) {
          return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid routine." };
        }
        const records = await reconcile(botId, await load(botId), append);
        // Back-off is for the Bot's own ideas. A follow-up the host queued for a
        // promise always gets its card. The model's own "the person asked"
        // claim only gets past a same-name decline, never cooling off.
        const found = input.hostFollowUp ? undefined : proposalBackoff(records, content.name, now());
        const backoff = found?.code === "declined_before" && input.requested ? undefined : found;
        if (backoff?.code === "cooling_off") {
          return {
            ok: false,
            code: "cooling_off",
            until: backoff.until,
            error: "The person declined most recent suggestions. Don't suggest routines for a while; the person can add one themselves in the Bot's profile.",
          };
        }
        if (backoff?.code === "declined_before") {
          return { ok: false, code: "declined_before", error: DECLINED_BEFORE };
        }
        if (waiting(records).length >= BOT_ROUTINE_PROPOSAL_PENDING_LIMIT) {
          return {
            ok: false,
            code: "too_many_pending",
            error: "The person already has routine suggestions to answer. Wait for them, or revise one of them, before suggesting another.",
          };
        }
        const record = recordOf(content, reason, now());
        await save(botId, [...records, record]);
        const proposal = entryData(record);
        await append(BOT_ROUTINE_PROPOSAL_ENTRY_KIND, { ...proposal });
        return { ok: true, proposal };
      });
    },

    /**
     * Replace a card that still waits for an answer: the new content gets its
     * own card and id, and the old card settles as replaced (not declined).
     * Takes no extra waiting slot.
     */
    revise(
      botId: string,
      proposalId: string,
      input: BotRoutineProposalInput,
      append: Append = sessionAppend(botId),
    ): Promise<BotRoutineReviseResult> {
      return serial(botId, async () => {
        let content: ProposalContent;
        let reason: string | undefined;
        try {
          content = await parseContent(botId, input);
          reason = cleanReason(input.reason);
        } catch (error) {
          return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid routine." };
        }
        const records = await reconcile(botId, await load(botId), append);
        const wanted = proposalId.toLowerCase();
        const index = records.findIndex((record) => record.proposalId === wanted);
        const current = records[index];
        if (!current) {
          return { ok: false, code: "not_found", error: "There is no suggestion with that id. Use list to see the ones still waiting." };
        }
        if (current.status !== "pending") {
          return {
            ok: false,
            code: "not_pending",
            error: "The person already answered that suggestion, so it can't be revised. Propose a new one only if it still clearly helps.",
          };
        }
        // Renaming a card into something the person turned down is a new idea.
        const renamed = normalizedProposalName(content.name) !== normalizedProposalName(current.name);
        if (renamed && !input.requested && !input.hostFollowUp && proposalBackoff(records, content.name, now())?.code === "declined_before") {
          return { ok: false, code: "declined_before", error: DECLINED_BEFORE };
        }
        // The new card names the card it replaces before either is shown,
        // so a revision cut short after this save still finishes.
        const record: BotRoutineProposalRecord = { ...recordOf(content, reason ?? current.reason, now()), revises: current.proposalId };
        records.push(record);
        await save(botId, records);
        const proposal = entryData(record);
        try {
          await append(BOT_ROUTINE_PROPOSAL_ENTRY_KIND, { ...proposal });
        } catch (error) {
          // The new card was never shown: the old one stays the one to answer.
          await save(botId, records.filter((entry) => entry !== record));
          throw error;
        }
        // Only now does the saved link replace the old card on recovery.
        record.revisionShown = true;
        await save(botId, records);
        await settle(botId, records, index, "dismissed", { append, supersededBy: record.proposalId });
        revised(botId, current.proposalId, record);
        return { ok: true, proposal, replaced: current.proposalId };
      });
    },

    /**
     * The person's answer. Accept creates the routine the card shows
     * (idempotent by the proposal id); either decision appends a status
     * entry. Once a routine exists for the proposal every answer, from any
     * device, settles as accepted; otherwise a repeat returns the settled
     * status. A replaced card can't be answered. Accepting a link routine
     * returns its token once, for the desktop to show as a link; the Bot
     * never sees it.
     */
    respond(input: BotRoutineProposalRespondInput & { settledBy?: "host" }): Promise<BotRoutineProposalServiceRespondResult> {
      return serial(input.botId, async () => {
        const records = await load(input.botId);
        await finishRevisions(input.botId, records);
        const index = records.findIndex((record) => record.proposalId === input.proposalId);
        const record = records[index];
        if (!record) throw new BotRoutineProposalNotFoundError();
        if (record.status === "accepted") return settled(record);
        const created = await createdFrom(input.botId, record.proposalId);
        if (created) return settled(await settle(input.botId, records, index, "accepted", { routineId: created.id }));
        if (record.supersededBy !== undefined) throw new BotRoutineProposalNotFoundError();
        if (record.status !== "pending") return settled(record);
        if (input.decision === "dismiss") {
          return settled(await settle(input.botId, records, index, "dismissed", {
            ...(input.reason !== undefined ? { declineReason: input.reason } : {}),
            ...(input.settledBy ? { settledBy: input.settledBy } : {}),
          }));
        }
        const shown = await shownProposal(input.botId, record.proposalId);
        if ("trigger" in shown) {
          const { routine, token } = await dependencies.eventRoutines!.create(input.botId, {
            name: shown.name,
            prompt: shown.prompt,
            trigger: shown.trigger,
            sourceProposalId: record.proposalId,
          });
          const answer = settled(await settle(input.botId, records, index, "accepted", { routineId: routine.id }));
          return token !== undefined ? { ...answer, token } : answer;
        }
        const routine = await dependencies.routines.create({ botId: input.botId, ...shown, sourceProposalId: record.proposalId });
        return settled(await settle(input.botId, records, index, "accepted", { routineId: routine.id }));
      });
    },
  };
}

const DECLINED_BEFORE =
  "The person declined a routine like this recently. Don't suggest it again on your own; if they asked for it, propose it again with requested set to true.";

export type BotRoutineProposalService = ReturnType<typeof createBotRoutineProposalService>;
