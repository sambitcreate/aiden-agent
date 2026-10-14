// The process-wide Bot turn intents. Desktop Stop (`main/handlers/bots.ts`),
// Remote Stop (`aiden-remote-bot-session.ts`) and the session's Resume
// (`onResumed` in `bot-session-main.ts`) announce here; the desktop live
// projection (`bot-session-main.ts`) and Remote projectors listen.

import { logger } from "../../platform.js";
import { createBotTurnIntents } from "./bot-turn-intents.js";

export const botTurnIntents = createBotTurnIntents({
  // A surface that missed a Stop or Resume would keep its old line; say so instead of hiding it.
  onError: (botId, intent, error) => logger.warn("bots", `Bot ${botId} ${intent} listener failed.`, error),
});
