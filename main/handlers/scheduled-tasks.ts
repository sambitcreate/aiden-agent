import { ipcMain } from "../platform.js";
import { parseScheduledTaskInput } from "./scheduled-tasks-parse.js";
import { scheduledTaskApplicationService } from "../services/scheduled-task-application-service-main.js";
import { scheduledTaskRevision } from "../services/scheduled-task-application-service.js";
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
    return scheduledTaskApplicationService.save(parsed, { expectedRevision: revision });
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
  ipcMain.handle("schedule:runNow", async (_event, id: unknown, updatedAt: unknown) =>
    scheduledTaskApplicationService.runNow(
      requiredString(id, "id"),
      undefined,
      await revisionFor(requiredString(id, "id"), updatedAt),
    ),
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
