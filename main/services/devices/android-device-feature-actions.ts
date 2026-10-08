/**
 * The Android variants of the device power features: screen recording,
 * clipboard paste, and erase.
 *
 * Every builder is pure and returns argv for `adb` or for the SDK's
 * `emulator` binary. Nothing runs through a host shell. `adb shell` joins its
 * words into one line for the device's own `sh`, so every word after `shell`
 * is quoted for that shell, as in `android-device-actions.ts`.
 */
import { DEVICE_ID_PATTERN } from "../../../renderer/shared/devices.js";
import { deviceShellQuote } from "./android-device-actions.js";
import type { DeviceActionCommand } from "./device-actions.js";
import type { DeviceCommandResult, DeviceHostReady } from "./device-host.js";

/** `screenrecord` refuses longer segments on images before Android 14. */
export const ANDROID_SCREENRECORD_LIMIT_S = 180;
/** serve-emu cuts one `text` gesture at 300 bytes, so a paste is sent in pieces this size. */
export const ANDROID_TEXT_CHUNK_BYTES = 300;
const ADB_QUICK_TIMEOUT_MS = 10_000;

const RECORDING_ID = /^[A-Za-z0-9_-]{8,64}$/u;

function adb(serial: string, ...args: string[]): DeviceActionCommand {
  return { command: "adb", args: ["-s", serial, ...args] };
}

function adbShell(serial: string, ...args: string[]): DeviceActionCommand {
  return adb(serial, "shell", ...args.map(deviceShellQuote));
}

// ── Screen recording ───────────────────────────────────────────────────────

/** Where a recording is written on the emulator. The id comes from the recorder, never from a caller. */
export function androidRecordingRemotePath(recordingId: string): string {
  if (!RECORDING_ID.test(recordingId)) throw new Error("A valid recording id is required.");
  return `/sdcard/aiden-rec-${recordingId}.mp4`;
}

/** The long-running recorder. It writes an H.264 MP4 on the emulator; `adb pull` copies it here when it ends. */
export function androidScreenrecordCommand(
  serial: string,
  remotePath: string,
  limitSeconds = ANDROID_SCREENRECORD_LIMIT_S,
): DeviceActionCommand {
  const seconds = Math.max(1, Math.min(ANDROID_SCREENRECORD_LIMIT_S, Math.round(limitSeconds)));
  return adbShell(serial, "screenrecord", "--time-limit", String(seconds), remotePath);
}

/**
 * Stops one recording so it finalizes: SIGINT to the `screenrecord` whose
 * command line names this file, never another recorder on the device. The
 * local `adb shell` exits only after the remote process wrote the MP4 index.
 */
export function androidStopScreenrecordCommand(serial: string, remotePath: string): DeviceActionCommand {
  return adbShell(serial, "pkill", "-INT", "-f", remotePath);
}

/** Copies a finished recording to a private local file. `adb pull` takes paths, not a device shell line. */
export function androidPullCommand(serial: string, remotePath: string, localPath: string): DeviceActionCommand {
  return adb(serial, "pull", remotePath, localPath);
}

export function androidRemoveRemoteFileCommand(serial: string, remotePath: string): DeviceActionCommand {
  return adbShell(serial, "rm", "-f", remotePath);
}

// ── Clipboard paste ────────────────────────────────────────────────────────

/**
 * Splits text into pieces of at most `maxBytes` of UTF-8, never inside a
 * character, so serve-emu types each piece unchanged.
 */
export function chunkDeviceText(text: string, maxBytes = ANDROID_TEXT_CHUNK_BYTES): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let size = 0;
  for (const char of text) {
    const bytes = encoder.encode(char).byteLength;
    if (size + bytes > maxBytes && current) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Erase ──────────────────────────────────────────────────────────────────

/** Emulator console ports: even numbers from 5554, each paired with the adb port above it. */
export const ANDROID_EMULATOR_PORTS: readonly number[] = Array.from({ length: 64 }, (_, index) => 5554 + index * 2);

/** The lowest console port that no emulator in `adb devices` output uses. */
export function freeEmulatorPort(
  adbDevices: string,
  candidates: readonly number[] = ANDROID_EMULATOR_PORTS,
): number | null {
  const used = new Set<number>();
  for (const match of adbDevices.matchAll(/^emulator-(\d+)\s/gmu)) used.add(Number(match[1]));
  return candidates.find((port) => !used.has(port) && !used.has(port - 1) && !used.has(port + 1)) ?? null;
}

/**
 * The one-shot cold boot that resets an AVD. `-wipe-data` copies the system
 * image's initial user data back, and `-no-snapshot-load` keeps the old Quick
 * Boot snapshot from restoring the previous state. It runs headless.
 */
export function androidWipeBootCommand(avdName: string, port: number): DeviceActionCommand {
  if (!DEVICE_ID_PATTERN.test(avdName)) throw new Error("A valid Android Virtual Device is required.");
  return {
    command: "emulator",
    args: [
      "-avd",
      avdName,
      "-wipe-data",
      "-no-snapshot-load",
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-port",
      String(port),
    ],
  };
}

export function androidBootCompletedCommand(serial: string): DeviceActionCommand {
  return adbShell(serial, "getprop", "sys.boot_completed");
}

/** Asks the emulator to exit through its console. On exit it saves a Quick Boot snapshot of the fresh state. */
export function androidKillEmulatorCommand(serial: string): DeviceActionCommand {
  return adb(serial, "emu", "kill");
}

export type AndroidErasePhase = "shutting-down" | "erasing" | "erased";

export interface AndroidEraseDeps {
  run: DeviceHostReady["run"];
  /** Shuts the running emulator down through the hub, which waits until adb loses it. */
  shutdown(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** A wipe is a full cold boot; slow Macs and large images take a few minutes. */
export const ANDROID_ERASE_TIMEOUT_MS = 6 * 60_000;
export const ANDROID_ERASE_POLL_MS = 2_000;
/** The old emulator may still be writing its snapshot after adb lost it; its AVD stays locked until it exits. */
const ANDROID_ERASE_LOCK_RETRIES = 30;
/** What `emulator` prints, and exits 1 on, while another emulator holds the AVD. */
const AVD_IN_USE = /multiple emulators with the same AVD/iu;

function lastOutputLine(result: DeviceCommandResult): string | undefined {
  return `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.replace(/^[A-Z_]+\s*\|\s*/u, "").trim())
    .filter(Boolean)
    .slice(-1)[0];
}

/**
 * Resets an AVD to its factory state, as `simctl erase` does for iOS:
 *
 * 1. A running emulator shuts down through the hub. A failed shutdown never wipes.
 * 2. The AVD cold-boots once, headless, with `-wipe-data` on a free port.
 * 3. Once Android reports `sys.boot_completed`, the console asks it to exit,
 *    so the Quick Boot snapshot it saves is the fresh state, not the old one.
 *
 * The AVD is left shut down; the caller offers to boot it again.
 */
export async function eraseAndroidEmulator(
  deps: AndroidEraseDeps,
  input: { avdName: string; booted: boolean },
  onPhase: (phase: AndroidErasePhase) => void = () => undefined,
): Promise<void> {
  if (!DEVICE_ID_PATTERN.test(input.avdName)) throw new Error("A valid Android Virtual Device is required.");
  if (input.booted) {
    onPhase("shutting-down");
    try {
      await deps.shutdown();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      throw new Error(`The emulator did not shut down, so it was not erased${detail ? `: ${detail}` : "."}`);
    }
  }
  onPhase("erasing");
  const deadline = deps.now() + ANDROID_ERASE_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    const listed = await deps.run("adb", ["devices"], { timeoutMs: ADB_QUICK_TIMEOUT_MS });
    const port = freeEmulatorPort(listed.code === 0 ? listed.stdout : "");
    if (port === null) throw new Error("No emulator port is free, so the emulator was not erased.");
    const serial = `emulator-${port}`;
    const boot = androidWipeBootCommand(input.avdName, port);
    // Filled when the wipe boot exits. The run's own timeout ends it if nothing else does.
    const wipe: { ended: DeviceCommandResult | null } = { ended: null };
    const exited = deps.run(boot.command, boot.args, { timeoutMs: Math.max(1, deadline - deps.now()) }).then((result) => {
      wipe.ended = result;
      return result;
    });
    let booted = false;
    while (wipe.ended === null && deps.now() < deadline) {
      const check = androidBootCompletedCommand(serial);
      const result = await deps.run(check.command, check.args, { timeoutMs: ADB_QUICK_TIMEOUT_MS });
      if (result.code === 0 && result.stdout.trim() === "1") {
        booted = true;
        break;
      }
      await deps.sleep(ANDROID_ERASE_POLL_MS);
    }
    const result = wipe.ended;
    if (booted || result === null) {
      const kill = androidKillEmulatorCommand(serial);
      await deps.run(kill.command, kill.args, { timeoutMs: ADB_QUICK_TIMEOUT_MS });
      await exited;
      if (!booted) throw new Error("The emulator did not finish erasing in time.");
      onPhase("erased");
      return;
    }
    if (AVD_IN_USE.test(`${result.stderr}\n${result.stdout}`) && attempt < ANDROID_ERASE_LOCK_RETRIES && deps.now() < deadline) {
      await deps.sleep(ANDROID_ERASE_POLL_MS);
      continue;
    }
    const detail = lastOutputLine(result);
    throw new Error(`The emulator could not be erased${detail ? `: ${detail}` : "."}`);
  }
}
