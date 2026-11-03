import { BOT_CONNECTOR_WATCH_CHANNELS as CHANNELS, type BotConnectorWatchRejection } from "../../renderer/shared/bot-connector-watches.js";
import { parseBotId } from "./bot-params.js";
import { BotConnectorWatchError, connectorFields, type BotConnectorWatchService } from "../services/bot-routine-events/connector-service.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";

export function registerBotConnectorWatchHandlers<Event>(ports: {
  handle(channel: string, handler: (event: Event, input: unknown) => Promise<unknown>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed" | "onInvalidated">;
  service(): Promise<BotConnectorWatchService>;
}): void {
  const methods = ["list", "discoverSources", "create", "update", "setEnabled", "remove", "testCheck", "runNow"] as const;
  for (const method of methods) ports.handle(CHANNELS[method], async (event, input) => {
    const owner = ports.owner(event);
    if (owner.isDestroyed()) throw new Error("This watch request came from an inactive renderer.");
    const abort = new AbortController();
    const detach = method === "discoverSources" ? owner.onInvalidated(() => abort.abort()) : () => {};
    try {
      const data = connectorFields(input, ["botId", "id", "expectedRevision", "mutationId", "sourceChoiceId", "name", "prompt", "condition", "everyMinutes", "enabled"]);
      const botId = parseBotId(data.botId);
      const service = await ports.service();
      if (method === "discoverSources") {
        connectorFields(input, ["botId"]);
        const assertCurrent = () => { if (owner.isDestroyed() || abort.signal.aborted) throw new BotConnectorWatchError("unavailable", "This source inspection's application document is no longer active."); };
        assertCurrent();
        return await service.discoverSources(botId, { signal: abort.signal, assertCurrent });
      }
      if (method === "list") {
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
    } finally { detach(); }
  });
}
