/**
 * Client side of simulator sharing (Simulator devices Phase 5): lists and
 * controls the iOS Simulators of paired Aiden desktops through their Aiden
 * Remote `/simulators` routes, over the existing pinned peer transport.
 *
 * Peers are contacted only from a user-driven refresh or action, never on a
 * timer. The paired credential and pinned trust stay in main; the renderer
 * reaches a peer's hub only through the main-owned device proxy.
 */
import https from "node:https";
import {
  parseDeviceSettings,
  type DeviceActionInput,
  type DeviceHostStatus,
  type DeviceKind,
  type DeviceSettings,
  DEVICE_HOST_STATUSES,
} from "../../../renderer/shared/devices.js";
import type { PeerHostView } from "../../../renderer/shared/peer-host.js";
import type { PeerRequest, PeerTrust } from "../peer-transport.js";
import { peerTlsOptions, PeerTransportError } from "../peer-transport.js";
import type { DeviceHubUpstream } from "./device-hub-proxy.js";

/** Booting a simulator on the other Mac can take minutes. */
/** Above the serving Mac's own boot wait, so the caller does not give up first. */
const PEER_OPEN_TIMEOUT_MS = 220_000;
const PEER_SCREENSHOT_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 32 * 1_048_576;
const MAX_PEER_SIMULATORS = 256;
const UDID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;

export interface PeerSimulator {
  id: string;
  name: string;
  version: string;
  booted: boolean;
  kind: DeviceKind;
}

export interface PeerSimulatorListing {
  sharing: boolean;
  status: DeviceHostStatus;
  detail?: string;
  devices: PeerSimulator[];
}

export interface DevicePeerHost {
  id: string;
  name: string;
}

/** What the device service needs from paired Macs. */
export interface DevicePeerPort {
  hosts(): Promise<DevicePeerHost[]>;
  /** Null when the peer's Aiden does not offer simulator sharing. */
  list(hostId: string): Promise<PeerSimulatorListing | null>;
  open(hostId: string, deviceId: string): Promise<PeerSimulator>;
  shutdown(hostId: string, deviceId: string): Promise<void>;
  settings(hostId: string, deviceId: string): Promise<DeviceSettings>;
  action(hostId: string, input: DeviceActionInput): Promise<DeviceSettings>;
  screenshot(hostId: string, deviceId: string): Promise<Buffer>;
  /** Relay upstream for the device proxy. Holds the credential; main only. */
  upstream(hostId: string): Promise<DeviceHubUpstream | null>;
}

export interface PeerRegistryPort {
  list(): Promise<PeerHostView[]>;
  request(id: string, input: Omit<PeerRequest, "credential">): Promise<unknown>;
  relayTarget(id: string): Promise<{ trust: PeerTrust; credential: string } | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSimulator(value: unknown): PeerSimulator | null {
  if (!isRecord(value)) return null;
  const { id, name, version, booted, kind, platform } = value;
  if (typeof id !== "string" || !UDID_PATTERN.test(id)) return null;
  if (typeof name !== "string" || name.length < 1 || name.length > 200) return null;
  if (typeof version !== "string" || version.length > 40 || typeof booted !== "boolean") return null;
  if (platform !== "ios" || (kind !== "iphone" && kind !== "ipad" && kind !== "other")) return null;
  return { id, name, version, booted, kind };
}

export function parsePeerSimulatorListing(value: unknown): PeerSimulatorListing {
  if (!isRecord(value) || typeof value.sharing !== "boolean" || !Array.isArray(value.devices)) {
    throw new PeerTransportError("invalid_response");
  }
  const status =
    typeof value.status === "string" && (DEVICE_HOST_STATUSES as readonly string[]).includes(value.status)
      ? (value.status as DeviceHostStatus)
      : null;
  if (!status || value.devices.length > MAX_PEER_SIMULATORS) throw new PeerTransportError("invalid_response");
  const devices: PeerSimulator[] = [];
  for (const entry of value.devices) {
    const parsed = parseSimulator(entry);
    if (!parsed) throw new PeerTransportError("invalid_response");
    devices.push(parsed);
  }
  const detail = typeof value.detail === "string" ? value.detail.slice(0, 300) : undefined;
  return {
    sharing: value.sharing,
    status,
    ...(detail ? { detail } : {}),
    devices: value.sharing ? devices : [],
  };
}

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof PeerTransportError &&
    error.code === "request_failed" &&
    (error.status === 400 || error.status === 404)
  );
}

function settingsFrom(value: unknown): DeviceSettings {
  const settings = parseDeviceSettings(value);
  if (!settings) throw new PeerTransportError("invalid_response");
  return settings;
}

export function createPeerDevices(registry: PeerRegistryPort): DevicePeerPort {
  /** Hosts that granted `simulators:control` in this process. Negotiated once, on first use. */
  const negotiated = new Map<string, Promise<boolean>>();

  function negotiate(hostId: string): Promise<boolean> {
    let pending = negotiated.get(hostId);
    if (!pending) {
      pending = registry
        .request(hostId, {
          method: "POST",
          path: "/device/capabilities",
          body: { accepts: ["simulators:control"] },
        })
        .then(
          (value) =>
            isRecord(value) &&
            Array.isArray(value.capabilities) &&
            value.capabilities.includes("simulators:control"),
          (error: unknown) => {
            if (isUnsupported(error)) return false;
            throw error;
          },
        );
      // Only a grant is remembered: a transport failure or "not supported" asks again next time,
      // so a Mac that turns the feature on or upgrades is found without restarting.
      pending.then(
        (granted) => {
          if (!granted) negotiated.delete(hostId);
        },
        () => negotiated.delete(hostId),
      );
      negotiated.set(hostId, pending);
    }
    return pending;
  }

  async function post(hostId: string, path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    return registry.request(hostId, {
      method: "POST",
      path,
      body,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  async function relayUpstream(hostId: string): Promise<DeviceHubUpstream | null> {
    const target = await registry.relayTarget(hostId);
    if (!target) return null;
    const endpoint = new URL(target.trust.endpoint);
    return {
      origin: endpoint.origin,
      basePath: `${endpoint.pathname.replace(/\/$/u, "")}/simulators/hub`,
      headers: {
        authorization: `Bearer ${target.credential}`,
        "aiden-protocol-version": "1",
      },
      tls: peerTlsOptions(target.trust),
    };
  }

  return {
    async hosts() {
      return (await registry.list())
        .filter((host) => host.enabled)
        .map((host) => ({ id: host.id, name: host.name }));
    },
    async list(hostId) {
      if (!(await negotiate(hostId))) return null;
      try {
        return parsePeerSimulatorListing(await registry.request(hostId, { path: "/simulators" }));
      } catch (error) {
        if (isUnsupported(error)) {
          // The peer turned the feature off or was downgraded; negotiate again next time.
          negotiated.delete(hostId);
          return null;
        }
        throw error;
      }
    },
    async open(hostId, deviceId) {
      const value = await post(hostId, "/simulators/open", { deviceId }, PEER_OPEN_TIMEOUT_MS);
      const device = isRecord(value) ? parseSimulator(value.device) : null;
      if (!device || device.id !== deviceId) throw new PeerTransportError("invalid_response");
      return device;
    },
    async shutdown(hostId, deviceId) {
      await post(hostId, "/simulators/shutdown", { deviceId }, PEER_OPEN_TIMEOUT_MS);
    },
    async settings(hostId, deviceId) {
      return settingsFrom(await post(hostId, "/simulators/settings", { deviceId }));
    },
    async action(hostId, input) {
      const { hostId: _hostId, ...body } = input;
      return settingsFrom(await post(hostId, "/simulators/action", body, PEER_OPEN_TIMEOUT_MS));
    },
    async screenshot(hostId, deviceId) {
      const upstream = await relayUpstream(hostId);
      if (!upstream) throw new Error("This paired Mac is disabled or unavailable.");
      const body = Buffer.from(JSON.stringify({ udid: deviceId }));
      return new Promise<Buffer>((resolve, reject) => {
        const request = https.request(
          `${upstream.origin}${upstream.basePath}/vendor/serve-sim/api/screenshot`,
          {
            method: "POST",
            agent: false,
            headers: {
              ...upstream.headers,
              "content-type": "application/json",
              "content-length": String(body.length),
            },
            ...upstream.tls,
          },
          (response) => {
            const type = response.headers["content-type"] ?? "";
            if (response.statusCode !== 200 || !type.startsWith("image/png")) {
              response.resume();
              reject(new Error("The simulator screenshot failed."));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_SCREENSHOT_BYTES) {
                request.destroy();
                reject(new Error("The simulator screenshot is too large."));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => resolve(Buffer.concat(chunks)));
            response.on("error", reject);
          },
        );
        request.setTimeout(PEER_SCREENSHOT_TIMEOUT_MS, () => request.destroy(new Error("The simulator screenshot timed out.")));
        request.on("error", () => reject(new Error("The simulator screenshot failed.")));
        request.end(body);
      });
    },
    upstream: relayUpstream,
  };
}
