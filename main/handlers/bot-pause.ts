// Pause and resume a Bot from the Mac (plan §7).
//
// - `bots:pause(botId)`: stop the Bot's turn where it stands and refuse new
//   turns until the person resumes it. Idempotent: pausing a paused Bot keeps
//   its first time. Returns the Bot's state (`{ kind: "paused", ... }`).
// - `bots:unpause(botId)`: lift the pause. A turn the pause cut short reads as
//   interrupted until the person resumes or dismisses it. Returns the state.
// - Throws for a malformed Bot id, a Bot that does not exist (pause only), or
//   an unreadable pause file. Unpausing a Bot that is gone is a harmless no-op.

import type { BotSessionService, BotSessionState } from "../services/bot-runtime/bot-session-service.js";
import { parseBotId } from "./bot-params.js";

export const BOT_PAUSE_CHANNEL = "bots:pause";
export const BOT_UNPAUSE_CHANNEL = "bots:unpause";

export interface BotPauseHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  runtime: () => Promise<Pick<BotSessionService, "pause" | "unpause">>;
  /** Whether the Bot exists, so a stray id never leaves a pause behind. */
  botExists(botId: string): Promise<boolean>;
}

export function registerBotPauseHandlers(dependencies: BotPauseHandlerDependencies): void {
  dependencies.handle(BOT_PAUSE_CHANNEL, async (_event, id): Promise<BotSessionState> => {
    const botId = parseBotId(id);
    if (!(await dependencies.botExists(botId))) throw new Error("This Bot no longer exists.");
    return (await dependencies.runtime()).pause(botId, "mac");
  });
  dependencies.handle(BOT_UNPAUSE_CHANNEL, async (_event, id): Promise<BotSessionState> => {
    const botId = parseBotId(id);
    return (await dependencies.runtime()).unpause(botId);
  });
}
