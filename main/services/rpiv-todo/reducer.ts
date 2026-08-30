import {
  MAX_TODO_DESCRIPTION_BYTES,
  MAX_TODO_LABEL_CODE_POINTS,
  MAX_TODO_SNAPSHOT_BYTES,
  MAX_TODO_SUBJECT_CODE_POINTS,
  MAX_TODO_TASKS,
  TODO_DETAILS_KIND,
  TODO_SNAPSHOT_VERSION,
  cloneTodoState,
  isTodoAction,
  isTodoStatus,
  parseTodoMetadata,
  sanitizeTodoText,
  todoCodePointLength,
  todoUtf8Bytes,
  validateTodoState,
  type TodoAction,
  type TodoJson,
  type TodoParams,
  type TodoState,
  type TodoStatus,
  type TodoTask,
  type TodoToolDetailsV1,
} from "./contract.js";

export interface TodoApplyResult {
  state: TodoState;
  details: TodoToolDetailsV1;
  content: string;
}

const TRANSITIONS: Record<TodoStatus, ReadonlySet<TodoStatus>> = {
  pending: new Set(["pending", "in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "in_progress", "completed", "deleted"]),
  completed: new Set(["completed", "deleted"]),
  deleted: new Set(["deleted"]),
};

function snapshotDetails(action: TodoAction, state: TodoState, error?: string): TodoToolDetailsV1 {
  const details: TodoToolDetailsV1 = {
    kind: TODO_DETAILS_KIND,
    version: TODO_SNAPSHOT_VERSION,
    action,
    tasks: state.tasks,
    nextId: state.nextId,
    ...(error ? { error } : {}),
  };
  if (todoUtf8Bytes(JSON.stringify(details)) > MAX_TODO_SNAPSHOT_BYTES) {
    throw new Error("The todo snapshot exceeds its durable size limit.");
  }
  return details;
}

function failure(action: TodoAction, state: TodoState, error: string): TodoApplyResult {
  return { state, details: snapshotDetails(action, state, error), content: `Error: ${error}` };
}

function positiveId(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function textField(
  value: unknown,
  kind: "subject" | "description" | "label",
): { value?: string; error?: string } {
  if (typeof value !== "string") return { error: `${kind} must be a string` };
  const sanitized = sanitizeTodoText(value);
  if (kind === "subject") {
    const subject = sanitized.trim();
    if (!subject) return { error: "subject required" };
    if (todoCodePointLength(subject) > MAX_TODO_SUBJECT_CODE_POINTS) {
      return { error: `subject exceeds ${MAX_TODO_SUBJECT_CODE_POINTS} Unicode code points` };
    }
    return { value: subject };
  }
  if (kind === "description") {
    if (todoUtf8Bytes(sanitized) > MAX_TODO_DESCRIPTION_BYTES) {
      return { error: `description exceeds ${MAX_TODO_DESCRIPTION_BYTES} UTF-8 bytes` };
    }
    return { value: sanitized };
  }
  if (todoCodePointLength(sanitized) > MAX_TODO_LABEL_CODE_POINTS) {
    return { error: `${kind} exceeds ${MAX_TODO_LABEL_CODE_POINTS} Unicode code points` };
  }
  return { value: sanitized };
}

function dependencyList(value: unknown, field: string): { value?: number[]; error?: string } {
  if (!Array.isArray(value)) return { error: `${field} must be an array` };
  if (value.length > MAX_TODO_TASKS) return { error: `${field} has too many ids` };
  const ids: number[] = [];
  for (const candidate of value) {
    const id = positiveId(candidate);
    if (!id) return { error: `${field} ids must be safe positive integers` };
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return { error: `${field} ids must be unique` };
  return { value: ids };
}

function cycleExists(tasks: readonly TodoTask[]): boolean {
  const edges = new Map(tasks.map((task) => [task.id, task.blockedBy ?? []]));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...edges.keys()].some(visit);
}

function validateDependencies(
  tasks: readonly TodoTask[],
  taskId: number,
  dependencies: readonly number[],
  field: string,
): string | undefined {
  for (const dependency of dependencies) {
    if (dependency === taskId) return `cannot block #${taskId} on itself`;
    const target = tasks.find((task) => task.id === dependency);
    if (!target) return `${field}: #${dependency} not found`;
    if (target.status === "deleted") return `${field}: #${dependency} is deleted`;
  }
  return undefined;
}

function commitOrFail(
  action: TodoAction,
  previous: TodoState,
  candidate: TodoState,
  content: string,
): TodoApplyResult {
  try {
    const state = validateTodoState(candidate);
    const details = snapshotDetails(action, state);
    return { state, details, content };
  } catch {
    return failure(action, previous, "the requested change exceeds the durable todo limits");
  }
}

function formatTask(task: TodoTask): string {
  const active = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
  const dependencies = task.blockedBy?.length
    ? ` · blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}`
    : "";
  return `[${task.status}] #${task.id} ${task.subject}${active}${dependencies}`;
}

function metadataForUpdate(
  current: Record<string, TodoJson> | undefined,
  supplied: unknown,
): { value?: Record<string, TodoJson>; error?: string } {
  let patch: Record<string, TodoJson>;
  try {
    patch = parseTodoMetadata(supplied) ?? {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Todo metadata is invalid." };
  }
  const merged: Record<string, TodoJson> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  try {
    return { value: parseTodoMetadata(merged) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Todo metadata is invalid." };
  }
}

export function applyTodo(stateInput: TodoState, params: TodoParams): TodoApplyResult {
  const state = cloneTodoState(stateInput);
  if (!isTodoAction(params.action)) {
    return failure("list", state, "action must be create, update, list, get, delete, or clear");
  }
  const action = params.action;
  if (action === "create") {
    if (state.tasks.length >= MAX_TODO_TASKS) return failure(action, state, "task limit reached");
    const subject = textField(params.subject, "subject");
    if (subject.error) return failure(action, state, subject.error);
    let dependencies: number[] | undefined;
    if (params.blockedBy !== undefined) {
      const parsed = dependencyList(params.blockedBy, "blockedBy");
      if (parsed.error) return failure(action, state, parsed.error);
      dependencies = parsed.value;
      const dependencyError = validateDependencies(
        state.tasks,
        state.nextId,
        dependencies ?? [],
        "blockedBy",
      );
      if (dependencyError) return failure(action, state, dependencyError);
    }
    const task: TodoTask = {
      id: state.nextId,
      subject: subject.value!,
      status: "pending",
    };
    for (const [field, kind] of [
      ["description", "description"],
      ["activeForm", "label"],
      ["owner", "label"],
    ] as const) {
      if (params[field] === undefined) continue;
      const parsed = textField(params[field], kind);
      if (parsed.error) return failure(action, state, parsed.error);
      task[field] = parsed.value!;
    }
    if (dependencies?.length) task.blockedBy = dependencies;
    if (params.metadata !== undefined) {
      try {
        const metadata = parseTodoMetadata(params.metadata);
        if (metadata && Object.keys(metadata).length) task.metadata = metadata;
      } catch (error) {
        return failure(
          action,
          state,
          error instanceof Error ? error.message : "Todo metadata is invalid.",
        );
      }
    }
    return commitOrFail(
      action,
      state,
      { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
      `Created #${task.id}: ${task.subject} (pending)`,
    );
  }

  if (action === "list") {
    if (params.status !== undefined && !isTodoStatus(params.status)) {
      return failure(action, state, "status filter is invalid");
    }
    let tasks = state.tasks.filter(
      (task) => params.includeDeleted === true || task.status !== "deleted",
    );
    if (isTodoStatus(params.status)) tasks = tasks.filter((task) => task.status === params.status);
    return {
      state,
      details: snapshotDetails(action, state),
      content: tasks.length ? tasks.map(formatTask).join("\n") : "No tasks",
    };
  }

  if (action === "clear") {
    return commitOrFail(
      action,
      state,
      { tasks: [], nextId: 1 },
      `Cleared ${state.tasks.length} tasks`,
    );
  }

  const id = positiveId(params.id);
  if (!id) return failure(action, state, `id required for ${action}`);
  const index = state.tasks.findIndex((task) => task.id === id);
  if (index < 0) return failure(action, state, `#${id} not found`);
  const current = state.tasks[index]!;
  if (action === "get") {
    const blocks = state.tasks
      .filter((task) => task.blockedBy?.includes(id))
      .map((task) => task.id);
    const suffix = blocks.length
      ? `\n  blocks: ${blocks.map((taskId) => `#${taskId}`).join(", ")}`
      : "";
    return {
      state,
      details: snapshotDetails(action, state),
      content: `${formatTask(current)}${suffix}`,
    };
  }
  if (action === "delete") {
    if (current.status === "deleted") return failure(action, state, `#${id} is already deleted`);
    const tasks = state.tasks.map((task) =>
      task.id === id ? { ...task, status: "deleted" as const } : task,
    );
    return commitOrFail(
      action,
      state,
      { tasks, nextId: state.nextId },
      `Deleted #${id}: ${current.subject}`,
    );
  }

  const mutationFields = [
    "subject",
    "description",
    "activeForm",
    "status",
    "owner",
    "metadata",
    "addBlockedBy",
    "removeBlockedBy",
  ] as const;
  if (!mutationFields.some((field) => params[field] !== undefined)) {
    return failure(action, state, "update requires at least one mutable field");
  }
  const updated: TodoTask = { ...current };
  for (const [field, kind] of [
    ["subject", "subject"],
    ["description", "description"],
    ["activeForm", "label"],
    ["owner", "label"],
  ] as const) {
    if (params[field] === undefined) continue;
    const parsed = textField(params[field], kind);
    if (parsed.error) return failure(action, state, parsed.error);
    updated[field] = parsed.value!;
  }
  if (params.status !== undefined) {
    if (!isTodoStatus(params.status)) return failure(action, state, "status is invalid");
    if (!TRANSITIONS[current.status].has(params.status)) {
      return failure(action, state, `illegal transition ${current.status} → ${params.status}`);
    }
    if (
      params.status === "in_progress" &&
      state.tasks.some((task) => task.id !== id && task.status === "in_progress")
    ) {
      return failure(action, state, "another task is already in_progress");
    }
    updated.status = params.status;
  }
  let dependencies = [...(current.blockedBy ?? [])];
  if (params.removeBlockedBy !== undefined) {
    const parsed = dependencyList(params.removeBlockedBy, "removeBlockedBy");
    if (parsed.error) return failure(action, state, parsed.error);
    const removed = new Set(parsed.value);
    dependencies = dependencies.filter((dependency) => !removed.has(dependency));
  }
  if (params.addBlockedBy !== undefined) {
    const parsed = dependencyList(params.addBlockedBy, "addBlockedBy");
    if (parsed.error) return failure(action, state, parsed.error);
    const dependencyError = validateDependencies(
      state.tasks,
      id,
      parsed.value ?? [],
      "addBlockedBy",
    );
    if (dependencyError) return failure(action, state, dependencyError);
    for (const dependency of parsed.value ?? []) {
      if (!dependencies.includes(dependency)) dependencies.push(dependency);
    }
  }
  if (dependencies.length) updated.blockedBy = dependencies;
  else delete updated.blockedBy;
  if (params.metadata !== undefined) {
    const metadata = metadataForUpdate(current.metadata, params.metadata);
    if (metadata.error) return failure(action, state, metadata.error);
    if (metadata.value && Object.keys(metadata.value).length) updated.metadata = metadata.value;
    else delete updated.metadata;
  }
  const tasks = state.tasks.map((task) => (task.id === id ? updated : task));
  if (cycleExists(tasks)) return failure(action, state, "addBlockedBy would create a cycle");
  const changed = JSON.stringify(current) !== JSON.stringify(updated);
  const transition =
    current.status === updated.status ? "" : ` (${current.status} → ${updated.status})`;
  return commitOrFail(
    action,
    state,
    { tasks, nextId: state.nextId },
    changed
      ? `Updated #${id}${transition}`
      : `No change: #${id} already matches the requested values`,
  );
}
