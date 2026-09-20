import type { ScheduledTask } from "./types.js";

interface ScheduledNotification {
  on(event: "click", listener: () => void): unknown;
  show(): void;
}

export interface ScheduledNotificationDependencies {
  isSupported(): boolean;
  create(options: { title: string; body: string }): ScheduledNotification;
  openChat(chatId: string): void | Promise<void>;
  onError?(stage: "delivery" | "navigation", error: unknown): void;
}

export function showScheduledNotification(
  task: ScheduledTask,
  body: string,
  chatId: string | undefined,
  dependencies: ScheduledNotificationDependencies,
): boolean {
  const report = (stage: "delivery" | "navigation", error: unknown) => {
    try {
      dependencies.onError?.(stage, error);
    } catch {
      // Diagnostics are best-effort too; they must not change a saved run.
    }
  };
  if (!task.notify) return false;
  try {
    if (!dependencies.isSupported()) return false;
    const notification = dependencies.create({
      title: task.name,
      body: body.replace(/\s+/gu, " ").trim().slice(0, 120),
    });
    if (chatId) {
      notification.on("click", () => {
        // Capture both synchronous throws and asynchronous navigation failures.
        void Promise.resolve()
          .then(() => dependencies.openChat(chatId))
          .catch((error: unknown) => report("navigation", error));
      });
    }
    notification.show();
    return true;
  } catch (error) {
    report("delivery", error);
    return false;
  }
}
