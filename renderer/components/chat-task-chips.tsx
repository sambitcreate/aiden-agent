// The composer's chip for scheduled tasks that post into this chat:
// "Daily build check · next 9:00 AM". It opens the task in Scheduled tasks,
// where "Use its own chat" moves it out of the conversation.

import { useNavigate } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";
import { Button } from "./ui";
import type { ScheduledTask } from "../lib/types";

/** Enabled tasks that post into this chat, soonest first. */
export function tasksPostingInChat(
  tasks: readonly ScheduledTask[] | undefined,
  chatId: string,
): ScheduledTask[] {
  return (tasks ?? [])
    .filter((task) => task.originChatId === chatId && task.enabled)
    .sort(
      (a, b) =>
        (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY),
    );
}

/** "9:00 AM", "tomorrow 9:00 AM" or "Thu 9:00 AM", in this computer's time. */
export function nextTaskRunLabel(timestamp: number, now = Date.now()): string {
  const at = new Date(timestamp);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** The chip's words: the task (or how many) and when the soonest one runs next. */
export function chatTaskChipLabel(tasks: readonly ScheduledTask[], now = Date.now()): string {
  const first = tasks[0];
  if (!first) return "";
  const name = tasks.length === 1 ? first.name : `${tasks.length} scheduled tasks`;
  return first.nextRunAt !== undefined
    ? `${name} · next ${nextTaskRunLabel(first.nextRunAt, now)}`
    : name;
}

export function ChatTaskChip({ tasks }: { tasks: readonly ScheduledTask[] }) {
  const navigate = useNavigate();
  const first = tasks[0];
  if (!first) return null;
  const label = chatTaskChipLabel(tasks);
  return (
    <Button
      variant="transparent"
      size="small"
      className="h-7 shrink-0 gap-1.5 px-2 text-secondary"
      aria-label={`${label}. Posts in this chat. Open in Scheduled tasks`}
      onClick={() =>
        void navigate({ to: "/scheduled", search: tasks.length === 1 ? { task: first.id } : {} })
      }
    >
      <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
      <span className="max-w-[14rem] truncate">{label}</span>
    </Button>
  );
}

/**
 * The delete dialog's line for tasks that post into the chats being deleted:
 * "Daily build check will keep running in its own chat." Empty when none do.
 */
export function chatDeleteTaskNote(
  tasks: readonly ScheduledTask[] | undefined,
  chatIds: readonly string[],
): string {
  const ids = new Set(chatIds);
  const bound = (tasks ?? []).filter(
    (task) => task.originChatId !== undefined && ids.has(task.originChatId),
  );
  if (bound.length === 0) return "";
  if (bound.length === 1) return `${bound[0]!.name} will keep running in its own chat.`;
  if (bound.length === 2)
    return `${bound[0]!.name} and ${bound[1]!.name} will keep running in their own chats.`;
  return `${bound[0]!.name} and ${bound.length - 1} other scheduled tasks will keep running in their own chats.`;
}
