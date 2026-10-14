// The process-wide Bot turn intents. Desktop Stop (`main/handlers/bots.ts`),
// Remote Stop (`aiden-remote-bot-session.ts`) and the session's Resume
// (`onResumed` in `bot-session-main.ts`) announce here; the desktop live
// projection (`bot-session-main.ts`) and Remote projectors listen.

import { createBotTurnIntents } from "./bot-turn-intents.js";

export const botTurnIntents = createBotTurnIntents();
