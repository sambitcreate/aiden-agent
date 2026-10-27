// "Needs you" items a Bot's host code raises for the person (plan F2).
//
// An issue is host-owned: the host writes it, settles it, and offers the
// person at most two actions. The chat card, the sidebar's "Needs you" state
// and the delivery funnel all read these values; a Bot's own model never
// raises one. Later tasks raise them for failed routines, pre-flight checks
// and stuck runs.

export type BotIssueKind = "preflight_failed" | "routine_failed" | "routine_paused" | "run_stalled";

export type BotIssueAction =
  | { kind: "open_settings"; section: "model" | "access" | "connections" | "providers" }
  | { kind: "resume_routine"; routineId: string }
  | { kind: "stop_run" }
  | { kind: "keep_waiting" }
  | { kind: "open_chat" };

export type BotIssueResolution = "fixed" | "dismissed" | "superseded";

export interface BotIssue {
  id: string;
  botId: string;
  kind: BotIssueKind;
  dedupeKey: string;
  title: string;
  body: string;
  routineId?: string;
  /** 0–2 actions, in the order the card offers them; the last one is primary. */
  actions: BotIssueAction[];
  createdAt: number;
  resolvedAt?: number;
  resolution?: BotIssueResolution;
}

export const BOT_ISSUE_LIMITS = {
  openPerBot: 8,
  retainedResolved: 50,
  titleChars: 80,
  bodyChars: 280,
} as const;

export const BOT_ISSUE_ENTRY_KIND = "aiden.bot-issue";
export const BOT_ISSUE_STATUS_ENTRY_KIND = "aiden.bot-issue-status";
export const BOT_ISSUE_CHANNELS = { act: "bots:issues:act", list: "bots:issues:list" } as const;

/** What a settled issue's status entry records; the newest one per issue wins. */
export interface BotIssueStatusEntryData {
  issueId: string;
  resolution: BotIssueResolution;
  resolvedAt?: number;
}

const ISSUE_KINDS: ReadonlySet<string> = new Set<BotIssueKind>([
  "preflight_failed",
  "routine_failed",
  "routine_paused",
  "run_stalled",
]);

const ISSUE_RESOLUTIONS: ReadonlySet<string> = new Set<BotIssueResolution>([
  "fixed",
  "dismissed",
  "superseded",
]);

type SettingsSection = Extract<BotIssueAction, { kind: "open_settings" }>["section"];

const SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsSection>([
  "model",
  "access",
  "connections",
  "providers",
]);

/** Issue, Bot and routine ids: the same path-safe shape the Bot stores accept. */
export const BOT_ISSUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const ISSUE_ID = BOT_ISSUE_ID_PATTERN;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Exactly these keys and no others: an issue never carries unrecognized fields. */
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const fields = record(value);
  if (!fields) return null;
  const allowed = new Set(keys);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) return null;
  return fields;
}

function text(value: unknown, limit: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const length = [...value].length;
  if (length > limit) return undefined;
  if (!allowEmpty && value.trim().length === 0) return undefined;
  return value;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function botIssueKindOf(value: unknown): BotIssueKind | null {
  return typeof value === "string" && ISSUE_KINDS.has(value) ? (value as BotIssueKind) : null;
}

export function botIssueResolutionOf(value: unknown): BotIssueResolution | null {
  return typeof value === "string" && ISSUE_RESOLUTIONS.has(value)
    ? (value as BotIssueResolution)
    : null;
}

/** One action exactly as a card offers it, or null when it is not the current shape. */
export function botIssueActionOf(value: unknown): BotIssueAction | null {
  const kind = record(value)?.kind;
  if (typeof kind !== "string") return null;
  switch (kind) {
    case "open_settings": {
      const fields = exact(value, ["kind", "section"]);
      if (!fields || typeof fields.section !== "string" || !SETTINGS_SECTIONS.has(fields.section)) {
        return null;
      }
      return { kind, section: fields.section as Extract<BotIssueAction, { kind: "open_settings" }>["section"] };
    }
    case "resume_routine": {
      const fields = exact(value, ["kind", "routineId"]);
      if (!fields || typeof fields.routineId !== "string" || !ISSUE_ID.test(fields.routineId)) {
        return null;
      }
      return { kind, routineId: fields.routineId };
    }
    case "stop_run":
    case "keep_waiting":
    case "open_chat":
      return exact(value, ["kind"]) ? { kind } : null;
    default:
      return null;
  }
}

/**
 * One stored or projected issue, or null when it is not the current shape.
 * `botId` (when given) must match, so a file can never carry another Bot's issue.
 */
export function botIssueOf(value: unknown, botId?: string): BotIssue | null {
  const fields = record(value);
  if (!fields) return null;
  if (typeof fields.id !== "string" || !ISSUE_ID.test(fields.id)) return null;
  if (typeof fields.botId !== "string" || !ISSUE_ID.test(fields.botId)) return null;
  if (botId !== undefined && fields.botId !== botId) return null;
  const kind = botIssueKindOf(fields.kind);
  const dedupeKey = text(fields.dedupeKey, 400);
  const title = text(fields.title, BOT_ISSUE_LIMITS.titleChars);
  const body = text(fields.body, BOT_ISSUE_LIMITS.bodyChars, true);
  const createdAt = timestamp(fields.createdAt);
  if (kind === null || dedupeKey === undefined || title === undefined || body === undefined || createdAt === undefined) {
    return null;
  }
  if (fields.routineId !== undefined && (typeof fields.routineId !== "string" || !ISSUE_ID.test(fields.routineId))) {
    return null;
  }
  if (!Array.isArray(fields.actions) || fields.actions.length > 2) return null;
  const actions: BotIssueAction[] = [];
  for (const item of fields.actions) {
    const action = botIssueActionOf(item);
    if (action === null) return null;
    actions.push(action);
  }
  const resolvedAt = fields.resolvedAt === undefined ? undefined : timestamp(fields.resolvedAt);
  if (fields.resolvedAt !== undefined && resolvedAt === undefined) return null;
  const resolution = fields.resolution === undefined ? undefined : botIssueResolutionOf(fields.resolution);
  if (resolution === null) return null;
  // A settled issue says both when and how; an open one says neither.
  if ((resolvedAt === undefined) !== (resolution === undefined)) return null;
  return {
    id: fields.id,
    botId: fields.botId,
    kind,
    dedupeKey,
    title,
    body,
    ...(typeof fields.routineId === "string" ? { routineId: fields.routineId } : {}),
    actions,
    createdAt,
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolution === undefined ? {} : { resolution }),
  };
}

/** One status entry, or null when it is not the current shape. */
export function botIssueStatusOf(value: unknown): BotIssueStatusEntryData | null {
  const fields = record(value);
  if (!fields) return null;
  if (typeof fields.issueId !== "string" || !ISSUE_ID.test(fields.issueId)) return null;
  const resolution = botIssueResolutionOf(fields.resolution);
  if (resolution === null) return null;
  const resolvedAt = fields.resolvedAt === undefined ? undefined : timestamp(fields.resolvedAt);
  if (fields.resolvedAt !== undefined && resolvedAt === undefined) return null;
  return { issueId: fields.issueId, resolution, ...(resolvedAt === undefined ? {} : { resolvedAt }) };
}
