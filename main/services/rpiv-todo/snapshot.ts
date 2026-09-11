import {
  todoSnapshotForRenderer,
  unavailableTodoSnapshot,
  type TodoSnapshotViewV1,
} from "../../../renderer/shared/todo.js";
import type { TodoState } from "./contract.js";
import { isTodoSnapshotFailure, replayTodoState, type TodoReplaySession } from "./replay.js";

/** Shared by chat-open reads and generation admission; in-memory sessions are not durable. */
export async function loadDurableTodoSnapshot(
  chatId: string,
  durableSession: TodoReplaySession | undefined,
): Promise<{ snapshot: TodoSnapshotViewV1; state?: TodoState }> {
  if (!durableSession) {
    return { snapshot: unavailableTodoSnapshot(chatId, "storage_not_enabled") };
  }
  try {
    const state = await replayTodoState(durableSession);
    return { state, snapshot: todoSnapshotForRenderer(chatId, state) };
  } catch (error) {
    if (!isTodoSnapshotFailure(error)) throw error;
    return { snapshot: unavailableTodoSnapshot(chatId, "invalid_snapshot") };
  }
}
