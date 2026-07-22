import { app } from "../../platform.js";
import { resolveCuaDriverInstallation } from "./binary.js";
import { ComputerUseController } from "./controller.js";
import { CuaDriverHost } from "./host.js";

/** Build one lazy, generation-owned Computer Use controller. */
export function createComputerUseController(
  generationId: string,
  supportsImages: boolean,
): ComputerUseController {
  return new ComputerUseController(generationId, supportsImages, async (signal) => {
    const installation = await resolveCuaDriverInstallation(
      {
        platform: process.platform,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      },
      signal,
    );
    return new CuaDriverHost({
      invocation: installation.invocation,
      broker: { appPath: installation.brokerAppPath },
    });
  });
}
