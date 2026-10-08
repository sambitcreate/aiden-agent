export type BotStartupOutcome = "started" | "failed" | "unsupported";

export const BOT_STARTUP_FAILURE_MESSAGE =
  "Bot storage could not be restored safely; the rest of Aiden will remain available for repair.";

/**
 * Starts the Bot application during app launch without ever blocking it. A host without
 * Bots touches nothing. On a host with Bots, a keyring or storage failure is logged and
 * reported, so the rest of Aiden still opens and the person can repair Bots from it.
 */
export async function startBotApplication(deps: {
  supported: boolean;
  initialize: () => Promise<void>;
  trackConnectionSetupFocus: () => void;
  logError: (message: string, error: unknown) => void;
}): Promise<BotStartupOutcome> {
  if (!deps.supported) return "unsupported";
  let outcome: BotStartupOutcome = "started";
  try {
    await deps.initialize();
  } catch (error) {
    deps.logError(BOT_STARTUP_FAILURE_MESSAGE, error);
    outcome = "failed";
  }
  try {
    deps.trackConnectionSetupFocus();
  } catch (error) {
    deps.logError("Connection setup focus tracking could not start.", error);
  }
  return outcome;
}
