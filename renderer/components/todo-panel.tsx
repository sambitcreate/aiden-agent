import { Check, Circle, ListChecks, LoaderCircle, LockKeyhole } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { pinOverflowListToEnd } from "../lib/scroll-follow";
import type { TodoSnapshotViewV1, TodoTaskViewV1 } from "../shared/todo";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui";

function taskIcon(task: TodoTaskViewV1) {
  if (task.status === "completed") return <Check className="size-3.5" aria-hidden="true" />;
  if (task.status === "in_progress") {
    return (
      <LoaderCircle
        className="size-3.5 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  return <Circle className="size-3" aria-hidden="true" />;
}

function boundedProgressAnnouncement(
  completed: number,
  total: number,
  current: TodoTaskViewV1 | undefined,
): string {
  const progress = `Task progress: ${completed} of ${total} completed.`;
  const detail = current?.activeForm || current?.subject;
  const announcement = detail
    ? `${progress} In progress: ${detail}.`
    : completed === total
      ? `${progress} All tasks complete.`
      : progress;
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

function floatingAnchor(children: React.ReactNode) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center px-[var(--aiden-dock-gutter)]">
      {children}
    </div>
  );
}

export function todoPanelHasVisibleChrome(snapshot: TodoSnapshotViewV1 | null): boolean {
  if (!snapshot) return false;
  if (snapshot.availability === "unavailable") {
    return snapshot.unavailableReason !== "storage_not_enabled";
  }
  return snapshot.tasks.some(
    (task) => task.status !== "deleted" && task.status !== "completed",
  );
}

export function TodoPanel({ snapshot }: { snapshot: TodoSnapshotViewV1 | null }) {
  if (!snapshot) return null;
  if (snapshot.availability === "unavailable") {
    // Rollout-ineligible and other intentionally journalless chats need no
    // user action. Keep that expected capability state out of the composer;
    // verified corruption remains visible because it can affect saved work.
    if (snapshot.unavailableReason === "storage_not_enabled") return null;
    const title = "Task tracking unavailable";
    const explanation =
      "Aiden could not verify this chat’s private task state, so it will not display or update an older snapshot.";
    return floatingAnchor(
      <>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {title}. {explanation}
        </p>
        <HoverCard openDelay={180} closeDelay={100}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              className="pointer-events-auto flex min-h-9 max-w-full items-center gap-2 rounded-pill bg-popover/95 px-3.5 text-small text-secondary shadow-popover outline-none backdrop-blur-xl transition-[background-color,box-shadow] duration-150 hover:bg-popover motion-reduce:transition-none"
              aria-label={`${title}. Focus or hover for details.`}
            >
              <LockKeyhole className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
              <span className="truncate">Tasks unavailable</span>
            </button>
          </HoverCardTrigger>
          <HoverCardContent align="center" side="top" className="w-[min(28rem,calc(100vw-2rem))]">
            <p className="text-small-strong text-primary">{title}</p>
            <p className="mt-1 text-small leading-relaxed text-secondary">
              {explanation}
            </p>
          </HoverCardContent>
        </HoverCard>
      </>,
    );
  }
  const tasks = snapshot.tasks.filter((task) => task.status !== "deleted");
  if (tasks.length === 0) return null;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const current = tasks.find((task) => task.status === "in_progress");
  const progressAnnouncement = boundedProgressAnnouncement(completed, tasks.length, current);

  // Keep the durable snapshot available for future generations, but remove its
  // visual chrome as soon as no unfinished work remains.
  if (completed === tasks.length) {
    return (
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {progressAnnouncement}
      </p>
    );
  }

  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const blocked = (task: TodoTaskViewV1) =>
    task.blockedBy?.some((id) => byId.get(id)?.status !== "completed") === true;
  const currentIndex = current
    ? tasks.findIndex((task) => task.id === current.id) + 1
    : completed + 1;
  const chipDetail =
    current?.activeForm || current?.subject || `${tasks.length - completed} remaining`;

  return floatingAnchor(
    <>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {progressAnnouncement}
      </p>
      <HoverCard openDelay={160} closeDelay={120}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className="pointer-events-auto flex min-h-9 max-w-[min(100%,38rem)] items-center gap-2 rounded-pill bg-popover/95 px-3.5 text-small shadow-popover outline-none backdrop-blur-xl transition-[background-color,box-shadow] duration-150 hover:bg-popover hover:shadow-modal motion-reduce:transition-none"
            aria-label={`Tasks: step ${currentIndex} of ${tasks.length}. ${chipDetail}. Focus or hover for full details.`}
          >
            {current ? (
              <LoaderCircle
                className="size-4 shrink-0 animate-spin text-accent motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <ListChecks className="size-4 shrink-0 text-accent" aria-hidden="true" />
            )}
            <span className="shrink-0 font-medium tabular-nums text-primary">
              Step {currentIndex} / {tasks.length}
            </span>
            <span aria-hidden="true" className="text-tertiary">
              ·
            </span>
            <span className="min-w-0 truncate text-secondary">{chipDetail}</span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          align="center"
          side="top"
          className="w-[min(32rem,calc(100vw-2rem))] p-1.5"
        >
          <TrackedTaskList tasks={tasks} byId={byId} blocked={blocked} />
        </HoverCardContent>
      </HoverCard>
    </>,
  );
}

function TrackedTaskList({
  tasks,
  byId,
  blocked,
}: {
  tasks: TodoTaskViewV1[];
  byId: Map<number, TodoTaskViewV1>;
  blocked: (task: TodoTaskViewV1) => boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const didPinOnOpen = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (!didPinOnOpen.current) {
      pinOverflowListToEnd(list);
      didPinOnOpen.current = true;
      return;
    }
    const remaining = list.scrollHeight - list.clientHeight - list.scrollTop;
    if (remaining < 48) pinOverflowListToEnd(list);
  }, [tasks.length]);

  return (
    <ol
      ref={listRef}
      className="max-h-[min(26rem,55vh)] overflow-y-auto p-0.5"
      aria-label="Tracked tasks"
    >
      {tasks.map((task) => {
        const dependencyIds =
          task.blockedBy?.filter((id) => byId.get(id)?.status !== "completed") ?? [];
        return (
          <li
            key={task.id}
            className="flex min-h-9 items-start gap-2.5 rounded-control px-2 py-2 text-small"
          >
            <span
              className={
                task.status === "in_progress"
                  ? "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-status-accent-surface text-status-accent"
                  : task.status === "completed"
                    ? "mt-0.5 grid size-5 shrink-0 place-items-center text-tertiary"
                    : "mt-0.5 grid size-5 shrink-0 place-items-center text-secondary"
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
                {task.subject}
              </span>
              {blocked(task) ? (
                <span className="mt-0.5 block text-mini leading-relaxed text-tertiary">
                  Blocked by{" "}
                  {dependencyIds
                    .map((id) => `#${id} ${byId.get(id)?.subject ?? "task"}`)
                    .join(" · ")}
                </span>
              ) : task.status === "in_progress" && task.activeForm ? (
                <span className="mt-0.5 block text-mini leading-relaxed text-tertiary">
                  {task.activeForm}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
