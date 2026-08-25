import { isSubagentRole, type SubagentRole } from "./capability-profile.js";
import type { SubagentContextMode } from "./forked-context.js";
import { normalizeSubagentModelText } from "./model-text.js";
import { types as utilTypes } from "node:util";

export const MAX_SUBAGENT_TASKS_PER_CALL = 4;
export const MAX_SUBAGENT_LAUNCHES_PER_GENERATION = 8;
export const MAX_SUBAGENT_LABEL_CHARS = 120;
export const MAX_SUBAGENT_TASK_CHARS = 8_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = 8_000;
export const MAX_SUBAGENT_TOOL_RESULT_CHARS = 24_000;
export const MAX_SUBAGENT_REQUESTED_MCP_SERVERS = 16;
export const MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER = 32;
export const SUBAGENT_SAFE_LABEL_PATTERN =
  "^(?!\\s)(?![\\s\\S]*\\s$)(?![\\s\\S]*[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069])[\\s\\S]+$";

export interface SubagentRequestedMcpScope {
  serverId: string;
  tools: string[];
}

/** Model-facing positive requests only. Host fingerprints/effects never enter this shape. */
export interface SubagentRequestedCapabilities {
  workspaceRead: boolean;
  workspaceWrite: boolean;
  /** Positive full-host shell request. Omission grants no shell authority. */
  shell?: boolean;
  /** Positive child-delegation request. Omission grants no nesting authority. */
  delegate?: boolean;
  web: boolean;
  mcp: SubagentRequestedMcpScope[];
  /** Separate positive mutating lane. Omission grants no mutation authority. */
  mcpMutations?: SubagentRequestedMcpScope[];
}

export interface SubagentTaskRequest {
  role: SubagentRole;
  label: string;
  task: string;
  /** Optional strict subset of the root request; omission inherits the root request. */
  capabilities?: SubagentRequestedCapabilities;
}

export interface SubagentToolRequest {
  context: SubagentContextMode;
  /** Omission preserves the legacy workspace-read-only request. */
  capabilities?: SubagentRequestedCapabilities;
  tasks: SubagentTaskRequest[];
}

export type SubagentTaskStatus = "completed" | "failed" | "timed_out" | "interrupted";

export interface SubagentTaskResult {
  role: SubagentRole;
  label: string;
  status: SubagentTaskStatus;
  summary: string;
  warning?: string;
}

function exactPlainDataRecord(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const actual = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
    actual.length < keys.length ||
    actual.length > keys.length + optional.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        (!keys.includes(key) && !optional.includes(key)) ||
        !("value" in descriptors[key]!) ||
        descriptors[key]!.enumerable !== true,
    )
  ) {
    return undefined;
  }
  return Object.fromEntries((actual as string[]).map((key) => [key, descriptors[key]!.value]));
}

function hasDisallowedLabelCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function boundedText(value: unknown, field: "label" | "task", maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Subagent ${field} must contain between 1 and ${maximum} characters.`);
  }
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    (field === "label" && value.trim() !== value)
  ) {
    throw new Error(`Subagent ${field} must contain visible text without NUL characters.`);
  }
  if (field === "label" && hasDisallowedLabelCharacter(value)) {
    throw new Error("Subagent label must be a single line without control characters.");
  }
  const normalized = normalizeSubagentModelText(value);
  if (normalized.trim().length === 0) {
    throw new Error(`Subagent ${field} must contain visible text.`);
  }
  return normalized;
}

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`Invalid subagent ${field}.`);
  }
  return value;
}

function parseRequestedCapabilities(value: unknown): SubagentRequestedCapabilities {
  const input = exactPlainDataRecord(
    value,
    ["workspaceRead", "web", "mcp"],
    ["workspaceWrite", "shell", "delegate", "mcpMutations"],
  );
  if (
    !input ||
    typeof input.workspaceRead !== "boolean" ||
    (Object.prototype.hasOwnProperty.call(input, "workspaceWrite") &&
      typeof input.workspaceWrite !== "boolean") ||
    (Object.prototype.hasOwnProperty.call(input, "shell") && typeof input.shell !== "boolean") ||
    (Object.prototype.hasOwnProperty.call(input, "delegate") &&
      typeof input.delegate !== "boolean") ||
    typeof input.web !== "boolean" ||
    !Array.isArray(input.mcp) ||
    input.mcp.length > MAX_SUBAGENT_REQUESTED_MCP_SERVERS ||
    (input.mcpMutations !== undefined &&
      (!Array.isArray(input.mcpMutations) ||
        input.mcpMutations.length > MAX_SUBAGENT_REQUESTED_MCP_SERVERS))
  ) {
    throw new Error("Invalid subagent capability request.");
  }
  const parseLane = (lane: readonly unknown[], label: string) => {
    const serverIds = new Set<string>();
    return lane.map((entry) => {
      const scope = exactPlainDataRecord(entry, ["serverId", "tools"]);
      if (
        !scope ||
        !Array.isArray(scope.tools) ||
        scope.tools.length < 1 ||
        scope.tools.length > MAX_SUBAGENT_REQUESTED_MCP_TOOLS_PER_SERVER
      ) {
        throw new Error(`Invalid subagent ${label} request.`);
      }
      const serverId = boundedIdentifier(scope.serverId, `${label} server request`);
      if (serverIds.has(serverId)) {
        throw new Error(`Duplicate subagent ${label} server request.`);
      }
      serverIds.add(serverId);
      const tools = scope.tools.map((tool) => boundedIdentifier(tool, `${label} tool request`));
      if (new Set(tools).size !== tools.length) {
        throw new Error(`Duplicate subagent ${label} tool request.`);
      }
      return { serverId, tools };
    });
  };
  const mcp = parseLane(input.mcp, "MCP read");
  const mcpMutations = parseLane(input.mcpMutations ?? [], "MCP mutation");
  const readPairs = new Set(
    mcp.flatMap((scope) => scope.tools.map((tool) => `${scope.serverId}\0${tool}`)),
  );
  if (
    mcpMutations.some((scope) =>
      scope.tools.some((tool) => readPairs.has(`${scope.serverId}\0${tool}`)),
    )
  ) {
    throw new Error("Subagent MCP read and mutation requests must be disjoint.");
  }
  return {
    workspaceRead: input.workspaceRead,
    workspaceWrite: input.workspaceWrite === true,
    ...(input.shell === undefined ? {} : { shell: input.shell === true }),
    ...(input.delegate === undefined ? {} : { delegate: input.delegate === true }),
    web: input.web,
    mcp,
    ...(input.mcpMutations === undefined ? {} : { mcpMutations }),
  };
}

function requestedMcpPairs(
  value: SubagentRequestedCapabilities,
  lane: "mcp" | "mcpMutations",
): Set<string> {
  return new Set(
    (value[lane] ?? []).flatMap((scope) => scope.tools.map((tool) => `${scope.serverId}\0${tool}`)),
  );
}

function assertTaskCapabilitiesNarrowRoot(
  root: SubagentRequestedCapabilities,
  task: SubagentRequestedCapabilities,
): void {
  if (
    (task.workspaceRead && !root.workspaceRead) ||
    (task.workspaceWrite && !root.workspaceWrite) ||
    (task.shell === true && root.shell !== true) ||
    (task.delegate === true && root.delegate !== true) ||
    (task.web && !root.web)
  ) {
    throw new Error("A subagent task capability request cannot widen its root request.");
  }
  for (const lane of ["mcp", "mcpMutations"] as const) {
    const rootMcp = requestedMcpPairs(root, lane);
    if ([...requestedMcpPairs(task, lane)].some((pair) => !rootMcp.has(pair))) {
      throw new Error("A subagent task MCP request cannot widen its root lane.");
    }
  }
}

/** Revalidate model arguments independently of TypeBox/provider schema enforcement. */
export function parseSubagentToolRequest(input: unknown): SubagentToolRequest {
  const request = exactPlainDataRecord(input, ["tasks"], ["context", "capabilities"]);
  if (
    !request ||
    !Array.isArray(request.tasks) ||
    (request.context !== undefined && request.context !== "fresh" && request.context !== "fork")
  ) {
    throw new Error("Invalid subagent request.");
  }
  if (request.tasks.length < 1 || request.tasks.length > MAX_SUBAGENT_TASKS_PER_CALL) {
    throw new Error(`A subagent request must contain 1 to ${MAX_SUBAGENT_TASKS_PER_CALL} tasks.`);
  }
  const capabilities =
    request.capabilities === undefined
      ? undefined
      : parseRequestedCapabilities(request.capabilities);
  const rootCapabilities: SubagentRequestedCapabilities = capabilities ?? {
    workspaceRead: true,
    workspaceWrite: false,
    shell: false,
    delegate: false,
    web: false,
    mcp: [],
  };
  return {
    context: request.context === "fork" ? "fork" : "fresh",
    ...(capabilities ? { capabilities } : {}),
    tasks: request.tasks.map((entry) => {
      const task = exactPlainDataRecord(entry, ["role", "label", "task"], ["capabilities"]);
      if (!task) {
        throw new Error("Invalid subagent task fields.");
      }
      if (typeof task.role !== "string" || !isSubagentRole(task.role)) {
        throw new Error("Unknown subagent role.");
      }
      const taskCapabilities =
        task.capabilities === undefined ? undefined : parseRequestedCapabilities(task.capabilities);
      if (taskCapabilities) {
        assertTaskCapabilitiesNarrowRoot(rootCapabilities, taskCapabilities);
      }
      return {
        role: task.role,
        label: boundedText(task.label, "label", MAX_SUBAGENT_LABEL_CHARS),
        task: boundedText(task.task, "task", MAX_SUBAGENT_TASK_CHARS),
        ...(taskCapabilities ? { capabilities: taskCapabilities } : {}),
      };
    }),
  };
}

export function effectiveSubagentTaskCapabilities(
  request: Pick<SubagentToolRequest, "capabilities">,
  task: Pick<SubagentTaskRequest, "capabilities">,
): SubagentRequestedCapabilities {
  const effective = structuredClone(
    task.capabilities ??
      request.capabilities ?? {
        workspaceRead: true,
        workspaceWrite: false,
        shell: false,
        delegate: false,
        web: false,
        mcp: [],
      },
  );
  return { ...effective, delegate: effective.delegate === true };
}
