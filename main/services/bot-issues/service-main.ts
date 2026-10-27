// Production wiring of Bot issues: the durable per-Bot file, the Bot
// conversation entry the card is projected from, the one delivery funnel and
// the host actions a card can offer.
//
// `main/services` may import electron only from `*-main.ts` modules (the CLI
// bundles the others), so `app.getPath` and the renderer navigation seam live
// here. The Bot runtime and routine service are imported lazily: the Bot
// session imports this module for its "Needs you" wiring, so a static import
// back would be a cycle.

import type { JsonValue } from "@earendil-works/chord";
import { app, logger } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { botDeliveryFunnel } from "../bot-delivery/funnel-main.js";
import { createBotIssueService } from "./service.js";
import { createBotIssueStore } from "./store.js";

const store = createBotIssueStore({ profileDir: () => app.getPath("userData") });

/**
 * Where an issue's Open settings goes. Model, access and connections are the
 * Bot's own Advanced page; providers is the app's Providers settings.
 */
export function botIssueSettingsPath(botId: string, section: string): string {
  const advanced = `/bots/${encodeURIComponent(botId)}?page=advanced`;
  return section === "providers" ? "/settings?section=providers" : advanced;
}

export const botIssues = createBotIssueService({
  store,
  appendEntry: async (botId, kind, data) => {
    const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
    await (await botSessionRuntime()).appendEntry(botId, kind, data as JsonValue);
  },
  funnel: { deliver: (input) => botDeliveryFunnel().deliver(input) },
  actions: {
    // The routine service's own enable path: read the revision, then turn it
    // back on. Already enabled stays as it is (no needless next-run rewrite).
    resumeRoutine: async (botId, id) => {
      const { botRoutineService } = await import("../scheduled-bot-routines-main.js");
      const routine = (await botRoutineService.list(botId)).find((candidate) => candidate.id === id);
      if (!routine) throw new Error("This routine no longer exists.");
      if (routine.enabled) return;
      await botRoutineService.update({ botId, id, expectedUpdatedAt: routine.updatedAt, enabled: true });
    },
    stopRun: async (botId) => {
      const [{ botSessionRuntime }, { stopWithIntents }, { botTurnIntents }] = await Promise.all([
        import("../bot-runtime/bot-session-main.js"),
        import("../bot-runtime/bot-turn-intents.js"),
        import("../bot-runtime/bot-turn-intents-main.js"),
      ]);
      // Same path as the Stop button, so every open chat says "Stopping" too.
      await stopWithIntents(botTurnIntents, botId, async () => (await botSessionRuntime()).stop(botId));
    },
    // Plan A has no watchdog yet; a later task replaces this with its snooze.
    snoozeStall: () => undefined,
    openSettings: (botId, section) => {
      void requestAppPath(botIssueSettingsPath(botId, section)).catch((error: unknown) =>
        logger.warn("bots", `Bot ${botId} issue settings navigation failed.`, error),
      );
    },
  },
  now: Date.now,
});
