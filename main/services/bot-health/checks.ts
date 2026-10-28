// A Bot's health checks, cheapest first (spec §5 S1). The first problem stops
// the network checks after it: there is no point connecting a Bot's services
// when it cannot sign in to its model.
//
// Every check is a port so this module stays free of Electron and the Bot
// runtime; `health-main.ts` supplies the real ones.

import type { BotHealthCheckResult, BotHealthReport } from "../../../renderer/shared/bot-health.js";

export interface BotHealthCheckDeps {
  sessionState(botId: string): Promise<string>;
  /** Admission repairs a model setting that only went stale; "drifted" needs the person. */
  refreshModelBinding(botId: string, signal: AbortSignal): Promise<"current" | "repaired" | "drifted" | "unknown">;
  /** May refresh an expired sign-in, which is the point of checking early. "unknown": couldn't tell (offline). */
  providerAuth(botId: string, signal: AbortSignal): Promise<"ok" | "refreshed" | "signed_out" | "unknown">;
  connections(botId: string, signal: AbortSignal): Promise<{ degraded: Array<{ id: string; label: string }> }>;
  /** Store reads only: a check never starts, clones or downloads a Bot computer. */
  computer(botId: string): Promise<"none" | "ready" | "stale">;
}

const BLOCKING_STATES = new Set(["needs_model", "model_error", "unavailable"]);

export async function runBotHealthChecks(
  botId: string,
  deps: BotHealthCheckDeps,
  options: { trigger: BotHealthReport["trigger"]; routineId?: string; signal: AbortSignal; now(): number },
): Promise<BotHealthReport> {
  const results: BotHealthCheckResult[] = [];
  const report = (): BotHealthReport => ({
    botId,
    checkedAt: options.now(),
    trigger: options.trigger,
    ...(options.routineId !== undefined ? { routineId: options.routineId } : {}),
    results,
  });
  const skipRest = (ids: BotHealthCheckResult["id"][]) => {
    for (const id of ids) results.push({ id, status: "skipped", label: LABELS[id] });
  };

  const state = await deps.sessionState(botId);
  if (state === "paused") {
    results.push({ id: "bot_state", status: "skipped", label: "Paused" });
    skipRest(["model", "provider_auth", "connections", "computer"]);
    return report();
  }
  if (BLOCKING_STATES.has(state)) {
    results.push({
      id: "bot_state",
      status: state === "unavailable" ? "skipped" : "needs_you",
      label: state === "unavailable" ? "Bots are open in another window" : "AI model",
      ...(state === "unavailable" ? {} : { failure: { kind: "model_setup" as const, code: state } }),
    });
    skipRest(["model", "provider_auth", "connections", "computer"]);
    return report();
  }
  results.push({ id: "bot_state", status: "ok", label: "Bot" });

  const model = await settle(() => deps.refreshModelBinding(botId, options.signal));
  // A check that could not tell (offline, a passing error) says nothing.
  if (model === "unknown" || model instanceof Error) {
    results.push({ id: "model", status: "skipped", label: LABELS.model });
    skipRest(["provider_auth", "connections", "computer"]);
    return report();
  }
  if (model === "drifted") {
    results.push({ id: "model", status: "needs_you", label: LABELS.model, failure: { kind: "access_changed", code: "model_changed" } });
    skipRest(["provider_auth", "connections", "computer"]);
    return report();
  }
  results.push({ id: "model", status: model === "repaired" ? "repaired" : "ok", label: LABELS.model });

  const auth = await settle(() => deps.providerAuth(botId, options.signal));
  if (auth === "unknown" || auth instanceof Error) {
    results.push({ id: "provider_auth", status: "skipped", label: LABELS.provider_auth });
    skipRest(["connections", "computer"]);
    return report();
  }
  if (auth === "signed_out") {
    results.push({ id: "provider_auth", status: "needs_you", label: LABELS.provider_auth, failure: { kind: "sign_in", code: "signed_out" } });
    skipRest(["connections", "computer"]);
    return report();
  }
  results.push({ id: "provider_auth", status: auth === "refreshed" ? "repaired" : "ok", label: LABELS.provider_auth });

  const connections = await settle(() => deps.connections(botId, options.signal));
  if (connections instanceof Error) {
    results.push({ id: "connections", status: "skipped", label: LABELS.connections });
  } else if (connections.degraded.length) {
    const names = connections.degraded.map(({ label }) => label).join(", ");
    results.push({
      id: "connections",
      status: "needs_you",
      label: `${names} ${connections.degraded.length === 1 ? "needs" : "need"} reconnecting`,
      failure: { kind: "access_changed", code: "connection_unavailable" },
    });
  } else {
    results.push({ id: "connections", status: "ok", label: LABELS.connections });
  }

  const computer = await settle(() => deps.computer(botId));
  if (computer === "stale") {
    results.push({ id: "computer", status: "needs_you", label: "Bot computer needs attention", failure: { kind: "other", code: "computer_stale" } });
  } else if (computer === "ready") {
    results.push({ id: "computer", status: "ok", label: LABELS.computer });
  } else {
    results.push({ id: "computer", status: "skipped", label: LABELS.computer });
  }
  return report();
}

const LABELS: Record<BotHealthCheckResult["id"], string> = {
  bot_state: "Bot",
  model: "AI model",
  provider_auth: "Sign-in",
  connections: "Connections",
  computer: "Bot computer",
};

async function settle<T>(run: () => Promise<T>): Promise<T | Error> {
  try {
    return await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
