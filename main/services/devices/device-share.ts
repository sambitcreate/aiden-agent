/**
 * Holder that lets Aiden Remote reach the device service without importing
 * it (and its Electron wiring). `main/handlers/devices.ts` registers the
 * provider when the Simulator feature is on; until then every
 * `/simulators` route answers `not_found`.
 */
import {
  AidenRemoteSimulatorRelay,
  type AidenRemoteSimulatorAudience,
  type AidenRemoteSimulatorHost,
} from "../aiden-remote-simulators.js";

type ShareHostProvider = (audience: AidenRemoteSimulatorAudience) => AidenRemoteSimulatorHost | null;

let provider: ShareHostProvider | null = null;

export function registerSimulatorShareHost(next: ShareHostProvider | null): void {
  provider = next;
  if (!next) simulatorShareRelay.closeAll();
}

export const simulatorShareRelay = new AidenRemoteSimulatorRelay((audience) => provider?.(audience) ?? null);
