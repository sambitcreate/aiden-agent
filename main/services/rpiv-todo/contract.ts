import { types as utilTypes } from "node:util";

export const TODO_TOOL_NAME = "todo";
export const TODO_EXTENSION_ID = "aiden.productivity.todo";
export const TODO_DETAILS_KIND = "aiden.todo.snapshot";
export const TODO_SNAPSHOT_VERSION = 1;

export const MAX_TODO_TASKS = 256;
export const MAX_TODO_SUBJECT_CODE_POINTS = 240;
export const MAX_TODO_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_TODO_LABEL_CODE_POINTS = 160;
export const MAX_TODO_METADATA_BYTES = 8 * 1024;
export const MAX_TODO_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_TODO_JSON_DEPTH = 16;
export const MAX_TODO_JSON_NODES = 2_048;
// Reserve room for the versioned details envelope and a bounded in-band error,
// so even a rejected call can always journal its complete unchanged state.
const MAX_TODO_STATE_BYTES = MAX_TODO_SNAPSHOT_BYTES - 2 * 1024;

export type TodoAction = "create" | "update" | "list" | "get" | "delete" | "clear";
export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoJson = null | boolean | number | string | TodoJson[] | { [key: string]: TodoJson };

export interface TodoTask {
  id: number;
  subject: string;
  status: TodoStatus;
  description?: string;
  activeForm?: string;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, TodoJson>;
}

export interface TodoState {
  tasks: TodoTask[];
  nextId: number;
}

export interface TodoToolDetailsV1 {
  kind: typeof TODO_DETAILS_KIND;
  version: typeof TODO_SNAPSHOT_VERSION;
  action: TodoAction;
  tasks: TodoTask[];
  nextId: number;
  error?: string;
}

export interface TodoParams {
  action?: unknown;
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
  status?: unknown;
  blockedBy?: unknown;
  addBlockedBy?: unknown;
  removeBlockedBy?: unknown;
  owner?: unknown;
  metadata?: unknown;
  id?: unknown;
  includeDeleted?: unknown;
}

export const EMPTY_TODO_STATE: TodoState = Object.freeze({ tasks: [], nextId: 1 });

export class TodoSnapshotError extends Error {
  constructor(message = "The durable todo snapshot is invalid or unsupported.") {
    super(message);
    this.name = "TodoSnapshotError";
  }
}

const ACTIONS = new Set<TodoAction>(["create", "update", "list", "get", "delete", "clear"]);
const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "deleted"]);
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const TERMINAL_CSI = new RegExp(String.raw`(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]`, "gu");
const TERMINAL_OSC = new RegExp(
  String.raw`(?:\x1b\]|\x9d)[^\x07\x9c\x1b]*(?:\x07|\x9c|\x1b\\)?`,
  "gu",
);
const TERMINAL_ESCAPE = new RegExp(String.raw`\x1b.`, "gu");
const CONTROL_CHARACTERS = new RegExp(String.raw`[\x00-\x1f\x7f-\x9f]`, "gu");

export function isTodoAction(value: unknown): value is TodoAction {
  return typeof value === "string" && ACTIONS.has(value as TodoAction);
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && STATUSES.has(value as TodoStatus);
}

export function sanitizeTodoText(value: string): string {
  return value
    .replace(TERMINAL_CSI, "")
    .replace(TERMINAL_OSC, "")
    .replace(TERMINAL_ESCAPE, "")
    .replace(/[\u2028\u2029]/gu, " ")
    .replace(CONTROL_CHARACTERS, (character) =>
      character === "\n" || character === "\r" || character === "\t" ? " " : "",
    )
    .replace(BIDI_CONTROLS, "");
}

export function todoCodePointLength(value: string): number {
  return Array.from(value).length;
}

export function todoUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function cloneTodoJson(
  value: unknown,
  budget: { nodes: number; seen: Set<object> },
  depth = 0,
): TodoJson {
  if (depth > MAX_TODO_JSON_DEPTH) throw new TodoSnapshotError();
  budget.nodes += 1;
  if (budget.nodes > MAX_TODO_JSON_NODES) throw new TodoSnapshotError();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TodoSnapshotError();
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) throw new TodoSnapshotError();
  if (budget.seen.has(value)) throw new TodoSnapshotError();
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0) throw new TodoSnapshotError();
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
        )
      ) {
        throw new TodoSnapshotError();
      }
      return Array.from({ length }, (_entry, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new TodoSnapshotError();
        }
        return cloneTodoJson(descriptor.value, budget, depth + 1);
      });
    }
    const record = plainRecord(value);
    if (!record) throw new TodoSnapshotError();
    const clone: Record<string, TodoJson> = {};
    for (const key of Object.keys(record).sort()) {
      clone[key] = cloneTodoJson(record[key], budget, depth + 1);
    }
    return clone;
  } finally {
    budget.seen.delete(value);
  }
}

export function parseTodoMetadata(value: unknown): Record<string, TodoJson> | undefined {
  if (value === undefined) return undefined;
  const record = plainRecord(value);
  if (!record) throw new TodoSnapshotError("Todo metadata must be a plain JSON object.");
  const clone = cloneTodoJson(record, { nodes: 0, seen: new Set() });
  if (Array.isArray(clone) || clone === null || typeof clone !== "object") {
    throw new TodoSnapshotError("Todo metadata must be a plain JSON object.");
  }
  if (todoUtf8Bytes(JSON.stringify(clone)) > MAX_TODO_METADATA_BYTES) {
    throw new TodoSnapshotError("Todo metadata exceeds the per-task limit.");
  }
  return clone;
}

function parsePositiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TodoSnapshotError();
  return value as number;
}

function parseStoredText(value: unknown, kind: "subject" | "description" | "label"): string {
  if (typeof value !== "string" || sanitizeTodoText(value) !== value) throw new TodoSnapshotError();
  if (kind === "subject") {
    if (!value.trim() || todoCodePointLength(value) > MAX_TODO_SUBJECT_CODE_POINTS) {
      throw new TodoSnapshotError();
    }
  } else if (kind === "description") {
    if (todoUtf8Bytes(value) > MAX_TODO_DESCRIPTION_BYTES) throw new TodoSnapshotError();
  } else if (todoCodePointLength(value) > MAX_TODO_LABEL_CODE_POINTS) {
    throw new TodoSnapshotError();
  }
  return value;
}

function parseDependencyList(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TODO_TASKS) {
    throw new TodoSnapshotError();
  }
  const dependencies = value.map(parsePositiveId);
  if (new Set(dependencies).size !== dependencies.length) throw new TodoSnapshotError();
  return dependencies;
}

function parseTodoTask(value: unknown): TodoTask {
  const task = plainRecord(value);
  if (
    !task ||
    !hasExactKeys(
      task,
      ["id", "subject", "status"],
      ["description", "activeForm", "blockedBy", "owner", "metadata"],
    ) ||
    !isTodoStatus(task.status)
  ) {
    throw new TodoSnapshotError();
  }
  const parsed: TodoTask = {
    id: parsePositiveId(task.id),
    subject: parseStoredText(task.subject, "subject"),
    status: task.status,
  };
  if (task.description !== undefined) {
    parsed.description = parseStoredText(task.description, "description");
  }
  if (task.activeForm !== undefined) parsed.activeForm = parseStoredText(task.activeForm, "label");
  if (task.owner !== undefined) parsed.owner = parseStoredText(task.owner, "label");
  const blockedBy = parseDependencyList(task.blockedBy);
  if (blockedBy) parsed.blockedBy = blockedBy;
  const metadata = parseTodoMetadata(task.metadata);
  if (metadata) parsed.metadata = metadata;
  return parsed;
}

function assertTaskGraph(tasks: readonly TodoTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new TodoSnapshotError();
  if (tasks.filter((task) => task.status === "in_progress").length > 1) {
    throw new TodoSnapshotError();
  }
  for (const task of tasks) {
    for (const dependency of task.blockedBy ?? []) {
      if (dependency === task.id || !byId.has(dependency)) throw new TodoSnapshotError();
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): void => {
    if (visiting.has(id)) throw new TodoSnapshotError();
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.blockedBy ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

export function validateTodoState(value: unknown): TodoState {
  const state = plainRecord(value);
  if (!state || !hasExactKeys(state, ["tasks", "nextId"]) || !Array.isArray(state.tasks)) {
    throw new TodoSnapshotError();
  }
  if (state.tasks.length > MAX_TODO_TASKS) throw new TodoSnapshotError();
  const tasks = state.tasks.map(parseTodoTask);
  const nextId = parsePositiveId(state.nextId);
  const maximumId = tasks.reduce((maximum, task) => Math.max(maximum, task.id), 0);
  if (nextId <= maximumId) throw new TodoSnapshotError();
  assertTaskGraph(tasks);
  const parsed = { tasks, nextId };
  if (todoUtf8Bytes(JSON.stringify(parsed)) > MAX_TODO_STATE_BYTES) {
    throw new TodoSnapshotError();
  }
  return parsed;
}

export function parseTodoToolDetails(value: unknown): TodoToolDetailsV1 {
  const details = plainRecord(value);
  if (
    !details ||
    !hasExactKeys(details, ["kind", "version", "action", "tasks", "nextId"], ["error"]) ||
    details.kind !== TODO_DETAILS_KIND ||
    details.version !== TODO_SNAPSHOT_VERSION ||
    !isTodoAction(details.action) ||
    (details.error !== undefined &&
      (typeof details.error !== "string" || details.error.length < 1 || details.error.length > 512))
  ) {
    throw new TodoSnapshotError();
  }
  const state = validateTodoState({ tasks: details.tasks, nextId: details.nextId });
  const parsed: TodoToolDetailsV1 = {
    kind: TODO_DETAILS_KIND,
    version: TODO_SNAPSHOT_VERSION,
    action: details.action,
    tasks: state.tasks,
    nextId: state.nextId,
  };
  if (typeof details.error === "string") parsed.error = details.error;
  if (todoUtf8Bytes(JSON.stringify(parsed)) > MAX_TODO_SNAPSHOT_BYTES) {
    throw new TodoSnapshotError();
  }
  return parsed;
}

export function cloneTodoState(state: TodoState): TodoState {
  return validateTodoState(structuredClone(state));
}
