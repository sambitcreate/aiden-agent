/** Simulator devices cross the renderer ↔ main boundary only through these fail-closed shapes. */
import {
  parseDeviceToolVersions,
  parseSshDeviceHostConfigs,
  type DeviceToolVersions,
  type SshDeviceHostConfig,
} from "./device-ssh-hosts.js";
export const DEVICE_PLATFORMS = ["ios", "android"] as const;
/** iOS Simulators (serve-sim) and Android Emulators (serve-emu), both streamed by expo-device-hub. */
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const DEVICE_PLATFORM_LABELS: Record<DevicePlatform, string> = { ios: "iOS", android: "Android" };
/**
 * A simulator UDID, an adb serial (`emulator-5554`), or an AVD name while the
 * emulator is not running (`Pixel_9_API_35`). The first character is
 * alphanumeric so an id can never be read as a command-line flag.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** `peer` is a paired Aiden desktop sharing its simulators (Phase 5). */
export type DeviceHostKind = "local" | "peer" | "ssh";
export const LOCAL_DEVICE_HOST_ID = "local";
/** Local is `local`; a paired desktop uses its Aiden Remote instance ID. */
export const DEVICE_HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
/** Android emulators are `other`; the platform tells them apart from unknown Apple devices. */
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
/** Whether a host can run one platform. Missing toolchains are reported, not hidden, so the tab can say why. */
export interface DevicePlatformAvailability {
  platform: DevicePlatform;
  available: boolean;
  reason?: string;
}
/** One device host the Simulator tab can show, local first. */
export interface DeviceHostInfo extends DeviceHostState {
  id: string;
  kind: DeviceHostKind;
  name: string;
  /** Installed, running, and pinned helper versions, when known. SSH hosts report them after a check or connect. */
  tools?: DeviceToolVersions;
  /** Why the last version check failed. Installed tools were not changed. */
  toolInspectionError?: string;
  /** Per-platform availability, once the host has been checked. Paired Macs do not report it. */
  platforms?: DevicePlatformAvailability[];
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
  /** Configured SSH device hosts, in the order Settings shows them. */
  sshHosts?: SshDeviceHostConfig[];
}
/** Shown before anything is downloaded from npm, in the panel and in Settings. */
export const DEVICE_SETUP_NOTICE =
  "Setup downloads two pinned helper tools, expo-device-hub and agent-device, from npm into Aiden's app data. " +
  "Installing them also lets node-datachannel download its prebuilt native binary. " +
  "Nothing is sent about your chats, and the simulators stay on this Mac.";
export type DeviceToolId = "hub" | "agent";
/** One pinned helper and the completed installs of it on this Mac. */
export interface DeviceToolInfo {
  id: DeviceToolId;
  name: string;
  pinned: string;
  installed: string[];
}
export interface DeviceToolchainState {
  tools: DeviceToolInfo[];
}
const TOOL_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/u;
const TOOL_NAME_PATTERN = /^[a-z0-9@/._-]{1,120}$/u;

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

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === "ios" || value === "android";
}

function parsePlatformAvailability(value: unknown): DevicePlatformAvailability | null {
  if (!isRecord(value) || !isDevicePlatform(value.platform) || typeof value.available !== "boolean") return null;
  if (value.reason !== undefined && typeof value.reason !== "string") return null;
  return {
    platform: value.platform,
    available: value.available,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function parseHostInfo(value: unknown): DeviceHostInfo | null {
  if (!isRecord(value)) return null;
  const state = parseHostState(value);
  const { id, kind, name } = value;
  if (!state || !isHostId(id) || !nonEmptyString(name)) return null;
  if (kind !== "local" && kind !== "peer" && kind !== "ssh") return null;
  let tools: DeviceToolVersions | undefined;
  if (value.tools !== undefined) {
    const parsed = parseDeviceToolVersions(value.tools);
    if (!parsed) return null;
    tools = parsed;
  }
  if (value.toolInspectionError !== undefined && typeof value.toolInspectionError !== "string") return null;
  let platforms: DevicePlatformAvailability[] | undefined;
  if (value.platforms !== undefined) {
    const parsed = parseList(value.platforms, parsePlatformAvailability);
    if (!parsed) return null;
    platforms = parsed;
  }
  return {
    id,
    kind,
    name,
    ...state,
    ...(tools ? { tools } : {}),
    ...(typeof value.toolInspectionError === "string" ? { toolInspectionError: value.toolInspectionError } : {}),
    ...(platforms ? { platforms } : {}),
  };
}

function parseDevice(value: unknown): DeviceSummary | null {
  if (!isRecord(value)) return null;
  const { hostId, id, name, platform, version, booted, kind } = value;
  if (!isHostId(hostId) || !nonEmptyString(id) || !nonEmptyString(name)) return null;
  if (!isDevicePlatform(platform) || typeof version !== "string" || typeof booted !== "boolean") return null;
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
  let sshHosts: SshDeviceHostConfig[] | undefined;
  if (value.sshHosts !== undefined) {
    const parsed = parseSshDeviceHostConfigs(value.sshHosts);
    if (!parsed) return null;
    sshHosts = parsed;
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
    ...(sshHosts ? { sshHosts } : {}),
  };
}

function parseToolInfo(value: unknown): DeviceToolInfo | null {
  if (!isRecord(value)) return null;
  const { id, name, pinned, installed } = value;
  if (id !== "hub" && id !== "agent") return null;
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) return null;
  if (typeof pinned !== "string" || !TOOL_VERSION_PATTERN.test(pinned)) return null;
  if (!Array.isArray(installed) || installed.length > 64) return null;
  const versions: string[] = [];
  for (const version of installed) {
    if (typeof version !== "string" || !TOOL_VERSION_PATTERN.test(version)) return null;
    versions.push(version);
  }
  return { id, name, pinned, installed: versions };
}

export function parseDeviceToolchainState(value: unknown): DeviceToolchainState | null {
  if (!isRecord(value)) return null;
  const tools = parseList(value.tools, parseToolInfo);
  return tools ? { tools } : null;
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
/** The permission groups `adb shell pm grant|revoke` can change; each maps to one or more runtime permissions. */
export const ANDROID_DEVICE_PERMISSIONS = [
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "location",
  "notifications",
  "motion",
] as const satisfies readonly DevicePermission[];
export type DevicePermissionDecision = "grant" | "revoke" | "reset";
/**
 * Device switches. On iOS, Increase Contrast goes through `simctl ui` and the
 * rest through serve-sim's helper. Android supports Reduce Motion (animation
 * scales) and the network switch (`svc wifi` and `svc data`).
 */
export const DEVICE_TOGGLES = [
  "reduceMotion",
  "increaseContrast",
  "reduceTransparency",
  "showBorders",
  "voiceOver",
  "networkEnabled",
] as const;
export type DeviceToggle = (typeof DEVICE_TOGGLES)[number];
export const DEVICE_PLATFORM_TOGGLES: Record<DevicePlatform, readonly DeviceToggle[]> = {
  ios: ["reduceMotion", "increaseContrast", "reduceTransparency", "showBorders", "voiceOver"],
  android: ["reduceMotion", "networkEnabled"],
};
export const DEVICE_ORIENTATIONS = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"] as const;
export type DeviceOrientationValue = (typeof DEVICE_ORIENTATIONS)[number];
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
    /** Android only: tilts the emulator's accelerometer so the display really rotates. */
    | { type: "setOrientation"; value: DeviceOrientationValue }
  );
export type DeviceActionType = DeviceActionInput["type"];

const IOS_ACTIONS: ReadonlySet<DeviceActionType> = new Set([
  "setAppearance",
  "setTextSize",
  "setToggle",
  "setLiquidGlass",
  "setColorFilter",
  "openUrl",
  "launchApp",
  "terminateApp",
  "sendPush",
  "setPermission",
  "setLocation",
  "clearLocation",
]);
const ANDROID_ACTIONS: ReadonlySet<DeviceActionType> = new Set([
  "setAppearance",
  "setTextSize",
  "setToggle",
  "setOrientation",
  "openUrl",
  "launchApp",
  "terminateApp",
  "setPermission",
  "setLocation",
  "clearLocation",
]);

/** Adapted from t3code DeviceActions `supportsAction` @ a6ec88f7 (MIT): what each platform can actually do. */
export function deviceActionSupported(
  platform: DevicePlatform,
  input: Pick<DeviceActionInput, "type"> & { setting?: unknown; permission?: unknown },
): boolean {
  if (!(platform === "ios" ? IOS_ACTIONS : ANDROID_ACTIONS).has(input.type)) return false;
  if (input.type === "setToggle") {
    return (DEVICE_PLATFORM_TOGGLES[platform] as readonly unknown[]).includes(input.setting);
  }
  if (input.type === "setPermission" && platform === "android") {
    return (ANDROID_DEVICE_PERMISSIONS as readonly unknown[]).includes(input.permission);
  }
  return true;
}

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
  /** Android: Wi-Fi and mobile data are both on. */
  networkEnabled?: boolean;
  /** Android: the package that holds window focus, read with the settings. iOS uses serve-sim's feed instead. */
  foregroundApp?: string;
}

/** A bundle ID or Android package name. Starts alphanumeric so it can never be read as a flag. */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/u;
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
    case "setOrientation":
      return (DEVICE_ORIENTATIONS as readonly unknown[]).includes(value.value)
        ? { ...target, type, value: value.value as DeviceOrientationValue }
        : null;
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
  if (value.foregroundApp !== undefined) {
    if (!isAppId(value.foregroundApp)) return null;
    settings.foregroundApp = value.foregroundApp;
  }
  return settings;
}
