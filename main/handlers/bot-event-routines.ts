// Event routines from the Bot profile (spec §6 P1).
//
// - `bots:eventRoutines:list({ botId })`: this Bot's event routines.
// - `bots:eventRoutines:create({ botId, name, prompt, trigger })`: a new one.
//   A webhook routine answers with its link once; only a hash is kept.
// - `bots:eventRoutines:update({ botId, id, name?, prompt?, trigger?, enabled? })`.
// - `bots:eventRoutines:remove({ botId, id })`.
// - `bots:eventRoutines:rotateLink({ botId, id })`: a new link; the old one stops working.

import type { BotEventRoutineStore, BotEventRoutineView } from "../services/bot-routine-events/store.js";
import { viewOf } from "../services/bot-routine-events/store.js";
import { parseBotId } from "./bot-params.js";

export const BOT_EVENT_ROUTINE_CHANNELS = {
  list: "bots:eventRoutines:list",
  create: "bots:eventRoutines:create",
  update: "bots:eventRoutines:update",
  remove: "bots:eventRoutines:remove",
  rotateLink: "bots:eventRoutines:rotateLink",
} as const;

const ROUTINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid event routine request.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Invalid event routine request.");
  return record;
}

function routineId(value: unknown): string {
  if (typeof value !== "string" || !ROUTINE_ID.test(value)) throw new Error("Invalid event routine id.");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid event routine request.");
  return value;
}

export interface BotEventRoutineHandlerDependencies<Event = unknown> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  store: Pick<BotEventRoutineStore, "list" | "create" | "update" | "remove" | "rotateToken">;
  /** The link a person can call, from the Remote listener's address; null when Aiden Remote is off. */
  linkFor(token: string): Promise<string | null>;
  changed(botId: string): void;
}

export function registerBotEventRoutineHandlers<Event = unknown>(dependencies: BotEventRoutineHandlerDependencies<Event>): void {
  dependencies.handle(BOT_EVENT_ROUTINE_CHANNELS.list, async (_event, input): Promise<BotEventRoutineView[]> => {
    const { botId } = fields(input, ["botId"]);
    return (await dependencies.store.list(parseBotId(botId))).map(viewOf);
  });
  dependencies.handle(BOT_EVENT_ROUTINE_CHANNELS.create, async (_event, input) => {
    const record = fields(input, ["botId", "name", "prompt", "trigger"]);
    const botId = parseBotId(record.botId);
    const { routine, token } = await dependencies.store.create(botId, {
      name: text(record.name),
      prompt: text(record.prompt),
      trigger: record.trigger,
    });
    dependencies.changed(botId);
    return { routine: viewOf(routine), ...(token ? { link: await dependencies.linkFor(token), token } : {}) };
  });
  dependencies.handle(BOT_EVENT_ROUTINE_CHANNELS.update, async (_event, input): Promise<BotEventRoutineView> => {
    const record = fields(input, ["botId", "id", "name", "prompt", "trigger", "enabled"]);
    const botId = parseBotId(record.botId);
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") throw new Error("Invalid event routine request.");
    const routine = await dependencies.store.update(botId, routineId(record.id), {
      ...(record.name !== undefined ? { name: text(record.name) } : {}),
      ...(record.prompt !== undefined ? { prompt: text(record.prompt) } : {}),
      ...(record.trigger !== undefined ? { trigger: record.trigger } : {}),
      ...(record.enabled !== undefined ? { enabled: record.enabled as boolean } : {}),
    });
    dependencies.changed(botId);
    return viewOf(routine);
  });
  dependencies.handle(BOT_EVENT_ROUTINE_CHANNELS.remove, async (_event, input): Promise<{ removed: boolean }> => {
    const record = fields(input, ["botId", "id"]);
    const botId = parseBotId(record.botId);
    const removed = await dependencies.store.remove(botId, routineId(record.id));
    dependencies.changed(botId);
    return { removed };
  });
  dependencies.handle(BOT_EVENT_ROUTINE_CHANNELS.rotateLink, async (_event, input): Promise<{ link: string | null; token: string }> => {
    const record = fields(input, ["botId", "id"]);
    const token = await dependencies.store.rotateToken(parseBotId(record.botId), routineId(record.id));
    return { link: await dependencies.linkFor(token), token };
  });
}
