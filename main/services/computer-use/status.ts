import { configStore } from "../config-store.js";
import { createCuaDriverHost } from "./runtime.js";
import { ComputerUseStatusService } from "./status-core.js";

export const computerUseStatus = new ComputerUseStatusService({
  isEnabled: async () => (await configStore.getSettings()).computerUseEnabled === true,
  createHost: createCuaDriverHost,
});
