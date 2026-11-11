import { aidenAppNavigation } from "../../aiden-app-navigation.js";
import { aidenLivePreferences } from "../../../../renderer/shared/aiden-live-settings.js";
import type { AppSettings } from "../../types.js";
import type { LiveToolProviderFactory } from "../live-tool-providers.js";
import { AidenAppControlProvider, type AidenWindowPort } from "./provider.js";

type Owner = Parameters<LiveToolProviderFactory>[0]["owner"];

/**
 * Live's moves through Aiden's own window, on every platform. Null when the
 * user turned off "Let Live move through Aiden" or the window is gone. The
 * switch is read again on every call, so turning it off mid-session stops
 * the tools at once.
 */
export function createAidenAppControlToolFactory(
  createPort: (owner: Owner) => Promise<AidenWindowPort | null> = async (owner) =>
    (await import("./electron-port.js")).createElectronAidenWindowPort(owner),
  readSettings: () => Promise<AppSettings> = async () =>
    (await import("../../config-store.js")).configStore.getSettings(),
): LiveToolProviderFactory {
  return async (input, settings) => {
    if (!aidenLivePreferences(settings).appControl || input.owner.isDestroyed()) return null;
    const port = await createPort(input.owner);
    if (!port) return null;
    return new AidenAppControlProvider({
      port,
      renderer: input.renderer,
      open: (place, signal) => aidenAppNavigation.open(place, input.owner, signal),
      enabled: async () => aidenLivePreferences(await readSettings()).appControl,
    });
  };
}

export const aidenAppControlToolFactory = createAidenAppControlToolFactory();
