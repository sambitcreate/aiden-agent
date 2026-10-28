// Main-process wiring for the one Bot delivery funnel: the real per-Bot
// delivery log, the interruption gate, the Mac banner and Telegram.
//
// `main/services` may import electron only from `*-main.ts` modules (the CLI
// bundles the others), so this file owns the `app`, `Notification` and
// navigation seams. Plan B swaps `ALWAYS_NOW_GATE` for the real gate and
// starts the deferred flush.

import { BrowserWindow, Notification, app, logger } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { BOT_ROUTINE_FAILED_PREVIEW } from "../scheduled-bot-routines.js";
import { showScheduledNotification } from "../schedule-notification.js";
import { BOT_DELIVERY_REQUEST_PREFIX, createBotDeliveryFunnel, type BotDeliveryFunnel } from "./funnel.js";
import { createBotDeliveryGate } from "./gate.js";
import { botStore } from "../bot-store.js";
import { resolveBotInterruptions } from "../../../renderer/shared/bots.js";
import { createBotDeliveryLog } from "./log.js";

/** Every Bot's delivery rows, beside that Bot's session (`bots/<dir>/deliveries.json`). */
export const botDeliveryLog = createBotDeliveryLog({ profileDir: () => app.getPath("userData") });

/** The Mac banner's one line, at most 120 characters. */
function bannerLine(text: string): string {
  const line = [...text.replace(/\s+/gu, " ").trim()];
  return line.length > 120 ? `${line.slice(0, 119).join("").trimEnd()}…` : line.join("");
}

let liveFunnel: BotDeliveryFunnel | undefined;

/** The process-wide funnel every Bot message goes through. */
export function botDeliveryFunnel(): BotDeliveryFunnel {
  return (liveFunnel ??= createBotDeliveryFunnel({
    log: botDeliveryLog,
    gate: createBotDeliveryGate({
      settings: async (botId) => resolveBotInterruptions((await botStore.get(botId))?.interruptions),
      // Proactive notifications that reached the person today count; held
      // rows count once they come due, suppressed ones never do.
      sentToday: async (botId, dayStart, now) =>
        (await botDeliveryLog.list(botId)).filter((row) =>
          (row.class === "routine_result" || row.class === "proposal") &&
          row.suppressed !== true && row.deliverAfter >= dayStart && row.deliverAfter <= now).length,
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    botName: async (botId) => (await botStore.get(botId))?.name,
    mac: async (input) => {
      // An issue, a digest, or a held routine result sent from the log is the
      // funnel's own banner, following the hand-off notifier: only while no
      // Aiden window has focus, and clicking it opens the Bot's chat. A throw
      // is reported, never raised: the row is already durable.
      if (input.class !== "routine_result" || input.routineTask === undefined) {
        try {
          if (BrowserWindow.getFocusedWindow() !== null) return;
          if (!Notification.isSupported()) return;
          const notification = new Notification({ title: input.title, body: bannerLine(input.body) });
          notification.on("click", () => {
            void Promise.resolve()
              .then(() => requestAppPath(`/bots/${encodeURIComponent(input.botId)}/chat`))
              .catch((error: unknown) => logger.warn("bots", "Bot issue notification navigation failed.", error));
          });
          notification.show();
        } catch (error) {
          logger.warn("bots", "Bot notification failed.", error);
        }
        return;
      }
      // A routine result keeps the routine's own banner.
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

const FLUSH_INTERVAL_MS = 5 * 60_000;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushInterval: ReturnType<typeof setInterval> | undefined;

/** Send what quiet hours held back once it is due; re-arms for the next held row. */
async function flushHeld(): Promise<void> {
  const next = await botDeliveryFunnel().flush(Date.now()).catch((error: unknown) => {
    logger.warn("bots", "Held Bot messages could not be sent.", error);
    return undefined;
  });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  if (next !== undefined && flushInterval) {
    flushTimer = setTimeout(() => void flushHeld(), Math.max(1_000, next - Date.now()));
    flushTimer.unref?.();
  }
}

/** Started once Bots are open; reads only the local delivery logs. */
export function startBotDeliveryFlush(): void {
  if (flushInterval) return;
  flushInterval = setInterval(() => void flushHeld(), FLUSH_INTERVAL_MS);
  flushInterval.unref?.();
  void flushHeld();
}

export function stopBotDeliveryFlush(): void {
  if (flushInterval) clearInterval(flushInterval);
  if (flushTimer) clearTimeout(flushTimer);
  flushInterval = undefined;
  flushTimer = undefined;
}
