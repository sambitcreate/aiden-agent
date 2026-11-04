import type { BotSessionState } from "../bot-runtime/bot-session-service.js";
import type { BotPlans } from "./plans.js";

/** Lifecycle callbacks stay synchronous so no session queue awaits a plan serial. */
export function createBotPlanLifecycle(deps: {
  plans: Pick<BotPlans, "endRuns">;
  onError?(botId: string, error: unknown): void;
}) {
  const running = new Set<string>();
  const end = (botId: string, reason: "stopped" | "finished"): void => {
    running.delete(botId);
    try {
      void deps.plans.endRuns(botId, reason).catch(error => deps.onError?.(botId, error));
    } catch (error) { deps.onError?.(botId, error); }
  };
  return {
    stateChanged(botId: string, state: Pick<BotSessionState, "kind">): void {
      if (state.kind === "running") running.add(botId);
      // Before recovery, an unopened session can look idle. It has not ended
      // a run that this process observed, so preserve its saved approval.
      else if (state.kind === "idle" && running.has(botId)) end(botId, "finished");
    },
    settled(botId: string, state: Pick<BotSessionState, "kind">): void {
      // Projection settlement represents an actual run, unlike an idle read.
      if (state.kind === "idle") end(botId, "finished");
    },
    stopped: (botId: string): void => end(botId, "stopped"),
    forget: (botId: string): void => { running.delete(botId); },
    clear: (): void => running.clear(),
  };
}
