// Skills a Bot proposes, and skills found in its folder, wait for the person's
// OK on a card (spec 2026-10-27 §7 L0, L2).

export const BOT_SKILL_PROPOSAL_ENTRY_KIND = "aiden.skill-proposal";
export const BOT_SKILL_PROPOSAL_STATUS_ENTRY_KIND = "aiden.skill-proposal-status";
export const BOT_SKILL_PROPOSAL_CHANNELS = { respond: "bots:skillProposals:respond" } as const;
export const BOT_SKILL_PROPOSAL_LIMITS = { nameChars: 48, descriptionChars: 240, instructionsBytes: 16_384, reasonChars: 280, pendingPerBot: 1, previewChars: 64 * 1024 } as const;

export type BotSkillProposalStatus = "pending" | "added" | "dismissed";
export type BotSkillProposalOrigin = "bot" | "folder";

export interface BotSkillProposalEntryData {
  proposalId: string;
  name: string;
  description: string;
  /** The Bot's one line on why; absent for a skill found in the folder. */
  reason?: string;
  origin: BotSkillProposalOrigin;
  /** What would change: the new file, or a unified diff against the current one. */
  preview: string;
  /** Whether this replaces a skill the Bot already has. */
  update: boolean;
}

export interface BotSkillProposalStatusEntryData {
  proposalId: string;
  status: Exclude<BotSkillProposalStatus, "pending">;
}

export function botSkillProposalOf(value: unknown): BotSkillProposalEntryData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.proposalId !== "string" || typeof data.name !== "string" || typeof data.description !== "string") return null;
  if (data.origin !== "bot" && data.origin !== "folder") return null;
  if (typeof data.preview !== "string" || typeof data.update !== "boolean") return null;
  if (data.reason !== undefined && typeof data.reason !== "string") return null;
  return {
    proposalId: data.proposalId,
    name: data.name.slice(0, 200),
    description: data.description.slice(0, 400),
    ...(typeof data.reason === "string" ? { reason: data.reason.slice(0, 400) } : {}),
    origin: data.origin,
    preview: data.preview.slice(0, BOT_SKILL_PROPOSAL_LIMITS.previewChars),
    update: data.update,
  };
}

export function botSkillProposalStatusOf(value: unknown): BotSkillProposalStatusEntryData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.proposalId !== "string") return null;
  if (data.status !== "added" && data.status !== "dismissed") return null;
  return { proposalId: data.proposalId, status: data.status };
}
