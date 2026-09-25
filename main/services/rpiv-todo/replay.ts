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
 * Rebuild from the current Pi branch only, in oldest-to-newest branch order.
 * Every checkpoint is a full snapshot, so validate only the newest non-error
 * todo result. A malformed newest result never falls back to older state
 * because that could silently regress completed work.
 */
export async function replayTodoState(session: TodoReplaySession): Promise<TodoState> {
  let latest: Record<string, unknown> | undefined;
  for (const entryValue of await session.getBranch()) {
    const entry = record(entryValue);
    if (entry?.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;
    // Pi emits schema/dispatch failures as isError tool results with empty
    // details before this extension can mutate its generation-local state.
    // They are durable evidence for the model, but never todo checkpoints.
    if (message.isError === true) continue;
    latest = message;
  }
  if (!latest) return { tasks: [...EMPTY_TODO_STATE.tasks], nextId: EMPTY_TODO_STATE.nextId };
  const details = parseTodoToolDetails(latest.details);
  return { tasks: details.tasks, nextId: details.nextId };
}

export function isTodoSnapshotFailure(error: unknown): error is TodoSnapshotError {
  return error instanceof TodoSnapshotError;
}
