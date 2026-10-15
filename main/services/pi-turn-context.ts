import type { AgentContext, AgentOptions } from "@earendil-works/pi-agent-core";
import { updateGenerationContextOptions, type GenerationContextOptions } from "./generation-context.js";
import { advanceAttendedToolErrorState, recoverAttendedToolErrorContext } from "./assistant/tool-loop-guard.js";

/** Owns preparation and publication of the final context for one generation. */
export function createPiTurnContextPreparation(options: {
  prepareContext(context: AgentContext, signal?: AbortSignal): Promise<AgentContext>;
  generationOptions: GenerationContextOptions;
  attended: boolean;
  onRecovery(): void;
}): NonNullable<AgentOptions["prepareNextTurnWithContext"]> {
  let consecutiveErrorTurns = 0;
  return async ({ toolResults, context }, signal) => {
    let nextContext = await options.prepareContext(context, signal);
    let changed = nextContext !== context;
    if (options.attended) {
      const state = advanceAttendedToolErrorState(consecutiveErrorTurns, toolResults);
      consecutiveErrorTurns = state.consecutiveErrorTurns;
      if (state.shouldStop) {
        options.onRecovery();
        nextContext = recoverAttendedToolErrorContext(nextContext);
        changed = true;
      }
    }
    // Publish only after every mutation, including text-only tool recovery.
    if (changed) {
      updateGenerationContextOptions(options.generationOptions, nextContext);
    }
    return changed ? { context: nextContext } : undefined;
  };
}
