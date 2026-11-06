import { app, ipcMain } from "../platform.js";
import { botSessionDeletionPending } from "./bot-runtime/bot-session-service.js";
import { botApplicationService, initializeBotApplicationService } from "./bot-application-service-main.js";
import { BOT_DESKTOP_AUDIENCE_ID, botRuntimeAuthority } from "./bot-runtime-authority-main.js";
import { botCapabilityCatalog, botCapabilityStore } from "./bot-capability-services-main.js";
import { botStore } from "./bot-store.js";
import { scheduleStore } from "./schedule-store.js";
import { resolveCompactionModelMetadata } from "./model-runtime.js";
import { createBotRoutineModelService, type BotExecutionModelChoice } from "./bot-routine-models.js";

/** Owner routes authorize their principal; this singleton mints only private exact grants. */
const service = createBotRoutineModelService({
  persistence: {
    read: async () => { await initializeBotApplicationService(); return botCapabilityStore.getRoutineModelsState(); },
    write: (previous, next, assertCurrent, isCurrent) => botCapabilityStore.saveRoutineModelsState(previous, next, assertCurrent, isCurrent),
  },
  identity: async (botId, routineId) => {
    await initializeBotApplicationService();
    if (await botSessionDeletionPending(app.getPath("userData"), botId)) throw new Error("This Bot is being deleted.");
    const bot = await botStore.get(botId); if (!bot) throw new Error("This Bot no longer exists.");
    const botIncarnation = String(bot.createdAt);
    if (!routineId) return { botIncarnation };
    const task = await scheduleStore.get(routineId);
    if (task) { if (task.botId !== botId || task.wakeUp) throw new Error("This routine does not belong to this Bot."); return { botIncarnation, routineIncarnation: `scheduled:${task.createdAt}` }; }
    const event = (await (await import("./bot-routine-events/sources-main.js")).botEventRoutines.list(botId)).find((row) => row.id === routineId);
    if (!event) throw new Error("This routine no longer exists."); return { botIncarnation, routineIncarnation: `event:${event.createdAt}` };
  },
  snapshot: (retainedProviders) => botCapabilityCatalog.snapshotModelsForRuntime({ retainedProviders }),
  metadata: resolveCompactionModelMetadata,
  deliveryQuiet: async (botId,routineId) => {const task=await scheduleStore.get(routineId);return task?.botId===botId&&task.notify===false;},
  companionChoice: async (botId) => (await botCapabilityStore.getBotVisionModelAuthority(botId))?.binding,
  defaultChoice: async (botId): Promise<BotExecutionModelChoice> => {
    const chat = await botApplicationService.getCanonicalChat(botId) ?? await botApplicationService.createChat({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId });
    // Only inheritance uses canonical default admission/metadata repair. An
    // explicit routine choice never resolves an unrelated broken default.
    const admission = await botRuntimeAuthority.admit({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, chatId: chat.id });
    try {
      await admission.revalidateBeforeEffect(); const authority = await botCapabilityStore.getBotModelAuthority(botId);
      if (!authority) throw new Error("This Bot needs an AI model.");
      // Bot defaults currently have no independent thinking setting.
      return { binding: authority.binding, thinkingLevel: "off" };
    } finally { admission.release(); }
  },
  changed: (botId) => ipcMain.broadcast("bots:changed", { botId }),
});

export const botRoutineModels = {
  ...service,
  /** Owner model chooser covers scheduled, generic event, script and connector watches. */
  async listRoutines(botId: string): Promise<{ botId: string; routines: { id: string; name: string; kind: "scheduled" | "event" | "watch" }[] }> {
    await initializeBotApplicationService();
    const before = await botStore.get(botId); if (!before || await botSessionDeletionPending(app.getPath("userData"), botId)) throw new Error("This Bot is not available.");
    const [scheduled, events] = await Promise.all([scheduleStore.list(), (await import("./bot-routine-events/sources-main.js")).botEventRoutines.list(botId)]);
    const routines = [
      ...scheduled.filter((task) => task.botId === botId && !task.wakeUp).map((task) => ({ id: task.id, name: task.name, kind: "scheduled" as const })),
      ...events.filter((event) => !event.connector?.deletedAt).map((event) => ({ id: event.id, name: event.name, kind: event.trigger.kind === "watch" ? "watch" as const : "event" as const })),
    ];
    const after = await botStore.get(botId); if (!after || before.createdAt !== after.createdAt || await botSessionDeletionPending(app.getPath("userData"), botId) || routines.length > 1024 || new Set(routines.map((row) => row.id)).size !== routines.length) throw new Error("Routine ownership changed. Refresh and try again.");
    return { botId, routines };
  },
};
