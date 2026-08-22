import { ipcMain } from "../platform.js";
import { configStore } from "./config-store.js";
import { selectedMcpServers } from "./mcp-selection.js";
import { listScheduledScripts } from "./schedule-script.js";
import { scheduleService } from "./schedule-service.js";
import { nextScheduledRuns, scheduleStore, systemTimezone, validateTimezone } from "./schedule-store.js";
import { scheduledSettingsPatch } from "./scheduled-settings-core.js";
import { createScheduledTaskApplicationService } from "./scheduled-task-application-service.js";

export const scheduledTaskApplicationService = createScheduledTaskApplicationService({
  store: scheduleStore,
  service: scheduleService,
  getSettings: () => configStore.getSettings(),
  setSettings: (patch) => configStore.setSettings(patch),
  getWorkspace: (id) => configStore.getWorkspace(id),
  listMcpServers: () => configStore.listMcpServers(),
  validateMcpSelection: (configured, selected) => {
    selectedMcpServers(configured, selected);
  },
  listScripts: listScheduledScripts,
  nextRuns: nextScheduledRuns,
  systemTimezone,
  validateTimezone,
  settingsPatch: (input) => scheduledSettingsPatch(input, validateTimezone),
  notifyChanged: (payload) => ipcMain.broadcast("schedule:updated", payload),
});
