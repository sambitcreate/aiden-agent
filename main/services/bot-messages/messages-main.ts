import path from "node:path";
import { app, logger } from "../../platform.js";
import { botMessagingEnabled } from "../../../renderer/shared/bot-messages.js";
import { botStore } from "../bot-store.js";
import { configStore } from "../config-store.js";
import { isBotPaused } from "../bot-pause-main.js";
import { botApprovals } from "../bot-runtime/bot-approvals-main.js";
import { botSessionRuntime, onBotSessionStateChange } from "../bot-runtime/bot-session-main.js";
import { botDeliveryFunnel } from "../bot-delivery/funnel-main.js";
import { botCapabilityStore } from "../bot-capability-services-main.js";
import { spending } from "../spending-main.js";
import { createBotMessageLifecycle } from "./lifecycle.js";
import { projectBotMessageRoster } from "./roster.js";
import { createBotMessageLedger } from "./ledger.js";
import { createBotMessageCourier, type BotMessageCourier, type BotRosterEntry } from "./courier.js";
export async function botMessageRoster(): Promise<readonly BotRosterEntry[]> {
  return projectBotMessageRoster(await botStore.list(), {
    paused: isBotPaused,
    hasModel: async (id) => (await botCapabilityStore.getBotModelAuthority(id)) !== undefined,
    spendingRefusal: (id, name) => spending.refusal({ kind: "bot", id }, name),
    report: (id, error) => logger.warn("bots", `Bot ${id} messaging availability is unreadable.`, error),
  });
}
const courier = createBotMessageLifecycle({
  report: (error) => logger.warn("bots", "Bot messaging could not start; other Bot features remain available.", error),
  create: () =>
    createBotMessageCourier({
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
      awaitMessageTaskSettlement: async (...args) => (await botSessionRuntime()).awaitMessageTaskSettlement(...args),
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
    }),
});
export function botMessages(): BotMessageCourier {
  return courier;
}
export async function disposeBotMessages(): Promise<void> {
  await courier.dispose();
}
