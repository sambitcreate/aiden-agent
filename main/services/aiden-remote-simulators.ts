/**
 * Serving side of simulator sharing between paired Macs (Simulator devices
 * Phase 5). A paired `mac`/`linux` device holding the negotiated
 * `simulators:control` capability may list, open, shut down and configure
 * this Mac's iOS Simulators and Android Emulators, and reach its device hub
 * through a relay that applies the Simulator tab proxy's allowlist.
 *
 * Phones and tablets holding `simulators:mobile` (contract revision 25) are
 * the `mobile` audience: they may list, open and shut down simulators, watch
 * the MJPEG stream and drive the input socket, and nothing else.
 *
 * Each audience has its own owner consent: "Share with paired Macs" for
 * desktops and "Share with Aiden On The Go" for phones. Turning one off,
 * revoking the device, or stopping the hub closes that audience's relays.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import {
  DEVICE_ID_PATTERN,
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

/** Who a relay call serves: a paired desktop (`simulators:control`) or a phone (`simulators:mobile`). */
export type AidenRemoteSimulatorAudience = "desktop" | "mobile";

/**
 * Hub routes a phone may reach: the MJPEG stream, the screen config and
 * health reads, and the input socket. Screenshots, the accessibility tree,
 * the event log, H.264 and the device list socket stay desktop-only.
 */
const MOBILE_HUB_HTTP_PATH = /^\/vendor\/serve-sim\/helper\/[A-Za-z0-9-]+\/(stream\.mjpeg|config|health)$/u;
const MOBILE_HUB_WS_PATH = /^\/vendor\/serve-sim\/helper\/ws$/u;

export const MOBILE_SIMULATOR_REFUSAL =
  "Phones can watch, tap, and shut down shared simulators, but not change their settings.";

export type AidenRemoteSimulator = Omit<DeviceSummary, "hostId">;

export interface AidenRemoteSimulatorListing {
  sharing: boolean;
  status: DeviceHostStatus;
  detail?: string;
  devices: AidenRemoteSimulator[];
  /** With a `chatId`: the listed simulators the desktop attached to that chat. */
  chatDeviceIds?: string[];
  /** Phones only: the pinned helper versions, shown in the viewer's options. */
  toolVersions?: { hub: string; agent: string };
}

export interface AidenRemoteSimulatorListOptions {
  /**
   * Also report the simulators attached to this chat. The caller has already
   * checked the device may read it. A chat-scoped listing never starts the hub.
   */
  chatId?: string;
}

/** What the device service offers one audience. Every method refuses while that audience's sharing is off. */
export interface AidenRemoteSimulatorHost {
  sharing(): boolean;
  /** Lists simulators, starting an already-installed hub but never installing. */
  list(options?: AidenRemoteSimulatorListOptions): Promise<AidenRemoteSimulatorListing>;
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

function mobileRefused(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("capability_denied", MOBILE_SIMULATOR_REFUSAL, 403);
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
    !DEVICE_ID_PATTERN.test(deviceId) ||
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
  /** Defaults to `desktop`. */
  audience?: AidenRemoteSimulatorAudience;
  /** A chat the router already authorized for `GET /simulators?chatId=`. */
  chatId?: string;
  readJson(maximumBytes: number): Promise<unknown>;
  writeJson(status: number, value: unknown): void;
}

/**
 * Owns live relay connections so a revoked device, a sharing change, or a
 * stopped hub closes them. `resolve` returns null while the feature is off.
 */
export class AidenRemoteSimulatorRelay {
  private readonly live = new Map<string, Set<{ destroy(): void }>>();
  /** The audience each paired device's live relays serve. */
  private readonly liveAudience = new Map<string, AidenRemoteSimulatorAudience>();
  private readonly subscriptions = new Map<
    AidenRemoteSimulatorAudience,
    { host: AidenRemoteSimulatorHost; unsubscribe: () => void }
  >();

  constructor(
    private readonly resolve: (audience: AidenRemoteSimulatorAudience) => AidenRemoteSimulatorHost | null,
  ) {}

  host(audience: AidenRemoteSimulatorAudience = "desktop"): AidenRemoteSimulatorHost | null {
    const host = this.resolve(audience);
    const current = this.subscriptions.get(audience);
    if (host && host !== current?.host) {
      current?.unsubscribe();
      this.subscriptions.set(audience, {
        host,
        unsubscribe: host.onSharingChanged((sharing) => {
          if (!sharing) this.closeAudience(audience);
        }),
      });
    }
    return host;
  }

  /** Closes every relay a revoked device holds. */
  revokeDevice(deviceId: string): void {
    const connections = this.live.get(deviceId);
    this.live.delete(deviceId);
    this.liveAudience.delete(deviceId);
    for (const connection of connections ?? []) connection.destroy();
  }

  closeAll(): void {
    for (const deviceId of [...this.live.keys()]) this.revokeDevice(deviceId);
  }

  /** Closes the relays one audience holds, e.g. when its sharing consent turns off. */
  closeAudience(audience: AidenRemoteSimulatorAudience): void {
    for (const [deviceId, owner] of [...this.liveAudience]) {
      if (owner === audience) this.revokeDevice(deviceId);
    }
  }

  private requireRelayCapacity(deviceId: string): void {
    if ((this.live.get(deviceId)?.size ?? 0) >= MAX_RELAYS_PER_DEVICE) {
      throw new AidenRemoteServiceError("handle_capacity", "Too many simulator streams are open.", 429, true);
    }
  }

  private track(
    deviceId: string,
    audience: AidenRemoteSimulatorAudience,
    connection: { destroy(): void; once(event: "close", listener: () => void): unknown },
  ) {
    const set = this.live.get(deviceId) ?? new Set();
    set.add(connection);
    this.live.set(deviceId, set);
    this.liveAudience.set(deviceId, audience);
    connection.once("close", () => {
      set.delete(connection);
      if (set.size === 0 && this.live.get(deviceId) === set) {
        this.live.delete(deviceId);
        this.liveAudience.delete(deviceId);
      }
    });
  }

  private requireSharing(audience: AidenRemoteSimulatorAudience): AidenRemoteSimulatorHost {
    const host = this.host(audience);
    if (!host) throw simulatorsUnavailable();
    if (!host.sharing()) throw sharingOff();
    return host;
  }

  /** Handles an authenticated `/simulators…` request. Resolves when the response is done. */
  async handle(context: AidenRemoteSimulatorRouteContext): Promise<void> {
    const { request, path, query } = context;
    const audience = context.audience ?? "desktop";
    if (path.startsWith(`${AIDEN_REMOTE_SIMULATOR_HUB_PREFIX}/`)) {
      await this.relayRequest(context, audience);
      return;
    }
    if (query) {
      throw new AidenRemoteServiceError("invalid_request", "This endpoint does not accept query parameters.", 400);
    }
    const host = this.host(audience);
    if (!host) throw simulatorsUnavailable();
    if (request.method === "GET" && path === "/simulators") {
      let listing: AidenRemoteSimulatorListing;
      try {
        listing = await host.list(context.chatId === undefined ? undefined : { chatId: context.chatId });
      } catch (error) {
        throw simulatorFailure(error);
      }
      context.writeJson(200, listing.sharing ? listing : { sharing: false, status: listing.status, devices: [] });
      return;
    }
    if (context.chatId !== undefined) {
      throw new AidenRemoteServiceError("invalid_request", "This endpoint does not accept query parameters.", 400);
    }
    if (request.method !== "POST") {
      throw new AidenRemoteServiceError("not_found", "This Aiden Remote endpoint does not exist.", 404);
    }
    // Settings and device actions stay desktop-only; refuse before reading the body.
    if (audience === "mobile" && (path === "/simulators/settings" || path === "/simulators/action")) {
      throw mobileRefused();
    }
    const body = await context.readJson(4_096);
    const shared = this.requireSharing(audience);
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
    audience: AidenRemoteSimulatorAudience,
  ): { hubOrigin: string; upstreamPath: string; mutable: boolean; hubPath: string } {
    const host = this.requireSharing(audience);
    const hubPath = path.slice(AIDEN_REMOTE_SIMULATOR_HUB_PREFIX.length);
    const route = decideDeviceHubRoute({
      method,
      rawPath: hubPath,
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
    // Phones get the stream and input only, never a mutation such as a screenshot.
    if (
      audience === "mobile" &&
      (route.mutable || !(upgrade ? MOBILE_HUB_WS_PATH : MOBILE_HUB_HTTP_PATH).test(hubPath))
    ) {
      throw mobileRefused();
    }
    if (route.deviceIds.some((deviceId) => !host.isKnownDevice(deviceId))) throw unknownSimulator();
    const hubOrigin = host.hubOrigin();
    if (!hubOrigin) {
      throw new AidenRemoteServiceError("not_found", "The simulator hub is not running on this Mac.", 404, true);
    }
    return { hubOrigin, upstreamPath: route.upstreamPath, mutable: route.mutable, hubPath };
  }

  /**
   * The only bodies the relay forwards, rebuilt from validated fields: an iOS
   * screenshot names a listed simulator, and an Android fold names a posture.
   * serve-emu's screenshot carries its device in the query. Stream tuning
   * (PUT and PATCH) stays local to the Simulator tab.
   */
  private async relayBody(
    context: AidenRemoteSimulatorRouteContext,
    method: string,
    hubPath: string,
    audience: AidenRemoteSimulatorAudience,
  ) {
    const invalid = () => new AidenRemoteServiceError("invalid_request", "The simulator request is invalid.", 400);
    if (method !== "POST") {
      throw new AidenRemoteServiceError("invalid_request", "This method is not allowed on this route.", 405);
    }
    if (hubPath === "/vendor/serve-emu/api/screenshot") return undefined;
    const parsed = await context.readJson(MAX_SCREENSHOT_BODY_BYTES);
    const record =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (hubPath === "/vendor/serve-emu/api/fold") {
      const posture = record?.posture;
      if (posture !== "closed" && posture !== "opened") throw invalid();
      return Buffer.from(JSON.stringify({ posture }));
    }
    // The iOS screenshot capture must name a listed simulator.
    const udid = record?.udid;
    if (typeof udid !== "string" || !DEVICE_ID_PATTERN.test(udid)) {
      throw new AidenRemoteServiceError("invalid_request", "The screenshot request is invalid.", 400);
    }
    if (!this.requireSharing(audience).isKnownDevice(udid)) throw unknownSimulator();
    return Buffer.from(JSON.stringify({ udid }));
  }

  private async relayRequest(
    context: AidenRemoteSimulatorRouteContext,
    audience: AidenRemoteSimulatorAudience,
  ): Promise<void> {
    const { request, response } = context;
    const method = request.method ?? "GET";
    if (method === "OPTIONS") {
      throw new AidenRemoteServiceError("invalid_request", "This method is not allowed on this route.", 405);
    }
    if (context.chatId !== undefined) {
      throw new AidenRemoteServiceError("invalid_request", "This endpoint does not accept a chat.", 400);
    }
    const target = this.hubTarget(method, context.path, context.query, false, audience);
    this.requireRelayCapacity(context.deviceId);
    const body =
      method === "GET" || method === "HEAD" ? undefined : await this.relayBody(context, method, target.hubPath, audience);
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
      this.track(context.deviceId, audience, response);
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
    /** Defaults to `desktop`. */
    audience?: AidenRemoteSimulatorAudience;
  }): void {
    const { request, socket } = input;
    const audience = input.audience ?? "desktop";
    if (!input.path.startsWith(`${AIDEN_REMOTE_SIMULATOR_HUB_PREFIX}/`)) {
      throw new AidenRemoteServiceError("not_found", "This Aiden Remote endpoint does not exist.", 404);
    }
    const target = this.hubTarget(request.method ?? "GET", input.path, input.query, true, audience);
    this.requireRelayCapacity(input.deviceId);
    const hub = new URL(target.hubOrigin);
    const upstream = connect({ host: hub.hostname, port: Number(hub.port) });
    this.track(input.deviceId, audience, socket);
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
