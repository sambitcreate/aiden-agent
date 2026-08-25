import { ipcMain } from "../platform.js";
import { parseScheduledTaskInput } from "./scheduled-tasks-parse.js";
import { scheduledTaskApplicationService } from "../services/scheduled-task-application-service-main.js";
import { systemTimezone } from "../services/schedule-store.js";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function registerScheduledTaskHandlers(): void {
  ipcMain.handle("schedule:list", () => scheduledTaskApplicationService.list());
  ipcMain.handle("schedule:save", async (_event, input: unknown) => {
    return scheduledTaskApplicationService.save(parseScheduledTaskInput(input));
  });
  ipcMain.handle("schedule:remove", (_event, id: unknown) =>
    scheduledTaskApplicationService.remove(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:pause", (_event, id: unknown) =>
    scheduledTaskApplicationService.pause(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:resume", (_event, id: unknown) =>
    scheduledTaskApplicationService.resume(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:runNow", (_event, id: unknown) =>
    scheduledTaskApplicationService.runNow(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:runs", (_event, id: unknown) =>
    scheduledTaskApplicationService.runs(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:preview", (_event, cron: unknown, timezone: unknown, count: unknown) =>
    scheduledTaskApplicationService.preview(
      requiredString(cron, "cron"),
      optionalString(timezone) ?? systemTimezone(),
      typeof count === "number" ? count : 3,
    ),
  );
  ipcMain.handle("schedule:scripts", (_event, workspaceId?: unknown) =>
    scheduledTaskApplicationService.scripts(optionalString(workspaceId)));
  ipcMain.handle("schedule:settings", async (_event, patch?: unknown) => {
    const current = await scheduledTaskApplicationService.settings();
    if (patch === undefined) return current.value;
    const input = (
      patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}
    ) as Record<string, unknown>;
    return (await scheduledTaskApplicationService.updateSettings(current.revision, input)).value;
  });
}
