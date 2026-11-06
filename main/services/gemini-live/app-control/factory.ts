import { aidenAppNavigation } from "../../aiden-app-navigation.js";
import { aidenLivePreferences } from "../../../../renderer/shared/aiden-live-settings.js";
import type { LiveToolProviderFactory } from "../live-tool-providers.js";
import { AidenAppControlProvider, type AidenWindowPort } from "./provider.js";

/**
 * Live's moves through Aiden's own window, on every platform. Null when the
 * user turned off "Let Live move through Aiden" or the window is gone.
 */
export function createAidenAppControlToolFactory(
  createPort: (owner: Parameters<LiveToolProviderFactory>[0]["owner"]) => Promise<AidenWindowPort | null> = async (owner) =>
    (await import("./electron-port.js")).createElectronAidenWindowPort(owner),
): LiveToolProviderFactory {
  return async (input, settings) => {
    if (!aidenLivePreferences(settings).appControl || input.owner.isDestroyed()) return null;
    const port = await createPort(input.owner);
    if (!port) return null;
    return new AidenAppControlProvider({
      port,
      renderer: input.renderer,
      open: (place, signal) => aidenAppNavigation.open(place, input.owner, signal),
    });
  };
}

export const aidenAppControlToolFactory = createAidenAppControlToolFactory();
