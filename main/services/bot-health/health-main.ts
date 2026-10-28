// Production wiring of Bot health: the real checks, the pre-fire timers, the
// last report per Bot, and the re-check after a failure only the person can
// fix. Started once Bots are open (bot-session-main), never during onboarding.

import { logger, powerMonitor } from "../../platform.js";
import type { BotHealthReport } from "../../../renderer/shared/bot-health.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { botCapabilityCatalog, botCapabilityStore } from "../bot-capability-services-main.js";
import { setBotRoutineAfterPersonFailure } from "../bot-routine-recovery-main.js";
import { scheduleStore } from "../schedule-store.js";
import { providerFailureFromLegacyPiMessage } from "../provider-failure.js";
import { runBotHealthChecks, type BotHealthCheckDeps } from "./checks.js";
import { createBotHealthReports, createBotRoutinePreflight, reconcileHealthIssues } from "./preflight.js";

/** How often the timers are re-read from the schedule (local file only). */
const REARM_INTERVAL_MS = 5 * 60_000;

export const botHealthReports = createBotHealthReports();

const checks: BotHealthCheckDeps = {
  sessionState: async (botId) => {
    const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
    return (await (await botSessionRuntime()).state(botId)).kind;
  },
  refreshModelBinding: async (botId) => {
    const { probeBotAdmission } = await import("../bot-runtime/bot-session-main.js");
    try {
      await probeBotAdmission(botId);
      return "current";
    } catch (error) {
      // Only a real authority drift is the person's to fix; anything else is unknown.
      return error instanceof Error && error.name === "BotRuntimeAuthorityError" ? "drifted" : "unknown";
    }
  },
  providerAuth: async (botId, signal) => {
    const [{ probeBotAdmission }, { preflightBotModelAuth }] = await Promise.all([
      import("../bot-runtime/bot-session-main.js"),
      import("../model-runtime.js"),
    ]);
    let target: { providerId: string; modelId: string };
    try {
      target = await probeBotAdmission(botId);
    } catch {
      return "unknown";
    }
    try {
      await preflightBotModelAuth(target.providerId, target.modelId, signal);
      return "ok";
    } catch (error) {
      if (signal.aborted) throw error;
      // Signed out only when the credential is gone or refused; offline is unknown.
      const message = error instanceof Error ? error.message : String(error);
      if (/no longer configured/iu.test(message)) return "signed_out";
      return providerFailureFromLegacyPiMessage(message)?.category === "authentication" ? "signed_out" : "unknown";
    }
  },
  // Only a Custom grant names the connections a Bot relies on. Under Full
  // access any configured server counts, so one broken server is not a reason
  // to bother the person about every routine.
  connections: async (botId, signal) => {
    const binding = await botCapabilityStore.getBotBinding(botId);
    if (!binding) return { degraded: [] };
    const reconciled = await botCapabilityCatalog.reconcile(binding, { audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, signal });
    const labels = new Map(binding.connections.map(({ option }) => [option.id, option.label] as const));
    return {
      degraded: reconciled.issues
        .filter(({ group, selectionId }) => group === "connection" && selectionId !== undefined)
        .map(({ selectionId }) => ({ id: selectionId!, label: labels.get(selectionId!) ?? "A connection" })),
    };
  },
  computer: async (botId) => {
    const { botComputers, botComputersEnabled } = await import("../bot-computers/bot-computers-main.js");
    if (!botComputersEnabled()) return "none";
    const status = await botComputers().host.computer(botId);
    if (!status) return "none";
    return status.state === "stale" ? "stale" : "ready";
  },
};

async function issues() {
  return (await import("../bot-issues/service-main.js")).botIssues;
}

/** Run a Bot's checks now and update its issues. Used by Check now and after failures. */
export async function checkBotHealth(
  botId: string,
  trigger: BotHealthReport["trigger"],
  routineId?: string,
): Promise<BotHealthReport> {
  const report = await runBotHealthChecks(botId, checks, {
    trigger,
    ...(routineId !== undefined ? { routineId } : {}),
    signal: AbortSignal.timeout(60_000),
    now: Date.now,
  });
  botHealthReports.set(report);
  const routineName = routineId ? (await scheduleStore.get(routineId))?.name : undefined;
  // After a failure the routine's own card already says what's wrong: only
  // clear what now passes, never raise a second card for the same cause.
  await reconcileHealthIssues(await issues(), report, routineName?.trim() || undefined, { raise: trigger !== "after_failure" });
  return report;
}

let preflight: ReturnType<typeof createBotRoutinePreflight> | undefined;
let rearmTimer: ReturnType<typeof setInterval> | undefined;
let onResume: (() => void) | undefined;

export function startBotHealth(): void {
  if (preflight) return;
  void import("../bot-delivery/funnel-main.js").then(({ startBotDeliveryFlush }) => startBotDeliveryFlush());
  void import("../bot-routine-events/sources-main.js").then(({ startBotEventRoutines }) => startBotEventRoutines());
  preflight = createBotRoutinePreflight({
    routines: () => scheduleStore.list(),
    run: (botId, routineId, signal) => runBotHealthChecks(botId, checks, { trigger: "pre_fire", routineId, signal, now: Date.now }),
    issues: {
      raise: async (input) => (await issues()).raise(input),
      resolve: async (botId, key, resolution) => (await issues()).resolve(botId, key, resolution),
    },
    reports: botHealthReports,
    now: Date.now,
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
    onError: (error) => logger.warn("bots", "A Bot pre-fire check failed.", error),
  });
  const rearm = () => void preflight?.rearm().catch((error: unknown) => logger.warn("bots", "Could not arm Bot pre-fire checks.", error));
  rearm();
  rearmTimer = setInterval(rearm, REARM_INTERVAL_MS);
  rearmTimer.unref?.();
  onResume = rearm;
  powerMonitor.on("resume", onResume);
  setBotRoutineAfterPersonFailure((botId, routineId) => {
    void checkBotHealth(botId, "after_failure", routineId).catch((error: unknown) =>
      logger.warn("bots", `Bot ${botId} re-check after a failure did not finish.`, error));
  });
}

export function stopBotHealth(): void {
  void import("../bot-delivery/funnel-main.js").then(({ stopBotDeliveryFlush }) => stopBotDeliveryFlush());
  void import("../bot-routine-events/sources-main.js").then(({ stopBotEventRoutines }) => stopBotEventRoutines());
  preflight?.dispose();
  preflight = undefined;
  if (rearmTimer) clearInterval(rearmTimer);
  rearmTimer = undefined;
  if (onResume) powerMonitor.removeListener("resume", onResume);
  onResume = undefined;
  setBotRoutineAfterPersonFailure(undefined);
}
