/**
 * Holder that lets Aiden Remote reach the device service without importing
 * it (and its Electron wiring). `main/handlers/devices.ts` registers the
 * provider when the Simulator feature is on; until then every
 * `/simulators` route answers `not_found`.
 */
import {
  AidenRemoteSimulatorRelay,
  type AidenRemoteSimulatorHost,
} from "../aiden-remote-simulators.js";

let provider: (() => AidenRemoteSimulatorHost | null) | null = null;

export function registerSimulatorShareHost(next: (() => AidenRemoteSimulatorHost | null) | null): void {
  provider = next;
  if (!next) simulatorShareRelay.closeAll();
}

export const simulatorShareRelay = new AidenRemoteSimulatorRelay(() => provider?.() ?? null);
