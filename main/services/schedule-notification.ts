import type { ScheduledTask } from "./types.js";

interface ScheduledNotification {
  on(event: "click", listener: () => void): unknown;
  show(): void;
}

export interface ScheduledNotificationDependencies {
  isSupported(): boolean;
  create(options: { title: string; body: string }): ScheduledNotification;
  openChat(chatId: string): void | Promise<void>;
}

export function showScheduledNotification(
  task: ScheduledTask,
  body: string,
  chatId: string | undefined,
  dependencies: ScheduledNotificationDependencies,
): boolean {
  if (!task.notify || !dependencies.isSupported()) return false;
  const notification = dependencies.create({
    title: task.name,
    body: body.replace(/\s+/gu, " ").trim().slice(0, 120),
  });
  if (chatId) {
    notification.on("click", () => {
      void dependencies.openChat(chatId);
    });
  }
  notification.show();
  return true;
}
