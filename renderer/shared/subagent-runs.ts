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

export const SUBAGENT_PROJECTION_NOTICE_KINDS = [
  "task_truncated",
  "report_truncated",
  "display_filtered",
] as const;
export type SubagentProjectionNoticeKind = (typeof SUBAGENT_PROJECTION_NOTICE_KINDS)[number];

/**
 * Projection facts describe immutable task handling plus terminal report
 * handling. Task provenance cannot change after launch; report/display facts
 * may only be added when a run becomes terminal, and no fact may disappear.
 */
export function subagentProjectionNoticesAreMonotonic(
  current: readonly SubagentProjectionNoticeKind[] | undefined,
  next: readonly SubagentProjectionNoticeKind[] | undefined,
  allowTerminalAdditions: boolean,
): boolean {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  if (currentSet.has("task_truncated") !== nextSet.has("task_truncated")) return false;
  if ([...currentSet].some((notice) => !nextSet.has(notice))) return false;
  return allowTerminalAdditions || [...nextSet].every((notice) => currentSet.has(notice));
}

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
  /** Closed producer facts about transformations applied to this saved view. */
  projectionNotices?: SubagentProjectionNoticeKind[];
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
const PROJECTION_NOTICE_KINDS = new Set<SubagentProjectionNoticeKind>(
  SUBAGENT_PROJECTION_NOTICE_KINDS,
);
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
  "projectionNotices",
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
    (value.projectionNotices !== undefined &&
      (!Array.isArray(value.projectionNotices) ||
        value.projectionNotices.length > SUBAGENT_PROJECTION_NOTICE_KINDS.length ||
        new Set(value.projectionNotices).size !== value.projectionNotices.length ||
        value.projectionNotices.some(
          (notice) =>
            typeof notice !== "string" ||
            !PROJECTION_NOTICE_KINDS.has(notice as SubagentProjectionNoticeKind),
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
    (SUBAGENT_ACTIVE_STATES.has(state) &&
      (value.projectionNotices as unknown[] | undefined)?.includes("report_truncated")) ||
    ((value.projectionNotices as unknown[] | undefined)?.includes("report_truncated") &&
      value.terminalMarkdown === undefined) ||
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
    ...(value.projectionNotices === undefined
      ? {}
      : {
          projectionNotices: [...(value.projectionNotices as SubagentProjectionNoticeKind[])],
        }),
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

export const SUBAGENT_RUN_SNAPSHOT_VERSION_V2 = 2 as const;
export type SubagentRunStateV2 = SubagentRunState | "needs_attention" | "stopped" | "unknown";
export type SubagentExecutionModeV2 = "foreground" | "background";
export type SubagentContextModeV2 = "fresh" | "fork";

export interface SubagentRunSnapshotV2 extends Omit<SubagentRunSnapshotV1, "version" | "state"> {
  version: typeof SUBAGENT_RUN_SNAPSHOT_VERSION_V2;
  state: SubagentRunStateV2;
  parentRunId?: string;
  retryOfRunId?: string;
  depth: number;
  execution: SubagentExecutionModeV2;
  context: SubagentContextModeV2;
  authorityRevision: number;
}

export type SubagentRunSnapshot = SubagentRunSnapshotV1 | SubagentRunSnapshotV2;

const V2_REQUIRED_SNAPSHOT_KEYS = new Set([
  ...REQUIRED_SNAPSHOT_KEYS,
  "depth",
  "execution",
  "context",
  "authorityRevision",
]);
const V2_OPTIONAL_SNAPSHOT_KEYS = new Set([
  ...OPTIONAL_SNAPSHOT_KEYS,
  "parentRunId",
  "retryOfRunId",
]);
const V2_STATES = new Set<SubagentRunStateV2>([
  ...RUN_STATES,
  "needs_attention",
  "stopped",
  "unknown",
]);
const V2_EXECUTION_MODES = new Set<SubagentExecutionModeV2>(["foreground", "background"]);
const V2_CONTEXT_MODES = new Set<SubagentContextModeV2>(["fresh", "fork"]);

function hasExactV2SnapshotKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    V2_REQUIRED_SNAPSHOT_KEYS.size <= keys.length &&
    keys.length <= V2_REQUIRED_SNAPSHOT_KEYS.size + V2_OPTIONAL_SNAPSHOT_KEYS.size &&
    [...V2_REQUIRED_SNAPSHOT_KEYS].every((key) => key in value) &&
    keys.every((key) => V2_REQUIRED_SNAPSHOT_KEYS.has(key) || V2_OPTIONAL_SNAPSHOT_KEYS.has(key))
  );
}

function v2StateAsV1(state: SubagentRunStateV2): SubagentRunState {
  return state === "needs_attention"
    ? "running"
    : state === "stopped"
      ? "interrupted"
      : state === "unknown"
        ? "failed"
        : state;
}

function v2BaseProjection(
  value: Record<string, unknown> | SubagentRunSnapshotV2,
): Record<string, unknown> {
  const state = value.state as SubagentRunStateV2;
  return {
    version: SUBAGENT_RUN_SNAPSHOT_VERSION,
    runId: value.runId,
    groupId: value.groupId,
    generationId: value.generationId,
    childId: value.childId,
    chatId: value.chatId,
    workspaceId: value.workspaceId,
    revision: value.revision,
    role: value.role,
    label: value.label,
    taskPreview: value.taskPreview,
    state: v2StateAsV1(state),
    ...(state === "needs_attention"
      ? { activity: "Needs attention." }
      : value.activity === undefined
        ? {}
        : { activity: value.activity }),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    modelId: value.modelId,
    turns: value.turns,
    tools: value.tools,
    tokens: value.tokens,
    ...(value.milestones === undefined ? {} : { milestones: value.milestones }),
    ...(value.projectionNotices === undefined
      ? {}
      : { projectionNotices: value.projectionNotices }),
    ...(value.latestText === undefined ? {} : { latestText: value.latestText }),
    ...(value.terminalMarkdown === undefined ? {} : { terminalMarkdown: value.terminalMarkdown }),
    ...(value.error === undefined ? {} : { error: value.error }),
    warnings: value.warnings,
  };
}

export function parseSubagentRunSnapshotV2(value: unknown): SubagentRunSnapshotV2 | undefined {
  if (
    !isRecord(value) ||
    !hasExactV2SnapshotKeys(value) ||
    value.version !== SUBAGENT_RUN_SNAPSHOT_VERSION_V2 ||
    typeof value.state !== "string" ||
    !V2_STATES.has(value.state as SubagentRunStateV2) ||
    !nonNegativeInteger(value.depth) ||
    value.depth < 1 ||
    value.depth > 2 ||
    typeof value.execution !== "string" ||
    !V2_EXECUTION_MODES.has(value.execution as SubagentExecutionModeV2) ||
    typeof value.context !== "string" ||
    !V2_CONTEXT_MODES.has(value.context as SubagentContextModeV2) ||
    !nonNegativeInteger(value.authorityRevision) ||
    (value.parentRunId !== undefined && !isSafeSubagentIdentifier(value.parentRunId)) ||
    (value.retryOfRunId !== undefined && !isSafeSubagentIdentifier(value.retryOfRunId)) ||
    (value.depth === 1 && value.parentRunId !== undefined) ||
    (value.depth > 1 && value.parentRunId === undefined) ||
    value.parentRunId === value.runId ||
    (value.state === "needs_attention" && value.activity !== "Needs attention.") ||
    value.retryOfRunId === value.runId
  ) {
    return undefined;
  }
  const state = value.state as SubagentRunStateV2;
  const v1 = parseSubagentRunSnapshotV1(v2BaseProjection(value));
  if (!v1) return undefined;
  if (
    (state === "needs_attention" && value.finishedAt !== undefined) ||
    ((state === "stopped" || state === "unknown") && value.finishedAt === undefined)
  ) {
    return undefined;
  }
  return {
    ...v1,
    version: SUBAGENT_RUN_SNAPSHOT_VERSION_V2,
    state,
    ...(value.parentRunId === undefined ? {} : { parentRunId: value.parentRunId as string }),
    ...(value.retryOfRunId === undefined ? {} : { retryOfRunId: value.retryOfRunId as string }),
    depth: value.depth,
    execution: value.execution as SubagentExecutionModeV2,
    context: value.context as SubagentContextModeV2,
    authorityRevision: value.authorityRevision,
  };
}

export function parseSubagentRunSnapshot(value: unknown): SubagentRunSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  return value.version === SUBAGENT_RUN_SNAPSHOT_VERSION
    ? parseSubagentRunSnapshotV1(value)
    : value.version === SUBAGENT_RUN_SNAPSHOT_VERSION_V2
      ? parseSubagentRunSnapshotV2(value)
      : undefined;
}

function subagentRunSnapshotIsTerminal(snapshot: SubagentRunSnapshot): boolean {
  return snapshot.version === 2
    ? snapshot.state === "completed" ||
        snapshot.state === "failed" ||
        snapshot.state === "timed_out" ||
        snapshot.state === "interrupted" ||
        snapshot.state === "stopped" ||
        snapshot.state === "unknown"
    : SUBAGENT_TERMINAL_STATES.has(snapshot.state);
}

function sameOptionalIdentifier(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function sameSubagentRunSnapshotIdentity(
  current: SubagentRunSnapshot,
  next: SubagentRunSnapshot,
): boolean {
  return (
    current.version === next.version &&
    current.runId === next.runId &&
    current.groupId === next.groupId &&
    current.generationId === next.generationId &&
    current.childId === next.childId &&
    current.chatId === next.chatId &&
    current.workspaceId === next.workspaceId &&
    current.role === next.role &&
    current.label === next.label &&
    current.taskPreview === next.taskPreview &&
    current.startedAt === next.startedAt &&
    current.modelId === next.modelId &&
    (current.version !== 2 ||
      (next.version === 2 &&
        current.authorityRevision === next.authorityRevision &&
        current.depth === next.depth &&
        current.execution === next.execution &&
        current.context === next.context &&
        sameOptionalIdentifier(current.parentRunId, next.parentRunId) &&
        sameOptionalIdentifier(current.retryOfRunId, next.retryOfRunId)))
  );
}

function subagentRunStateProgresses(
  current: SubagentRunSnapshot,
  next: SubagentRunSnapshot,
): boolean {
  if (subagentRunSnapshotIsTerminal(current)) return false;
  if (current.state === "queued") return true;
  if (current.state === "starting") return next.state !== "queued";
  return next.state !== "queued" && next.state !== "starting";
}

/**
 * The shared renderer-facing lifecycle fence. A newer revision may enrich an
 * active run, but it cannot rewrite authority/display identity, revive a
 * terminal run, or move timestamps, counters, milestones, or projection facts
 * backward. Exact same-revision replays are opt-in for idempotent history reads.
 */
export function subagentRunSnapshotUpdateIsMonotonic(
  currentValue: unknown,
  nextValue: unknown,
  options: { allowExactReplay?: boolean } = {},
): boolean {
  const current = parseSubagentRunSnapshot(currentValue);
  const next = parseSubagentRunSnapshot(nextValue);
  if (!current || !next || !sameSubagentRunSnapshotIdentity(current, next)) return false;
  if (next.revision === current.revision) {
    return options.allowExactReplay === true && JSON.stringify(next) === JSON.stringify(current);
  }
  const currentMilestones = current.milestones ?? [];
  const nextMilestones = next.milestones ?? [];
  return (
    next.revision > current.revision &&
    next.updatedAt >= current.updatedAt &&
    next.turns >= current.turns &&
    next.tools >= current.tools &&
    next.tokens >= current.tokens &&
    nextMilestones.length >= currentMilestones.length &&
    currentMilestones.every((milestone, index) => nextMilestones[index] === milestone) &&
    subagentProjectionNoticesAreMonotonic(
      current.projectionNotices,
      next.projectionNotices,
      subagentRunSnapshotIsTerminal(next),
    ) &&
    subagentRunStateProgresses(current, next)
  );
}

export const MAX_SUBAGENT_EFFECT_ACTIVITY = 512;
export type SubagentEffectActivityKindV1 = "mcp_mutation" | "shell";
export type SubagentEffectActivityStateV1 =
  | "prepared"
  | "authorized"
  | "dispatch_started"
  | "completed"
  | "remote_error"
  | "cancelled_before_dispatch"
  | "unknown";

export interface SubagentEffectActivityV1 {
  version: 1;
  kind: SubagentEffectActivityKindV1;
  state: SubagentEffectActivityStateV1;
  label: string;
  updatedAt: number;
}

export interface SubagentHistoryDetailV1 {
  version: 1;
  snapshot: SubagentRunSnapshot;
  effects: SubagentEffectActivityV1[];
}

const EFFECT_KINDS = new Set<SubagentEffectActivityKindV1>(["mcp_mutation", "shell"]);
const EFFECT_STATES = new Set<SubagentEffectActivityStateV1>([
  "prepared",
  "authorized",
  "dispatch_started",
  "completed",
  "remote_error",
  "cancelled_before_dispatch",
  "unknown",
]);

function hasExactPlainDataKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        expected.includes(key) &&
        descriptors[key]?.enumerable === true &&
        "value" in descriptors[key]!,
    )
  );
}

export function parseSubagentEffectActivityV1(
  value: unknown,
): SubagentEffectActivityV1 | undefined {
  if (!hasExactPlainDataKeys(value, ["version", "kind", "state", "label", "updatedAt"])) {
    return undefined;
  }
  if (
    value.version !== 1 ||
    typeof value.kind !== "string" ||
    !EFFECT_KINDS.has(value.kind as SubagentEffectActivityKindV1) ||
    typeof value.state !== "string" ||
    !EFFECT_STATES.has(value.state as SubagentEffectActivityStateV1) ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > MAX_SUBAGENT_ACTIVITY_CHARS ||
    sanitizeSubagentSnapshotText(value.label) !== value.label ||
    !finiteTimestamp(value.updatedAt)
  )
    return undefined;
  return {
    version: 1,
    kind: value.kind as SubagentEffectActivityKindV1,
    state: value.state as SubagentEffectActivityStateV1,
    label: value.label,
    updatedAt: value.updatedAt,
  };
}

export function parseSubagentHistoryDetailV1(value: unknown): SubagentHistoryDetailV1 | undefined {
  if (
    !hasExactPlainDataKeys(value, ["version", "snapshot", "effects"]) ||
    value.version !== 1 ||
    !Array.isArray(value.effects) ||
    value.effects.length > MAX_SUBAGENT_EFFECT_ACTIVITY
  )
    return undefined;
  const snapshot = parseSubagentRunSnapshot(value.snapshot);
  const effects = value.effects.map(parseSubagentEffectActivityV1);
  if (!snapshot || effects.some((effect) => effect === undefined)) return undefined;
  return {
    version: 1,
    snapshot,
    effects: effects as SubagentEffectActivityV1[],
  };
}

export function adaptSubagentRunSnapshotV1ToV2(
  snapshot: SubagentRunSnapshotV1,
): SubagentRunSnapshotV2 | undefined {
  const parsed = parseSubagentRunSnapshotV1(snapshot);
  if (!parsed) return undefined;
  const active = SUBAGENT_ACTIVE_STATES.has(parsed.state);
  return parseSubagentRunSnapshotV2({
    ...parsed,
    version: SUBAGENT_RUN_SNAPSHOT_VERSION_V2,
    state: active ? "interrupted" : parsed.state,
    ...(active ? { finishedAt: parsed.updatedAt } : {}),
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 0,
  });
}

export function adaptSubagentRunSnapshotV2ToV1(
  snapshot: SubagentRunSnapshotV2,
): SubagentRunSnapshotV1 | undefined {
  const parsed = parseSubagentRunSnapshotV2(snapshot);
  return parsed ? parseSubagentRunSnapshotV1(v2BaseProjection(parsed)) : undefined;
}
