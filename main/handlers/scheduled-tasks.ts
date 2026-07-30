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
import { parseScheduledTaskInput } from "./scheduled-tasks-parse.js";
import type { ScheduledTaskSettings } from "../services/types.js";
import { scheduledSettingsPatch } from "../services/scheduled-settings-core.js";
import { selectedMcpServers } from "../services/mcp-selection.js";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for "${name}".`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function settingsDefaults(
  input: Awaited<ReturnType<typeof configStore.getSettings>>,
): ScheduledTaskSettings {
  return {
    enabled: input.scheduledTasksEnabled !== false,
    defaultMode: input.scheduledDefaultMode === "script" ? "script" : "llm",
    defaultPermission: input.scheduledDefaultPermission === "full" ? "full" : "read-only",
    defaultMcpEnabled: input.scheduledDefaultMcpEnabled === true,
    defaultNotify: input.scheduledDefaultNotify !== false,
    defaultTimezone: validateTimezone(input.scheduledDefaultTimezone ?? systemTimezone()),
  };
}

export function registerScheduledTaskHandlers(): void {
  ipcMain.handle("schedule:list", () => scheduleStore.list());
  ipcMain.handle("schedule:save", async (_event, input: unknown) => {
    const parsed = parseScheduledTaskInput(input);
    if ((parsed.mcpServerIds?.length ?? 0) > 0) {
      selectedMcpServers(await configStore.listMcpServers(), parsed.mcpServerIds);
    }
    return scheduleService.save(parsed);
  });
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
  ipcMain.handle("schedule:preview", (_event, cron: unknown, timezone: unknown, count: unknown) =>
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
    const input = (
      patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}
    ) as Record<string, unknown>;
    const saved = await configStore.setSettings(scheduledSettingsPatch(input, validateTimezone));
    if (
      typeof input.enabled === "boolean" &&
      input.enabled !== (current.scheduledTasksEnabled !== false)
    ) {
      await scheduleService.setGlobalEnabled(input.enabled);
    }
    return settingsDefaults(saved);
  });
}
