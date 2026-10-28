// What a Bot learned, from the desktop (spec 2026-10-27 §7 L5).
//
// - `bots:learning:get({ botId })`: lessons, recent changes, follow-ups, today's budget.
// - `bots:learning:undo({ botId, changeId })`: Undo one change; `conflict` when it changed since.
// - `bots:learning:undoInChat({ botId, target })`: the chat line's Undo (a correction lesson, or the newest tidy).
// - `bots:lessons:respond({ botId, lessonId, decision })`: Keep this or Not now.
// - `bots:lessons:remove({ botId, lessonId })`.

import { parseBotId } from "./bot-params.js";
import type { BotLearningOverview } from "../../renderer/shared/bot-learning-overview.js";

const ID = /^[A-Za-z0-9-]{8,64}$/u;

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid learning request.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Invalid learning request.");
  return record;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid learning id.");
  return value;
}

export interface BotLearningHandlerDependencies<Event = unknown> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  overview(botId: string): Promise<BotLearningOverview>;
  undo(botId: string, changeId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  undoLesson(botId: string, lessonId: string): Promise<void>;
  respondLesson(botId: string, lessonId: string, decision: "keep" | "dismiss"): Promise<"active" | "dismissed">;
  removeLesson(botId: string, lessonId: string): Promise<void>;
}

export function registerBotLearningHandlers<Event = unknown>(deps: BotLearningHandlerDependencies<Event>): void {
  deps.handle("bots:learning:get", async (_event, input) => deps.overview(parseBotId(fields(input, ["botId"]).botId)));
  deps.handle("bots:learning:undo", async (_event, input) => {
    const record = fields(input, ["botId", "changeId"]);
    return deps.undo(parseBotId(record.botId), id(record.changeId));
  });
  deps.handle("bots:learning:undoInChat", async (_event, input) => {
    const record = fields(input, ["botId", "target"]);
    const botId = parseBotId(record.botId);
    const target = fields(record.target, ["kind", "lessonId", "changeId"]);
    if (target.kind === "lesson") {
      await deps.undoLesson(botId, id(target.lessonId));
      return { ok: true };
    }
    // The line's own change: never whichever tidy happens to be newest.
    if (target.kind === "change") return deps.undo(botId, id(target.changeId));
    throw new Error("Invalid learning request.");
  });
  deps.handle("bots:lessons:respond", async (_event, input) => {
    const record = fields(input, ["botId", "lessonId", "decision"]);
    if (record.decision !== "keep" && record.decision !== "dismiss") throw new Error("Invalid learning request.");
    return { status: await deps.respondLesson(parseBotId(record.botId), id(record.lessonId), record.decision) };
  });
  deps.handle("bots:lessons:remove", async (_event, input) => {
    const record = fields(input, ["botId", "lessonId"]);
    await deps.removeLesson(parseBotId(record.botId), id(record.lessonId));
  });
}
