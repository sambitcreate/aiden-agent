/** Simulator devices cross the renderer ↔ main boundary only through these fail-closed shapes. */
export type DevicePlatform = "ios";
/** `peer` is a paired Aiden desktop sharing its simulators (Phase 5). */
export type DeviceHostKind = "local" | "peer" | "ssh";
export const LOCAL_DEVICE_HOST_ID = "local";
/** Local is `local`; a paired desktop uses its Aiden Remote instance ID. */
export const DEVICE_HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
export type DeviceKind = "iphone" | "ipad" | "other";
export interface DeviceSummary {
  hostId: string;
  id: string;
  name: string;
  platform: DevicePlatform;
  version: string;
  booted: boolean;
  kind: DeviceKind;
}
export const DEVICE_HOST_STATUSES = [
  "disabled",
  "needs-consent",
  "installing",
  "starting",
  "ready",
  /** Consent is granted and the helpers are installed, but the hub is not running yet. */
  "stopped",
  "unavailable",
  "error",
] as const;
export type DeviceHostStatus = (typeof DEVICE_HOST_STATUSES)[number];
export type DeviceConsentKind = "streaming" | "agentAccess" | "peerSharing";
export interface DeviceConsent {
  streaming: boolean;
  agentAccess: boolean;
  /** Lets paired desktops holding `simulators:control` watch and control this Mac's simulators. */
  peerSharing: boolean;
}
export interface DeviceSession {
  chatId: string;
  hostId: string;
  deviceId: string;
  openedBy: "user" | "agent";
}
export interface DeviceHostState {
  status: DeviceHostStatus;
  detail?: string;
}
/** One device host the Simulator tab can show, local first. */
export interface DeviceHostInfo extends DeviceHostState {
  id: string;
  kind: DeviceHostKind;
  name: string;
}
export interface DeviceServiceState {
  hostStatus: DeviceHostStatus;
  hostStatuses: Record<string, DeviceHostState>;
  hosts: DeviceHostInfo[];
  consent: DeviceConsent;
  devices: DeviceSummary[];
  sessions: DeviceSession[];
  toolVersions: { hub: string; agent: string };
  /** A user-readable reason the host cannot run, e.g. missing Xcode or npm. */
  unavailableReason?: string;
}
/** A short-lived credential for the main-owned loopback proxy; never the hub origin itself. */
export interface DeviceStreamGrant {
  origin: string;
  token: string;
  expiresAt: number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,}$/u;
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseHostStatus(value: unknown): DeviceHostStatus | null {
  return typeof value === "string" && (DEVICE_HOST_STATUSES as readonly string[]).includes(value)
    ? (value as DeviceHostStatus)
    : null;
}

function parseHostState(value: unknown): DeviceHostState | null {
  if (!isRecord(value)) return null;
  const status = parseHostStatus(value.status);
  if (!status) return null;
  if (value.detail !== undefined && typeof value.detail !== "string") return null;
  return value.detail === undefined ? { status } : { status, detail: value.detail };
}

function isHostId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_HOST_ID_PATTERN.test(value);
}

function parseHostInfo(value: unknown): DeviceHostInfo | null {
  if (!isRecord(value)) return null;
  const state = parseHostState(value);
  const { id, kind, name } = value;
  if (!state || !isHostId(id) || !nonEmptyString(name)) return null;
  if (kind !== "local" && kind !== "peer" && kind !== "ssh") return null;
  return { id, kind, name, ...state };
}

function parseDevice(value: unknown): DeviceSummary | null {
  if (!isRecord(value)) return null;
  const { hostId, id, name, platform, version, booted, kind } = value;
  if (!isHostId(hostId) || !nonEmptyString(id) || !nonEmptyString(name)) return null;
  if (platform !== "ios" || typeof version !== "string" || typeof booted !== "boolean") return null;
  if (kind !== "iphone" && kind !== "ipad" && kind !== "other") return null;
  return { hostId, id, name, platform, version, booted, kind };
}

function parseSession(value: unknown): DeviceSession | null {
  if (!isRecord(value)) return null;
  const { chatId, hostId, deviceId, openedBy } = value;
  if (!nonEmptyString(chatId) || !isHostId(hostId) || !nonEmptyString(deviceId)) return null;
  if (openedBy !== "user" && openedBy !== "agent") return null;
  return { chatId, hostId, deviceId, openedBy };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

export function parseDeviceServiceState(value: unknown): DeviceServiceState | null {
  if (!isRecord(value)) return null;
  const hostStatus = parseHostStatus(value.hostStatus);
  if (!hostStatus || !isRecord(value.hostStatuses)) return null;
  const hostStatuses: Record<string, DeviceHostState> = {};
  for (const [hostId, state] of Object.entries(value.hostStatuses)) {
    const parsed = parseHostState(state);
    if (!parsed) return null;
    hostStatuses[hostId] = parsed;
  }
  const consent = value.consent;
  if (
    !isRecord(consent) ||
    typeof consent.streaming !== "boolean" ||
    typeof consent.agentAccess !== "boolean" ||
    typeof consent.peerSharing !== "boolean"
  ) {
    return null;
  }
  const hosts = parseList(value.hosts, parseHostInfo);
  const devices = parseList(value.devices, parseDevice);
  const sessions = parseList(value.sessions, parseSession);
  if (!hosts || !devices || !sessions) return null;
  const toolVersions = value.toolVersions;
  if (
    !isRecord(toolVersions) ||
    !nonEmptyString(toolVersions.hub) ||
    !nonEmptyString(toolVersions.agent)
  ) {
    return null;
  }
  if (value.unavailableReason !== undefined && typeof value.unavailableReason !== "string") {
    return null;
  }
  return {
    hostStatus,
    hostStatuses,
    hosts,
    consent: {
      streaming: consent.streaming,
      agentAccess: consent.agentAccess,
      peerSharing: consent.peerSharing,
    },
    devices,
    sessions,
    toolVersions: { hub: toolVersions.hub, agent: toolVersions.agent },
    ...(value.unavailableReason === undefined
      ? {}
      : { unavailableReason: value.unavailableReason }),
  };
}

/** Rejects anything that is not a live grant for a loopback proxy. */
export function parseDeviceStreamGrant(value: unknown, now = Date.now()): DeviceStreamGrant | null {
  if (!isRecord(value)) return null;
  const { origin, token, expiresAt } = value;
  if (typeof origin !== "string" || typeof token !== "string") return null;
  const port = LOOPBACK_ORIGIN_PATTERN.exec(origin)?.[1];
  if (!port || Number(port) > 65_535) return null;
  if (!TOKEN_PATTERN.test(token)) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { origin, token, expiresAt };
}

export type DeviceAppearance = "light" | "dark";
export const DEVICE_TEXT_SIZES = ["small", "default", "large", "extra-large"] as const;
export type DeviceTextSize = (typeof DEVICE_TEXT_SIZES)[number];
/** `xcrun simctl privacy` services, plus notifications, which serve-sim's CLI changes. */
export const DEVICE_PERMISSIONS = [
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "motion",
  "media-library",
  "faceid",
  "location",
  "notifications",
] as const;
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];
export type DevicePermissionDecision = "grant" | "revoke" | "reset";
/** Accessibility switches. Increase Contrast goes through `simctl ui`; the rest through serve-sim's helper. */
export const DEVICE_TOGGLES = [
  "reduceMotion",
  "increaseContrast",
  "reduceTransparency",
  "showBorders",
  "voiceOver",
] as const;
export type DeviceToggle = (typeof DEVICE_TOGGLES)[number];
export const DEVICE_LIQUID_GLASS = ["clear", "tinted"] as const;
export type DeviceLiquidGlass = (typeof DEVICE_LIQUID_GLASS)[number];
export const DEVICE_COLOR_FILTERS = ["none", "grayscale", "red-green", "green-red", "blue-yellow"] as const;
export type DeviceColorFilter = (typeof DEVICE_COLOR_FILTERS)[number];
/** APNs caps a payload at 4 KB; the simulator enforces the same limit. */
export const MAX_DEVICE_PUSH_PAYLOAD_BYTES = 4096;

interface DeviceActionTarget {
  hostId: string;
  deviceId: string;
}

export type DeviceActionInput = DeviceActionTarget &
  (
    | { type: "setAppearance"; value: DeviceAppearance }
    | { type: "setTextSize"; value: DeviceTextSize }
    | { type: "setToggle"; setting: DeviceToggle; value: boolean }
    | { type: "setLiquidGlass"; value: DeviceLiquidGlass }
    | { type: "setColorFilter"; value: DeviceColorFilter }
    | { type: "openUrl"; url: string }
    | { type: "launchApp"; appId: string }
    | { type: "terminateApp"; appId: string }
    /** An APNs-style payload; a bare string becomes the alert body. */
    | { type: "sendPush"; appId: string; payload: string | Record<string, unknown> }
    | {
        type: "setPermission";
        permission: DevicePermission;
        decision: DevicePermissionDecision;
        appId: string;
      }
    | { type: "setLocation"; latitude: number; longitude: number }
    | { type: "clearLocation" }
  );
export type DeviceActionType = DeviceActionInput["type"];

/** What the settings read could determine; an unknown value is simply absent. */
export interface DeviceSettings {
  appearance?: DeviceAppearance;
  textSize?: DeviceTextSize;
  reduceMotion?: boolean;
  increaseContrast?: boolean;
  reduceTransparency?: boolean;
  showBorders?: boolean;
  voiceOver?: boolean;
  liquidGlass?: DeviceLiquidGlass;
  colorFilter?: DeviceColorFilter;
}

const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const APP_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]{0,31}):/iu;
/** Schemes that would reach the local filesystem or run script instead of opening an app or page. */
const REFUSED_URL_SCHEMES = new Set(["file", "javascript", "data", "vbscript", "blob"]);
const MAX_DEVICE_URL_LENGTH = 2048;

function isDeviceUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_DEVICE_URL_LENGTH) return false;
  if (/\s/u.test(value)) return false;
  if (Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return false;
  }
  const scheme = URL_SCHEME_PATTERN.exec(value)?.[1]?.toLowerCase();
  if (!scheme || REFUSED_URL_SCHEMES.has(scheme)) return false;
  if (scheme === "http" || scheme === "https") {
    try {
      return Boolean(new URL(value).hostname);
    } catch {
      return false;
    }
  }
  return true;
}

function isAppId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && APP_ID_PATTERN.test(value);
}

function isPushPayload(value: unknown): value is string | Record<string, unknown> {
  if (typeof value === "string") return value.trim().length > 0 && value.length <= MAX_DEVICE_PUSH_PAYLOAD_BYTES;
  if (!isRecord(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_DEVICE_PUSH_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function inRange(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** Fail-closed parse of a renderer (or, later, agent) request for one typed simulator action. */
export function parseDeviceActionInput(value: unknown): DeviceActionInput | null {
  if (!isRecord(value)) return null;
  const { hostId, deviceId, type } = value;
  if (!isHostId(hostId)) return null;
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) return null;
  const target = { hostId, deviceId };
  switch (type) {
    case "setAppearance":
      return value.value === "light" || value.value === "dark"
        ? { ...target, type, value: value.value }
        : null;
    case "setTextSize":
      return (DEVICE_TEXT_SIZES as readonly unknown[]).includes(value.value)
        ? { ...target, type, value: value.value as DeviceTextSize }
        : null;
    case "setToggle":
      return (DEVICE_TOGGLES as readonly unknown[]).includes(value.setting) && typeof value.value === "boolean"
        ? { ...target, type, setting: value.setting as DeviceToggle, value: value.value }
        : null;
    case "setLiquidGlass":
      return (DEVICE_LIQUID_GLASS as readonly unknown[]).includes(value.value)
        ? { ...target, type, value: value.value as DeviceLiquidGlass }
        : null;
    case "setColorFilter":
      return (DEVICE_COLOR_FILTERS as readonly unknown[]).includes(value.value)
        ? { ...target, type, value: value.value as DeviceColorFilter }
        : null;
    case "openUrl":
      return isDeviceUrl(value.url) ? { ...target, type, url: value.url } : null;
    case "launchApp":
    case "terminateApp":
      return isAppId(value.appId) ? { ...target, type, appId: value.appId } : null;
    case "sendPush":
      return isAppId(value.appId) && isPushPayload(value.payload)
        ? { ...target, type, appId: value.appId, payload: value.payload }
        : null;
    case "setPermission": {
      const { permission, decision, appId } = value;
      if (!(DEVICE_PERMISSIONS as readonly unknown[]).includes(permission)) return null;
      if (decision !== "grant" && decision !== "revoke" && decision !== "reset") return null;
      if (!isAppId(appId)) return null;
      return { ...target, type, permission: permission as DevicePermission, decision, appId };
    }
    case "setLocation":
      return inRange(value.latitude, 90) && inRange(value.longitude, 180)
        ? { ...target, type, latitude: value.latitude, longitude: value.longitude }
        : null;
    case "clearLocation":
      return { ...target, type };
    default:
      return null;
  }
}

export function parseDeviceSettings(value: unknown): DeviceSettings | null {
  if (!isRecord(value)) return null;
  const settings: DeviceSettings = {};
  if (value.appearance !== undefined) {
    if (value.appearance !== "light" && value.appearance !== "dark") return null;
    settings.appearance = value.appearance;
  }
  if (value.textSize !== undefined) {
    if (!(DEVICE_TEXT_SIZES as readonly unknown[]).includes(value.textSize)) return null;
    settings.textSize = value.textSize as DeviceTextSize;
  }
  for (const toggle of DEVICE_TOGGLES) {
    if (value[toggle] === undefined) continue;
    if (typeof value[toggle] !== "boolean") return null;
    settings[toggle] = value[toggle];
  }
  if (value.liquidGlass !== undefined) {
    if (!(DEVICE_LIQUID_GLASS as readonly unknown[]).includes(value.liquidGlass)) return null;
    settings.liquidGlass = value.liquidGlass as DeviceLiquidGlass;
  }
  if (value.colorFilter !== undefined) {
    if (!(DEVICE_COLOR_FILTERS as readonly unknown[]).includes(value.colorFilter)) return null;
    settings.colorFilter = value.colorFilter as DeviceColorFilter;
  }
  return settings;
}
