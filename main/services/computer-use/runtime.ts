import { app } from "../../platform.js";
import { resolveCuaDriverInstallation } from "./binary.js";
import { ComputerUseController } from "./controller.js";
import { CuaDriverHost } from "./host.js";
import { computerUsePlatformSupported, CuaDriverError } from "./contract.js";

function currentSystemVersion(): string {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string };
  return electronProcess.getSystemVersion?.() ?? "0";
}

/** Resolve and construct one authenticated, generation- or probe-owned driver host. */
export async function createCuaDriverHost(signal: AbortSignal): Promise<CuaDriverHost> {
  if (!computerUsePlatformSupported(process.platform, currentSystemVersion())) {
    throw new CuaDriverError(
      "unsupported_platform",
      "Aiden Computer Use requires macOS 14.4 or newer.",
    );
  }
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
}

/** Build one lazy, generation-owned Computer Use controller. */
export function createComputerUseController(
  generationId: string,
  supportsImages: boolean,
): ComputerUseController {
  return new ComputerUseController(generationId, supportsImages, createCuaDriverHost);
}
