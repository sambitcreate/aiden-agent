/**
 * Adapted from t3code apps/server/src/device/DeviceActions.ts @ a6ec88f7 (MIT)
 *
 * Typed Android Emulator actions for the device tools drawer, the rail, and
 * paired Macs. Every action is one or more `adb` execs with an argv array and
 * no host shell. `adb shell` joins its arguments into one command line for the
 * device's own shell, so every argument after `shell` is quoted for that shell
 * here. Inputs are already validated by `parseDeviceActionInput`.
 */
import {
  deviceActionSupported,
  type DeviceActionInput,
  type DeviceOrientationValue,
  type DevicePermission,
  type DeviceSettings,
  type DeviceTextSize,
} from "../../../renderer/shared/devices.js";
import { DeviceActionUnavailableError, type DeviceActionCommand } from "./device-actions.js";
import type { DeviceHostReady } from "./device-host.js";

const ADB_ACTION_TIMEOUT_MS = 30_000;
const ADB_SETTINGS_TIMEOUT_MS = 10_000;

/** Android `font_scale` values for the four shared text-size steps. */
const ANDROID_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: "0.85",
  default: "1.0",
  large: "1.15",
  "extra-large": "1.3",
};

export function textSizeFromAndroid(scale: number): DeviceTextSize {
  if (scale <= 0.9) return "small";
  if (scale >= 1.25) return "extra-large";
  if (scale >= 1.1) return "large";
  return "default";
}

/** Aiden permission groups -> Android runtime permissions. */
export const ANDROID_RUNTIME_PERMISSIONS: Partial<Record<DevicePermission, readonly string[]>> = {
  camera: ["android.permission.CAMERA"],
  microphone: ["android.permission.RECORD_AUDIO"],
  photos: ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE"],
  contacts: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
  calendar: ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
  location: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
  motion: ["android.permission.ACTIVITY_RECOGNITION"],
};

// Gravity (x:y:z) that makes the emulator's accelerometer report each orientation,
// and the window-manager rotation index for a device without that sensor.
const ANDROID_GRAVITY: Record<DeviceOrientationValue, string> = {
  portrait: "0:9.81:0",
  landscape_left: "9.81:0:0",
  portrait_upside_down: "0:-9.81:0",
  landscape_right: "-9.81:0:0",
};
const ANDROID_ROTATION: Record<DeviceOrientationValue, string> = {
  portrait: "0",
  landscape_left: "1",
  portrait_upside_down: "2",
  landscape_right: "3",
};

const ANIMATION_SCALES = ["animator_duration_scale", "transition_animation_scale", "window_animation_scale"] as const;

const DEVICE_SHELL_SAFE = /^[A-Za-z0-9_./:=@%+,-]+$/u;

/** Quotes one argument for the device's `sh`, which parses the line `adb shell` sends. */
export function deviceShellQuote(value: string): string {
  return DEVICE_SHELL_SAFE.test(value) ? value : `'${value.split("'").join(`'"'"'`)}'`;
}

/** One Android step. A step marked `optional` may fail, e.g. a permission the app never declared. */
export interface AndroidActionStep extends DeviceActionCommand {
  optional?: boolean;
}

function adb(serial: string, ...args: string[]): AndroidActionStep {
  return { command: "adb", args: ["-s", serial, ...args] };
}

function adbShell(serial: string, ...args: string[]): AndroidActionStep {
  return adb(serial, "shell", ...args.map(deviceShellQuote));
}

/** Emulator serials are `emulator-<port>`; anything else is a physical device. */
export const isEmulatorSerial = (serial: string): boolean => /^emulator-\d+$/u.test(serial);

/** The complete, ordered argv list for one Android action. */
export function androidActionCommands(input: DeviceActionInput): AndroidActionStep[] {
  if (!deviceActionSupported("android", input)) {
    throw new DeviceActionUnavailableError("Android Emulators do not support this setting.");
  }
  const serial = input.deviceId;
  switch (input.type) {
    case "setAppearance":
      return [adbShell(serial, "cmd", "uimode", "night", input.value === "dark" ? "yes" : "no")];
    case "setTextSize":
      return [adbShell(serial, "settings", "put", "system", "font_scale", ANDROID_TEXT_SIZES[input.value])];
    case "setToggle":
      if (input.setting === "networkEnabled") {
        const state = input.value ? "enable" : "disable";
        return [adbShell(serial, "svc", "wifi", state), adbShell(serial, "svc", "data", state)];
      }
      // Reduce Motion is the developer animation scales at 0.
      return ANIMATION_SCALES.map((key) =>
        adbShell(serial, "settings", "put", "global", key, input.value ? "0" : "1"),
      );
    case "setOrientation":
      // `user-rotation lock` only rotates window content on recent images; the
      // display the encoder captures stays put. Tilting the emulator's
      // accelerometer rotates it for real.
      if (isEmulatorSerial(serial)) {
        return [
          adbShell(serial, "settings", "put", "system", "accelerometer_rotation", "1"),
          adbShell(serial, "cmd", "window", "user-rotation", "free"),
          adb(serial, "emu", "sensor", "set", "acceleration", ANDROID_GRAVITY[input.value]),
        ];
      }
      return [adbShell(serial, "cmd", "window", "user-rotation", "lock", ANDROID_ROTATION[input.value])];
    case "setLocation":
      // The emulator console takes longitude first.
      return [adb(serial, "emu", "geo", "fix", String(input.longitude), String(input.latitude))];
    case "clearLocation":
      // The emulator has no "clear"; the last fix stays, so this only re-reads the settings.
      return [];
    case "setPermission": {
      const verb = input.decision === "grant" ? "grant" : "revoke";
      return (ANDROID_RUNTIME_PERMISSIONS[input.permission] ?? []).map((permission) => ({
        ...adbShell(serial, "pm", verb, input.appId, permission),
        // Not every app declares every permission in a group.
        optional: true,
      }));
    }
    case "openUrl":
      return [adbShell(serial, "am", "start", "-a", "android.intent.action.VIEW", "-d", input.url)];
    case "launchApp":
      return [adbShell(serial, "monkey", "-p", input.appId, "-c", "android.intent.category.LAUNCHER", "1")];
    case "terminateApp":
      return [adbShell(serial, "am", "force-stop", input.appId)];
    default:
      throw new DeviceActionUnavailableError("Android Emulators do not support this setting.");
  }
}

const ACTION_LABELS: Record<DeviceActionInput["type"], string> = {
  setAppearance: "change the appearance",
  setTextSize: "change the text size",
  setToggle: "change the setting",
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

export async function runAndroidDeviceAction(ready: DeviceHostReady, input: DeviceActionInput): Promise<void> {
  for (const step of androidActionCommands(input)) {
    const result = await ready.run(step.command, step.args, { timeoutMs: ADB_ACTION_TIMEOUT_MS });
    // `adb emu` reports console failures as "KO:" on stdout with exit code 0.
    const failed = result.code !== 0 || /^KO\b/mu.test(result.stdout);
    if (failed && !step.optional) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-1)[0]?.trim();
      throw new Error(`The emulator could not ${ACTION_LABELS[input.type]}${detail ? `: ${detail}` : "."}`);
    }
  }
}

/** The package that holds window focus, from `dumpsys window`. */
export function parseAndroidFocusedPackage(dump: string): string | undefined {
  const match = /m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ }]+)[/ }]/u.exec(dump);
  const name = match?.[1];
  return name && /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/u.test(name) ? name : undefined;
}

/** Reads what `adb shell` reports. Each failed read just leaves its setting unknown. */
export async function readAndroidDeviceSettings(ready: DeviceHostReady, serial: string): Promise<DeviceSettings> {
  const read = async (...args: string[]): Promise<string | undefined> => {
    try {
      const step = adbShell(serial, ...args);
      const result = await ready.run(step.command, step.args, { timeoutMs: ADB_SETTINGS_TIMEOUT_MS });
      const value = result.stdout.trim();
      return result.code === 0 && value ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const [night, fontScale, animator, wifi, focus] = await Promise.all([
    read("cmd", "uimode", "night"),
    read("settings", "get", "system", "font_scale"),
    read("settings", "get", "global", "animator_duration_scale"),
    read("settings", "get", "global", "wifi_on"),
    // `dumpsys window windows` stopped printing the focus on API 36; the unfiltered dump still does.
    read("dumpsys", "window"),
  ]);
  const scale = fontScale && fontScale !== "null" ? Number(fontScale) : Number.NaN;
  const animatorScale = animator && animator !== "null" ? Number(animator) : Number.NaN;
  const foregroundApp = focus ? parseAndroidFocusedPackage(focus) : undefined;
  const appearance = night?.includes("yes") ? "dark" : night?.includes("no") ? "light" : undefined;
  return {
    ...(appearance ? { appearance } : {}),
    ...(Number.isFinite(scale) ? { textSize: textSizeFromAndroid(scale) } : {}),
    ...(Number.isFinite(animatorScale) ? { reduceMotion: animatorScale === 0 } : {}),
    ...(wifi === "1" || wifi === "0" ? { networkEnabled: wifi === "1" } : {}),
    ...(foregroundApp ? { foregroundApp } : {}),
  };
}
