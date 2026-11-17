// Aiden Remote contract revision 61 (provisional): Phase 6 of the Bot UX
// simplification on the wire. What phones need to render and answer the same
// cards and settings the desktop shows, each behind its own opt-in:
//
// - `approval:cards`: the typed approval card (`renderer/shared/approval-card-model.ts`).
// - `bot:settings-changes`: `settings_change` session entries (held `update_bot`
//   cards and applied-change receipts) and their answer route.
// - `bot:suggestions`: `skill_proposal`, `lesson` and `memory_tidy` session
//   entries (suggestion cards and learning receipts) and their answer routes.
// - `bot:templates`: template versions, samples and Open on the preset list,
//   the version check on create, and one-field create.
// - `approvals:settings`: the Mac's approval mode and the rules page.
//
// Every shape here is built by the host and parsed strictly, so the shared
// fixtures round-trip through the same functions the host serves with.

import {
  APPROVAL_CARD_KINDS,
  APPROVAL_CARD_LIMITS,
  type ApprovalCard,
  type ApprovalCardButton,
} from "../../renderer/shared/approval-card-model.js";
import { APPROVAL_MODES, type ApprovalMode } from "../../renderer/shared/approval-mode.js";
import type { BotTranscriptEntry } from "../../renderer/shared/bot-live.js";
import {
  BOT_SETTINGS_FIELDS,
  botInstructionsDiff,
  botSettingsHeldTitle,
  botSettingsReceiptLabel,
  type BotSettingsField,
} from "../../renderer/shared/bot-settings-changes.js";
import type { BotPreset } from "../../renderer/shared/bot-presets.js";
import { parseAidenRemoteBotPresetList, type AidenRemoteBotPreset } from "./aiden-remote-protocol.js";

// ---------------------------------------------------------------------------
// Strict-parse helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has an unknown field: ${key}.`);
}
function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function text(value: unknown, label: string, max: number, options: { blank?: boolean } = {}): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if ([...value].length > max) throw new Error(`${label} is too long.`);
  if (!options.blank && value.trim() === "") throw new Error(`${label} must not be blank.`);
  return value;
}
function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} is not a known value.`);
  return value as T;
}
function list<T>(value: unknown, label: string, max: number, item: (entry: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a list of at most ${max}.`);
  return value.map(item);
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}
function iso(value: unknown, label: string): string {
  const raw = text(value, label, 40);
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`${label} must be a date.`);
  return raw;
}
const ENTRY_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
function opaque(value: unknown, label: string): string {
  const raw = text(value, label, 160);
  if (!OPAQUE_ID.test(raw)) throw new Error(`${label} is invalid.`);
  return raw;
}
function clip(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max - 1).join("")}…`;
}

// ---------------------------------------------------------------------------
// The typed approval card (`approval:cards`)

function parseCardText(value: unknown, label: string): { format: "command" | "text"; text: string } {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  exactKeys(value, ["format", "text"], label);
  return { format: member(value.format, ["command", "text"] as const, `${label} format`), text: text(value.text, `${label} text`, APPROVAL_CARD_LIMITS.body) };
}

function parseCardButton(value: unknown, index: number): ApprovalCardButton {
  if (!isRecord(value)) throw new Error("Approval card button must be an object.");
  exactKeys(value, ["label", "decision", "scope", "answered"], "Approval card button");
  const decision = member(value.decision, ["allow", "deny"] as const, "Approval card button decision");
  if (has(value, "scope") && decision !== "allow") throw new Error("Only an allow button carries a scope.");
  if (index === 0 && decision !== "deny") throw new Error("An approval card's first button is its deny.");
  return {
    label: text(value.label, "Approval card button label", 80),
    decision,
    ...(has(value, "scope") ? { scope: member(value.scope, ["chat", "always"] as const, "Approval card button scope") } : {}),
    answered: text(value.answered, "Approval card button answered", 80),
  };
}

/** Strict parse of the typed card, as a revision-61 client decodes it. */
export function parseAidenRemoteApprovalCard(value: unknown): ApprovalCard {
  if (!isRecord(value)) throw new Error("Approval card must be an object.");
  exactKeys(value, ["kind", "mac", "title", "arguments", "body", "previous", "rows", "notes", "buttons", "allowOnMac"], "Approval card");
  const kind = member(value.kind, APPROVAL_CARD_KINDS, "Approval card kind");
  if (has(value, "mac") && kind !== "mac") throw new Error("Only a Mac card names a part of the Mac.");
  const buttons = list(value.buttons, "Approval card buttons", 5, parseCardButton);
  if (buttons.length === 0) throw new Error("An approval card offers at least Deny.");
  const allows = buttons.some((button) => button.decision === "allow");
  if (has(value, "allowOnMac") === allows) throw new Error("A card says where to allow it exactly when it offers no allow here.");
  return {
    kind,
    ...(has(value, "mac") ? { mac: member(value.mac, ["shell", "files", "computer_use"] as const, "Approval card mac") } : {}),
    title: text(value.title, "Approval card title", APPROVAL_CARD_LIMITS.title),
    arguments: list(value.arguments, "Approval card arguments", APPROVAL_CARD_LIMITS.argumentCount, (entry) => {
      if (!isRecord(entry)) throw new Error("Approval card argument must be an object.");
      exactKeys(entry, ["key", "value"], "Approval card argument");
      return { key: text(entry.key, "Approval card argument key", APPROVAL_CARD_LIMITS.key), value: text(entry.value, "Approval card argument value", APPROVAL_CARD_LIMITS.value) };
    }),
    ...(has(value, "body") ? { body: parseCardText(value.body, "Approval card body") } : {}),
    ...(has(value, "previous") ? { previous: parseCardText(value.previous, "Approval card previous") } : {}),
    ...(has(value, "rows") ? {
      rows: list(value.rows, "Approval card rows", APPROVAL_CARD_LIMITS.rows, (row) => {
        if (!isRecord(row)) throw new Error("Approval card row must be an object.");
        exactKeys(row, ["label", "value"], "Approval card row");
        return { label: text(row.label, "Approval card row label", APPROVAL_CARD_LIMITS.key * 2), value: text(row.value, "Approval card row value", APPROVAL_CARD_LIMITS.value, { blank: true }) };
      }),
    } : {}),
    ...(has(value, "notes") ? { notes: list(value.notes, "Approval card notes", APPROVAL_CARD_LIMITS.notes, (note) => text(note, "Approval card note", APPROVAL_CARD_LIMITS.note)) } : {}),
    buttons,
    ...(has(value, "allowOnMac") ? { allowOnMac: text(value.allowOnMac, "Approval card allowOnMac", 120) } : {}),
  };
}

/** A Bot approval's card as one device reads it: Always only for a `bot:allowed` holder. */
export function botApprovalCardForAudience(card: ApprovalCard, allowed: boolean): ApprovalCard {
  if (allowed) return card;
  return { ...card, buttons: card.buttons.filter((button) => button.scope !== "always") };
}

// ---------------------------------------------------------------------------
// Bot session entries (`bot:settings-changes`, `bot:suggestions`)

export const BOT_SETTINGS_CHANGE_STATUSES = ["pending", "restored", "undo_refused", "applied", "edited", "dismissed"] as const;
export const BOT_SETTINGS_HELD_REASONS = ["not_owner", "outside_content", "widens"] as const;
export const BOT_INSTRUCTIONS_MAX = 32_000;
const DIFF_LINES_MAX = 2_000;

export interface AidenRemoteBotSettingsChangeEntry {
  type: "settings_change";
  id: string;
  changeId: string;
  /** `applied`: a receipt ("Instructions updated", Undo while `pending`). `held`: a card (Apply / Dismiss while `pending`). */
  mode: "applied" | "held";
  status: (typeof BOT_SETTINGS_CHANGE_STATUSES)[number];
  /** "Instructions updated" / "Settings updated", or "Update instructions?" / "Update settings?". */
  title: string;
  fields: BotSettingsField[];
  /** One line per changed field ("Name: Chief → Planner"). */
  lines: string[];
  heldReason?: (typeof BOT_SETTINGS_HELD_REASONS)[number];
  /** A held change's whole proposed instructions. */
  instructions?: string;
  /** The instructions as they were when it was proposed. */
  previousInstructions?: string;
  /** Lines marked against `previousInstructions`, from the desktop's own diff; absent when too long to send. */
  instructionsDiff?: Array<{ kind: "same" | "added" | "removed"; text: string }>;
  /** False when Undo can't put this change back. */
  undoable: boolean;
  createdAt?: string;
}

export interface AidenRemoteBotSkillProposalEntry {
  type: "skill_proposal";
  id: string;
  proposalId: string;
  name: string;
  description: string;
  reason?: string;
  /** Replaces a skill the Bot already has. */
  update: boolean;
  /** The new file, or a unified diff against the current one. */
  preview: string;
  /** Set when `preview` was cut to fit: such a skill is added on the Mac only. */
  previewTruncated?: true;
  status: "pending" | "added" | "dismissed";
  createdAt?: string;
}

export interface AidenRemoteBotLessonEntry {
  type: "lesson";
  id: string;
  lessonId: string;
  /** `proposal`: Keep / Not now while pending. `learned`: a receipt with Undo while active. */
  kind: "proposal" | "learned";
  text: string;
  routineName?: string;
  runs?: number;
  status: "pending" | "active" | "dismissed" | "retired";
  createdAt?: string;
}

/** "Tidied memory" receipt; Undo while `changeId` is present. */
export interface AidenRemoteBotMemoryTidyEntry {
  type: "memory_tidy";
  id: string;
  changeId?: string;
  createdAt?: string;
}

export type AidenRemoteBotUxEntry =
  | AidenRemoteBotSettingsChangeEntry
  | AidenRemoteBotSkillProposalEntry
  | AidenRemoteBotLessonEntry
  | AidenRemoteBotMemoryTidyEntry;

/** Session entry types only `bot:settings-changes` devices receive. */
export const AIDEN_REMOTE_BOT_SETTINGS_CHANGE_ENTRY_TYPES = ["settings_change"] as const;
/** Session entry types only `bot:suggestions` devices receive. */
/** A skill suggestion's preview on the wire, in code points; a longer one is cut and added on the Mac only. */
export const AIDEN_REMOTE_BOT_SKILL_PREVIEW_MAX = 16_000;
/** Refusal for Add on a skill whose preview the phone could not show in full. */
export const BOT_SKILL_ADD_ON_MAC_MESSAGE = "This skill is too long to review here. Add it on your Mac.";

export const AIDEN_REMOTE_BOT_SUGGESTION_ENTRY_TYPES = ["skill_proposal", "lesson", "memory_tidy"] as const;

/** The wire entry for one of the desktop's settings, suggestion or learning rows, or undefined. */
export function projectBotUxEntry(entry: BotTranscriptEntry, id: string, createdAt: string | undefined): AidenRemoteBotUxEntry | undefined {
  const at = createdAt ? { createdAt } : {};
  switch (entry.type) {
    case "settings_change": {
      const change = entry.change;
      const held = change.mode === "held";
      const previous = held && change.previousInstructions !== undefined ? clip(change.previousInstructions, BOT_INSTRUCTIONS_MAX) : undefined;
      const proposed = held && change.instructions !== undefined ? clip(change.instructions, BOT_INSTRUCTIONS_MAX) : undefined;
      const diff = proposed !== undefined && change.previousInstructions !== undefined
        ? botInstructionsDiff(change.previousInstructions, change.instructions!)
        : undefined;
      const fields = change.fields.filter((field) => (BOT_SETTINGS_FIELDS as readonly string[]).includes(field));
      return {
        type: "settings_change",
        id,
        changeId: clip(change.changeId, 160),
        mode: change.mode,
        status: entry.status,
        title: held ? botSettingsHeldTitle(fields) : botSettingsReceiptLabel(fields),
        fields,
        lines: change.lines.slice(0, 10).map((line) => clip(line, 400)),
        ...(held && change.heldReason ? { heldReason: change.heldReason } : held ? { heldReason: "not_owner" as const } : {}),
        ...(proposed !== undefined ? { instructions: proposed } : {}),
        ...(previous !== undefined ? { previousInstructions: previous } : {}),
        ...(diff && diff.length <= DIFF_LINES_MAX && diff.every((line) => [...line.text].length <= 4_000) ? { instructionsDiff: diff } : {}),
        undoable: change.undoable !== false,
        ...at,
      };
    }
    case "skill_proposal": {
      const proposal = entry.proposal;
      return {
        type: "skill_proposal",
        id,
        proposalId: proposal.proposalId,
        name: clip(proposal.name, 120).trim() || "Skill",
        description: clip(proposal.description, 400),
        ...(proposal.reason?.trim() ? { reason: clip(proposal.reason.trim(), 400) } : {}),
        update: proposal.update,
        preview: clip(proposal.preview, AIDEN_REMOTE_BOT_SKILL_PREVIEW_MAX),
        ...([...proposal.preview].length > AIDEN_REMOTE_BOT_SKILL_PREVIEW_MAX ? { previewTruncated: true as const } : {}),
        status: entry.status,
        ...at,
      };
    }
    case "lesson_proposal":
    case "lesson_learned":
      return {
        type: "lesson",
        id,
        lessonId: entry.lesson.lessonId,
        kind: entry.type === "lesson_proposal" ? "proposal" : "learned",
        text: clip(entry.lesson.lesson, 400).trim() || "Lesson",
        ...(entry.lesson.routineName ? { routineName: clip(entry.lesson.routineName, 200) } : {}),
        ...(entry.lesson.runs !== undefined && entry.lesson.runs >= 0 ? { runs: entry.lesson.runs } : {}),
        status: entry.status,
        ...at,
      };
    case "memory_tidy":
      return { type: "memory_tidy", id, ...(entry.changeId ? { changeId: entry.changeId } : {}), ...at };
    default:
      return undefined;
  }
}

/** Strict parse of the revision-61 session entries. */
export function parseAidenRemoteBotUxEntry(value: unknown): AidenRemoteBotUxEntry {
  if (!isRecord(value)) throw new Error("Bot session entry must be an object.");
  const id = text(value.id, "Bot session entry id", 128);
  if (!ENTRY_ID.test(id)) throw new Error("Bot session entry id is invalid.");
  const createdAt = has(value, "createdAt") ? { createdAt: iso(value.createdAt, "Bot session entry createdAt") } : {};
  switch (value.type) {
    case "settings_change": {
      exactKeys(value, ["type", "id", "changeId", "mode", "status", "title", "fields", "lines", "heldReason", "instructions", "previousInstructions", "instructionsDiff", "undoable", "createdAt"], "Settings change entry");
      const mode = member(value.mode, ["applied", "held"] as const, "Settings change mode");
      if (mode === "applied" && (has(value, "heldReason") || has(value, "instructions") || has(value, "previousInstructions"))) {
        throw new Error("Only a held change carries a reason and proposed instructions.");
      }
      return {
        type: "settings_change",
        id,
        changeId: opaque(value.changeId, "Settings change changeId"),
        mode,
        status: member(value.status, BOT_SETTINGS_CHANGE_STATUSES, "Settings change status"),
        title: text(value.title, "Settings change title", 80),
        fields: list(value.fields, "Settings change fields", BOT_SETTINGS_FIELDS.length, (field) => member(field, BOT_SETTINGS_FIELDS, "Settings change field")),
        lines: list(value.lines, "Settings change lines", 10, (line) => text(line, "Settings change line", 400)),
        ...(has(value, "heldReason") ? { heldReason: member(value.heldReason, BOT_SETTINGS_HELD_REASONS, "Settings change heldReason") } : {}),
        ...(has(value, "instructions") ? { instructions: text(value.instructions, "Settings change instructions", BOT_INSTRUCTIONS_MAX, { blank: true }) } : {}),
        ...(has(value, "previousInstructions") ? { previousInstructions: text(value.previousInstructions, "Settings change previousInstructions", BOT_INSTRUCTIONS_MAX, { blank: true }) } : {}),
        ...(has(value, "instructionsDiff") ? {
          instructionsDiff: list(value.instructionsDiff, "Settings change instructionsDiff", DIFF_LINES_MAX, (line) => {
            if (!isRecord(line)) throw new Error("Instructions diff line must be an object.");
            exactKeys(line, ["kind", "text"], "Instructions diff line");
            return { kind: member(line.kind, ["same", "added", "removed"] as const, "Instructions diff kind"), text: text(line.text, "Instructions diff text", 4_000, { blank: true }) };
          }),
        } : {}),
        undoable: bool(value.undoable, "Settings change undoable"),
        ...createdAt,
      };
    }
    case "skill_proposal":
      exactKeys(value, ["type", "id", "proposalId", "name", "description", "reason", "update", "preview", "previewTruncated", "status", "createdAt"], "Skill proposal entry");
      if (has(value, "previewTruncated") && value.previewTruncated !== true) throw new Error("Skill proposal previewTruncated must be true when present.");
      return {
        type: "skill_proposal",
        id,
        proposalId: opaque(value.proposalId, "Skill proposal proposalId"),
        name: text(value.name, "Skill proposal name", 120),
        description: text(value.description, "Skill proposal description", 400, { blank: true }),
        ...(has(value, "reason") ? { reason: text(value.reason, "Skill proposal reason", 400) } : {}),
        update: bool(value.update, "Skill proposal update"),
        preview: text(value.preview, "Skill proposal preview", AIDEN_REMOTE_BOT_SKILL_PREVIEW_MAX, { blank: true }),
        ...(value.previewTruncated === true ? { previewTruncated: true as const } : {}),
        status: member(value.status, ["pending", "added", "dismissed"] as const, "Skill proposal status"),
        ...createdAt,
      };
    case "lesson": {
      exactKeys(value, ["type", "id", "lessonId", "kind", "text", "routineName", "runs", "status", "createdAt"], "Lesson entry");
      if (has(value, "runs") && (!Number.isSafeInteger(value.runs) || (value.runs as number) < 0)) throw new Error("Lesson runs must be a count.");
      return {
        type: "lesson",
        id,
        lessonId: opaque(value.lessonId, "Lesson lessonId"),
        kind: member(value.kind, ["proposal", "learned"] as const, "Lesson kind"),
        text: text(value.text, "Lesson text", 400),
        ...(has(value, "routineName") ? { routineName: text(value.routineName, "Lesson routineName", 200) } : {}),
        ...(has(value, "runs") ? { runs: value.runs as number } : {}),
        status: member(value.status, ["pending", "active", "dismissed", "retired"] as const, "Lesson status"),
        ...createdAt,
      };
    }
    case "memory_tidy":
      exactKeys(value, ["type", "id", "changeId", "createdAt"], "Memory tidy entry");
      return { type: "memory_tidy", id, ...(has(value, "changeId") ? { changeId: opaque(value.changeId, "Memory tidy changeId") } : {}), ...createdAt };
    default:
      throw new Error("Bot session entry type is not a revision-61 type.");
  }
}

/** Exactly `{decision}` from one of `decisions`. */
export function parseBotUxDecision<T extends string>(value: unknown, decisions: readonly T[], label: string): T {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  exactKeys(value, ["decision"], label);
  return member(value.decision, decisions, `${label} decision`);
}

/** Exactly `{}`. */
export function parseEmptyBody(value: unknown, label: string): void {
  if (!isRecord(value) || Object.keys(value).length > 0) throw new Error(`${label} must be an empty object.`);
}

export const BOT_SETTINGS_CHANGE_REMOTE_DECISIONS = ["apply", "dismiss", "undo"] as const;
export const BOT_SKILL_PROPOSAL_REMOTE_DECISIONS = ["add", "dismiss"] as const;
export const BOT_LESSON_REMOTE_DECISIONS = ["keep", "dismiss"] as const;

// ---------------------------------------------------------------------------
// Templates (`bot:templates`)

/** What a `bot:templates` holder adds to each preset row. */
export interface AidenRemoteBotTemplateFields {
  version: number;
  /** The template's instructions, for the Adds section. */
  instructions: string;
  /** A short made-up sample of its output, shown faded. */
  sample: string[];
  /** The live Bot this template already made: the detail offers Open instead of Create bot. */
  existingBotId?: string;
}

export function botTemplateFields(preset: Pick<BotPreset, "version" | "instructions" | "sample">, existingBotId: string | undefined): AidenRemoteBotTemplateFields {
  return {
    version: preset.version,
    instructions: clip(preset.instructions, BOT_INSTRUCTIONS_MAX),
    sample: preset.sample.slice(0, 8).map((line) => clip(line, 280)),
    ...(existingBotId ? { existingBotId } : {}),
  };
}

export function parseAidenRemoteBotTemplateFields(value: Record<string, unknown>): AidenRemoteBotTemplateFields {
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new Error("Template version must be a positive integer.");
  return {
    version: value.version as number,
    instructions: text(value.instructions, "Template instructions", BOT_INSTRUCTIONS_MAX),
    sample: list(value.sample, "Template sample", 8, (line) => text(line, "Template sample line", 280)),
    ...(has(value, "existingBotId") ? { existingBotId: opaque(value.existingBotId, "Template existingBotId") } : {}),
  };
}

/**
 * `GET /bot-presets` for a `bot:templates` holder: every preset row as before,
 * plus that template's `version`, `instructions`, `sample` and, when it already
 * made a Bot, `existingBotId`.
 */
export function parseAidenRemoteBotTemplateList(value: unknown): { presets: Array<AidenRemoteBotPreset & AidenRemoteBotTemplateFields> } {
  if (!isRecord(value)) throw new Error("Template list must be an object.");
  exactKeys(value, ["presets"], "Template list");
  if (!Array.isArray(value.presets)) throw new Error("Template list presets must be an array.");
  const rows = value.presets.map((row) => {
    if (!isRecord(row)) throw new Error("Template must be an object.");
    const { version, instructions, sample, existingBotId, ...base } = row;
    return { base, fields: { version, instructions, sample, ...(has(row, "existingBotId") ? { existingBotId } : {}) } };
  });
  const bases = parseAidenRemoteBotPresetList({ presets: rows.map((row) => row.base) }).presets;
  return { presets: bases.map((base, index) => ({ ...base, ...parseAidenRemoteBotTemplateFields(rows[index]!.fields) })) };
}

/** `POST /bots/from-preset` for a `bot:templates` holder: `{presetId, version}`. */
export function parseAidenRemoteBotTemplateCreateRequest(value: unknown): { presetId: string; version: number } {
  if (!isRecord(value)) throw new Error("Template create request must be an object.");
  exactKeys(value, ["presetId", "version"], "Template create request");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new Error("Template version must be a positive integer.");
  return { presetId: opaque(value.presetId, "Template presetId"), version: value.version as number };
}

// ---------------------------------------------------------------------------
// Approval mode (`approvals:settings`)

export interface AidenRemoteApprovalModeView {
  /** The mode this Mac runs in now (Auto without a usable model reads Ask). */
  mode: ApprovalMode;
  /** Auto can be chosen: the Mac has a usable model. */
  autoAvailable: boolean;
}

export function parseAidenRemoteApprovalModeView(value: unknown): AidenRemoteApprovalModeView {
  if (!isRecord(value)) throw new Error("Approval mode must be an object.");
  exactKeys(value, ["mode", "autoAvailable"], "Approval mode");
  return { mode: member(value.mode, APPROVAL_MODES, "Approval mode"), autoAvailable: bool(value.autoAvailable, "Approval mode autoAvailable") };
}

export function parseAidenRemoteApprovalModeRequest(value: unknown): ApprovalMode {
  if (!isRecord(value)) throw new Error("Approval mode request must be an object.");
  exactKeys(value, ["mode"], "Approval mode request");
  return member(value.mode, APPROVAL_MODES, "Approval mode");
}
