// Main-process wiring for the one Bot delivery funnel: the real per-Bot
// delivery log, the interruption gate, the Mac banner and Telegram.
//
// `main/services` may import electron only from `*-main.ts` modules (the CLI
// bundles the others), so this file owns the `app`, `Notification` and
// navigation seams. Plan B swaps `ALWAYS_NOW_GATE` for the real gate and
// starts the deferred flush.

import { Notification, app, logger } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { BOT_ROUTINE_FAILED_PREVIEW } from "../scheduled-bot-routines.js";
import { showScheduledNotification } from "../schedule-notification.js";
import { ALWAYS_NOW_GATE, BOT_DELIVERY_REQUEST_PREFIX, createBotDeliveryFunnel, type BotDeliveryFunnel } from "./funnel.js";
import { createBotDeliveryLog } from "./log.js";

/** Every Bot's delivery rows, beside that Bot's session (`bots/<dir>/deliveries.json`). */
export const botDeliveryLog = createBotDeliveryLog({ profileDir: () => app.getPath("userData") });

let liveFunnel: BotDeliveryFunnel | undefined;

/** The process-wide funnel every Bot message goes through. */
export function botDeliveryFunnel(): BotDeliveryFunnel {
  return (liveFunnel ??= createBotDeliveryFunnel({
    log: botDeliveryLog,
    gate: ALWAYS_NOW_GATE,
    mac: async (input) => {
      // A routine result keeps the routine's own banner. Other classes bring
      // their own surface.
      if (input.routineTask === undefined) return;
      showScheduledNotification(input.routineTask, input.body, input.botId, {
        isSupported: () => Notification.isSupported(),
        create: (options) => new Notification(options),
        openChat: async (botId) => {
          // The routine posted into the Bot's chat, not its Profile.
          await requestAppPath(`/bots/${encodeURIComponent(botId)}/chat`);
        },
        onError: (stage) => logger.warn("bots", `Bot delivery notification ${stage} failed.`),
      });
    },
    telegram: async (input) => {
      const { telegramService } = await import("../telegram/telegram-service.js");
      await telegramService.deliverBotRoutineResult({
        botId: input.botId,
        requestId: input.requestId ?? `${BOT_DELIVERY_REQUEST_PREFIX}${input.dedupeKey}`,
        routineName: input.title,
        // A failure keeps its detail on the Mac and in the run record; outside
        // the Mac it is the fixed line, as it always was.
        text: input.status === "failed" ? BOT_ROUTINE_FAILED_PREVIEW : input.body,
      });
    },
    now: Date.now,
  }));
}
