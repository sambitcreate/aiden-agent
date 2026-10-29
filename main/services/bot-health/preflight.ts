// The pre-fire check (spec §5 S1): about 30 minutes before each enabled Bot
// routine fires, run that Bot's health checks once for that fire. A problem
// becomes one issue the person can fix before the fire; a later passing check
// resolves it.
//
// Timers come from the schedule store's `nextRunAt`; nothing here contacts the
// network until a check is actually due (D1).

import type { BotIssueAction } from "../../../renderer/shared/bot-issues.js";
import type { BotHealthCheckResult, BotHealthReport } from "../../../renderer/shared/bot-health.js";
import type { BotIssueService } from "../bot-issues/service.js";
import type { ScheduledTask } from "../types.js";

export const BOT_ROUTINE_PREFLIGHT_LEAD_MS = 30 * 60_000;
export const BOT_ROUTINE_PREFLIGHT_MIN_LEAD_MS = 2 * 60_000;

export interface BotHealthReports {
  set(report: BotHealthReport): void;
  get(botId: string): BotHealthReport | undefined;
}

export function createBotHealthReports(): BotHealthReports & { onChange(listener: (botId: string) => void): () => void } {
  const reports = new Map<string, BotHealthReport>();
  const listeners = new Set<(botId: string) => void>();
  return {
    set(report) {
      reports.set(report.botId, report);
      for (const listener of listeners) listener(report.botId);
    },
    get: (botId) => reports.get(botId),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Issue key for one failed check of one Bot; one card per problem, not per routine. */
export function preflightIssueKey(id: BotHealthCheckResult["id"]): string {
  return `preflight:${id}`;
}

const ISSUE_BODY: Record<BotHealthCheckResult["id"], string> = {
  bot_state: "This Bot needs a working AI model.",
  model: "This Bot's AI model changed. Choose it again in its settings.",
  provider_auth: "Sign in to your AI provider again before it runs.",
  connections: "{label}. Reconnect it so the routine can use it.",
  computer: "This Bot's computer needs attention before it runs.",
};

const ISSUE_ACTION: Record<BotHealthCheckResult["id"], BotIssueAction> = {
  bot_state: { kind: "open_settings", section: "model" },
  model: { kind: "open_settings", section: "model" },
  provider_auth: { kind: "open_settings", section: "providers" },
  connections: { kind: "open_settings", section: "connections" },
  computer: { kind: "open_chat" },
};

/**
 * Raise one issue per failed check and resolve the issues of checks that now
 * pass. A skipped check says nothing, so its issue stays as it is.
 */
export async function reconcileHealthIssues(
  issues: Pick<BotIssueService, "raise" | "resolve">,
  report: BotHealthReport,
  routineName: string | undefined,
  options: { raise?: boolean } = {},
): Promise<void> {
  for (const result of report.results) {
    const dedupeKey = preflightIssueKey(result.id);
    if (result.status === "ok" || result.status === "repaired") {
      await issues.resolve(report.botId, dedupeKey, "fixed");
      continue;
    }
    if (result.status !== "needs_you" || options.raise === false) continue;
    // Bots open in another window is not something a card here can fix.
    if (result.failure?.code === "unavailable") continue;
    await issues.raise({
      botId: report.botId,
      kind: "preflight_failed",
      dedupeKey,
      title: routineName ? `${routineName} may not run` : "This Bot needs you",
      body: ISSUE_BODY[result.id].replace("{label}", result.label),
      ...(report.routineId !== undefined ? { routineId: report.routineId } : {}),
      actions: [ISSUE_ACTION[result.id]],
    });
  }
}

export interface BotRoutinePreflightDependencies {
  routines(): Promise<ScheduledTask[]>;
  run(botId: string, routineId: string, signal: AbortSignal): Promise<BotHealthReport>;
  issues: Pick<BotIssueService, "raise" | "resolve">;
  reports: BotHealthReports;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
}

/** Timers are armed only this far ahead; the periodic rearm picks up the rest. */
export const BOT_ROUTINE_PREFLIGHT_HORIZON_MS = 60 * 60_000;
/** An unattended check never hangs a Bot's check chain. */
export const BOT_ROUTINE_PREFLIGHT_TIMEOUT_MS = 60_000;
const CHECKED_KEPT = 500;

export function createBotRoutinePreflight(dependencies: BotRoutinePreflightDependencies): { rearm(): Promise<void>; dispose(): void } {
  const timers = new Map<string, { timer: { cancel(): void } }>();
  const checked = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let disposed = false;

  function remember(fireKey: string): void {
    checked.add(fireKey);
    if (checked.size > CHECKED_KEPT) checked.delete(checked.values().next().value!);
  }

  async function check(task: ScheduledTask & { botId: string }, fireKey: string): Promise<void> {
    if (disposed || checked.has(fireKey)) return;
    // The timer may wake late (sleep): never check a fire that is past or too close.
    if (task.nextRunAt! - dependencies.now() < BOT_ROUTINE_PREFLIGHT_MIN_LEAD_MS) return;
    remember(fireKey);
    // One check per Bot at a time; a second routine of the same Bot waits.
    const previous = running.get(task.botId) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (disposed) return;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(BOT_ROUTINE_PREFLIGHT_TIMEOUT_MS)]);
      const report = await dependencies.run(task.botId, task.id, signal);
      dependencies.reports.set(report);
      await reconcileHealthIssues(dependencies.issues, report, task.name?.trim() || undefined);
    }).catch((error: unknown) => dependencies.onError?.(error));
    running.set(task.botId, current);
    await current;
    if (running.get(task.botId) === current) running.delete(task.botId);
  }

  return {
    async rearm() {
      if (disposed) return;
      const routines = await dependencies.routines();
      // From here on everything is synchronous, so overlapping rearms (the
      // interval and a wake from sleep) can't leave a timer nothing cancels.
      if (disposed) return;
      const now = dependencies.now();
      // Re-timed on every rearm: a timer armed before sleep may be hours off.
      for (const { timer } of timers.values()) timer.cancel();
      timers.clear();
      for (const task of routines) {
        if (!task.botId || !task.enabled || task.nextRunAt === undefined) continue;
        const fireKey = `${task.id}:${task.nextRunAt}`;
        if (checked.has(fireKey)) continue;
        const untilFire = task.nextRunAt - now;
        // Too close to the fire: checking now would only delay it.
        if (untilFire < BOT_ROUTINE_PREFLIGHT_MIN_LEAD_MS) continue;
        const delay = Math.max(0, untilFire - BOT_ROUTINE_PREFLIGHT_LEAD_MS);
        // Far-off fires wait for a later rearm; this also keeps every delay
        // well under the timer's 24.8-day limit, past which it fires at once.
        if (delay > BOT_ROUTINE_PREFLIGHT_HORIZON_MS) continue;
        const routine = task as ScheduledTask & { botId: string };
        const timer = dependencies.setTimer(() => {
          timers.delete(task.id);
          void check(routine, fireKey);
        }, delay);
        timers.set(task.id, { timer });
      }
    },
    dispose() {
      disposed = true;
      controller.abort();
      for (const { timer } of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
