import { configStore } from "../config-store.js";
import { llmClient } from "../llm-client.js";
import { computerUseStatus } from "./status.js";
import { ComputerUseSettingsCoordinator } from "./settings-core.js";
import { computerUseSupported } from "./platform.js";

export const computerUseSettings = new ComputerUseSettingsCoordinator({
  readPersisted: async () =>
    computerUseSupported() && (await configStore.getSettings()).computerUseEnabled === true,
  persist: async (enabled, isCurrent) => {
    if (enabled && !computerUseSupported()) {
      throw new Error("Computer Use is not available on Linux.");
    }
    await configStore.setSettings({ computerUseEnabled: enabled }, isCurrent);
  },
  setRuntimeEnabled: (enabled) => computerUseStatus.setRuntimeEnabled(enabled),
  cancelComputerUseGenerations: () => llmClient.cancelComputerUseGenerations(),
});
