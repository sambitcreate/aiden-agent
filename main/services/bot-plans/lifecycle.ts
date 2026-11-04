import type { BotSessionState } from "../bot-runtime/bot-session-service.js";
import type { BotPlans } from "./plans.js";

/** Lifecycle callbacks stay synchronous so no session queue awaits a plan serial. */
export function createBotPlanLifecycle(deps: {
  plans: Pick<BotPlans, "endRuns">;
  onError?(botId: string, error: unknown): void;
}) {
  const running = new Set<string>();
  const completed = (state: Pick<BotSessionState, "kind">): boolean =>
    state.kind === "idle" || state.kind === "needs_model" || state.kind === "model_error";
  const end = (botId: string, reason: "stopped" | "finished"): void => {
    running.delete(botId);
    try {
      void deps.plans.endRuns(botId, reason).catch(error => deps.onError?.(botId, error));
    } catch (error) { deps.onError?.(botId, error); }
  };
  return {
    stateChanged(botId: string, state: Pick<BotSessionState, "kind">): void {
      if (state.kind === "running") running.add(botId);
      // Before recovery, unopened sessions can look idle or lack a model.
      // Only end an observed run; paused/interrupted states remain recoverable.
      else if (completed(state) && running.has(botId)) end(botId, "finished");
    },
    settled(botId: string, state: Pick<BotSessionState, "kind">): void {
      // Projection settlement represents an actual run, unlike an idle read.
      if (completed(state)) end(botId, "finished");
    },
    stopped: (botId: string): void => end(botId, "stopped"),
    forget: (botId: string): void => { running.delete(botId); },
    clear: (): void => running.clear(),
  };
}
