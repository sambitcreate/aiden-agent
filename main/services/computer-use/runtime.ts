import { app } from "../../platform.js";
import { resolveCuaDriverInstallation } from "./binary.js";
import { ComputerUseController } from "./controller.js";
import { CuaDriverHost } from "./host.js";
import { computerUsePlatformSupported, CuaDriverError } from "./contract.js";

function currentSystemVersion(): string {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string };
  return electronProcess.getSystemVersion?.() ?? "0";
}

/**
 * Cheap, synchronous checks for an OS or build where Computer Use can never
 * run: the broker needs macOS 14.4+, and the driver bridge only verifies
 * inside a signed packaged app. Readiness (permissions, driver integrity) is
 * probed only when a call needs it.
 */
export function computerUseCanEverRun(): boolean {
  return (
    app.isPackaged && computerUsePlatformSupported(process.platform, currentSystemVersion())
  );
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
      // A packaged app keeps its bundled helpers even with an isolated dev profile.
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
