// What a pause does outside the Bot's harness once its running turn is closed
// (`afterPaused`, plan §7). Steps run in order, so whatever a step stops
// stops after the run did. A `background` step is started in that order but
// not waited for: stopping the Bot's computer gracefully can take half a
// minute, and the person's Pause answers at once instead.

export interface BotPauseStep {
  run(botId: string): void | Promise<void>;
  /** Started once the steps before it finish, but never waited for; the pause answers without it. */
  background?: boolean;
}

/** The `afterPaused` hook for `steps`. A step that fails is reported, and the steps after it still run. */
export function runBotPauseSteps(
  steps: readonly BotPauseStep[],
  onError: (botId: string, error: unknown) => void,
): (botId: string) => Promise<void> {
  return async (botId) => {
    for (const step of steps) {
      const running = Promise.resolve()
        .then(() => step.run(botId))
        .catch((error: unknown) => {
          try {
            onError(botId, error);
          } catch {
            // Reporting is best-effort; it never stops the pause.
          }
        });
      if (!step.background) await running;
    }
  };
}
