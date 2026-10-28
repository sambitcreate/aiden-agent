// Skill proposals (spec §7 L0, L2). The Bot proposes; or a skill turns up in
// its folder. Either way a card shows what would load, and only Add makes it
// load: Aiden writes the file (for a proposal) and approves that exact content.
// Records live in `<profile>/bots/<dir>/skill-proposals.json`, which Bot file
// tools cannot write.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BOT_SKILL_PROPOSAL_ENTRY_KIND,
  BOT_SKILL_PROPOSAL_LIMITS,
  BOT_SKILL_PROPOSAL_STATUS_ENTRY_KIND,
  type BotSkillProposalEntryData,
  type BotSkillProposalOrigin,
  type BotSkillProposalStatus,
} from "../../../renderer/shared/bot-skill-proposals.js";
import { botSkillContentFingerprint, type BotSkillApprovals } from "../bot-skill-approvals.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { validateBotSkillProposal, type BotSkillDraft } from "./validate.js";

export const BOT_SKILL_PROPOSALS_FILE = "skill-proposals.json";
/** A folder skill longer than this is never offered for approval (its card could not show it all). */
export const FOLDER_SKILL_REVIEW_CHARS = 60_000;
const SETTLED_KEPT = 50;

interface StoredProposal extends BotSkillDraft {
  proposalId: string;
  origin: BotSkillProposalOrigin;
  reason?: string;
  /** For a proposal: the file Aiden would write. */
  file?: string;
  status: BotSkillProposalStatus;
  createdAt: number;
  decidedAt?: number;
}

export interface BotSkillProposalDependencies {
  profileDir(): string;
  /** The Bot's home folder; skills go to `<home>/.aiden/skills/<name>/SKILL.md`. */
  homePath(botId: string): Promise<string>;
  approvals: Pick<BotSkillApprovals, "approve" | "revoke">;
  /** Skill names already in use, and where they come from. */
  existingSources(botId: string): Promise<ReadonlyMap<string, "configured" | "workspace" | "global">>;
  appendEntry(botId: string, kind: string, data: Record<string, unknown>): Promise<void>;
  /** The skill set changed: reload skills and Bot authority. */
  invalidate(): void;
  /** Records an added skill in the learning history (before/after file text). */
  recordAdded?(botId: string, change: { name: string; before: string | null; after: string }): Promise<void>;
  now?(): number;
  newId?(): string;
}

export function botHomeSkillFile(home: string, name: string): string {
  return path.join(home, ".aiden", "skills", name, "SKILL.md");
}

export function createBotSkillProposalService(deps: BotSkillProposalDependencies) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(deps.profileDir(), botId), BOT_SKILL_PROPOSALS_FILE);

  async function load(botId: string): Promise<StoredProposal[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredProposal[]).filter((record) => typeof record?.proposalId === "string") : [];
    } catch {
      return [];
    }
  }

  async function save(botId: string, records: StoredProposal[]): Promise<void> {
    const pending = records.filter((record) => record.status === "pending");
    const settled = records.filter((record) => record.status !== "pending").slice(-SETTLED_KEPT);
    await writeJsonAtomic(fileOf(botId), [...records.filter((record) => pending.includes(record) || settled.includes(record))], {
      mode: 0o600,
      mkdirMode: 0o700,
    });
  }

  async function currentFile(botId: string, name: string): Promise<string | undefined> {
    return fs.readFile(botHomeSkillFile(await deps.homePath(botId), name), "utf8").catch(() => undefined);
  }

  type Append = (kind: string, data: Record<string, unknown>) => Promise<void>;

  return {
    /** The Bot's `propose_skill`: validate, then show the card through the calling tool's own write. */
    propose(
      botId: string,
      input: BotSkillDraft & { reason?: string },
      append: Append = (kind, data) => deps.appendEntry(botId, kind, data),
    ): Promise<{ ok: true; proposalId: string } | { ok: false; code: "invalid" | "too_many_pending"; errors: string[] }> {
      return serial(botId, async () => {
        const records = await load(botId);
        if (records.filter((record) => record.status === "pending").length >= BOT_SKILL_PROPOSAL_LIMITS.pendingPerBot) {
          return { ok: false, code: "too_many_pending", errors: ["The person has a skill to look at already. Wait for their answer."] };
        }
        const reason = input.reason?.trim();
        if (reason && [...reason].length > BOT_SKILL_PROPOSAL_LIMITS.reasonChars) {
          return { ok: false, code: "invalid", errors: [`The reason is at most ${BOT_SKILL_PROPOSAL_LIMITS.reasonChars} characters.`] };
        }
        const current = await currentFile(botId, input.name.trim());
        const checked = validateBotSkillProposal(input, {
          existingSources: await deps.existingSources(botId),
          ...(current !== undefined ? { current } : {}),
        });
        if (!checked.ok) return { ok: false, code: "invalid", errors: checked.errors };
        const record: StoredProposal = {
          proposalId: newId(),
          origin: "bot",
          name: input.name.trim(),
          // As the loader will read it back, so the approved content matches.
          description: input.description.trim().replace(/\s+/gu, " "),
          instructions: input.instructions.trim(),
          ...(reason ? { reason } : {}),
          file: checked.file,
          status: "pending",
          createdAt: now(),
        };
        await save(botId, [...records, record]);
        const card: BotSkillProposalEntryData = {
          proposalId: record.proposalId,
          name: record.name,
          description: record.description,
          ...(reason ? { reason } : {}),
          origin: "bot",
          preview: checked.preview,
          update: checked.update,
        };
        await append(BOT_SKILL_PROPOSAL_ENTRY_KIND, { ...card });
        return { ok: true, proposalId: record.proposalId };
      });
    },

    /** A skill found in the Bot's folder that nobody approved: one card asking whether to use it. */
    reviewExisting(botId: string, skill: BotSkillDraft): Promise<void> {
      return serial(botId, async () => {
        // Too large to show in full on a card: it stays unused rather than be approved unseen.
        if (skill.instructions.length > FOLDER_SKILL_REVIEW_CHARS) return;
        const records = await load(botId);
        const fingerprint = botSkillContentFingerprint(skill);
        // Asked once per content: a "Not now" stays answered after a restart.
        if (records.some((record) => record.origin === "folder" && botSkillContentFingerprint(record) === fingerprint)) return;
        const record: StoredProposal = {
          proposalId: newId(),
          origin: "folder",
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          status: "pending",
          createdAt: now(),
        };
        await save(botId, [...records, record]);
        const card: BotSkillProposalEntryData = {
          proposalId: record.proposalId,
          name: record.name,
          description: record.description,
          origin: "folder",
          preview: skill.instructions,
          update: false,
        };
        await deps.appendEntry(botId, BOT_SKILL_PROPOSAL_ENTRY_KIND, { ...card });
      });
    },

    /** The person's answer. Add writes (for a proposal) and approves the exact content. */
    respond(input: { botId: string; proposalId: string; decision: "add" | "dismiss" }): Promise<{ status: "added" | "dismissed" }> {
      return serial(input.botId, async () => {
        const records = await load(input.botId);
        const index = records.findIndex((record) => record.proposalId === input.proposalId);
        const record = records[index];
        if (!record) throw new Error("This skill suggestion is no longer available.");
        if (record.status !== "pending") return { status: record.status };
        if (input.decision === "add") {
          if (record.origin === "bot") {
            const home = await deps.homePath(input.botId);
            const target = botHomeSkillFile(home, record.name);
            const before = await fs.readFile(target, "utf8").catch(() => null);
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(staging, record.file!, { mode: 0o600 });
            await fs.rename(staging, target);
            await deps.recordAdded?.(input.botId, { name: record.name, before, after: record.file! });
          }
          const fingerprint = botSkillContentFingerprint(record);
          await deps.approvals.approve(input.botId, fingerprint, fingerprint);
          deps.invalidate();
        }
        const status = input.decision === "add" ? "added" : "dismissed";
        await deps.appendEntry(input.botId, BOT_SKILL_PROPOSAL_STATUS_ENTRY_KIND, { proposalId: record.proposalId, status });
        records[index] = { ...record, status, decidedAt: now() };
        await save(input.botId, records);
        return { status };
      });
    },

    list: load,
  };
}

export type BotSkillProposalService = ReturnType<typeof createBotSkillProposalService>;
