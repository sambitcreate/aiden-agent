import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { scheduleService } from "../services/schedule-service.js";
import { listScheduledScripts } from "../services/schedule-script.js";
import {
  nextScheduledRuns,
  scheduleStore,
  systemTimezone,
  validateTimezone,
} from "../services/schedule-store.js";
import type {
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  ScheduledTaskSettings,
} from "../services/types.js";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function taskInput(value: unknown): ScheduledTaskInput {
  const input = (value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;
  const mode: ScheduledTaskMode =
    input.mode === "script" ? "script" : input.mode === "llm" ? "llm" : (() => {
      throw new Error("Invalid scheduled task mode.");
    })();
  const permission: ScheduledTaskPermission | undefined =
    input.permission === "full"
      ? "full"
      : input.permission === "read-only"
        ? "read-only"
        : undefined;
  return {
    id: optionalString(input.id),
    name: requiredString(input.name, "name"),
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    mode,
    cron: requiredString(input.cron, "cron"),
    timezone: optionalString(input.timezone),
    workspaceId: optionalString(input.workspaceId),
    providerId: optionalString(input.providerId),
    model: optionalString(input.model),
    prompt: optionalString(input.prompt),
    script: optionalString(input.script),
    permission,
    notify: typeof input.notify === "boolean" ? input.notify : undefined,
  };
}

function settingsDefaults(input: Awaited<ReturnType<typeof configStore.getSettings>>): ScheduledTaskSettings {
  return {
    enabled: input.scheduledTasksEnabled !== false,
    defaultMode: input.scheduledDefaultMode === "script" ? "script" : "llm",
    defaultPermission: input.scheduledDefaultPermission === "full" ? "full" : "read-only",
    defaultNotify: input.scheduledDefaultNotify !== false,
    defaultTimezone: validateTimezone(input.scheduledDefaultTimezone ?? systemTimezone()),
  };
}

export function registerScheduledTaskHandlers(): void {
  ipcMain.handle("schedule:list", () => scheduleStore.list());
  ipcMain.handle("schedule:save", (_event, input: unknown) => scheduleService.save(taskInput(input)));
  ipcMain.handle("schedule:remove", (_event, id: unknown) =>
    scheduleService.remove(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:pause", (_event, id: unknown) =>
    scheduleService.pause(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:resume", (_event, id: unknown) =>
    scheduleService.resume(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:runNow", (_event, id: unknown) =>
    scheduleService.runNow(requiredString(id, "id")),
  );
  ipcMain.handle("schedule:runs", (_event, id: unknown) =>
    scheduleStore.runs(requiredString(id, "id")),
  );
  ipcMain.handle(
    "schedule:preview",
    (_event, cron: unknown, timezone: unknown, count: unknown) =>
      nextScheduledRuns(
        requiredString(cron, "cron"),
        optionalString(timezone) ?? systemTimezone(),
        typeof count === "number" ? count : 3,
      ),
  );
  ipcMain.handle("schedule:scripts", async (_event, workspaceId?: unknown) => {
    const id = optionalString(workspaceId);
    const workspace = id ? await configStore.getWorkspace(id) : undefined;
    if (id && !workspace) throw new Error(`Workspace ${id} not found.`);
    return listScheduledScripts({ workspaceRoot: workspace?.folderPath });
  });
  ipcMain.handle("schedule:settings", async (_event, patch?: unknown) => {
    const current = await configStore.getSettings();
    if (patch === undefined) return settingsDefaults(current);
    const input = (patch && typeof patch === "object" && !Array.isArray(patch)
      ? patch
      : {}) as Record<string, unknown>;
    const next = {
      scheduledTasksEnabled:
        typeof input.enabled === "boolean" ? input.enabled : current.scheduledTasksEnabled,
      scheduledDefaultMode:
        input.defaultMode === "llm" || input.defaultMode === "script"
          ? input.defaultMode
          : current.scheduledDefaultMode,
      scheduledDefaultPermission:
        input.defaultPermission === "read-only" || input.defaultPermission === "full"
          ? input.defaultPermission
          : current.scheduledDefaultPermission,
      scheduledDefaultNotify:
        typeof input.defaultNotify === "boolean"
          ? input.defaultNotify
          : current.scheduledDefaultNotify,
      scheduledDefaultTimezone:
        input.defaultTimezone === undefined
          ? current.scheduledDefaultTimezone
          : validateTimezone(requiredString(input.defaultTimezone, "defaultTimezone")),
    };
    const saved = await configStore.setSettings(next);
    if (
      typeof input.enabled === "boolean" &&
      input.enabled !== (current.scheduledTasksEnabled !== false)
    ) {
      await scheduleService.setGlobalEnabled(input.enabled);
    }
    return settingsDefaults(saved);
  });
}
