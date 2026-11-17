// Settings from chat (docs/plans/bot-ux-simplification.md §4.6): the Bot's
// own `update_bot` tool, its chat receipt ("Settings updated" with Undo) and
// its held card ("Update instructions?" with Apply / Edit / Dismiss).
//
// The tool changes only what a Bot may say about itself: its name,
// description, look, instructions, daily check-ins, notifications and model
// (among providers already connected). It never changes access, tools,
// credentials, other Bots, Bot messaging, the computer, approvals or hooks:
// a Bot never widens its own powers from chat.

import {
  BOT_AVATAR_COLOR_LABELS,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPE_LABELS,
  BOT_AVATAR_SHAPES,
  BOT_INTERRUPTIONS_MAX_DAILY_LIMIT,
  BOT_LIMITS,
  type BotAvatarColor,
  type BotAvatarShape,
  type BotInterruptions,
} from "./bots.js";

export const UPDATE_BOT_TOOL_NAME = "update_bot";
export const BOT_SETTINGS_CHANGE_ENTRY_KIND = "aiden.bot-settings-change";
export const BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND = "aiden.bot-settings-change-status";

/** What `update_bot` may change, and nothing else. */
export const BOT_SETTINGS_FIELDS = [
  "name",
  "description",
  "look",
  "instructions",
  "dailyCheckIns",
  "notifications",
  "model",
] as const;
export type BotSettingsField = (typeof BOT_SETTINGS_FIELDS)[number];

export interface BotSettingsModel {
  providerId: string;
  modelId: string;
}

/** A Bot's settings as `update_bot` reads and writes them. */
export interface BotSettingsValues {
  name: string;
  description: string;
  look: { color: BotAvatarColor; shape: BotAvatarShape };
  instructions: string;
  dailyCheckIns: boolean;
  notifications: BotInterruptions;
  /** Null when the Bot has no model of its own yet. */
  model: BotSettingsModel | null;
}

export type BotSettingsPatch = Partial<BotSettingsValues>;

/**
 * Settings only the person changes, in the Bot's own settings: named so the
 * tool can say why it refuses them.
 */
export const BOT_SETTINGS_PERSON_ONLY = new Set([
  "access",
  "accessMode",
  "tools",
  "disabledTools",
  "connections",
  "credentials",
  "apiKey",
  "skills",
  "files",
  "folders",
  "shell",
  "computer",
  "computerMode",
  "botMessaging",
  "acceptsBotMessages",
  "messagesOtherBots",
  "peers",
  "approvalMode",
  "approvals",
  "rules",
  "hooks",
  "spending",
  "spendingLimit",
  "telegram",
  "routines",
  "delete",
  "pause",
  "visionModel",
]);

export type BotSettingsChangeMode = "applied" | "held";

/**
 * Why a change waits for the person instead of applying: the run wasn't
 * theirs, the conversation already read content from outside the chat (a
 * page, a search, an app's data), or the change has the Bot reach out more
 * on its own (daily check-ins on, or more notifications a day).
 */
export type BotSettingsHeldReason = "not_owner" | "outside_content" | "widens";
const HELD_REASONS: readonly BotSettingsHeldReason[] = ["not_owner", "outside_content", "widens"];

/** The chat entry a change writes. */
export interface BotSettingsChangeEntryData {
  changeId: string;
  mode: BotSettingsChangeMode;
  fields: BotSettingsField[];
  /** One line per changed field, e.g. "Name: Chief → Planner". */
  lines: string[];
  /** The proposed instructions, for a held change that has them (Edit starts from these). */
  instructions?: string;
  /** The instructions when the held change was proposed, so the card can mark what changes. */
  previousInstructions?: string;
  /** Why a held change waits; absent on older entries, which were all `not_owner`. */
  heldReason?: BotSettingsHeldReason;
  /** False when Undo can't put this change back (the Bot had no model of its own before). */
  undoable?: false;
}

/** The minutes of the day quiet hours cover (a window past midnight wraps). */
function quietMinutes(quiet: BotInterruptions["quietHours"]): Set<number> {
  const minutes = new Set<number>();
  if (!quiet.enabled) return minutes;
  const at = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  const start = at(quiet.start);
  const end = at(quiet.end);
  if (start === end) return minutes;
  for (let minute = start; minute !== end; minute = (minute + 1) % 1440) minutes.add(minute);
  return minutes;
}

/**
 * Whether a patch has the Bot reach out more on its own: daily check-ins
 * turned on, a higher daily notification limit, or quiet hours that no
 * longer cover every minute they did (turned off, shortened or moved).
 * Those always wait for the person, whoever started the run.
 */
export function botSettingsPatchWidens(current: BotSettingsValues, patch: BotSettingsPatch): boolean {
  if (patch.dailyCheckIns === true && !current.dailyCheckIns) return true;
  if (patch.notifications === undefined) return false;
  if (patch.notifications.dailyLimit > current.notifications.dailyLimit) return true;
  const after = quietMinutes(patch.notifications.quietHours);
  for (const minute of quietMinutes(current.notifications.quietHours)) if (!after.has(minute)) return true;
  return false;
}

export type BotInstructionsDiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Lines compared at most; longer instructions show as all removed then all added. */
const DIFF_LINES_COMPARED = 400;

/**
 * A line-by-line comparison of two instructions (longest common
 * subsequence), in reading order with removed lines before the added ones
 * that replace them.
 */
export function botInstructionsDiff(before: string, after: string): BotInstructionsDiffLine[] {
  const a = before.split(/\r?\n/u);
  const b = after.split(/\r?\n/u);
  if (a.length > DIFF_LINES_COMPARED || b.length > DIFF_LINES_COMPARED) {
    return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  }
  // lengths[i][j]: the longest common run of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const out: BotInstructionsDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      out.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  return out;
}

/**
 * `restored`: Undo put the earlier values back. `undo_refused`: something
 * changed them again since, so Undo left them. `applied`, `edited` and
 * `dismissed` answer a held change.
 */
export type BotSettingsChangeStatus = "restored" | "undo_refused" | "applied" | "edited" | "dismissed";

export interface BotSettingsChangeStatusEntryData {
  changeId: string;
  status: BotSettingsChangeStatus;
}

export type BotSettingsChangeDecision = "undo" | "apply" | "edited" | "dismiss";

export const BOT_SETTINGS_UNDO_REFUSED_MESSAGE = "These settings changed again since, so Undo left them as they are.";

/** "Instructions updated" when only the instructions changed, else "Settings updated". */
export function botSettingsReceiptLabel(fields: readonly BotSettingsField[]): string {
  return fields.length === 1 && fields[0] === "instructions" ? "Instructions updated" : "Settings updated";
}

/** "Update instructions?" when the held change touches the instructions, else "Update settings?". */
export function botSettingsHeldTitle(fields: readonly BotSettingsField[]): string {
  return fields.includes("instructions") ? "Update instructions?" : "Update settings?";
}

/** One readable line for a changed field. `modelLabel` names a model. */
export function botSettingsLine(
  field: BotSettingsField,
  before: BotSettingsValues,
  after: BotSettingsValues,
  modelLabel: (model: BotSettingsModel | null) => string = (model) => model?.modelId ?? "None",
): string {
  switch (field) {
    case "name":
      return `Name: ${before.name} → ${after.name}`;
    case "description":
      return after.description ? `Description: ${after.description}` : "Description cleared";
    case "look":
      return `Look: ${BOT_AVATAR_COLOR_LABELS[after.look.color]} ${BOT_AVATAR_SHAPE_LABELS[after.look.shape]}`;
    case "instructions":
      return "Instructions";
    case "dailyCheckIns":
      return `Daily check-ins: ${after.dailyCheckIns ? "On" : "Off"}`;
    case "notifications": {
      const quiet = after.notifications.quietHours;
      const hours = quiet.enabled ? `quiet ${quiet.start}–${quiet.end}` : "no quiet hours";
      return `Notifications: ${after.notifications.dailyLimit} a day, ${hours}`;
    }
    case "model":
      return `Model: ${modelLabel(after.model)}`;
  }
}

/** Whether two values of one field are the same. */
export function sameBotSettingsValue(field: BotSettingsField, left: BotSettingsValues, right: BotSettingsValues): boolean {
  return JSON.stringify(left[field]) === JSON.stringify(right[field]);
}

/** The result of reading `update_bot`'s arguments. */
export type BotSettingsArgs =
  | { ok: true; patch: BotSettingsPatch }
  | { ok: false; error: string };

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function boundedText(value: unknown, maximum: number, allowEmpty: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) return undefined;
  if (Array.from(trimmed).length > maximum) return undefined;
  // No control characters other than line breaks and tabs.
  for (const character of trimmed) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") || code === 0x7f) return undefined;
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads `update_bot`'s arguments against `current`: only the fields above,
 * each checked. Anything else (access, tools, Bot messaging, …) is refused,
 * whatever the schema let through. A partial look or notifications value is
 * merged onto the current one.
 */
export function parseBotSettingsArgs(raw: unknown, current: BotSettingsValues): BotSettingsArgs {
  if (raw === undefined || raw === null) return { ok: true, patch: {} };
  if (!isRecord(raw)) return { ok: false, error: "update_bot takes an object of settings." };
  const unknown = Object.keys(raw).filter((key) => !(BOT_SETTINGS_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    const personOnly = unknown.filter((key) => BOT_SETTINGS_PERSON_ONLY.has(key));
    return {
      ok: false,
      error: personOnly.length > 0
        ? `You can't change ${personOnly.join(", ")} from chat. Only the person changes that, in this Bot's settings.`
        : `update_bot can't change ${unknown.join(", ")}. It changes only: ${BOT_SETTINGS_FIELDS.join(", ")}.`,
    };
  }
  const patch: BotSettingsPatch = {};
  if (raw.name !== undefined) {
    const name = boundedText(raw.name, BOT_LIMITS.nameChars, false);
    if (name === undefined) return { ok: false, error: `name must be 1–${BOT_LIMITS.nameChars} characters.` };
    patch.name = name;
  }
  if (raw.description !== undefined) {
    const description = boundedText(raw.description, BOT_LIMITS.descriptionChars, true);
    if (description === undefined) return { ok: false, error: `description must be at most ${BOT_LIMITS.descriptionChars} characters.` };
    patch.description = description;
  }
  if (raw.instructions !== undefined) {
    const instructions = boundedText(raw.instructions, BOT_LIMITS.instructionsChars, false);
    if (instructions === undefined) return { ok: false, error: "instructions must not be empty." };
    patch.instructions = instructions;
  }
  if (raw.look !== undefined) {
    if (!isRecord(raw.look) || Object.keys(raw.look).some((key) => key !== "color" && key !== "shape")) {
      return { ok: false, error: "look takes color and shape." };
    }
    const color = raw.look.color ?? current.look.color;
    const shape = raw.look.shape ?? current.look.shape;
    if (!(BOT_AVATAR_COLORS as readonly unknown[]).includes(color)) return { ok: false, error: `color must be one of ${BOT_AVATAR_COLORS.join(", ")}.` };
    if (!(BOT_AVATAR_SHAPES as readonly unknown[]).includes(shape)) return { ok: false, error: `shape must be one of ${BOT_AVATAR_SHAPES.join(", ")}.` };
    patch.look = { color: color as BotAvatarColor, shape: shape as BotAvatarShape };
  }
  if (raw.dailyCheckIns !== undefined) {
    if (typeof raw.dailyCheckIns !== "boolean") return { ok: false, error: "dailyCheckIns is true or false." };
    patch.dailyCheckIns = raw.dailyCheckIns;
  }
  if (raw.notifications !== undefined) {
    const value = raw.notifications;
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "perDay" && key !== "quietHours")) {
      return { ok: false, error: "notifications takes perDay and quietHours." };
    }
    const next: BotInterruptions = structuredClone(current.notifications);
    if (value.perDay !== undefined) {
      if (typeof value.perDay !== "number" || !Number.isInteger(value.perDay) || value.perDay < 0 || value.perDay > BOT_INTERRUPTIONS_MAX_DAILY_LIMIT) {
        return { ok: false, error: `notifications.perDay is a whole number from 0 to ${BOT_INTERRUPTIONS_MAX_DAILY_LIMIT}.` };
      }
      next.dailyLimit = value.perDay;
    }
    if (value.quietHours !== undefined) {
      const quiet = value.quietHours;
      if (!isRecord(quiet) || Object.keys(quiet).some((key) => key !== "enabled" && key !== "start" && key !== "end")) {
        return { ok: false, error: "quietHours takes enabled, start and end." };
      }
      if (quiet.enabled !== undefined) {
        if (typeof quiet.enabled !== "boolean") return { ok: false, error: "quietHours.enabled is true or false." };
        next.quietHours.enabled = quiet.enabled;
      }
      for (const key of ["start", "end"] as const) {
        if (quiet[key] === undefined) continue;
        if (typeof quiet[key] !== "string" || !CLOCK.test(quiet[key])) return { ok: false, error: `quietHours.${key} is a 24-hour time like 22:00.` };
        next.quietHours[key] = quiet[key];
      }
    }
    patch.notifications = next;
  }
  if (raw.model !== undefined) {
    const model = raw.model;
    if (!isRecord(model) || Object.keys(model).some((key) => key !== "providerId" && key !== "modelId")
      || typeof model.providerId !== "string" || typeof model.modelId !== "string"
      || !model.providerId || !model.modelId || model.providerId.length > 200 || model.modelId.length > 200) {
      return { ok: false, error: "model takes providerId and modelId, from the models update_bot lists." };
    }
    patch.model = { providerId: model.providerId, modelId: model.modelId };
  }
  return { ok: true, patch };
}

/** The fields a patch changes against `current`, in the fixed order above. */
export function changedBotSettingsFields(current: BotSettingsValues, patch: BotSettingsPatch): BotSettingsField[] {
  const next = { ...current, ...patch };
  return BOT_SETTINGS_FIELDS.filter((field) => patch[field] !== undefined && !sameBotSettingsValue(field, current, next));
}

/** Exact parse of a change entry; `undefined` when it isn't one. */
export function botSettingsChangeOf(data: unknown): BotSettingsChangeEntryData | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.changeId !== "string" || (data.mode !== "applied" && data.mode !== "held")) return undefined;
  if (!Array.isArray(data.fields) || !data.fields.every((field) => (BOT_SETTINGS_FIELDS as readonly unknown[]).includes(field))) return undefined;
  if (!Array.isArray(data.lines) || !data.lines.every((line) => typeof line === "string")) return undefined;
  if (data.instructions !== undefined && typeof data.instructions !== "string") return undefined;
  if (data.previousInstructions !== undefined && typeof data.previousInstructions !== "string") return undefined;
  if (data.heldReason !== undefined && !HELD_REASONS.includes(data.heldReason as BotSettingsHeldReason)) return undefined;
  if (data.undoable !== undefined && data.undoable !== false) return undefined;
  return {
    changeId: data.changeId,
    mode: data.mode,
    fields: data.fields as BotSettingsField[],
    lines: data.lines as string[],
    ...(typeof data.instructions === "string" ? { instructions: data.instructions } : {}),
    ...(typeof data.previousInstructions === "string" ? { previousInstructions: data.previousInstructions } : {}),
    ...(data.heldReason !== undefined ? { heldReason: data.heldReason as BotSettingsHeldReason } : {}),
    ...(data.undoable === false ? { undoable: false as const } : {}),
  };
}

const STATUSES: readonly BotSettingsChangeStatus[] = ["restored", "undo_refused", "applied", "edited", "dismissed"];

export function botSettingsChangeStatusOf(data: unknown): BotSettingsChangeStatusEntryData | undefined {
  if (!isRecord(data) || typeof data.changeId !== "string") return undefined;
  return STATUSES.includes(data.status as BotSettingsChangeStatus)
    ? { changeId: data.changeId, status: data.status as BotSettingsChangeStatus }
    : undefined;
}
