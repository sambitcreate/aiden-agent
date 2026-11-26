import { ipcMain, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { listConfiguredProviders } from "./provider-list-main.js";

/**
 * An earlier "Hide all" hid a provider's future models too. Turn each such
 * rule into the list of models it hides today, so models a provider adds later
 * (a new Gemini release, say) show up in the pickers. Local only: it reads the
 * provider lists Aiden already has and never contacts a provider. Runs at
 * startup, not awaited, never rejects; a failure is retried next launch.
 */
export async function revealFutureProviderModels(): Promise<void> {
  try {
    if (!(await configStore.hidesFutureModels())) return;
    const providers = await listConfiguredProviders();
    const saved = await configStore.revealFutureProviderModels(
      new Map(providers.map((provider) => [provider.id, provider.models])),
    );
    // Open windows re-read settings, so the pickers pick up the change.
    if (saved) ipcMain.broadcast("app:config-externally-changed", {});
  } catch (error) {
    logger.debug("model-visibility", "Could not update hidden-model rules; retrying next launch.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
