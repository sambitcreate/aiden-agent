// Bot-proposed routines (spec 2026-10-09 §11.3). A Bot never starts recurring
// work on its own: its `routines` tool stores a proposal and shows the person
// an Add routine card; only the person's Accept creates the routine.
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
} from "../../renderer/shared/bot-routine-proposals.js";
import { isPathSafeBotCapabilityId } from "../../renderer/shared/bot-capabilities.js";
import { BOT_LIMITS } from "../../renderer/shared/bots.js";
import { botSessionDirectory, createKeyedSerial } from "./bot-routine-notes.js";
import { writeJsonAtomic } from "./durable-fs.js";
import { botRoutineLabel, parseBotRoutineCreate, type BotRoutineService } from "./scheduled-bot-routines.js";

export const BOT_ROUTINE_PROPOSALS_FILE = "routine-proposals.json";
/** Settled proposals kept on disk (pending ones are always kept). */
const SETTLED_PROPOSALS_KEPT = 50;

export interface BotRoutineProposalRecord extends BotRoutineProposalEntryData {
  status: BotRoutineProposalStatus;
  routineId?: string;
  createdAt: number;
  decidedAt?: number;
}

export type BotRoutineProposeResult =
  | { ok: true; proposal: BotRoutineProposalEntryData }
  | { ok: false; code: "too_many_pending" | "invalid"; error: string };

export class BotRoutineProposalNotFoundError extends Error {
  readonly code = "routine_proposal_not_found";
  constructor() {
    super("This routine suggestion is no longer available.");
    this.name = "BotRoutineProposalNotFoundError";
  }
}

export interface BotRoutineProposalServiceDependencies {
  profileDir(): string;
  routines: Pick<BotRoutineService, "create">;
  defaultTimezone(): string;
  /** Append a display entry to the Bot's conversation (used outside a tool call). */
  appendEntry(botId: string, kind: string, data: Record<string, unknown>): Promise<void>;
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
  if (keys.length !== 3 || !["botId", "proposalId", "decision"].every((key) => keys.includes(key))) invalid();
  if (!isPathSafeBotCapabilityId(fields.botId, BOT_LIMITS.idChars)) invalid();
  if (fields.decision !== "accept" && fields.decision !== "dismiss") invalid();
  return { botId: fields.botId, proposalId: parseBotRoutineProposalId(fields.proposalId), decision: fields.decision };
}

function isRecord(value: unknown): value is BotRoutineProposalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.proposalId === "string" &&
    typeof record.name === "string" &&
    typeof record.prompt === "string" &&
    typeof record.timezone === "string" &&
    typeof record.label === "string" &&
    typeof record.createdAt === "number" &&
    (record.status === "pending" || record.status === "accepted" || record.status === "dismissed") &&
    Boolean(record.schedule) &&
    typeof record.schedule === "object"
  );
}

function entryData(record: BotRoutineProposalRecord): BotRoutineProposalEntryData {
  return {
    proposalId: record.proposalId,
    name: record.name,
    prompt: record.prompt,
    schedule: record.schedule,
    timezone: record.timezone,
    label: record.label,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  };
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

  return {
    async list(botId: string): Promise<BotRoutineProposalRecord[]> {
      return load(botId);
    },

    /**
     * Validate and store a proposal, then show its card through `append`
     * (the calling tool's own conversation write). At most two wait at once.
     */
    propose(
      botId: string,
      input: { name: string; schedule: unknown; prompt: string; reason?: string },
      append: (kind: string, data: Record<string, unknown>) => Promise<void> = (kind, data) =>
        dependencies.appendEntry(botId, kind, data),
    ): Promise<BotRoutineProposeResult> {
      return serial(botId, async () => {
        let parsed;
        try {
          parsed = parseBotRoutineCreate({ botId, name: input.name, schedule: input.schedule, prompt: input.prompt });
        } catch (error) {
          return { ok: false, code: "invalid", error: error instanceof Error ? error.message : "Invalid routine." };
        }
        const reason = input.reason?.trim();
        if (reason !== undefined && [...reason].length > BOT_ROUTINE_PROPOSAL_REASON_LIMIT) {
          return { ok: false, code: "invalid", error: `The reason is at most ${BOT_ROUTINE_PROPOSAL_REASON_LIMIT} characters.` };
        }
        const records = await load(botId);
        if (records.filter((record) => record.status === "pending").length >= BOT_ROUTINE_PROPOSAL_PENDING_LIMIT) {
          return {
            ok: false,
            code: "too_many_pending",
            error: "The person already has routine suggestions to answer. Wait for them before suggesting another.",
          };
        }
        const timezone = dependencies.defaultTimezone();
        const at = now();
        const record: BotRoutineProposalRecord = {
          proposalId: newId(),
          name: parsed.name,
          prompt: parsed.prompt,
          schedule: parsed.schedule,
          timezone,
          label: botRoutineLabel(parsed.schedule, timezone, at),
          ...(reason ? { reason } : {}),
          status: "pending",
          createdAt: at,
        };
        await save(botId, [...records, record]);
        const proposal = entryData(record);
        await append(BOT_ROUTINE_PROPOSAL_ENTRY_KIND, { ...proposal });
        return { ok: true, proposal };
      });
    },

    /**
     * The person's answer. Accept creates the routine (idempotent by the
     * proposal id); either decision appends a status entry. A repeated answer
     * returns the settled status unchanged, whichever device sent it.
     */
    respond(input: BotRoutineProposalRespondInput): Promise<BotRoutineProposalRespondResult> {
      return serial(input.botId, async () => {
        const records = await load(input.botId);
        const index = records.findIndex((record) => record.proposalId === input.proposalId);
        const record = records[index];
        if (!record) throw new BotRoutineProposalNotFoundError();
        if (record.status !== "pending") return settled(record);
        let routineId: string | undefined;
        if (input.decision === "accept") {
          const routine = await dependencies.routines.create({
            botId: input.botId,
            name: record.name,
            schedule: record.schedule,
            prompt: record.prompt,
            timezone: record.timezone,
            sourceProposalId: record.proposalId,
          });
          routineId = routine.id;
        }
        const status = input.decision === "accept" ? "accepted" : "dismissed";
        const data: BotRoutineProposalStatusEntryData = {
          proposalId: record.proposalId,
          status,
          ...(routineId !== undefined ? { routineId } : {}),
        };
        // The card settles before the record does: a crash in between
        // re-runs the answer, and a repeated status entry folds the same way.
        await dependencies.appendEntry(input.botId, BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND, { ...data });
        const next: BotRoutineProposalRecord = {
          ...record,
          status,
          ...(routineId !== undefined ? { routineId } : {}),
          decidedAt: now(),
        };
        await save(input.botId, records.map((candidate, at) => (at === index ? next : candidate)));
        return settled(next);
      });
    },
  };
}

export type BotRoutineProposalService = ReturnType<typeof createBotRoutineProposalService>;
