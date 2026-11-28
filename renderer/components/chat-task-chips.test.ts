import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledTask } from "../lib/types.js";
import { chatDeleteTaskNote, chatTaskChipLabel, tasksPostingInChat } from "./chat-task-chips.js";

function task(id: string, patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: `Task ${id}`,
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    prompt: "hello",
    notify: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as ScheduledTask;
}

test("the composer chip lists only enabled tasks posting into this chat, soonest first", () => {
  const now = new Date(2026, 10, 22, 8, 0).getTime();
  const soon = new Date(2026, 10, 22, 9, 0).getTime();
  const later = new Date(2026, 10, 23, 9, 0).getTime();
  const tasks = [
    task("a", { originChatId: "chat-1", nextRunAt: later, name: "Weekly notes" }),
    task("b", { originChatId: "chat-1", nextRunAt: soon, name: "Daily build check" }),
    task("c", { originChatId: "chat-2", nextRunAt: soon }),
    task("d", { originChatId: "chat-1", enabled: false, nextRunAt: soon }),
    task("e", { nextRunAt: soon }),
  ];
  const posting = tasksPostingInChat(tasks, "chat-1");
  assert.deepEqual(
    posting.map((item) => item.id),
    ["b", "a"],
  );
  assert.match(chatTaskChipLabel(posting, now), /^2 scheduled tasks · next \S+/u);
  assert.match(chatTaskChipLabel(posting.slice(1), now), /^Weekly notes · next tomorrow /u);
  assert.equal(chatTaskChipLabel([task("x", { name: "No next run" })], now), "No next run");
  assert.equal(chatTaskChipLabel([], now), "");
});

test("deleting a chat says which tasks will keep running in their own chats", () => {
  const tasks = [
    task("a", { originChatId: "chat-1", name: "Daily build check" }),
    task("b", { originChatId: "chat-2", name: "Inbox brief" }),
    task("c", { originChatId: "chat-3", name: "Release notes" }),
    task("d", { name: "Unbound" }),
  ];
  assert.equal(chatDeleteTaskNote(tasks, ["chat-9"]), "");
  assert.equal(
    chatDeleteTaskNote(tasks, ["chat-1"]),
    "Daily build check will keep running in its own chat.",
  );
  assert.equal(
    chatDeleteTaskNote(tasks, ["chat-1", "chat-2"]),
    "Daily build check and Inbox brief will keep running in their own chats.",
  );
  assert.equal(
    chatDeleteTaskNote(tasks, ["chat-1", "chat-2", "chat-3"]),
    "Daily build check and 2 other scheduled tasks will keep running in their own chats.",
  );
});
