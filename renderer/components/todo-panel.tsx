import { Check, ChevronRight, Circle, ListChecks, LoaderCircle, LockKeyhole } from "lucide-react";
import type { TodoSnapshotViewV1, TodoTaskViewV1 } from "../shared/todo";

function taskIcon(task: TodoTaskViewV1) {
  if (task.status === "completed") return <Check className="size-3" aria-hidden="true" />;
  if (task.status === "in_progress") {
    return (
      <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    );
  }
  return <Circle className="size-2.5" aria-hidden="true" />;
}

function boundedProgressAnnouncement(
  completed: number,
  total: number,
  current: TodoTaskViewV1 | undefined,
): string {
  const progress = `Task progress: ${completed} of ${total} completed.`;
  const detail = current?.activeForm || current?.subject;
  const announcement = detail ? `${progress} In progress: ${detail}.` : progress;
  const codePoints = Array.from(announcement);
  return codePoints.length <= 360 ? announcement : `${codePoints.slice(0, 359).join("")}…`;
}

function taskStatusText(task: TodoTaskViewV1, dependencyIds: readonly number[]): string {
  if (task.status === "completed") return "Completed.";
  if (task.status === "in_progress") return "In progress.";
  if (dependencyIds.length > 0) {
    return `Pending, blocked by ${dependencyIds.map((id) => `task ${id}`).join(", ")}.`;
  }
  return "Pending.";
}

export function TodoPanel({ snapshot }: { snapshot: TodoSnapshotViewV1 | null }) {
  if (!snapshot) return null;
  if (snapshot.availability === "unavailable") {
    return (
      <div className="aiden-dock-inset chat-content-column pb-2">
        <div
          className="flex items-center gap-2 rounded-control bg-well px-3 py-2 text-small text-secondary"
          role="status"
        >
          <LockKeyhole className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
          Task tracking is unavailable because its private chat state could not be verified.
        </div>
      </div>
    );
  }
  const tasks = snapshot.tasks.filter((task) => task.status !== "deleted");
  if (tasks.length === 0) return null;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const current = tasks.find((task) => task.status === "in_progress");
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const blocked = (task: TodoTaskViewV1) =>
    task.blockedBy?.some((id) => byId.get(id)?.status !== "completed") === true;
  const statusText =
    current?.activeForm || current?.subject || `${tasks.length - completed} remaining`;
  const progressAnnouncement = boundedProgressAnnouncement(completed, tasks.length, current);

  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {progressAnnouncement}
      </p>
      <details className="group/todos overflow-hidden rounded-card bg-well">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-2 text-small outline-none hover:bg-control focus-visible:bg-list-selection">
          <ListChecks className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
          <span className="font-medium text-primary">Tasks</span>
          <span className="shrink-0 tabular-nums text-tertiary">
            {completed}/{tasks.length}
          </span>
          <span className="min-w-0 flex-1 truncate text-secondary">{statusText}</span>
          <ChevronRight
            className="size-3.5 shrink-0 text-tertiary transition-transform duration-150 group-open/todos:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <ol
          className="max-h-48 overflow-y-auto border-t border-separator px-2 py-1.5"
          aria-label="Tracked tasks"
        >
          {tasks.map((task) => {
            const dependencyIds =
              task.blockedBy?.filter((id) => byId.get(id)?.status !== "completed") ?? [];
            return (
              <li
                key={task.id}
                className="flex min-h-8 items-start gap-2 rounded-control px-2 py-1.5 text-small"
              >
                <span
                  className={
                    task.status === "in_progress"
                      ? "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-accent/10 text-accent"
                      : task.status === "completed"
                        ? "mt-0.5 grid size-4 shrink-0 place-items-center text-tertiary"
                        : "mt-0.5 grid size-4 shrink-0 place-items-center text-secondary"
                  }
                >
                  {taskIcon(task)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="sr-only">{taskStatusText(task, dependencyIds)}</span>
                  <span
                    className={
                      task.status === "completed"
                        ? "block text-tertiary line-through"
                        : "block text-primary"
                    }
                  >
                    <span className="mr-1 text-tertiary">#{task.id}</span>
                    {task.subject}
                  </span>
                  {blocked(task) ? (
                    <span className="block truncate text-mini text-tertiary">
                      Blocked by{" "}
                      {dependencyIds
                        .map((id) => `#${id} ${byId.get(id)?.subject ?? "task"}`)
                        .join(" · ")}
                    </span>
                  ) : task.status === "in_progress" && task.activeForm ? (
                    <span className="block truncate text-mini text-tertiary">
                      {task.activeForm}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}
