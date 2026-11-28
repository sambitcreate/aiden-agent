import { ipcMain } from "../platform.js";
import { parseScheduledTaskInput } from "./scheduled-tasks-parse.js";
import { scheduledTaskApplicationService } from "../services/scheduled-task-application-service-main.js";
import { scheduledTaskRevision } from "../services/scheduled-task-application-service.js";
import { systemTimezone } from "../services/schedule-store.js";
import { saveConnectorTask } from "../services/scheduled-task-connector-trigger.js";
import { keepAwakeStatus } from "../services/keep-awake/keep-awake-main.js";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredUpdatedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected an exact task revision for "updatedAt".');
  }
  return value;
}

async function revisionFor(id: string, updatedAt: unknown): Promise<string> {
  const task = await scheduledTaskApplicationService.get(id);
  if (task.updatedAt !== requiredUpdatedAt(updatedAt)) {
    throw new Error("This automation changed. Refresh it before trying again.");
  }
  return scheduledTaskRevision(task);
}

export function registerScheduledTaskHandlers(): void {
  ipcMain.handle("schedule:list", () => scheduledTaskApplicationService.list());
  ipcMain.handle("schedule:save", async (_event, input: unknown, updatedAt?: unknown) => {
    const parsed = parseScheduledTaskInput(input);
    const revision = parsed.id ? await revisionFor(parsed.id, updatedAt) : undefined;
    if (parsed.trigger?.kind !== "connector")
      return scheduledTaskApplicationService.save(parsed, { expectedRevision: revision });
    // A connected-app task: its Find sources choice becomes its exact source,
    // which stays in main and is bound once the task is saved.
    const triggers = await import("../services/scheduled-task-triggers-main.js");
    const existing = parsed.id
      ? (await scheduledTaskApplicationService.get(parsed.id)).trigger
      : undefined;
    return saveConnectorTask(parsed.trigger, existing, {
      connector: triggers.taskConnectorChoices,
      save: (trigger) =>
        scheduledTaskApplicationService.save(
          { ...parsed, trigger },
          { expectedRevision: revision },
        ),
      bind: triggers.bindTaskConnectorSource,
      needsSource: triggers.markTaskNeedsSource,
    });
  });
  ipcMain.handle("schedule:remove", async (_event, id: unknown, updatedAt: unknown) =>
    scheduledTaskApplicationService.remove(
      requiredString(id, "id"),
      await revisionFor(requiredString(id, "id"), updatedAt),
    ),
  );
  ipcMain.handle("schedule:pause", async (_event, id: unknown, updatedAt: unknown) =>
    scheduledTaskApplicationService.pause(
      requiredString(id, "id"),
      await revisionFor(requiredString(id, "id"), updatedAt),
    ),
  );
  ipcMain.handle("schedule:resume", async (_event, id: unknown, updatedAt: unknown) =>
    scheduledTaskApplicationService.resume(
      requiredString(id, "id"),
      await revisionFor(requiredString(id, "id"), updatedAt),
    ),
  );
  // A link task's link is shown once, when made or rotated; reads never include it.
  ipcMain.handle("schedule:trigger-link:rotate", async (_event, id: unknown) =>
    (await import("../services/scheduled-task-triggers-main.js")).rotateTaskTriggerLink(
      requiredString(id, "id"),
    ),
  );
  // Find sources for a connected-app task: foreground, through connections that are already open.
  ipcMain.handle("schedule:trigger-connector:find-sources", async () =>
    (await import("../services/scheduled-task-triggers-main.js")).findTaskConnectorSources(
      AbortSignal.timeout(60_000),
    ),
  );
  ipcMain.handle("schedule:trigger-link:state", async (_event, id: unknown) =>
    (await import("../services/scheduled-task-triggers-main.js")).taskTriggerLinkState(
      requiredString(id, "id"),
    ),
  );
  ipcMain.handle("schedule:use-own-chat", async (_event, id: unknown, updatedAt: unknown) =>
    scheduledTaskApplicationService.useOwnChat(
      requiredString(id, "id"),
      await revisionFor(requiredString(id, "id"), updatedAt),
    ),
  );
  ipcMain.handle("schedule:runNow", async (_event, id: unknown, updatedAt: unknown) =>
    scheduledTaskApplicationService.runNow(
      requiredString(id, "id"),
      undefined,
      await revisionFor(requiredString(id, "id"), updatedAt),
    ),
  );
  ipcMain.handle("schedule:preview", (_event, cron: unknown, timezone: unknown, count: unknown) =>
    scheduledTaskApplicationService.preview(
      requiredString(cron, "cron"),
      optionalString(timezone) ?? systemTimezone(),
      typeof count === "number" ? count : 3,
    ),
  );
  ipcMain.handle("schedule:scripts", (_event, workspaceId?: unknown) =>
    scheduledTaskApplicationService.scripts(optionalString(workspaceId)),
  );
  ipcMain.handle("schedule:keepAwakeStatus", () => keepAwakeStatus());
  ipcMain.handle("schedule:settings", async (_event, patch?: unknown) => {
    const current = await scheduledTaskApplicationService.settings();
    if (patch === undefined) return current.value;
    const input = (
      patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}
    ) as Record<string, unknown>;
    return (await scheduledTaskApplicationService.updateSettings(current.revision, input)).value;
  });
}
