import type { ScheduledRun, ScheduledTask } from "../types.js";
import type { BotIssueService } from "../bot-issues/service.js";
import type { BotEventRoutineStore } from "./store.js";
import { failureStreak, fireOutcomes, BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD } from "../bot-routine-recovery.js";

/**
 * Healing for event routines (spec §5 S2, adapted): a failure only the person
 * can fix raises one card; three failed runs in a row of the same kind turn
 * the routine off with one card. No retries: the next event is the retry.
 */
export async function eventRoutineAfterRun(task: ScheduledTask, run: ScheduledRun, ports: {
  store: Pick<BotEventRoutineStore, "pause">;
  runs(taskId: string): Promise<ScheduledRun[]>;
  issues: Pick<BotIssueService, "raise" | "resolve">;
  changed(botId: string): void;
}): Promise<void> {
  const botId = task.botId;
  if (!botId) return;
  const key = `event_failed:${task.id}`;
  if (run.result === "success" && run.failure?.kind !== "tool_error") {
    await ports.issues.resolve(botId, key, "fixed");
    return;
  }
  if (run.result !== "error" && run.failure?.kind !== "tool_error") return;
  const streak = failureStreak(fireOutcomes(await ports.runs(task.id)));
  const kind = run.failure?.kind ?? "other";
  const needsPerson = kind === "sign_in" || kind === "access_changed" || kind === "model_setup";
  if (streak.count >= BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD) {
    await ports.store.pause(botId, task.id);
    ports.changed(botId);
    await ports.issues.raise({
      botId,
      kind: "routine_paused",
      dedupeKey: key,
      title: `Turned off ${task.name}`,
      body: `It failed ${BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD} times in a row. Turn it back on in the Bot's profile when it's fixed.`,
      routineId: task.id,
      actions: [],
    });
  } else if (needsPerson) {
    await ports.issues.raise({
      botId,
      kind: "routine_failed",
      dedupeKey: key,
      title: `${task.name} needs you`,
      body: kind === "sign_in" ? "Sign in to your AI provider again so it can run." : kind === "model_setup" ? "This Bot needs a working AI model." : "This Bot's model or access changed. Check its settings.",
      routineId: task.id,
      actions: [{ kind: "open_settings", section: kind === "sign_in" ? "providers" : kind === "model_setup" ? "model" : "access" }],
    });
  }
}
