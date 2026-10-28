// What happens after a Bot routine run fails: retry a passing failure later,
// tell the person at once when only they can fix it, and pause a routine that
// keeps failing the same way instead of failing silently every day.
//
// Pure decisions (`fireOutcomes`, `failureStreak`, `retryPlan`) are separate
// from the effects (`createBotRoutineRecovery`) so each rule is testable alone.

import type { BotIssueService } from "./bot-issues/service.js";
import type { BotIssueAction } from "../../renderer/shared/bot-issues.js";
import type { BotRoutineFailure, BotRoutineFailureKind } from "../../renderer/shared/bot-routine-failure.js";
import type { ScheduledRunTrigger } from "./schedule-service-core.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

export const BOT_ROUTINE_RETRY_DELAYS_MS = [5 * 60_000, 20 * 60_000] as const;
export const BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD = 3;

/** One fire and its retries, judged by its newest (final) attempt. */
export interface FireOutcome { fireKey: string; failed: boolean; kind?: BotRoutineFailureKind }

const RETRY_SUFFIX = /:retry-[12]$/u;

/** Kinds that pass on their own; only these are retried. */
const RETRYABLE = new Set<BotRoutineFailureKind>(["temporary", "stalled"]);

/** Kinds only the person can fix; these raise an issue on the first failure. */
const NEEDS_PERSON = new Set<BotRoutineFailureKind>(["sign_in", "access_changed", "model_setup"]);

/**
 * Newest first. Skipped, silent and blocked runs say nothing about whether the
 * routine works, so they are left out. A fire's retries share its key.
 */
export function fireOutcomes(runs: readonly ScheduledRun[]): FireOutcome[] {
  const seen = new Set<string>();
  const outcomes: FireOutcome[] = [];
  for (const run of runs) {
    if (run.result !== "success" && run.result !== "error") continue;
    const fireKey = run.id.replace(RETRY_SUFFIX, "");
    if (seen.has(fireKey)) continue;
    seen.add(fireKey);
    // A reply that claimed a failed step worked counts as a failed fire.
    const failed = run.result === "error" || run.failure?.kind === "tool_error";
    outcomes.push(failed ? { fireKey, failed, kind: run.failure?.kind ?? "other" } : { fireKey, failed });
  }
  return outcomes;
}

/** How many of the newest fires failed in a row with the same kind. */
export function failureStreak(outcomes: readonly FireOutcome[]): { count: number; kind?: BotRoutineFailureKind } {
  const first = outcomes[0];
  if (!first?.failed) return { count: 0 };
  let count = 0;
  for (const outcome of outcomes) {
    if (!outcome.failed || outcome.kind !== first.kind) break;
    count += 1;
  }
  return { count, kind: first.kind };
}

/**
 * When to try a failed fire again, if at all. `attempt` is how many retries
 * already ran for this fire. A retry is pointless when the routine's next
 * regular fire would come first.
 */
export function retryPlan(input: {
  failure: BotRoutineFailure;
  attempt: 0 | 1 | 2;
  finishedAt: number;
  nextRunAt?: number;
}): { at: number; attempt: 1 | 2 } | undefined {
  const delay = input.attempt === 2 ? undefined : BOT_ROUTINE_RETRY_DELAYS_MS[input.attempt];
  if (!RETRYABLE.has(input.failure.kind) || delay === undefined) return undefined;
  const at = input.finishedAt + delay;
  if (input.nextRunAt !== undefined && input.nextRunAt <= at) return undefined;
  return { at, attempt: (input.attempt + 1) as 1 | 2 };
}

const NEEDS_PERSON_BODY: Partial<Record<BotRoutineFailureKind, string>> = {
  sign_in: "Sign in to your AI provider again so it can run.",
  access_changed: "This Bot's model or access changed. Check its settings.",
  model_setup: "This Bot needs a working AI model.",
};

const STREAK_SENTENCE: Record<BotRoutineFailureKind, string> = {
  temporary: "The AI service wasn't reachable.",
  sign_in: "Its AI provider needs signing in again.",
  access_changed: "This Bot's model or access changed.",
  model_setup: "This Bot needs a working AI model.",
  tool_error: "A step it depends on didn't work.",
  stalled: "It stopped making progress.",
  other: "Something went wrong each time.",
};

const SETTINGS_SECTION: Partial<Record<BotRoutineFailureKind, "providers" | "access" | "model">> = {
  sign_in: "providers",
  access_changed: "access",
  model_setup: "model",
};

/** Issue keys for one routine, shared by raise and resolve. */
export function routineFailedKey(taskId: string): string { return `routine_failed:${taskId}`; }
export function routinePausedKey(taskId: string): string { return `routine_paused:${taskId}`; }

export interface BotRoutineRecoveryDependencies {
  store: {
    runs(taskId: string): Promise<ScheduledRun[]>;
    addRoutineRetry(id: string, retry: { failedRunId: string; attempt: 1 | 2; at: number }): Promise<boolean>;
    clearRoutineRetries(id: string): Promise<void>;
  };
  routines: { pause(botId: string, id: string): Promise<unknown> };
  issues: Pick<BotIssueService, "raise" | "resolve">;
  /** Runs the Bot's health checks after a failure only the person can fix. */
  afterPersonFailure?(botId: string, routineId: string): void;
  now(): number;
}

export interface BotRoutineRecovery {
  afterRun(task: ScheduledTask, run: ScheduledRun, trigger: ScheduledRunTrigger): Promise<void>;
}

export function createBotRoutineRecovery(dependencies: BotRoutineRecoveryDependencies): BotRoutineRecovery {
  return {
    async afterRun(task, run, trigger) {
      const botId = task.botId;
      if (!botId) return;
      const name = task.name?.trim() || "This routine";
      if (run.result === "success" && run.failure?.kind !== "tool_error") {
        await dependencies.issues.resolve(botId, routineFailedKey(task.id), "fixed");
        await dependencies.issues.resolve(botId, routinePausedKey(task.id), "fixed");
        return;
      }
      if (run.result !== "error" && run.failure?.kind !== "tool_error") return;
      const failure: BotRoutineFailure = run.failure ?? { kind: "other", code: "run_failed" };

      const plan = retryPlan({
        failure,
        attempt: trigger.kind === "retry" ? trigger.attempt : 0,
        finishedAt: run.finishedAt,
        ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
      });
      // The fire is not final while a retry is queued; judge it after the retry.
      if (plan && (task.enabled || task.routineSchedule?.kind === "once")) {
        const failedRunId = trigger.kind === "retry" ? trigger.failedRunId : run.id;
        if (await dependencies.store.addRoutineRetry(task.id, { failedRunId, attempt: plan.attempt, at: plan.at })) return;
      }

      const section = SETTINGS_SECTION[failure.kind];
      if (section && NEEDS_PERSON.has(failure.kind)) {
        const actions: BotIssueAction[] = [{ kind: "open_settings", section }];
        await dependencies.issues.raise({
          botId,
          kind: "routine_failed",
          dedupeKey: routineFailedKey(task.id),
          title: `${name} needs you`,
          body: NEEDS_PERSON_BODY[failure.kind]!,
          routineId: task.id,
          actions,
        });
        dependencies.afterPersonFailure?.(botId, task.id);
      }

      if (!task.enabled) return;
      const streak = failureStreak(fireOutcomes(await dependencies.store.runs(task.id)));
      if (streak.count < BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD || !streak.kind) return;
      await dependencies.routines.pause(botId, task.id);
      await dependencies.store.clearRoutineRetries(task.id);
      await dependencies.issues.resolve(botId, routineFailedKey(task.id), "superseded");
      await dependencies.issues.raise({
        botId,
        kind: "routine_paused",
        dedupeKey: routinePausedKey(task.id),
        title: `Paused ${name}`,
        body: `It failed ${BOT_ROUTINE_FAILURE_PAUSE_THRESHOLD} times in a row. ${STREAK_SENTENCE[streak.kind]}`,
        routineId: task.id,
        actions: [{ kind: "resume_routine", routineId: task.id }],
      });
    },
  };
}
