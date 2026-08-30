import {
  EMPTY_TODO_STATE,
  TODO_TOOL_NAME,
  TodoSnapshotError,
  parseTodoToolDetails,
  type TodoState,
} from "./contract.js";

export interface TodoReplaySession {
  getBranch(): Promise<Iterable<unknown>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Rebuild from the current Pi branch only. Once a todo tool result is found it
 * must be a fully valid Aiden snapshot; a malformed newer result never falls
 * back to older state because that could silently regress completed work.
 */
export async function replayTodoState(session: TodoReplaySession): Promise<TodoState> {
  let latest: TodoState | undefined;
  for (const entryValue of await session.getBranch()) {
    const entry = record(entryValue);
    if (entry?.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;
    // Pi emits schema/dispatch failures as isError tool results with empty
    // details before this extension can mutate its generation-local state.
    // They are durable evidence for the model, but never todo checkpoints.
    if (message.isError === true) continue;
    const details = parseTodoToolDetails(message.details);
    latest = { tasks: details.tasks, nextId: details.nextId };
  }
  return latest ?? { tasks: [...EMPTY_TODO_STATE.tasks], nextId: EMPTY_TODO_STATE.nextId };
}

export function isTodoSnapshotFailure(error: unknown): error is TodoSnapshotError {
  return error instanceof TodoSnapshotError;
}
