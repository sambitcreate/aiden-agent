import type { BotRoutineModelDirectory } from "../../renderer/shared/bot-routine-model-directory.js";
import type { BotExecutionResumeStatus } from "../../renderer/shared/bot-execution-resume.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import { parseBotRoutineModelId, parseBotRoutineModelSave, type BotRoutineModelCatalog, type BotRoutineModelResult, type BotRoutineModelSave, type BotRoutineModelSettings, type BotRoutineModelRun } from "../../renderer/shared/bot-routine-models.js";

export interface BotRoutineModelInvocation {
  signal: AbortSignal;
  assertCurrent(): void | Promise<void>;
}
export interface BotRoutineModelSettingsPort {
  listRoutines(botId: string): Promise<BotRoutineModelDirectory>;
  resumeStatus(botId: string): Promise<BotExecutionResumeStatus>;
  read(botId: string, routineId: string): Promise<BotRoutineModelSettings>;
  catalog(botId: string, routineId: string): Promise<BotRoutineModelCatalog>;
  readRuns(botId: string, routineId: string): Promise<BotRoutineModelRun[]>;
  save(input: BotRoutineModelSave, lifetime: BotRoutineModelInvocation): Promise<BotRoutineModelResult>;
}

/** The active person can authorize a routine choice; JSON never carries that authority. */
export function registerBotRoutineModels<Event>(ports: {
  handle(channel: string, handler: (event: Event, input: unknown) => Promise<unknown>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed" | "onInvalidated">;
  service(): Promise<BotRoutineModelSettingsPort>;
}) {
  for (const action of ["read", "catalog", "runs", "save", "resumeStatus", "directory"] as const) ports.handle(`bots:routineModels:${action}`, async (event, input) => {
    const owner = ports.owner(event);
    const controller = new AbortController();
    const current = () => { controller.signal.throwIfAborted(); if (owner.isDestroyed()) throw new Error("The application document is no longer active."); };
    current();
    const detach = owner.onInvalidated(() => controller.abort());
    try {
      current();
      if (action === "resumeStatus" || action === "directory") {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !("botId" in input)) throw new Error("Invalid Bot resume request.");
        const botId = parseBotRoutineModelId((input as { botId: unknown }).botId), service = await ports.service(); current();
        const result = await (action === "resumeStatus" ? service.resumeStatus(botId) : service.listRoutines(botId)); current(); return result;
      }
      if (action === "save") {
        const request = parseBotRoutineModelSave(input);
        const service = await ports.service(); current();
        const result = await service.save(request, { signal: controller.signal, assertCurrent: current });
        current(); return result;
      }
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || Object.keys(input).some((key) => key !== "botId" && key !== "routineId")) throw new Error("Invalid routine model request.");
      const raw = input as Record<string, unknown>, botId = parseBotRoutineModelId(raw.botId), routineId = parseBotRoutineModelId(raw.routineId);
      const service = await ports.service(); current();
      const result = await (action === "runs" ? service.readRuns(botId, routineId) : service[action](botId, routineId)); current(); return result;
    } finally { detach(); controller.abort(); }
  });
}
