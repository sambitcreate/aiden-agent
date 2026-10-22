// Loads the on-device voice model before the first dictation, so pressing the
// hotkey or the composer mic does not pay the model load (about a second for
// Parakeet). Runs at launch and when Settings changes which model voice would
// use. The live dependencies load lazily, which keeps this module importable
// in tests.

import { localVoicePreloadEnabled } from "../../renderer/shared/voice-preferences.js";
import type { VoiceProviderResolution } from "../../renderer/shared/voice-provider.js";
import type { AppSettings } from "./types.js";

export interface LocalVoicePreloadDeps {
  /** The "Load in advance" setting. */
  enabled(): Promise<boolean>;
  /** Cheap disk check, so a Mac without on-device voice never resolves providers or reads keys. */
  hasLocalModel(): Promise<boolean>;
  resolve(): Promise<VoiceProviderResolution>;
  warm(modelId: string): Promise<void>;
  log?(message: string, error?: unknown): void;
}

/**
 * Returns a request function. Requests made while a preload runs coalesce into
 * one more pass, so the last setting change always wins and a burst of
 * changes never queues a load per change.
 */
export function createLocalVoicePreloader(deps: LocalVoicePreloadDeps): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;

  async function preloadOnce(): Promise<void> {
    if (!(await deps.enabled()) || !(await deps.hasLocalModel())) return;
    const resolution = await deps.resolve();
    // Cloud providers and missing setup have nothing to load.
    if (resolution.kind !== "ready" || resolution.provider !== "local") return;
    await deps.warm(resolution.modelId);
  }

  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await preloadOnce();
          } catch (error) {
            // Best effort: the next dictation reports an actionable error.
            deps.log?.("Could not load the on-device voice model in advance.", error);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** Whether a saved settings change can change which on-device model to load. */
export function localVoicePreloadRelevant(patch: Partial<AppSettings>): boolean {
  return (
    patch.localVoiceModel !== undefined ||
    patch.voiceProvider !== undefined ||
    patch.localVoicePreload === true
  );
}

export const preloadLocalVoice = createLocalVoicePreloader({
  enabled: async () => {
    const { configStore } = await import("./config-store.js");
    return localVoicePreloadEnabled((await configStore.getSettings()).localVoicePreload);
  },
  hasLocalModel: async () =>
    (await import("./local-speech-models.js")).listModels().some((model) => model.installed),
  resolve: async () => (await import("./voice-provider-resolution.js")).resolveVoiceProviderNow(),
  warm: async (modelId) => (await import("./local-speech.js")).warmLocalVoice(modelId),
  log: (message, error) => {
    void import("../platform.js").then(({ logger }) => logger.warn("local-speech", message, error));
  },
});
