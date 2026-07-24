import assert from "node:assert/strict";
import test from "node:test";
import { showScheduledNotification } from "./schedule-notification.js";
import type { ScheduledTask } from "./types.js";

function task(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Daily brief",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    notify: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

test("notification truncates output and opens the dedicated chat on click", async () => {
  let click: (() => void) | undefined;
  let options: { title: string; body: string } | undefined;
  const opened: string[] = [];
  const shown = showScheduledNotification(task(), `  ${"result ".repeat(30)}  `, "chat-1", {
    isSupported: () => true,
    create: (input) => {
      options = input;
      return {
        on: (_event, listener) => {
          click = listener;
        },
        show: () => undefined,
      };
    },
    openChat: async (chatId) => {
      opened.push(chatId);
    },
  });
  assert.equal(shown, true);
  assert.equal(options?.title, "Daily brief");
  assert.equal(options?.body.length, 120);
  click?.();
  await Promise.resolve();
  assert.deepEqual(opened, ["chat-1"]);
});

test("notification honors task opt-out and platform support", () => {
  let creates = 0;
  const dependencies = {
    isSupported: () => true,
    create: () => {
      creates += 1;
      return { on: () => undefined, show: () => undefined };
    },
    openChat: () => undefined,
  };
  assert.equal(showScheduledNotification(task({ notify: false }), "done", "chat-1", dependencies), false);
  assert.equal(
    showScheduledNotification(task(), "done", "chat-1", {
      ...dependencies,
      isSupported: () => false,
    }),
    false,
  );
  assert.equal(creates, 0);
});
