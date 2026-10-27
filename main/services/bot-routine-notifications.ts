// The phone feed of Bot routine results (spec 2026-10-09 §11.1), served at
// `GET /bots/routine-notifications?since=`.
//
// A view over the per-Bot delivery log: a row is written when a routine result
// or failure is delivered, and only rows that are due are served (quiet hours
// hold a row until it is ready). Silent, skipped and blocked runs never reach
// the delivery funnel, so they never appear here. The generic
// `/scheduled-tasks/notifications` feed keeps excluding Bot tasks, so older
// phones see no change.

import {
  AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATION_PREVIEW_MAX_CHARS,
  AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATIONS_MAX,
  parseAidenRemoteBotRoutineNotificationList,
  type AidenRemoteBotRoutineNotification,
  type AidenRemoteBotRoutineNotificationList,
} from "./aiden-remote-protocol.js";
import { redactRemoteText } from "./aiden-remote-bot-session.js";
import type { BotDeliveryLog } from "./bot-delivery/log.js";
import { BOT_ROUTINE_FAILED_PREVIEW } from "./scheduled-bot-routines.js";

export interface BotNotificationFeedDependencies {
  log: BotDeliveryLog;
  /** The Bot's current name, or undefined when the Bot is gone. */
  botName(botId: string): Promise<string | undefined>;
  now?(): number;
}

export function createBotNotificationFeed(dependencies: BotNotificationFeedDependencies) {
  const now = dependencies.now ?? Date.now;
  return {
    /** Delivered routine results due after `since` (epoch ms), newest first, at most 100. */
    async list(since: number | undefined): Promise<AidenRemoteBotRoutineNotificationList> {
      const at = now();
      const names = new Map<string, Promise<string | undefined>>();
      const nameOf = (botId: string) => {
        let name = names.get(botId);
        if (name === undefined) {
          name = dependencies.botName(botId).catch(() => undefined);
          names.set(botId, name);
        }
        return name;
      };
      const notifications: AidenRemoteBotRoutineNotification[] = [];
      for (const row of await dependencies.log.due(since, at)) {
        // The routine feed carries routine results only; other classes join it
        // when phones learn their `kind`.
        if (row.class !== "routine_result" || row.routineId === undefined) continue;
        const botName = await nameOf(row.botId);
        if (botName === undefined) continue;
        const status = row.status === "failed" ? "failed" : "succeeded";
        const preview =
          status === "failed"
            ? BOT_ROUTINE_FAILED_PREVIEW
            : redactRemoteText(row.body, AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATION_PREVIEW_MAX_CHARS) ||
              BOT_ROUTINE_FAILED_PREVIEW;
        notifications.push({
          // The routine firing, so a phone posts one local notification per fire.
          id: row.requestId ?? row.id,
          botId: row.botId,
          botName,
          routineId: row.routineId,
          routineName: [...row.title.trim()].slice(0, 120).join("") || "Routine",
          status,
          finishedAt: new Date(row.createdAt).toISOString(),
          preview,
        });
      }
      return parseAidenRemoteBotRoutineNotificationList({
        notifications: notifications.slice(0, AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATIONS_MAX),
        now: new Date(at).toISOString(),
      });
    },
  };
}

export type BotNotificationFeed = ReturnType<typeof createBotNotificationFeed>;
