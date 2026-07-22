import type { CuaDriverInvocation } from "./contract.js";
import { CuaDriverError } from "./contract.js";
import {
  CuaDriverHost,
  type CuaDriverHostOptions,
} from "./host.js";
import { verifyCuaDriverBridgeProcess } from "./binary.js";

export interface CuaDriverHostTestHooks {
  brokerInvocation: CuaDriverInvocation;
  verifyBridgeProcess?: typeof verifyCuaDriverBridgeProcess;
}

/**
 * Node-only harness for the faithful fake driver. This module is imported by
 * tests, never by Aiden's Electron entry graph; even an accidental packaged
 * import fails before it can disable live process verification.
 */
export class TestCuaDriverHost extends CuaDriverHost {
  constructor(
    options: CuaDriverHostOptions,
    private readonly hooks: CuaDriverHostTestHooks,
  ) {
    if (typeof process.versions.electron === "string") {
      throw new CuaDriverError(
        "broker_required",
        "Computer Use test hooks cannot run inside Electron.",
      );
    }
    super(options);
  }

  protected override directBrokerInvocation(): CuaDriverInvocation {
    return this.hooks.brokerInvocation;
  }

  protected override verifySpawnedBridge(
    pid: number,
    expectedExecutable: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.hooks.verifyBridgeProcess?.(pid, expectedExecutable, signal) ?? Promise.resolve();
  }
}
