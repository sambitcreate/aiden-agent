import { configStore } from "../config-store.js";
import { llmClient } from "../llm-client.js";
import { computerUseStatus } from "./status.js";
import { ComputerUseSettingsCoordinator } from "./settings-core.js";

export const computerUseSettings = new ComputerUseSettingsCoordinator({
  readPersisted: async () => (await configStore.getSettings()).computerUseEnabled === true,
  persist: async (enabled, isCurrent) => {
    await configStore.setSettings({ computerUseEnabled: enabled }, isCurrent);
  },
  setRuntimeEnabled: (enabled) => computerUseStatus.setRuntimeEnabled(enabled),
  cancelComputerUseGenerations: () => llmClient.cancelComputerUseGenerations(),
});
