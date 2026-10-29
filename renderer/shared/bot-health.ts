// One health status per Bot, and the check results behind it (spec §5 S1, S3).

import type { BotRoutineFailure } from "./bot-routine-failure.js";

export type BotHealthCheckId = "bot_state" | "model" | "provider_auth" | "connections" | "computer";

export interface BotHealthCheckResult {
  id: BotHealthCheckId;
  status: "ok" | "repaired" | "needs_you" | "skipped";
  failure?: BotRoutineFailure;
  /** Plain words for the person, e.g. "AI model" or "Gmail needs reconnecting". */
  label: string;
}

export interface BotHealthReport {
  botId: string;
  checkedAt: number;
  trigger: "pre_fire" | "manual" | "after_failure";
  routineId?: string;
  results: BotHealthCheckResult[];
}

export type BotHealthStatus = "ok" | "needs_you" | "paused";

export const BOT_HEALTH_CHANNELS = {
  check: "bots:health:check",
  report: "bots:health:report",
} as const;

/** Paused wins over everything; then anything that needs the person. */
export function botHealthStatus(input: {
  paused: boolean;
  sessionState: string;
  openIssues: number;
  report?: BotHealthReport;
}): BotHealthStatus {
  if (input.paused || input.sessionState === "paused") return "paused";
  if (input.openIssues > 0) return "needs_you";
  if (input.sessionState === "needs_model" || input.sessionState === "model_error") return "needs_you";
  if (input.report?.results.some((result) => result.status === "needs_you")) return "needs_you";
  return "ok";
}

/** The words a health status reads as. */
export const BOT_HEALTH_LABELS: Record<BotHealthStatus, string> = {
  ok: "Ready",
  needs_you: "Needs you",
  paused: "Paused",
};
