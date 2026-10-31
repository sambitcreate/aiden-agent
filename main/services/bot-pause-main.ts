// The one Bot pause store in the desktop process (plan §7):
// `<userData>/bot-service/bot-pauses.json`. The durable Bot runtime writes it
// (`bot-session-main.ts`); the legacy chat generation path (`llm-client.ts`)
// and the Remote chat route read it, so a paused Bot runs no turn anywhere.

import { botServiceRoot } from "./bot-capability-services-main.js";
import { createBotPauseStore } from "./bot-pause-store.js";

export const botPauses = createBotPauseStore({ root: botServiceRoot });

/** Whether the person paused this Bot; throws when the pause file is unreadable, so callers refuse. */
export async function isBotPaused(botId: string): Promise<boolean> {
  return (await botPauses.get(botId)) !== undefined;
}
