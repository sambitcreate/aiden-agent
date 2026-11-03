import { BOT_CONNECTOR_WATCH_CHANNELS as CHANNELS, type BotConnectorWatchRejection } from "../../renderer/shared/bot-connector-watches.js";
import { parseBotId } from "./bot-params.js";
import { BotConnectorWatchError, connectorFields, type BotConnectorWatchService } from "../services/bot-routine-events/connector-service.js";

export function registerBotConnectorWatchHandlers<Event>(ports: {
  handle(channel: string, handler: (event: Event, input: unknown) => Promise<unknown>): void;
  requireOwner(event: Event): void;
  service(): Promise<BotConnectorWatchService>;
}): void {
  const methods = ["list", "discoverSources", "create", "update", "setEnabled", "remove", "testCheck", "runNow"] as const;
  for (const method of methods) ports.handle(CHANNELS[method], async (event, input) => {
    ports.requireOwner(event);
    try {
      const data = connectorFields(input, ["botId", "id", "expectedRevision", "mutationId", "sourceChoiceId", "name", "prompt", "condition", "everyMinutes", "enabled"]);
      const botId = parseBotId(data.botId);
      const service = await ports.service();
      if (method === "list" || method === "discoverSources") {
        connectorFields(input, ["botId"]);
        return await service[method](botId);
      }
      // Each concrete service method performs its own exact shape validation.
      return await (service[method] as (input: never) => Promise<unknown>)({ ...data, botId } as never);
    } catch (error) {
      if (!(error instanceof BotConnectorWatchError)) throw error;
      const rejection: BotConnectorWatchRejection = { ok: false, code: error.code, message: error.message,
        ...(typeof error.details?.currentRevision === "string" ? { currentRevision: error.details.currentRevision } : {}),
        ...(error.details?.current ? { current: error.details.current as BotConnectorWatchRejection["current"] } : {}) };
      return rejection;
    }
  });
}
