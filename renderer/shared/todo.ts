export const TODO_VIEW_VERSION = 1 as const;
export const MAX_TODO_VIEW_TASKS = 256;

export type TodoViewStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTaskViewV1 {
  id: number;
  subject: string;
  status: TodoViewStatus;
  activeForm?: string;
  blockedBy?: number[];
}

export interface TodoSnapshotViewV1 {
  version: typeof TODO_VIEW_VERSION;
  chatId: string;
  availability: "ready" | "unavailable";
  tasks: TodoTaskViewV1[];
}

export interface TodoSnapshotReadTicket {
  chatId: string;
  revision: number;
}

/**
 * Keeps an initial journal read from replacing a snapshot delivered by the
 * active generation while that read was pending.
 */
export class TodoSnapshotReadFence {
  private activeChatId: string | null = null;
  private revision = 0;

  reset(chatId: string): void {
    this.activeChatId = chatId;
    this.revision += 1;
  }

  beginInitialRead(chatId: string): TodoSnapshotReadTicket {
    return { chatId, revision: this.revision };
  }

  markLive(chatId: string): boolean {
    if (chatId !== this.activeChatId) return false;
    this.revision += 1;
    return true;
  }

  canApplyInitial(ticket: TodoSnapshotReadTicket): boolean {
    return ticket.chatId === this.activeChatId && ticket.revision === this.revision;
  }
}

const STATUS = new Set<TodoViewStatus>(["pending", "in_progress", "completed", "deleted"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseTodoSnapshotView(value: unknown): TodoSnapshotViewV1 | undefined {
  const snapshot = record(value);
  if (
    !snapshot ||
    snapshot.version !== TODO_VIEW_VERSION ||
    typeof snapshot.chatId !== "string" ||
    snapshot.chatId.length < 1 ||
    snapshot.chatId.length > 200 ||
    (snapshot.availability !== "ready" && snapshot.availability !== "unavailable") ||
    !Array.isArray(snapshot.tasks) ||
    snapshot.tasks.length > MAX_TODO_VIEW_TASKS
  ) {
    return undefined;
  }
  const ids = new Set<number>();
  const tasks: TodoTaskViewV1[] = [];
  for (const value of snapshot.tasks) {
    const task = record(value);
    if (
      !task ||
      !safeId(task.id) ||
      ids.has(task.id) ||
      typeof task.subject !== "string" ||
      task.subject.length < 1 ||
      task.subject.length > 480 ||
      typeof task.status !== "string" ||
      !STATUS.has(task.status as TodoViewStatus) ||
      (task.activeForm !== undefined &&
        (typeof task.activeForm !== "string" || task.activeForm.length > 320)) ||
      (task.blockedBy !== undefined &&
        (!Array.isArray(task.blockedBy) ||
          task.blockedBy.length > MAX_TODO_VIEW_TASKS ||
          !task.blockedBy.every(safeId) ||
          new Set(task.blockedBy).size !== task.blockedBy.length))
    ) {
      return undefined;
    }
    ids.add(task.id);
    tasks.push({
      id: task.id,
      subject: task.subject,
      status: task.status as TodoViewStatus,
      ...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
      ...(Array.isArray(task.blockedBy) ? { blockedBy: [...task.blockedBy] as number[] } : {}),
    });
  }
  if (tasks.some((task) => task.blockedBy?.some((id) => !ids.has(id)))) return undefined;
  if (snapshot.availability === "unavailable" && tasks.length > 0) return undefined;
  return {
    version: TODO_VIEW_VERSION,
    chatId: snapshot.chatId,
    availability: snapshot.availability,
    tasks,
  };
}

export function todoSnapshotForRenderer(
  chatId: string,
  state: {
    tasks: readonly {
      id: number;
      subject: string;
      status: TodoViewStatus;
      activeForm?: string;
      blockedBy?: readonly number[];
    }[];
  },
): TodoSnapshotViewV1 {
  const parsed = parseTodoSnapshotView({
    version: TODO_VIEW_VERSION,
    chatId,
    availability: "ready",
    tasks: state.tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
      ...(task.blockedBy !== undefined ? { blockedBy: [...task.blockedBy] } : {}),
    })),
  });
  if (!parsed) throw new Error("The todo renderer projection is invalid.");
  return parsed;
}

export function unavailableTodoSnapshot(chatId: string): TodoSnapshotViewV1 {
  return { version: TODO_VIEW_VERSION, chatId, availability: "unavailable", tasks: [] };
}
