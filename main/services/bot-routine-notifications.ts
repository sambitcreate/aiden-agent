// The phone feed of Bot routine results (spec 2026-10-09 §11.1), served at
// `GET /bots/routine-notifications?since=`.
//
// A projector over the routine run store: no new state is kept. Phones poll it
// on foreground and post one local notification per run id. The generic
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
import { BOT_ROUTINE_FAILED_PREVIEW, isSilentBotRoutineReply } from "./scheduled-bot-routines.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

export interface BotRoutineNotificationFeedDependencies {
  store: {
    list(): Promise<ScheduledTask[]>;
    runs(taskId: string): Promise<ScheduledRun[]>;
  };
  /** The Bot's current name, or undefined when the Bot is gone. */
  botName(botId: string): Promise<string | undefined>;
  now?(): number;
}

/** A run worth a phone notification: a visible reply or a failure. */
function announced(run: ScheduledRun): "succeeded" | "failed" | undefined {
  if (run.result === "error") return "failed";
  if (run.result === "success" && run.output.trim() && !isSilentBotRoutineReply(run.output)) return "succeeded";
  // silent, skipped (paused or duplicate) and blocked (cancelled by the person) stay quiet.
  return undefined;
}

export function createBotRoutineNotificationFeed(dependencies: BotRoutineNotificationFeedDependencies) {
  const now = dependencies.now ?? Date.now;
  return {
    /** Runs that finished after `since` (epoch ms), newest first, at most 100. */
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
      for (const task of await dependencies.store.list()) {
        if (task.botId === undefined || !task.notify) continue;
        const botName = await nameOf(task.botId);
        if (botName === undefined) continue;
        for (const run of await dependencies.store.runs(task.id)) {
          if (since !== undefined && run.finishedAt <= since) continue;
          const status = announced(run);
          if (status === undefined) continue;
          const preview =
            status === "failed"
              ? BOT_ROUTINE_FAILED_PREVIEW
              : redactRemoteText(run.output, AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATION_PREVIEW_MAX_CHARS) ||
                BOT_ROUTINE_FAILED_PREVIEW;
          notifications.push({
            id: run.id,
            botId: task.botId,
            botName,
            routineId: task.id,
            routineName: task.name.trim() || "Routine",
            status,
            finishedAt: new Date(run.finishedAt).toISOString(),
            preview,
          });
        }
      }
      notifications.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
      return parseAidenRemoteBotRoutineNotificationList({
        notifications: notifications.slice(0, AIDEN_REMOTE_BOT_ROUTINE_NOTIFICATIONS_MAX),
        now: new Date(at).toISOString(),
      });
    },
  };
}

export type BotRoutineNotificationFeed = ReturnType<typeof createBotRoutineNotificationFeed>;
