// Production wiring of a Bot's own wake-ups. Loaded lazily: it reaches the
// scheduler, which must not load while the Bot runtime graph initializes.

import { botStore } from "../bot-store.js";
import { botRoutineService } from "../scheduled-bot-routines-main.js";
import { scheduleStore, systemTimezone } from "../schedule-store.js";
import { createBotWakeUps } from "./wake-ups.js";

/** Whether the person lets this Bot set its own wake-ups (on unless they turned it off). */
export async function botSelfWakeUpsEnabled(botId: string): Promise<boolean> {
  const bot = await botStore.get(botId);
  return bot !== null && bot !== undefined && bot.selfWakeUps !== false;
}

export const botWakeUps = createBotWakeUps({
  store: scheduleStore,
  routines: botRoutineService,
  timezone: systemTimezone,
  enabled: botSelfWakeUpsEnabled,
});
