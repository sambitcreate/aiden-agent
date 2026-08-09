// Shared between main and every renderer: the reserved workspace id that keeps
// assistant threads out of the main window's sidebar. The sidebar always lists
// chats filtered by the active workspace, and workspace ids are main-generated,
// so a reserved literal is sufficient isolation.
export const ASSISTANT_WORKSPACE_ID = "assistant";
export const ASSISTANT_AUTOMATION_TOOL_NAME = "schedule_task";
export const ASSISTANT_AUTOMATION_EDIT_TOOL_NAME = "edit_automation";
export const ASSISTANT_AUTOMATION_NAME_LIMIT = 120;
export const ASSISTANT_AUTOMATION_PROMPT_LIMIT = 32 * 1024;
export const ASSISTANT_AUTOMATION_CRON_LIMIT = 256;
export const ASSISTANT_AUTOMATION_TIMEZONE_LIMIT = 128;
export const ASSISTANT_AUTOMATION_TASK_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT = 120;
export const ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT = 16;
export const ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT = 120;
export const ASSISTANT_AUTOMATION_PROVIDER_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT = 120;
export const ASSISTANT_AUTOMATION_MODEL_ID_LIMIT = 256;
export const ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT = 256;
export const SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT = 120;
export const SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT = 512;
export const SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT = 120;
export const SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT = 160;
export const SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT = 12 * 1024;
export const SUBAGENT_WORKSPACE_WRITE_MAX_BYTES = 10 * 1024 * 1024;
export const SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH = 12;
export const SUBAGENT_MCP_MUTATION_DIGEST_PREFIX_LENGTH = 12;
export const SUBAGENT_MCP_MUTATION_DISPLAY_INPUT_BYTES = 8 * 1024;
export const SUBAGENT_MCP_MUTATION_DISPLAY_ESCAPED_CHARS = 64 * 1024;
export const SUBAGENT_SHELL_COMMAND_DISPLAY_CHARS = 32 * 1024;

/** The exact automation proposal shown before an attended Assistant tool call resumes. */
export interface AssistantAutomationApprovalDetails {
  kind: "assistant-automation";
  action: "create" | "edit";
  /** Present only when changing an existing saved automation. */
  taskId?: string;
  /** Present on edits so a paused task is not described as having an active next run. */
  enabled?: boolean;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  nextRunAt: number;
  notify: boolean;
  mode: "llm";
  permission: "read-only" | "full";
  workspaceId: string | null;
  workspaceName: string | null;
  mcpServerIds: string[];
  mcpServerNames: string[];
  providerId: string;
  providerName: string;
  model: string;
  modelName: string;
  schedulerEnabled: boolean;
}

/** Renderer-safe facts for one exact, attended child file mutation. */
export interface SubagentWorkspaceWriteApprovalDetails {
  kind: "subagent-workspace-write";
  operation: "create" | "replace" | "edit";
  childLabel: string;
  /** Canonical workspace-relative path. Absolute and parent-traversal paths are rejected. */
  path: string;
  workspaceLabel: string;
  /** Present only when the authorized workspace is an Aiden managed worktree. */
  worktreeLabel: string | null;
  isManagedWorktree: boolean;
  /** Null only for a create that requires the target not to exist. */
  preDigestPrefix: string | null;
  postDigestPrefix: string;
  beforeBytes: number;
  afterBytes: number;
  diffPreview: string;
  diffTruncated: boolean;
  /** Literal safety claims supplied by the main-owned mutation broker. */
  commandWillRun: false;
  refuseIfChanged: true;
}

/** Renderer-safe host-derived facts for one inert mutating-MCP approval proposal. */
export interface SubagentMcpMutationApprovalDetails {
  kind: "subagent-mcp-mutation";
  childLabel: string;
  serverId: string;
  toolName: string;
  connectionDigestPrefix: string;
  schemaDigestPrefix: string;
  profileDigestPrefix: string;
  argumentDigestPrefix: string;
  classification: "declared_mutating" | "unproven_mutating";
  destructive: "destructive" | "additive" | "unknown";
  idempotency: "idempotent" | "not_declared";
  openWorld: "open" | "closed" | "unknown";
  taskSupport: "forbidden" | "optional";
  timeoutMs: number;
  canonicalArguments: string;
  priorUnknownEffect: boolean;
  automaticRetry: false;
  rollbackAvailable: false;
}

/** Renderer-safe exact facts for one attended full-host child command. */
export interface SubagentShellApprovalDetails {
  kind: "subagent-shell";
  childLabel: string;
  command: string;
  initialCwd: string;
  shell: "/bin/zsh -f -c";
  argumentDigestPrefix: string;
  rootDigestPrefix: string;
  effectDigestPrefix: string;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  workspaceLabel: string;
  isManagedWorktree: boolean;
  worktreeLabel: string | null;
  environmentProfile: "minimal-private-0700-v1";
  osSandboxed: false;
  rollbackAvailable: false;
  outputSentToModel: true;
  arbitraryNetworkAvailable: true;
  detachedProcessesMaySurvive: true;
}

export type ToolApprovalDetails =
  | AssistantAutomationApprovalDetails
  | SubagentWorkspaceWriteApprovalDetails
  | SubagentMcpMutationApprovalDetails
  | SubagentShellApprovalDetails;

function unsafeApprovalCodePoint(codePoint: number, multiline: boolean): boolean {
  const allowedWhitespace =
    multiline && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d);
  return (
    (!allowedWhitespace && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function safeApprovalText(value: unknown, limit: number, multiline = false): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (unsafeApprovalCodePoint(codePoint, multiline)) return false;
  }
  return true;
}

function safeApprovalPreview(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (unsafeApprovalCodePoint(codePoint, true)) return false;
  }
  return true;
}

function hasExactApprovalKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function safeWorkspaceRelativePath(value: unknown): value is string {
  if (!safeApprovalText(value, SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT)) return false;
  if (
    value.normalize("NFKC") !== value ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function safeDigestPrefix(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^[a-f0-9]{${SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH}}$`, "u").test(value)
  );
}

function safeMutationDigestPrefix(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^[a-f0-9]{${SUBAGENT_MCP_MUTATION_DIGEST_PREFIX_LENGTH}}$`, "u").test(value)
  );
}

function canonicalParsedJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalParsedJson).join(",")}]`;
  }
  if (typeof value !== "object") throw new Error("Invalid JSON value.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalParsedJson(record[key])}`)
    .join(",")}}`;
}

/** Escape every raw control, bidi, isolate, and Unicode line-separator code point. */
export function escapeSubagentMcpMutationApprovalJson(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (unsafeApprovalCodePoint(codePoint, false)) {
      if (codePoint <= 0xffff) {
        result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      } else {
        const adjusted = codePoint - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        result += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      }
    } else {
      result += character;
    }
  }
  return result;
}

function safeCanonicalMutationArguments(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > SUBAGENT_MCP_MUTATION_DISPLAY_ESCAPED_CHARS
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      new TextEncoder().encode(canonicalParsedJson(parsed)).length >
        SUBAGENT_MCP_MUTATION_DISPLAY_INPUT_BYTES
    ) {
      return false;
    }
    return escapeSubagentMcpMutationApprovalJson(canonicalParsedJson(parsed)) === value;
  } catch {
    return false;
  }
}

/** Malformed privileged mutation details never retain an Allow action. */
export function isSubagentMcpMutationApprovalDetails(
  value: unknown,
): value is SubagentMcpMutationApprovalDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (
    !hasExactApprovalKeys(details, [
      "kind",
      "childLabel",
      "serverId",
      "toolName",
      "connectionDigestPrefix",
      "schemaDigestPrefix",
      "profileDigestPrefix",
      "argumentDigestPrefix",
      "classification",
      "destructive",
      "idempotency",
      "openWorld",
      "taskSupport",
      "timeoutMs",
      "canonicalArguments",
      "priorUnknownEffect",
      "automaticRetry",
      "rollbackAvailable",
    ])
  ) {
    return false;
  }
  return (
    details.kind === "subagent-mcp-mutation" &&
    safeApprovalText(details.childLabel, SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT) &&
    safeApprovalText(details.serverId, 128) &&
    safeApprovalText(details.toolName, 128) &&
    safeMutationDigestPrefix(details.connectionDigestPrefix) &&
    safeMutationDigestPrefix(details.schemaDigestPrefix) &&
    safeMutationDigestPrefix(details.profileDigestPrefix) &&
    safeMutationDigestPrefix(details.argumentDigestPrefix) &&
    (details.classification === "declared_mutating" ||
      details.classification === "unproven_mutating") &&
    (details.destructive === "destructive" ||
      details.destructive === "additive" ||
      details.destructive === "unknown") &&
    (details.idempotency === "idempotent" || details.idempotency === "not_declared") &&
    (details.openWorld === "open" ||
      details.openWorld === "closed" ||
      details.openWorld === "unknown") &&
    (details.taskSupport === "forbidden" || details.taskSupport === "optional") &&
    typeof details.timeoutMs === "number" &&
    Number.isSafeInteger(details.timeoutMs) &&
    details.timeoutMs >= 1 &&
    details.timeoutMs <= 120_000 &&
    safeCanonicalMutationArguments(details.canonicalArguments) &&
    typeof details.priorUnknownEffect === "boolean" &&
    details.automaticRetry === false &&
    details.rollbackAvailable === false
  );
}

function safeShellCommand(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > SUBAGENT_SHELL_COMMAND_DISPLAY_CHARS
  ) {
    return false;
  }
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return !(
      point === 0 ||
      point === 0x0d ||
      point === 0x1b ||
      (point < 0x20 && point !== 0x09 && point !== 0x0a) ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x2028 ||
      point === 0x2029 ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    );
  });
}

/** Malformed full-host shell claims never retain an Allow action. */
export function isSubagentShellApprovalDetails(
  value: unknown,
): value is SubagentShellApprovalDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (
    !hasExactApprovalKeys(details, [
      "kind",
      "childLabel",
      "command",
      "initialCwd",
      "shell",
      "argumentDigestPrefix",
      "rootDigestPrefix",
      "effectDigestPrefix",
      "timeoutMs",
      "stdoutLimitBytes",
      "stderrLimitBytes",
      "workspaceLabel",
      "isManagedWorktree",
      "worktreeLabel",
      "environmentProfile",
      "osSandboxed",
      "rollbackAvailable",
      "outputSentToModel",
      "arbitraryNetworkAvailable",
      "detachedProcessesMaySurvive",
    ])
  ) {
    return false;
  }
  return (
    details.kind === "subagent-shell" &&
    safeApprovalText(details.childLabel, SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT) &&
    safeShellCommand(details.command) &&
    safeApprovalText(details.initialCwd, 1024) &&
    details.initialCwd.startsWith("/") &&
    details.shell === "/bin/zsh -f -c" &&
    safeMutationDigestPrefix(details.argumentDigestPrefix) &&
    safeMutationDigestPrefix(details.rootDigestPrefix) &&
    safeMutationDigestPrefix(details.effectDigestPrefix) &&
    typeof details.timeoutMs === "number" &&
    Number.isSafeInteger(details.timeoutMs) &&
    details.timeoutMs >= 1 &&
    details.timeoutMs <= 120_000 &&
    details.stdoutLimitBytes === 512 * 1024 &&
    details.stderrLimitBytes === 512 * 1024 &&
    safeApprovalText(details.workspaceLabel, SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT) &&
    ((details.isManagedWorktree === false && details.worktreeLabel === null) ||
      (details.isManagedWorktree === true &&
        safeApprovalText(details.worktreeLabel, SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT))) &&
    details.environmentProfile === "minimal-private-0700-v1" &&
    details.osSandboxed === false &&
    details.rollbackAvailable === false &&
    details.outputSentToModel === true &&
    details.arbitraryNetworkAvailable === true &&
    details.detachedProcessesMaySurvive === true
  );
}

function safeByteCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SUBAGENT_WORKSPACE_WRITE_MAX_BYTES
  );
}

/** Fail closed before structured child-mutation facts are rendered as trusted safety copy. */
export function isSubagentWorkspaceWriteApprovalDetails(
  value: unknown,
): value is SubagentWorkspaceWriteApprovalDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (
    !hasExactApprovalKeys(details, [
      "kind",
      "operation",
      "childLabel",
      "path",
      "workspaceLabel",
      "worktreeLabel",
      "isManagedWorktree",
      "preDigestPrefix",
      "postDigestPrefix",
      "beforeBytes",
      "afterBytes",
      "diffPreview",
      "diffTruncated",
      "commandWillRun",
      "refuseIfChanged",
    ])
  ) {
    return false;
  }
  const operationIsValid =
    details.operation === "create" ||
    details.operation === "replace" ||
    details.operation === "edit";
  const worktreeIsValid =
    (details.isManagedWorktree === false && details.worktreeLabel === null) ||
    (details.isManagedWorktree === true &&
      safeApprovalText(details.worktreeLabel, SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT));
  const preimageIsValid =
    details.operation === "create"
      ? details.preDigestPrefix === null && details.beforeBytes === 0
      : safeDigestPrefix(details.preDigestPrefix);
  return (
    details.kind === "subagent-workspace-write" &&
    operationIsValid &&
    safeApprovalText(details.childLabel, SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT) &&
    safeWorkspaceRelativePath(details.path) &&
    safeApprovalText(details.workspaceLabel, SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT) &&
    worktreeIsValid &&
    preimageIsValid &&
    safeDigestPrefix(details.postDigestPrefix) &&
    safeByteCount(details.beforeBytes) &&
    safeByteCount(details.afterBytes) &&
    safeApprovalPreview(details.diffPreview) &&
    typeof details.diffTruncated === "boolean" &&
    details.commandWillRun === false &&
    details.refuseIfChanged === true
  );
}

/** Fail-closed renderer boundary for attended Assistant automation approvals. */
export function isAssistantAutomationApprovalDetails(
  value: unknown,
): value is AssistantAutomationApprovalDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  const actionIsValid =
    details.action === "create"
      ? details.taskId === undefined && details.enabled === undefined
      : details.action === "edit" &&
        safeApprovalText(details.taskId, ASSISTANT_AUTOMATION_TASK_ID_LIMIT) &&
        typeof details.enabled === "boolean";
  const projectIsValid =
    (details.workspaceId === null && details.workspaceName === null) ||
    (safeApprovalText(details.workspaceId, ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT) &&
      safeApprovalText(details.workspaceName, ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT));
  const mcpServerIds = Array.isArray(details.mcpServerIds) ? details.mcpServerIds : [];
  const mcpServerNames = Array.isArray(details.mcpServerNames) ? details.mcpServerNames : [];
  const mcpServersAreValid =
    Array.isArray(details.mcpServerIds) &&
    Array.isArray(details.mcpServerNames) &&
    mcpServerIds.length <= ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT &&
    mcpServerIds.length === mcpServerNames.length &&
    new Set(mcpServerIds).size === mcpServerIds.length &&
    mcpServerIds.every((id) => safeApprovalText(id, ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT)) &&
    mcpServerNames.every((name) =>
      safeApprovalText(name, ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT),
    );
  return (
    details.kind === "assistant-automation" &&
    actionIsValid &&
    safeApprovalText(details.name, ASSISTANT_AUTOMATION_NAME_LIMIT) &&
    safeApprovalText(details.prompt, ASSISTANT_AUTOMATION_PROMPT_LIMIT, true) &&
    safeApprovalText(details.cron, ASSISTANT_AUTOMATION_CRON_LIMIT) &&
    safeApprovalText(details.timezone, ASSISTANT_AUTOMATION_TIMEZONE_LIMIT) &&
    typeof details.nextRunAt === "number" &&
    Number.isFinite(details.nextRunAt) &&
    details.nextRunAt >= 0 &&
    typeof details.notify === "boolean" &&
    details.mode === "llm" &&
    (details.permission === "read-only" || details.permission === "full") &&
    projectIsValid &&
    mcpServersAreValid &&
    (details.workspaceId === null || mcpServerIds.length === 0) &&
    safeApprovalText(details.providerId, ASSISTANT_AUTOMATION_PROVIDER_ID_LIMIT) &&
    safeApprovalText(details.providerName, ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT) &&
    safeApprovalText(details.model, ASSISTANT_AUTOMATION_MODEL_ID_LIMIT) &&
    safeApprovalText(details.modelName, ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT) &&
    (mcpServerIds.length === 0 || details.permission === "full") &&
    (details.permission !== "full" || details.workspaceId !== null || mcpServerIds.length > 0) &&
    typeof details.schedulerEnabled === "boolean"
  );
}

/**
 * Prompts offered in Aiden's empty state.
 *
 * Deliberately limited to questions Aiden can answer from what it knows about
 * the app. The live-state questions this feature is ultimately for — "Any
 * uncommitted changes?", "Summarize my settings" — need the get_settings and
 * list_projects tools, and offering them before those tools exist just invites
 * a confident wrong answer. Restore them with the tools.
 */
export const ASSISTANT_SUGGESTED_PROMPTS = [
  "What can you help me with?",
  "How do scheduled tasks work?",
  "Where do I add a provider?",
] as const;
