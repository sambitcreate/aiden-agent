import path from "node:path";
import { app, logger } from "../../platform.js";
import { botMessagingEnabled } from "../../../renderer/shared/bot-messages.js";
import { botStore } from "../bot-store.js";
import { configStore } from "../config-store.js";
import { isBotPaused } from "../bot-pause-main.js";
import { botApprovals } from "../bot-runtime/bot-approvals-main.js";
import { botSessionRuntime, onBotSessionStateChange } from "../bot-runtime/bot-session-main.js";
import { botDeliveryFunnel } from "../bot-delivery/funnel-main.js";
import { createBotMessageLedger } from "./ledger.js";
import { createBotMessageCourier, type BotMessageCourier, type BotRosterEntry } from "./courier.js";
export async function botMessageRoster(): Promise<readonly BotRosterEntry[]> {
  return Promise.all(
    (await botStore.list()).map(async (bot) => ({
      id: bot.id,
      name: bot.name,
      purpose: bot.description ?? "",
      acceptsMessages: bot.acceptsBotMessages !== false,
      sendsMessages: bot.messagesOtherBots !== false,
      ...((await isBotPaused(bot.id)) ? { unavailable: "bot_paused" as const } : {}),
    })),
  );
}
let courier: BotMessageCourier | undefined;
export function botMessages(): BotMessageCourier {
  return (courier ??= createBotMessageCourier({
    ledger: createBotMessageLedger({
      file: () => path.join(app.getPath("userData"), "bots", "bot-messages.json"),
      now: Date.now,
    }),
    // These adapters are used only by external courier work, never by post().
    sessions: {
      send: async (...args) => (await botSessionRuntime()).send(...args),
      awaitReply: async (...args) => (await botSessionRuntime()).awaitReply(...args),
      markSilent: async (...args) => (await botSessionRuntime()).markSilent(...args),
      appendEntry: async (...args) => (await botSessionRuntime()).appendEntry(...args),
      state: async (...args) => (await botSessionRuntime()).state(...args),
      submissionForRequest: async (...args) => (await botSessionRuntime()).submissionForRequest(...args),
    },
    roster: botMessageRoster,
    enabled: async () => botMessagingEnabled(await configStore.getSettings()),
    approvals: botApprovals,
    onStateChange: (listener) => onBotSessionStateChange(listener),
    deliver: (input) => botDeliveryFunnel().deliver(input),
    now: Date.now,
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    },
    report: (error) => logger.warn("bots", "Bot message courier failed.", error),
  }));
}
export async function disposeBotMessages(): Promise<void> {
  const current = courier;
  courier = undefined;
  await current?.dispose();
}
