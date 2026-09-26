/**
 * Serving side of simulator sharing between paired Macs (Simulator devices
 * Phase 5). A paired `mac`/`linux` device holding the negotiated
 * `simulators:control` capability may list, open, shut down and configure
 * this Mac's iOS Simulators, and reach its device hub through a relay that
 * applies the Simulator tab proxy's allowlist.
 *
 * The owner's "Share with paired Macs" consent gates every call. Turning it
 * off, revoking the device, or stopping the hub closes live relays.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import {
  LOCAL_DEVICE_HOST_ID,
  parseDeviceActionInput,
  type DeviceActionInput,
  type DeviceHostStatus,
  type DeviceSettings,
  type DeviceSummary,
} from "../../renderer/shared/devices.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  decideDeviceHubRoute,
  hubRequestHeaders,
  hubResponseHeaders,
  pipeUpgrade,
  upgradeRequestHead,
} from "./devices/device-hub-proxy.js";

/** Relay routes live under this prefix, followed by the hub path. */
export const AIDEN_REMOTE_SIMULATOR_HUB_PREFIX = "/simulators/hub";
const MAX_SCREENSHOT_BODY_BYTES = 1_024;
/** Open relays per paired device: a few simulators' frame and input streams, with headroom. */
export const MAX_RELAYS_PER_DEVICE = 8;
const UDID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;

export type AidenRemoteSimulator = Omit<DeviceSummary, "hostId">;

export interface AidenRemoteSimulatorListing {
  sharing: boolean;
  status: DeviceHostStatus;
  detail?: string;
  devices: AidenRemoteSimulator[];
}

/** What the device service offers paired Macs. Every method refuses while sharing is off. */
export interface AidenRemoteSimulatorHost {
  sharing(): boolean;
  /** Lists simulators, starting an already-installed hub but never installing. */
  list(): Promise<AidenRemoteSimulatorListing>;
  open(deviceId: string): Promise<AidenRemoteSimulator>;
  shutdown(deviceId: string): Promise<void>;
  settings(deviceId: string): Promise<DeviceSettings>;
  action(input: DeviceActionInput): Promise<DeviceSettings>;
  /** The loopback hub origin while sharing is on and the hub runs. */
  hubOrigin(): string | null;
  /** Whether the latest listing reported this simulator. */
  isKnownDevice(deviceId: string): boolean;
  onSharingChanged(listener: (sharing: boolean) => void): () => void;
}

export function simulatorsUnavailable(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("not_found", "Simulators are unavailable on this Aiden installation.", 404);
}

function sharingOff(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("not_found", "Simulator sharing is off on this Mac.", 404);
}

function unknownSimulator(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("not_found", "That simulator is no longer available.", 404);
}

/** Host errors carry local detail (paths, tool output). Paired devices get a fixed message. */
function simulatorFailure(error: unknown): AidenRemoteServiceError {
  if (error instanceof AidenRemoteServiceError) return error;
  return new AidenRemoteServiceError("internal_error", "The simulator request could not be completed.", 500, true);
}

function requireDeviceId(body: unknown): string {
  const deviceId =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).deviceId
      : undefined;
  if (
    typeof deviceId !== "string" ||
    !UDID_PATTERN.test(deviceId) ||
    Object.keys(body as Record<string, unknown>).length !== 1
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The simulator request is invalid.", 400);
  }
  return deviceId;
}

export interface AidenRemoteSimulatorRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  /** Path after the Aiden Remote base path. */
  path: string;
  query: string;
  deviceId: string;
  readJson(maximumBytes: number): Promise<unknown>;
  writeJson(status: number, value: unknown): void;
}

/**
 * Owns live relay connections so a revoked device, a sharing change, or a
 * stopped hub closes them. `resolve` returns null while the feature is off.
 */
export class AidenRemoteSimulatorRelay {
  private readonly live = new Map<string, Set<{ destroy(): void }>>();
  private subscribed: AidenRemoteSimulatorHost | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly resolve: () => AidenRemoteSimulatorHost | null) {}

  host(): AidenRemoteSimulatorHost | null {
    const host = this.resolve();
    if (host && host !== this.subscribed) {
      this.unsubscribe?.();
      this.subscribed = host;
      this.unsubscribe = host.onSharingChanged((sharing) => {
        if (!sharing) this.closeAll();
      });
    }
    return host;
  }

  /** Closes every relay a revoked device holds. */
  revokeDevice(deviceId: string): void {
    const connections = this.live.get(deviceId);
    this.live.delete(deviceId);
    for (const connection of connections ?? []) connection.destroy();
  }

  closeAll(): void {
    for (const deviceId of [...this.live.keys()]) this.revokeDevice(deviceId);
  }

  private requireRelayCapacity(deviceId: string): void {
    if ((this.live.get(deviceId)?.size ?? 0) >= MAX_RELAYS_PER_DEVICE) {
      throw new AidenRemoteServiceError("handle_capacity", "Too many simulator streams are open.", 429, true);
    }
  }

  private track(deviceId: string, connection: { destroy(): void; once(event: "close", listener: () => void): unknown }) {
    const set = this.live.get(deviceId) ?? new Set();
    set.add(connection);
    this.live.set(deviceId, set);
    connection.once("close", () => {
      set.delete(connection);
      if (set.size === 0 && this.live.get(deviceId) === set) this.live.delete(deviceId);
    });
  }

  private requireSharing(): AidenRemoteSimulatorHost {
    const host = this.host();
    if (!host) throw simulatorsUnavailable();
    if (!host.sharing()) throw sharingOff();
    return host;
  }

  /** Handles an authenticated `/simulators…` request. Resolves when the response is done. */
  async handle(context: AidenRemoteSimulatorRouteContext): Promise<void> {
    const { request, path, query } = context;
    if (path.startsWith(`${AIDEN_REMOTE_SIMULATOR_HUB_PREFIX}/`)) {
      await this.relayRequest(context);
      return;
    }
    if (query) {
      throw new AidenRemoteServiceError("invalid_request", "This endpoint does not accept query parameters.", 400);
    }
    const host = this.host();
    if (!host) throw simulatorsUnavailable();
    if (request.method === "GET" && path === "/simulators") {
      let listing: AidenRemoteSimulatorListing;
      try {
        listing = await host.list();
      } catch (error) {
        throw simulatorFailure(error);
      }
      context.writeJson(200, listing.sharing ? listing : { sharing: false, status: listing.status, devices: [] });
      return;
    }
    if (request.method !== "POST") {
      throw new AidenRemoteServiceError("not_found", "This Aiden Remote endpoint does not exist.", 404);
    }
    const body = await context.readJson(4_096);
    const shared = this.requireSharing();
    try {
      switch (path) {
        case "/simulators/open": {
          const deviceId = requireDeviceId(body);
          if (!shared.isKnownDevice(deviceId)) throw unknownSimulator();
          context.writeJson(200, { device: await shared.open(deviceId) });
          return;
        }
        case "/simulators/shutdown": {
          const deviceId = requireDeviceId(body);
          if (!shared.isKnownDevice(deviceId)) throw unknownSimulator();
          await shared.shutdown(deviceId);
          context.writeJson(200, { ok: true });
          return;
        }
        case "/simulators/settings": {
          const deviceId = requireDeviceId(body);
          if (!shared.isKnownDevice(deviceId)) throw unknownSimulator();
          context.writeJson(200, await shared.settings(deviceId));
          return;
        }
        case "/simulators/action": {
          // The serving Mac only ever acts on its own simulators.
          const input =
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? parseDeviceActionInput({ ...(body as Record<string, unknown>), hostId: LOCAL_DEVICE_HOST_ID })
              : null;
          if (!input) throw new AidenRemoteServiceError("invalid_request", "The simulator action is invalid.", 400);
          if (!shared.isKnownDevice(input.deviceId)) throw unknownSimulator();
          context.writeJson(200, await shared.action(input));
          return;
        }
        default:
          throw new AidenRemoteServiceError("not_found", "This Aiden Remote endpoint does not exist.", 404);
      }
    } catch (error) {
      throw simulatorFailure(error);
    }
  }

  private hubTarget(
    method: string,
    path: string,
    query: string,
    upgrade: boolean,
  ): { hubOrigin: string; upstreamPath: string; mutable: boolean } {
    const host = this.requireSharing();
    const route = decideDeviceHubRoute({
      method,
      rawPath: path.slice(AIDEN_REMOTE_SIMULATOR_HUB_PREFIX.length),
      search: new URLSearchParams(query),
      upgrade,
    });
    if (!route.ok) {
      throw new AidenRemoteServiceError(
        route.status === 405 ? "invalid_request" : "not_found",
        route.status === 405 ? "This method is not allowed on this route." : "This Aiden Remote endpoint does not exist.",
        route.status,
      );
    }
    if (route.deviceIds.some((deviceId) => !host.isKnownDevice(deviceId))) throw unknownSimulator();
    const hubOrigin = host.hubOrigin();
    if (!hubOrigin) {
      throw new AidenRemoteServiceError("not_found", "The simulator hub is not running on this Mac.", 404, true);
    }
    return { hubOrigin, upstreamPath: route.upstreamPath, mutable: route.mutable };
  }

  private async relayRequest(context: AidenRemoteSimulatorRouteContext): Promise<void> {
    const { request, response } = context;
    const method = request.method ?? "GET";
    if (method === "OPTIONS") {
      throw new AidenRemoteServiceError("invalid_request", "This method is not allowed on this route.", 405);
    }
    const target = this.hubTarget(method, context.path, context.query, false);
    this.requireRelayCapacity(context.deviceId);
    let body: Buffer | undefined;
    if (method === "POST") {
      // The screenshot capture is the only body; it must name a listed simulator.
      const parsed = await context.readJson(MAX_SCREENSHOT_BODY_BYTES);
      const udid =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).udid
          : undefined;
      if (typeof udid !== "string" || !UDID_PATTERN.test(udid)) {
        throw new AidenRemoteServiceError("invalid_request", "The screenshot request is invalid.", 400);
      }
      if (!this.requireSharing().isKnownDevice(udid)) throw unknownSimulator();
      body = Buffer.from(JSON.stringify({ udid }));
    }
    const headers = hubRequestHeaders(request.headers, target.hubOrigin, { forceOrigin: true });
    delete headers["content-type"];
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    await new Promise<void>((resolve, reject) => {
      const upstream = httpRequest(`${target.hubOrigin}${target.upstreamPath}`, { method, headers }, (hubResponse) => {
        response.writeHead(hubResponse.statusCode ?? 502, hubResponseHeaders(hubResponse.headers));
        // pipe() never forwards errors: a hub that resets mid-stream must end this response, not crash main.
        hubResponse.once("error", () => response.destroy());
        hubResponse.pipe(response);
        response.once("close", () => hubResponse.destroy());
      });
      upstream.once("error", () => {
        if (!response.headersSent) {
          reject(new AidenRemoteServiceError("internal_error", "The simulator hub did not respond.", 502, true));
        } else {
          response.destroy();
          resolve();
        }
      });
      response.once("close", () => {
        upstream.destroy();
        resolve();
      });
      this.track(context.deviceId, response);
      upstream.end(body);
    });
  }

  /**
   * Relays an authenticated WebSocket upgrade under the hub prefix. Throws
   * `AidenRemoteServiceError` on refusal, so the caller answers with a bare
   * HTTP status line and logs it; the socket never reaches the hub then.
   */
  upgrade(input: {
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
    path: string;
    query: string;
    deviceId: string;
  }): void {
    const { request, socket } = input;
    if (!input.path.startsWith(`${AIDEN_REMOTE_SIMULATOR_HUB_PREFIX}/`)) {
      throw new AidenRemoteServiceError("not_found", "This Aiden Remote endpoint does not exist.", 404);
    }
    const target = this.hubTarget(request.method ?? "GET", input.path, input.query, true);
    this.requireRelayCapacity(input.deviceId);
    const hub = new URL(target.hubOrigin);
    const upstream = connect({ host: hub.hostname, port: Number(hub.port) });
    this.track(input.deviceId, socket);
    pipeUpgrade({
      client: socket,
      upstream,
      readyEvent: "connect",
      requestHead: upgradeRequestHead(
        target.upstreamPath,
        hubRequestHeaders(request.headers, target.hubOrigin, { forceOrigin: true }),
        request.headers,
      ),
      head: input.head,
    });
  }
}
