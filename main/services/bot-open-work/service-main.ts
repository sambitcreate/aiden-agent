import { app, ipcMain } from "../../platform.js";
import { botStore } from "../bot-store.js";
import { scheduleStore } from "../schedule-store.js";
import { createBotOpenWorkStore } from "./store.js";
import { createBotOpenWorkService } from "./service.js";
import { createBotOpenWorkRoutineOrigin } from "../bot-open-work-host-origin.js";

/** Loading records never submits work or resumes the Bot. */
export const botOpenWork = createBotOpenWorkService({
  store: createBotOpenWorkStore({ profileDir: () => app.getPath("userData"), botExists: async (botId) => await botStore.get(botId) !== null }),
  execution: {
    inspect: async (botId, submissionId) => (await (await import("../bot-runtime/bot-session-main.js")).botSessionRuntime()).inspectLinkedWork(botId, submissionId),
    evidence: async (botId, submissionId, kind) => (await (await import("../bot-runtime/bot-session-main.js")).botSessionRuntime()).readLinkedWorkEvidence(botId, submissionId, kind),
    stop: async (botId, submissionId, intentId) => (await (await import("../bot-runtime/bot-session-main.js")).botSessionRuntime()).stopLinkedWork(botId, submissionId, intentId),
  },
  publish: (botId) => { ipcMain.broadcast("bots:openWork:changed", { botId }); ipcMain.broadcast("bots:changed", { botId }); },
});

export const resolveBotOpenWorkRoutineOrigin = createBotOpenWorkRoutineOrigin({
  task: (id) => scheduleStore.get(id).then((task) => task ?? undefined),
  run: (id, requestId) => scheduleStore.runById(id, requestId),
  events: async (botId) => (await import("../bot-routine-events/sources-main.js")).botEventRoutines.list(botId),
});
