import { sanitizeSubagentSnapshotText } from "./subagent-safe-text.js";

export const SUBAGENT_RUN_SNAPSHOT_VERSION = 1 as const;
export const MAX_SUBAGENT_RUNS_PER_GENERATION = 8;
export const MAX_SUBAGENT_LABEL_CHARS = 120;
export const MAX_SUBAGENT_TASK_PREVIEW_CHARS = 240;
export const MAX_SUBAGENT_ACTIVITY_CHARS = 160;
export const MAX_SUBAGENT_LATEST_TEXT_CHARS = 2_000;
export const MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS = 12_000;
export const MAX_SUBAGENT_ERROR_CHARS = 240;
export const MAX_SUBAGENT_WARNINGS = 5;
export const MAX_SUBAGENT_WARNING_CHARS = 240;
export const MAX_SUBAGENT_MILESTONES = 12;

export type SubagentSnapshotRole = "scout" | "planner" | "reviewer";

/**
 * Renderer-safe activity facts. These values are deliberately closed and
 * contain no tool names, arguments, results, commands, or filesystem data.
 */
export const SUBAGENT_MILESTONE_KINDS = [
  "reading",
  "listing",
  "matching",
  "searching",
  "inspecting",
  "composing",
] as const;
export type SubagentMilestoneKind = (typeof SUBAGENT_MILESTONE_KINDS)[number];

export type SubagentRunState =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "interrupted";

export const SUBAGENT_ACTIVE_STATES: ReadonlySet<SubagentRunState> = new Set([
  "queued",
  "starting",
  "running",
]);
export const SUBAGENT_TERMINAL_STATES: ReadonlySet<SubagentRunState> = new Set([
  "completed",
  "failed",
  "timed_out",
  "interrupted",
]);

/**
 * The complete renderer-safe record for one child run. This is deliberately a
 * projection, not a serialized Pi session or AgentEvent.
 */
export interface SubagentRunSnapshotV1 {
  version: typeof SUBAGENT_RUN_SNAPSHOT_VERSION;
  runId: string;
  groupId: string;
  generationId: string;
  childId: string;
  chatId: string;
  workspaceId: string;
  revision: number;
  role: SubagentSnapshotRole;
  label: string;
  taskPreview: string;
  state: SubagentRunState;
  activity?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  modelId: string;
  turns: number;
  tools: number;
  tokens: number;
  /** Bounded, ordered, renderer-safe activity kinds. */
  milestones?: SubagentMilestoneKind[];
  latestText?: string;
  terminalMarkdown?: string;
  error?: string;
  warnings: string[];
}

/** Bounded reference copied onto a terminal assistant message. */
export interface SubagentMessageReferenceV1 {
  version: typeof SUBAGENT_RUN_SNAPSHOT_VERSION;
  generationId: string;
  runIds: string[];
  /**
   * New V1 writers include renderer-ready terminal metadata. This remains
   * optional so persisted references written before the metadata was added can
   * still be replayed without a migration.
   */
  items?: SubagentMessageReferenceItemV1[];
  total: number;
  completed: number;
  failed: number;
  timedOut: number;
  interrupted: number;
}

export interface SubagentMessageReferenceItemV1 {
  runId: string;
  label: string;
  role: SubagentSnapshotRole;
  state: Exclude<SubagentRunState, "queued" | "starting" | "running">;
}

const RUN_STATES = new Set<SubagentRunState>([
  ...SUBAGENT_ACTIVE_STATES,
  ...SUBAGENT_TERMINAL_STATES,
]);
const ROLES = new Set<SubagentSnapshotRole>(["scout", "planner", "reviewer"]);
const MILESTONE_KINDS = new Set<SubagentMilestoneKind>(SUBAGENT_MILESTONE_KINDS);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/u;
const IDENTIFIER_ENCODING_SEPARATOR = /[._:-]/u;
const IDENTIFIER_ENCODING_SEPARATORS = /[._:-]/gu;
const MAX_IDENTIFIER_ENCODING_SLICES = 512;
const REQUIRED_SNAPSHOT_KEYS = new Set([
  "version",
  "runId",
  "groupId",
  "generationId",
  "childId",
  "chatId",
  "workspaceId",
  "revision",
  "role",
  "label",
  "taskPreview",
  "state",
  "startedAt",
  "updatedAt",
  "modelId",
  "turns",
  "tools",
  "tokens",
  "warnings",
]);
const OPTIONAL_SNAPSHOT_KEYS = new Set([
  "activity",
  "finishedAt",
  "milestones",
  "latestText",
  "terminalMarkdown",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifierEncodingSlicesAreSafe(value: string): boolean {
  const starts = [0];
  const ends = [value.length];
  for (let index = 0; index < value.length; index += 1) {
    if (!IDENTIFIER_ENCODING_SEPARATOR.test(value[index]!)) continue;
    if (index > 0) ends.push(index);
    if (index + 1 < value.length) starts.push(index + 1);
  }

  let checked = 0;
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start || (start === 0 && end === value.length) || end - start < 8) continue;
      checked += 1;
      if (checked > MAX_IDENTIFIER_ENCODING_SLICES) return false;
      const slice = value.slice(start, end);
      if (sanitizeSubagentSnapshotText(slice) !== slice) return false;
      const compact = slice.replace(IDENTIFIER_ENCODING_SEPARATORS, "");
      if (compact.length >= 8 && sanitizeSubagentSnapshotText(compact) !== compact) return false;
    }
  }
  const compact = value.replace(IDENTIFIER_ENCODING_SEPARATORS, "");
  if (compact.length >= 8 && sanitizeSubagentSnapshotText(compact) !== compact) return false;
  return true;
}

/**
 * Shared privacy and syntax boundary for every identifier that can be
 * persisted in child history or reflected to a renderer.
 */
export function isSafeSubagentIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    value.normalize("NFKC") === value &&
    SAFE_ID.test(value) &&
    sanitizeSubagentSnapshotText(value) === value &&
    identifierEncodingSlicesAreSafe(value)
  );
}

function hasControl(value: string, allowNewlines: boolean): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (allowNewlines && (code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  });
}

function safeText(
  value: unknown,
  maximum: number,
  options: { allowEmpty?: boolean; allowNewlines?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    (options.allowEmpty === true || value.trim().length > 0) &&
    value.length <= maximum &&
    !hasControl(value, options.allowNewlines === true) &&
    sanitizeSubagentSnapshotText(value) === value
  );
}

function hasExactSnapshotKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    REQUIRED_SNAPSHOT_KEYS.size <= keys.length &&
    keys.length <= REQUIRED_SNAPSHOT_KEYS.size + OPTIONAL_SNAPSHOT_KEYS.size &&
    [...REQUIRED_SNAPSHOT_KEYS].every((key) => key in value) &&
    keys.every((key) => REQUIRED_SNAPSHOT_KEYS.has(key) || OPTIONAL_SNAPSHOT_KEYS.has(key))
  );
}

/** Reject malformed or non-redacted values before they cross IPC or replay from disk. */
export function parseSubagentRunSnapshotV1(value: unknown): SubagentRunSnapshotV1 | undefined {
  if (!isRecord(value) || !hasExactSnapshotKeys(value)) return undefined;
  if (
    value.version !== SUBAGENT_RUN_SNAPSHOT_VERSION ||
    !isSafeSubagentIdentifier(value.runId) ||
    !isSafeSubagentIdentifier(value.groupId) ||
    !isSafeSubagentIdentifier(value.generationId) ||
    !isSafeSubagentIdentifier(value.childId) ||
    !isSafeSubagentIdentifier(value.chatId) ||
    !isSafeSubagentIdentifier(value.workspaceId) ||
    !nonNegativeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.role !== "string" ||
    !ROLES.has(value.role as SubagentSnapshotRole) ||
    !safeText(value.label, MAX_SUBAGENT_LABEL_CHARS) ||
    !safeText(value.taskPreview, MAX_SUBAGENT_TASK_PREVIEW_CHARS) ||
    typeof value.state !== "string" ||
    !RUN_STATES.has(value.state as SubagentRunState) ||
    !finiteTimestamp(value.startedAt) ||
    !finiteTimestamp(value.updatedAt) ||
    value.updatedAt < value.startedAt ||
    !safeText(value.modelId, 160) ||
    !nonNegativeInteger(value.turns) ||
    !nonNegativeInteger(value.tools) ||
    !nonNegativeInteger(value.tokens) ||
    (value.milestones !== undefined &&
      (!Array.isArray(value.milestones) ||
        value.milestones.length > MAX_SUBAGENT_MILESTONES ||
        value.milestones.some(
          (milestone) =>
            typeof milestone !== "string" ||
            !MILESTONE_KINDS.has(milestone as SubagentMilestoneKind),
        ))) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > MAX_SUBAGENT_WARNINGS ||
    value.warnings.some((warning) => !safeText(warning, MAX_SUBAGENT_WARNING_CHARS))
  ) {
    return undefined;
  }

  const state = value.state as SubagentRunState;
  const activeHasTerminalFields =
    SUBAGENT_ACTIVE_STATES.has(state) &&
    (value.latestText !== undefined ||
      value.terminalMarkdown !== undefined ||
      value.error !== undefined ||
      value.warnings.length > 0);
  if (
    (value.activity !== undefined && !safeText(value.activity, MAX_SUBAGENT_ACTIVITY_CHARS)) ||
    (value.latestText !== undefined &&
      !safeText(value.latestText, MAX_SUBAGENT_LATEST_TEXT_CHARS, {
        allowNewlines: true,
      })) ||
    (value.terminalMarkdown !== undefined &&
      !safeText(value.terminalMarkdown, MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS, {
        allowNewlines: true,
      })) ||
    (value.error !== undefined && !safeText(value.error, MAX_SUBAGENT_ERROR_CHARS)) ||
    (value.finishedAt !== undefined &&
      (!finiteTimestamp(value.finishedAt) || value.finishedAt < value.updatedAt)) ||
    activeHasTerminalFields ||
    (SUBAGENT_ACTIVE_STATES.has(state) && value.finishedAt !== undefined) ||
    (SUBAGENT_TERMINAL_STATES.has(state) && value.finishedAt === undefined)
  ) {
    return undefined;
  }

  return {
    version: SUBAGENT_RUN_SNAPSHOT_VERSION,
    runId: value.runId,
    groupId: value.groupId,
    generationId: value.generationId,
    childId: value.childId,
    chatId: value.chatId,
    workspaceId: value.workspaceId,
    revision: value.revision,
    role: value.role as SubagentSnapshotRole,
    label: value.label,
    taskPreview: value.taskPreview,
    state,
    ...(value.activity === undefined ? {} : { activity: value.activity as string }),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as number }),
    modelId: value.modelId,
    turns: value.turns,
    tools: value.tools,
    tokens: value.tokens,
    ...(value.milestones === undefined
      ? {}
      : { milestones: [...(value.milestones as SubagentMilestoneKind[])] }),
    ...(value.latestText === undefined ? {} : { latestText: value.latestText as string }),
    ...(value.terminalMarkdown === undefined
      ? {}
      : { terminalMarkdown: value.terminalMarkdown as string }),
    ...(value.error === undefined ? {} : { error: value.error as string }),
    warnings: [...(value.warnings as string[])],
  };
}

export function parseSubagentRunSnapshotsV1(value: unknown): SubagentRunSnapshotV1[] {
  if (!Array.isArray(value) || value.length > MAX_SUBAGENT_RUNS_PER_GENERATION) return [];
  const parsed = value.map(parseSubagentRunSnapshotV1);
  return parsed.every((entry): entry is SubagentRunSnapshotV1 => entry !== undefined) ? parsed : [];
}

export function subagentMessageReference(
  generationId: string,
  snapshots: readonly SubagentRunSnapshotV1[],
): SubagentMessageReferenceV1 | undefined {
  if (!isSafeSubagentIdentifier(generationId) || snapshots.length === 0) return undefined;
  const runs: SubagentRunSnapshotV1[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const parsed = parseSubagentRunSnapshotV1(snapshot);
    if (
      !parsed ||
      parsed.generationId !== generationId ||
      !SUBAGENT_TERMINAL_STATES.has(parsed.state) ||
      seen.has(parsed.runId)
    ) {
      continue;
    }
    seen.add(parsed.runId);
    runs.push(parsed);
    if (runs.length === MAX_SUBAGENT_RUNS_PER_GENERATION) break;
  }
  if (!runs.length) return undefined;
  return {
    version: SUBAGENT_RUN_SNAPSHOT_VERSION,
    generationId,
    runIds: runs.map(({ runId }) => runId),
    items: runs.map(({ runId, label, role, state }) => ({
      runId,
      label,
      role,
      state: state as SubagentMessageReferenceItemV1["state"],
    })),
    total: runs.length,
    completed: runs.filter(({ state }) => state === "completed").length,
    failed: runs.filter(({ state }) => state === "failed").length,
    timedOut: runs.filter(({ state }) => state === "timed_out").length,
    interrupted: runs.filter(({ state }) => state === "interrupted").length,
  };
}

export function parseSubagentMessageReferenceV1(
  value: unknown,
): SubagentMessageReferenceV1 | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  const legacyKeys = [
    "version",
    "generationId",
    "runIds",
    "total",
    "completed",
    "failed",
    "timedOut",
    "interrupted",
  ];
  const enriched = keys.length === legacyKeys.length + 1 && "items" in value;
  if (
    (keys.length !== legacyKeys.length && !enriched) ||
    !legacyKeys.every((key) => key in value) ||
    keys.some((key) => !legacyKeys.includes(key) && key !== "items") ||
    value.version !== SUBAGENT_RUN_SNAPSHOT_VERSION ||
    !isSafeSubagentIdentifier(value.generationId) ||
    !Array.isArray(value.runIds) ||
    value.runIds.length < 1 ||
    value.runIds.length > MAX_SUBAGENT_RUNS_PER_GENERATION ||
    value.runIds.some((runId) => !isSafeSubagentIdentifier(runId)) ||
    new Set(value.runIds).size !== value.runIds.length ||
    !nonNegativeInteger(value.total) ||
    !nonNegativeInteger(value.completed) ||
    !nonNegativeInteger(value.failed) ||
    !nonNegativeInteger(value.timedOut) ||
    !nonNegativeInteger(value.interrupted)
  ) {
    return undefined;
  }
  const total =
    (value.completed as number) +
    (value.failed as number) +
    (value.timedOut as number) +
    (value.interrupted as number);
  if (value.total !== value.runIds.length || total !== value.total) return undefined;

  let items: SubagentMessageReferenceItemV1[] | undefined;
  if (enriched) {
    if (!Array.isArray(value.items) || value.items.length !== value.runIds.length) return undefined;
    const parsedItems: SubagentMessageReferenceItemV1[] = [];
    for (let index = 0; index < value.items.length; index += 1) {
      const item = value.items[index];
      if (
        !isRecord(item) ||
        Object.keys(item).length !== 4 ||
        !["runId", "label", "role", "state"].every((key) => key in item) ||
        !isSafeSubagentIdentifier(item.runId) ||
        item.runId !== value.runIds[index] ||
        !safeText(item.label, MAX_SUBAGENT_LABEL_CHARS) ||
        typeof item.role !== "string" ||
        !ROLES.has(item.role as SubagentSnapshotRole) ||
        typeof item.state !== "string" ||
        !SUBAGENT_TERMINAL_STATES.has(item.state as SubagentRunState)
      ) {
        return undefined;
      }
      parsedItems.push({
        runId: item.runId,
        label: item.label,
        role: item.role as SubagentSnapshotRole,
        state: item.state as SubagentMessageReferenceItemV1["state"],
      });
    }
    const itemCounts = {
      completed: parsedItems.filter(({ state }) => state === "completed").length,
      failed: parsedItems.filter(({ state }) => state === "failed").length,
      timedOut: parsedItems.filter(({ state }) => state === "timed_out").length,
      interrupted: parsedItems.filter(({ state }) => state === "interrupted").length,
    };
    if (
      itemCounts.completed !== value.completed ||
      itemCounts.failed !== value.failed ||
      itemCounts.timedOut !== value.timedOut ||
      itemCounts.interrupted !== value.interrupted
    ) {
      return undefined;
    }
    items = parsedItems;
  }

  return {
    version: SUBAGENT_RUN_SNAPSHOT_VERSION,
    generationId: value.generationId,
    runIds: [...(value.runIds as string[])],
    ...(items ? { items } : {}),
    total: value.total,
    completed: value.completed,
    failed: value.failed,
    timedOut: value.timedOut,
    interrupted: value.interrupted,
  };
}
