// Stop and Resume, shared by every surface that shows a Bot's activity. The
// desktop live projection and the Remote session projectors turn these into
// "Stopping" and "Picking up where it left off" (spec §5), so a Stop pressed
// on the Mac or on a phone reads the same everywhere.
//
// - `stopping`: a person pressed Stop. Listeners ignore it when nothing runs.
// - `stopCancelled`: that Stop failed, so the run goes on and stops reading "Stopping".
// - `resuming`: the session resumed an interrupted turn. Only the session
//   announces it (`onResumed`, inside its per-Bot serialization, and only when
//   that call resumed), never a route ahead of `resume`, so a Resume that did
//   nothing never leaves a stale "Picking up where it left off".

import type { BotLiveProjection } from "./live-projection.js";

export type BotTurnIntent = "stopping" | "stopCancelled" | "resuming";

export interface BotTurnIntents {
  /**
   * Tell every listener, synchronously and in order. A Resume relies on that:
   * it must be heard before the session publishes the resumed run's state.
   */
  announce(botId: string, intent: BotTurnIntent): void;
  onIntent(listener: (botId: string, intent: BotTurnIntent) => void): () => void;
}

export function createBotTurnIntents(): BotTurnIntents {
  const listeners = new Set<(botId: string, intent: BotTurnIntent) => void>();
  return {
    announce(botId, intent) {
      for (const listener of [...listeners]) {
        try {
          listener(botId, intent);
        } catch {
          // A status line that can't update must never block the Stop itself.
        }
      }
    },
    onIntent(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Stop, as every surface presses it: "Stopping" shows at once, and a Stop
 * that fails takes it back before the error reaches the caller.
 */
export async function stopWithIntents<Result>(
  intents: Pick<BotTurnIntents, "announce">,
  botId: string,
  stop: () => Promise<Result>,
): Promise<Result> {
  intents.announce(botId, "stopping");
  try {
    return await stop();
  } catch (error) {
    intents.announce(botId, "stopCancelled");
    throw error;
  }
}

interface BotLiveTurnIntentsDeps {
  intents: Pick<BotTurnIntents, "onIntent">;
  /** The desktop live projection, read per intent (it is created on first use). */
  projection(): Pick<BotLiveProjection, "notifyStopping" | "cancelStopping" | "notifyResuming">;
}

/** Open desktop chats follow Stop and Resume from any surface; the returned function stops it. */
export function wireBotLiveTurnIntents(deps: BotLiveTurnIntentsDeps): () => void {
  return deps.intents.onIntent((botId, intent) => {
    const projection = deps.projection();
    if (intent === "stopping") projection.notifyStopping(botId);
    else if (intent === "stopCancelled") projection.cancelStopping(botId);
    else projection.notifyResuming(botId);
  });
}
