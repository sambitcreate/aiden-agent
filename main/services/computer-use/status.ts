import { configStore } from "../config-store.js";
import { createCuaDriverHost } from "./runtime.js";
import { ComputerUseStatusService } from "./status-core.js";
import { computerUseSupported } from "./platform.js";

export const computerUseStatus = new ComputerUseStatusService({
  isEnabled: async () =>
    computerUseSupported() && (await configStore.getSettings()).computerUseEnabled === true,
  createHost: createCuaDriverHost,
});
