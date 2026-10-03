import {
  hostIdentifier,
  peerPairingAttemptId,
  type PeerDiscoveryState,
  type PeerHostView,
  type PeerPairingFailure,
  type PeerPairingProgress,
  type PeerPairingResult,
} from "../../renderer/shared/peer-host.js";
import type { PeerDiscovery } from "../services/peer-discovery.js";
import type { PeerHostRegistry, PeerPairingOptions } from "../services/peer-host-registry.js";
import { parsePeerPairing, type PeerPairing } from "../services/peer-pairing.js";
import { PeerPairingOutcomeError } from "../services/peer-pairing-client.js";
import type { PeerHostLiveOwner } from "./peer-host-live.js";

export type PeerPairingDiscovery = Pick<PeerDiscovery, "start" | "stop" | "refresh" | "target" | "state">;
export type PeerPairingRegistry = Pick<
  PeerHostRegistry,
  "pair" | "pairWithRequest" | "pairWithSetupCode" | "rename"
>;

export interface PeerPairingOwner extends PeerHostLiveOwner {
  /** Deliver a notification to this document only. */
  send(channel: "remote:peer-pairing-progress", payload: PeerPairingProgress): void;
}

export interface PeerPairingHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws for a sender that is not the current main frame. */
  owner(event: Event): PeerPairingOwner;
  discovery(): PeerPairingDiscovery;
  registry(): PeerPairingRegistry;
  /** Restart supervision of a host, as after a re-pair. */
  reconnect(hostId: string): Promise<void>;
}

const INACTIVE = "The application document changed.";
const API_PATH = "/api/aiden/v1";

/**
 * Normalize an address typed for a setup code to the endpoint the other
 * device seals into its payload: `https://host[:port]/api/aiden/v1`.
 */
export function peerSetupAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  const typed = value.trim();
  const rest = /^https:\/\//iu.test(typed) ? typed.slice(8) : typed;
  if (!rest || /^[a-z][a-z0-9+.-]*:\/\//iu.test(rest) || /[\s@\\?#]/u.test(rest)) return undefined;
  let url: URL;
  try {
    url = new URL(`https://${rest}`);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (path !== "" && path !== API_PATH) return undefined;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$|^\[[0-9a-f:.]+\]$/u.test(url.hostname))
    return undefined;
  return `https://${url.host}${API_PATH}`;
}

function failure(message: string): PeerPairingResult {
  return { ok: false, outcome: { status: "failed", message } };
}

function replacement(value: unknown): PeerPairingOptions {
  return value === undefined || value === null ? {} : { replaceHostId: hostIdentifier(value) };
}

function setupInput(value: unknown): { deviceId?: string; address?: unknown; code: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid setup code request.");
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.length > 64) throw new Error("Invalid setup code.");
  return {
    code: record.code,
    ...(record.deviceId === undefined ? {} : { deviceId: hostIdentifier(record.deviceId) }),
    ...(record.address === undefined ? {} : { address: record.address }),
  };
}

/**
 * Pairing IPC for the Add device sheet. Discovery runs only while at least
 * one document has the sheet open. Discovered devices are named by ID; their
 * addresses, the credentials and the pins never leave the main process.
 * Every attempt ends in a typed `PeerPairingResult` rather than a throw.
 */
export function registerPeerPairingHandlers<Event>(dependencies: PeerPairingHandlerDependencies<Event>): void {
  const { handle } = dependencies;
  /** Documents with the sheet open, and the listener that closes their scan. */
  const scanners = new Map<string, () => void>();
  const attempts = new Map<string, { owner: string; controller: AbortController }>();

  const active = (event: Event): PeerPairingOwner => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return owner;
  };

  const release = (key: string): void => {
    const detach = scanners.get(key);
    if (!detach) return;
    scanners.delete(key);
    detach();
    if (scanners.size === 0) dependencies.discovery().stop();
  };

  const attempt = async (
    owner: PeerPairingOwner,
    attemptId: string,
    work: (signal: AbortSignal) => Promise<PeerHostView>,
    options: PeerPairingOptions,
  ): Promise<PeerPairingResult> => {
    if (attempts.has(attemptId)) throw new Error("That pairing attempt is already running.");
    const controller = new AbortController();
    attempts.set(attemptId, { owner: owner.key, controller });
    const detach = owner.onInvalidated(() => controller.abort());
    try {
      const host = await work(controller.signal);
      // A re-paired host was blocked; supervise it again with the new trust.
      if (options.replaceHostId !== undefined) await dependencies.reconnect(host.id).catch(() => undefined);
      return { ok: true, host };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, outcome: { status: "cancelled" } };
      const outcome: PeerPairingFailure =
        error instanceof PeerPairingOutcomeError
          ? error.outcome
          : { status: "failed", message: "The other device could not complete pairing." };
      return { ok: false, outcome };
    } finally {
      detach();
      attempts.delete(attemptId);
    }
  };

  const discoveryState = (): Promise<PeerDiscoveryState> => dependencies.discovery().state();

  handle("remote:peerDiscoveryStart", async (event) => {
    const owner = active(event);
    if (!scanners.has(owner.key)) scanners.set(owner.key, owner.onInvalidated(() => release(owner.key)));
    dependencies.discovery().start();
    return discoveryState();
  });

  handle("remote:peerDiscoveryRefresh", async (event) => {
    const owner = active(event);
    if (!scanners.has(owner.key)) throw new Error("Device search is not open.");
    dependencies.discovery().refresh();
    return discoveryState();
  });

  handle("remote:peerDiscoveryStop", (event) => {
    release(active(event).key);
  });

  handle("remote:peerPairRequest", async (event, rawAttemptId, deviceId, replaceHostId) => {
    const owner = active(event);
    const attemptId = peerPairingAttemptId(rawAttemptId);
    const options = replacement(replaceHostId);
    const target = dependencies.discovery().target(hostIdentifier(deviceId));
    if (!target) return failure("That device is no longer listed. Search again.");
    return attempt(
      owner,
      attemptId,
      (signal) =>
        dependencies.registry().pairWithRequest(
          target,
          (matchCode, expiresAt) => {
            if (!owner.isDestroyed())
              owner.send("remote:peer-pairing-progress", { attemptId, matchCode, expiresAt });
          },
          signal,
          options,
        ),
      options,
    );
  });

  handle("remote:peerPairSetupCode", async (event, rawAttemptId, rawInput, replaceHostId) => {
    const owner = active(event);
    const attemptId = peerPairingAttemptId(rawAttemptId);
    const options = replacement(replaceHostId);
    const input = setupInput(rawInput);
    let destination: { endpoint: string; instanceId?: string };
    if (input.deviceId !== undefined) {
      const target = dependencies.discovery().target(input.deviceId);
      if (!target) return failure("That device is no longer listed. Search again.");
      destination = { endpoint: target.endpoint, instanceId: target.instanceId };
    } else {
      const endpoint = peerSetupAddress(input.address);
      if (!endpoint) return failure("Enter the address shown on the other device.");
      destination = { endpoint };
    }
    return attempt(
      owner,
      attemptId,
      (signal) => dependencies.registry().pairWithSetupCode({ ...destination, code: input.code }, signal, options),
      options,
    );
  });

  // The advanced fallback: a pairing link copied from the other device.
  handle("remote:peerPairLink", async (event, rawAttemptId, link, replaceHostId) => {
    const owner = active(event);
    const attemptId = peerPairingAttemptId(rawAttemptId);
    const options = replacement(replaceHostId);
    let pairing: PeerPairing;
    try {
      if (typeof link !== "string" || link.length > 8192) throw new Error("Invalid pairing link.");
      pairing = parsePeerPairing(link.trim());
    } catch {
      return failure("That pairing link is not valid or has expired.");
    }
    return attempt(owner, attemptId, (signal) => dependencies.registry().pair(pairing, signal, options), options);
  });

  handle("remote:peerPairCancel", (event, attemptId) => {
    const owner = active(event);
    const running = attempts.get(peerPairingAttemptId(attemptId));
    if (!running || running.owner !== owner.key) return false;
    running.controller.abort();
    return true;
  });

  handle("remote:peersRename", (event, hostId, name) => {
    active(event);
    if (typeof name !== "string" || name.length > 200) throw new Error("Enter a name of up to 80 characters.");
    return dependencies.registry().rename(hostIdentifier(hostId), name);
  });

  handle("remote:peersReconnect", async (event, hostId) => {
    active(event);
    await dependencies.reconnect(hostIdentifier(hostId));
  });
}
