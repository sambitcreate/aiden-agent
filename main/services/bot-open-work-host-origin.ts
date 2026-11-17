import type { ScheduledRun, ScheduledTask } from "./types.js";
import type { BotEventRoutine } from "./bot-routine-events/store.js";
import { botRoutineRequestId, botRoutineTaskIdOf } from "./scheduled-bot-routines.js";
import { issueBotRoutineInputOrigin, parseBotRoutineInputOrigin, type BotRoutineInputOrigin } from "./bot-runtime/bot-input-entry.js";
import { parseBotRoutineTiming, type BotRoutineSessionPort } from "./bot-routines-port.js";

export function createBotOpenWorkRoutineOrigin(ports: {
  task(id: string): Promise<ScheduledTask | undefined>;
  run(taskId: string, runId: string): Promise<ScheduledRun | undefined>;
  events(botId: string): Promise<readonly BotEventRoutine[]>;
}) {
  return async (botId: string, requestId: string, _submissionId: string, storedOrigin?: BotRoutineInputOrigin): Promise<{ routineId: string; runId: string } | undefined> => {
    const id = botRoutineTaskIdOf(requestId); if (!id) return undefined;
    const task = await ports.task(id);
    const hosted = storedOrigin ? parseBotRoutineInputOrigin(storedOrigin) : undefined;
    if (storedOrigin && !hosted) return undefined;
    if (hosted && (hosted.botId !== botId || hosted.routineId !== id || hosted.runId !== requestId)) return undefined;
    if (task) {
      if (task.botId !== botId || task.wakeUp) return undefined;
      if (hosted && hosted.kind !== "event") return { routineId: id, runId: requestId };
      const accepted = task.pendingRoutineFires?.some((fire) => fire.requestId === requestId);
      const run = accepted ? undefined : await ports.run(id, requestId);
      return accepted || run?.taskId === id && run.id === requestId && ["success", "error", "silent"].includes(run.result) ? { routineId: id, runId: requestId } : undefined;
    }
    const event = (await ports.events(botId)).find((candidate) => candidate.id === id && candidate.botId === botId && candidate.connector?.deletedAt === undefined);
    if (!event) return undefined;
    if (hosted?.kind === "event") return { routineId: id, runId: requestId };
    if (event.running?.some((receipt) => botRoutineRequestId(id, { kind: "event", eventId: receipt.eventId, source: event.trigger.kind, payload: receipt.payload }) === requestId)) return { routineId: id, runId: requestId };
    const run = await ports.run(id, requestId);
    return run?.taskId === id && run.id === requestId && ["success", "error", "silent"].includes(run.result) ? { routineId: id, runId: requestId } : undefined;
  };
}

/** Production executor adapter: ordinary senders cannot issue this private token. */
export function createBotRoutineOriginSender(ports: {
  resolveOrigin: ReturnType<typeof createBotOpenWorkRoutineOrigin>;
  resolveRetry?(botId: string, requestId: string, retryOf: string): Promise<boolean>;
  send: BotRoutineSessionPort["send"];
}): BotRoutineSessionPort["send"] {
  return async (botId, input) => {
    if (!input.routineOrigin) {
      if (input.routineTiming || input.retryOf) throw new Error("This input has no verified routine occurrence.");
      return ports.send(botId, input);
    }
    const origin = input.routineOrigin;
    if (origin.botId !== botId || origin.runId !== input.requestId || !await ports.resolveOrigin(botId, input.requestId, "1", origin)) throw new Error("This input is not an accepted Bot routine.");
    if (origin.kind === "retry" ? !input.retryOf || !await ports.resolveRetry?.(botId, input.requestId, input.retryOf) : input.retryOf !== undefined) throw new Error("This input is not a verified retry of an accepted Bot routine.");
    return ports.send(botId, { ...input, routineOrigin: issueBotRoutineInputOrigin(origin), ...(input.routineTiming ? { routineTiming: parseBotRoutineTiming(input.routineTiming) } : {}) });
  };
}
