import { configStore } from "../config-store.js";
import { llmClient } from "../llm-client.js";
import { computerUseStatus } from "./status.js";
import { ComputerUseSettingsCoordinator } from "./settings-core.js";
import { geminiLiveService } from "../gemini-live/service-main.js";
import { computerUseSupported } from "./platform.js";
import { revokeComputerUseGrants } from "./access-gate.js";

export const computerUseSettings = new ComputerUseSettingsCoordinator({
  readPersisted: async () =>
    computerUseSupported() && (await configStore.getSettings()).computerUseEnabled === true,
  persist: async (enabled, isCurrent) => {
    if (enabled && !computerUseSupported()) {
      throw new Error("Computer Use is not available on this platform.");
    }
    // Turning the beta off also turns off Always allow, so re-enabling it
    // never silently means "always".
    await configStore.setSettings(
      enabled ? { computerUseEnabled: true } : { computerUseEnabled: false, computerUseAlwaysAllow: false },
      isCurrent,
    );
  },
  setRuntimeEnabled: (enabled) => computerUseStatus.setRuntimeEnabled(enabled),
  cancelComputerUseGenerations: () => {
    revokeComputerUseGrants();
    llmClient.cancelComputerUseGenerations();
    geminiLiveService.revokeComputerUse();
  },
});
