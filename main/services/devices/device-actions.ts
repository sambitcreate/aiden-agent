/**
 * Adapted from t3code apps/server/src/device/DeviceActions.ts @ 1c127066 (MIT)
 *
 * Typed simulator actions for the Simulator tab and the agent. Each action is
 * exactly one exec with an argv array. It never uses a shell, and it never uses
 * the hub's exec route. Most actions are `xcrun simctl`. The accessibility
 * switches spawn serve-sim's bundled `serve-sim-ax-settings` inside the
 * simulator. Notification permission runs serve-sim's CLI, because `simctl
 * privacy` has no notifications service. Both steps follow T3.
 */
import {
  MAX_DEVICE_PUSH_PAYLOAD_BYTES,
  type DeviceActionInput,
  type DeviceColorFilter,
  type DevicePermission,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceTextSize,
  type DeviceToggle,
} from "../../../renderer/shared/devices.js";
import { DEVICE_CLIPBOARD_MAX_BYTES, checkDeviceClipboardText } from "../../../renderer/shared/device-features.js";
import type { DeviceCommandOptions, DeviceHostReady } from "./device-host.js";

const SIMCTL_ACTION_TIMEOUT_MS = 30_000;
const SIMCTL_SETTINGS_TIMEOUT_MS = 10_000;

// iOS content-size categories for the four shared steps. `default` is what a
// fresh simulator reports ("large").
const IOS_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: "small",
  default: "large",
  large: "extra-extra-large",
  "extra-large": "accessibility-large",
};

export function textSizeFromIos(category: string): DeviceTextSize {
  const entry = (Object.entries(IOS_TEXT_SIZES) as Array<[DeviceTextSize, string]>).find(
    ([, value]) => value === category,
  );
  if (entry) return entry[0];
  if (category.startsWith("accessibility")) return "extra-large";
  if (category.includes("extra")) return "large";
  return category === "extra-small" || category === "small" || category === "medium" ? "small" : "default";
}

// Aiden permission names -> the `simctl privacy` service. Notifications have none.
const IOS_PRIVACY_SERVICES: Record<Exclude<DevicePermission, "notifications">, string> = {
  camera: "camera",
  microphone: "microphone",
  photos: "photos",
  contacts: "contacts",
  calendar: "calendar",
  reminders: "reminders",
  motion: "motion",
  "media-library": "media-library",
  faceid: "faceid",
  location: "location",
};

// Aiden toggle names -> `serve-sim-ax-settings` options. Increase Contrast uses `simctl ui`;
// the network switch is Android-only.
const IOS_AX_TOGGLES: Record<Exclude<DeviceToggle, "increaseContrast" | "networkEnabled">, string> = {
  reduceMotion: "reduce-motion",
  reduceTransparency: "reduce-transparency",
  showBorders: "show-borders",
  voiceOver: "voiceover",
};

/** The helper an action needs is not in this hub install. */
export class DeviceActionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceActionUnavailableError";
  }
}

export interface DeviceActionCommand {
  command: string;
  args: string[];
  options?: Pick<DeviceCommandOptions, "stdin" | "env">;
}

/** `simctl <verb> <udid> …rest`: every per-device subcommand takes the UDID second. */
function simctl(udid: string, verb: string, ...rest: string[]): DeviceActionCommand {
  return { command: "xcrun", args: ["simctl", verb, udid, ...rest] };
}

function axSettings(ready: Pick<DeviceHostReady, "helpers">, udid: string, ...rest: string[]): DeviceActionCommand {
  const helper = ready.helpers.axSettings;
  if (!helper) {
    throw new DeviceActionUnavailableError("This simulator helper version cannot change accessibility settings.");
  }
  return { command: "xcrun", args: ["simctl", "spawn", udid, helper, ...rest] };
}

function pushPayload(payload: string | Record<string, unknown>): string {
  const body = JSON.stringify(typeof payload === "string" ? { aps: { alert: payload } } : payload);
  if (new TextEncoder().encode(body).length > MAX_DEVICE_PUSH_PAYLOAD_BYTES) {
    throw new DeviceActionUnavailableError("The notification payload is larger than 4 KB.");
  }
  return body;
}

/** The complete command for one action. Inputs are already parsed by `parseDeviceActionInput`. */
export function iosActionCommand(
  ready: Pick<DeviceHostReady, "helpers" | "nodePath">,
  input: DeviceActionInput,
): DeviceActionCommand {
  const udid = input.deviceId;
  switch (input.type) {
    case "setAppearance":
      return simctl(udid, "ui", "appearance", input.value);
    case "setTextSize":
      return simctl(udid, "ui", "content_size", IOS_TEXT_SIZES[input.value]);
    case "setToggle":
      if (input.setting === "increaseContrast") {
        return simctl(udid, "ui", "increase_contrast", input.value ? "enabled" : "disabled");
      }
      if (input.setting === "networkEnabled") {
        throw new DeviceActionUnavailableError("iOS Simulators cannot turn the network off.");
      }
      return axSettings(ready, udid, "set", IOS_AX_TOGGLES[input.setting], input.value ? "on" : "off");
    case "setLiquidGlass":
      return axSettings(ready, udid, "set", "liquid-glass", input.value);
    case "setColorFilter":
      return axSettings(ready, udid, "set", "color-filter", input.value);
    case "openUrl":
      return simctl(udid, "openurl", input.url);
    case "launchApp":
      return simctl(udid, "launch", input.appId);
    case "terminateApp":
      return simctl(udid, "terminate", input.appId);
    case "sendPush":
      return {
        ...simctl(udid, "push", input.appId, "-"),
        options: { stdin: pushPayload(input.payload) },
      };
    case "setPermission": {
      if (input.permission === "notifications") {
        const cli = ready.helpers.serveSimCli;
        if (!cli) {
          throw new DeviceActionUnavailableError(
            "This simulator helper version cannot change notification permissions.",
          );
        }
        return {
          command: ready.nodePath,
          args: [cli, "permissions", input.decision, "notifications", input.appId, "-d", udid],
          options: { env: { ELECTRON_RUN_AS_NODE: "1" } },
        };
      }
      return simctl(udid, "privacy", input.decision, IOS_PRIVACY_SERVICES[input.permission], input.appId);
    }
    case "setLocation":
      return simctl(udid, "location", "set", `${input.latitude},${input.longitude}`);
    case "clearLocation":
      return simctl(udid, "location", "clear");
    case "setOrientation":
      throw new DeviceActionUnavailableError("Rotate an iOS Simulator with the rail's Rotate button.");
  }
}

const ACTION_LABELS: Record<DeviceActionInput["type"], string> = {
  setAppearance: "change the appearance",
  setTextSize: "change the text size",
  setToggle: "change the accessibility setting",
  setLiquidGlass: "change Liquid Glass",
  setColorFilter: "change the color filter",
  openUrl: "open the link",
  launchApp: "launch the app",
  terminateApp: "quit the app",
  sendPush: "deliver the notification",
  setPermission: "change the permission",
  setLocation: "set the location",
  clearLocation: "clear the location",
  setOrientation: "rotate",
};

export async function runDeviceAction(ready: DeviceHostReady, input: DeviceActionInput): Promise<void> {
  const { command, args, options } = iosActionCommand(ready, input);
  const result = await ready.run(command, args, { timeoutMs: SIMCTL_ACTION_TIMEOUT_MS, ...options });
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-1)[0]?.trim();
    throw new Error(`The simulator could not ${ACTION_LABELS[input.type]}${detail ? `: ${detail}` : "."}`);
  }
}

const COLOR_FILTERS: readonly DeviceColorFilter[] = ["none", "grayscale", "red-green", "green-red", "blue-yellow"];

function parseAxStatus(stdout: string): DeviceSettings {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) return {};
  const record = status as Record<string, unknown>;
  const settings: DeviceSettings = {};
  for (const [toggle, option] of Object.entries(IOS_AX_TOGGLES) as Array<[keyof typeof IOS_AX_TOGGLES, string]>) {
    if (record[option] === "on" || record[option] === "off") settings[toggle] = record[option] === "on";
  }
  const glass = record["liquid-glass"];
  if (glass === "clear" || glass === "tinted") settings.liquidGlass = glass;
  const filter = record["color-filter"];
  if (COLOR_FILTERS.includes(filter as DeviceColorFilter)) settings.colorFilter = filter as DeviceColorFilter;
  return settings;
}

/** Reads what `simctl ui` and the accessibility helper report. Each failed read just leaves its settings unknown. */
export async function readDeviceSettings(ready: DeviceHostReady, udid: string): Promise<DeviceSettings> {
  const read = async (command: DeviceActionCommand): Promise<string | undefined> => {
    try {
      const result = await ready.run(command.command, command.args, { timeoutMs: SIMCTL_SETTINGS_TIMEOUT_MS });
      const value = result.stdout.trim();
      return result.code === 0 && value ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const uiValue = async (option: string) => (await read(simctl(udid, "ui", option)))?.toLowerCase();
  const axStatus = ready.helpers.axSettings ? read(axSettings(ready, udid, "status")) : Promise.resolve(undefined);
  const [appearance, contentSize, contrast, ax] = await Promise.all([
    uiValue("appearance"),
    uiValue("content_size"),
    uiValue("increase_contrast"),
    axStatus,
  ]);
  return {
    ...(appearance === "light" || appearance === "dark" ? { appearance } : {}),
    ...(contentSize ? { textSize: textSizeFromIos(contentSize) } : {}),
    ...(contrast === "enabled" || contrast === "disabled" ? { increaseContrast: contrast === "enabled" } : {}),
    ...(ax ? parseAxStatus(ax) : {}),
  };
}

// ── Device power features: erase, clipboard, and screen recording ───────────
// Each takes the target's platform so Android's adb variants can slot in
// beside iOS. Only iOS is implemented; any other platform is refused before
// anything runs.

type DeviceRun = DeviceHostReady["run"];
const SIMCTL_SHUTDOWN_TIMEOUT_MS = 60_000;
const SIMCTL_ERASE_TIMEOUT_MS = 120_000;
const SIMCTL_CLIPBOARD_TIMEOUT_MS = 15_000;

function requireIos(platform: DevicePlatform, feature: string): void {
  if (platform !== "ios") throw new DeviceActionUnavailableError(`${feature} is not available for this device yet.`);
}

function lastLine(stderr: string): string | undefined {
  return stderr.trim().split("\n").slice(-1)[0]?.trim() || undefined;
}

/** The two steps of an erase: `simctl erase` refuses a booted simulator, so it shuts down first. */
export function deviceEraseCommands(
  platform: DevicePlatform,
  udid: string,
): { shutdown: DeviceActionCommand; erase: DeviceActionCommand } {
  requireIos(platform, "Erasing");
  return { shutdown: simctl(udid, "shutdown"), erase: simctl(udid, "erase") };
}

export function deviceClipboardWriteCommand(platform: DevicePlatform, udid: string, text: string): DeviceActionCommand {
  requireIos(platform, "Pasting");
  return { ...simctl(udid, "pbcopy"), options: { stdin: text } };
}

export function deviceClipboardReadCommand(platform: DevicePlatform, udid: string): DeviceActionCommand {
  requireIos(platform, "Copying");
  return simctl(udid, "pbpaste");
}

/** A long-running recorder. SIGINT makes simctl finalize the file; H.264 plays everywhere. */
export function deviceRecordVideoCommand(platform: DevicePlatform, udid: string, file: string): DeviceActionCommand {
  requireIos(platform, "Screen recording");
  return { command: "xcrun", args: ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file] };
}

export type DeviceErasePhase = "shutting-down" | "erasing" | "erased";

/**
 * Shuts a booted simulator down, then erases all of its content and settings.
 * A shutdown that loses a race with another one (the simulator is already
 * off) still erases. A failed shutdown never erases.
 */
export async function eraseDevice(
  run: DeviceRun,
  input: { platform: DevicePlatform; deviceId: string; booted: boolean },
  onPhase: (phase: DeviceErasePhase) => void = () => undefined,
): Promise<{ wasBooted: boolean }> {
  const commands = deviceEraseCommands(input.platform, input.deviceId);
  if (input.booted) {
    onPhase("shutting-down");
    const result = await run(commands.shutdown.command, commands.shutdown.args, {
      timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS,
    });
    if (result.code !== 0 && !/current state: Shutdown/iu.test(result.stderr)) {
      const detail = lastLine(result.stderr);
      throw new Error(`The simulator did not shut down, so it was not erased${detail ? `: ${detail}` : "."}`);
    }
  }
  onPhase("erasing");
  const result = await run(commands.erase.command, commands.erase.args, { timeoutMs: SIMCTL_ERASE_TIMEOUT_MS });
  if (result.code !== 0) {
    const detail = lastLine(result.stderr);
    throw new Error(`The simulator could not be erased${detail ? `: ${detail}` : "."}`);
  }
  onPhase("erased");
  return { wasBooted: input.booted };
}

/** Puts text on the simulator's pasteboard. The caller sends Cmd+V so the focused field receives it. */
export async function writeDeviceClipboard(
  run: DeviceRun,
  input: { platform: DevicePlatform; deviceId: string },
  value: unknown,
): Promise<{ bytes: number }> {
  const checked = checkDeviceClipboardText(value);
  if (!checked.ok) throw new Error(checked.reason);
  const command = deviceClipboardWriteCommand(input.platform, input.deviceId, checked.text);
  const result = await run(command.command, command.args, {
    timeoutMs: SIMCTL_CLIPBOARD_TIMEOUT_MS,
    ...command.options,
  });
  if (result.code !== 0) {
    const detail = lastLine(result.stderr);
    throw new Error(`The simulator clipboard could not be set${detail ? `: ${detail}` : "."}`);
  }
  return { bytes: checked.bytes };
}

/** Reads the simulator's pasteboard text. Empty, non-text, and oversized contents are refused. */
export async function readDeviceClipboard(
  run: DeviceRun,
  input: { platform: DevicePlatform; deviceId: string },
): Promise<{ text: string; bytes: number }> {
  const command = deviceClipboardReadCommand(input.platform, input.deviceId);
  const result = await run(command.command, command.args, { timeoutMs: SIMCTL_CLIPBOARD_TIMEOUT_MS });
  if (result.code !== 0) {
    const detail = lastLine(result.stderr);
    throw new Error(`The simulator clipboard could not be read${detail ? `: ${detail}` : "."}`);
  }
  if (result.stdout.length === 0) throw new Error("The simulator clipboard has no text.");
  const checked = checkDeviceClipboardText(result.stdout);
  if (!checked.ok) throw new Error(`The simulator clipboard text is larger than ${DEVICE_CLIPBOARD_MAX_BYTES / 1024} KB.`);
  return { text: checked.text, bytes: checked.bytes };
}
