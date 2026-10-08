/**
 * Device power features on top of the device service: erase, clipboard
 * transfer, screen recording, and saving screenshots to a file.
 *
 * Every action targets one device the last listing reported, on this Mac,
 * through a typed argv builder (never a shell, never the hub's exec route):
 * `device-actions.ts` for iOS simulators, `android-device-feature-actions.ts`
 * for Android emulators. Android paste types the text through serve-emu's
 * `text` gesture on the hub. Only the user reaches these; agents get no erase
 * tool. Save locations always come from the user's own save dialog.
 */
import {
  ANDROID_RECORDING_MAX_MS,
  checkDeviceClipboardText,
  deviceCaptureFileName,
  deviceFeatureCapabilities,
  type DeviceFeatureTarget,
  type DeviceRecordingInfo,
  type DeviceSaveResult,
} from "../../../renderer/shared/device-features.js";
import type { DeviceServiceState, DeviceSummary } from "../../../renderer/shared/devices.js";
import {
  DeviceActionUnavailableError,
  deviceRecordVideoCommand,
  eraseDevice,
  readDeviceClipboard,
  writeDeviceClipboard,
  type DeviceErasePhase,
} from "./device-actions.js";
import {
  androidPullCommand,
  androidRecordingRemotePath,
  androidRemoveRemoteFileCommand,
  androidScreenrecordCommand,
  androidStopScreenrecordCommand,
  chunkDeviceText,
  eraseAndroidEmulator,
} from "./android-device-feature-actions.js";
import type { DeviceHostReady } from "./device-host.js";
import type { DeviceRecorder, DeviceRecordingRemote } from "./device-recording.js";
import type { DeviceService } from "./device-service.js";

export type DeviceFeaturePort = Pick<
  DeviceService,
  "localTarget" | "refreshLocal" | "state" | "onState" | "screenshot" | "shutdownLocal"
>;

/** The hub's answer to one serve-emu request; only what paste reads. */
export interface DeviceFeatureHubResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const ADB_RECORDING_STEP_TIMEOUT_MS = 15_000;
/** `adb pull` of a three-minute recording at the default 20 Mbps is under half a gigabyte. */
const ADB_PULL_TIMEOUT_MS = 120_000;
const HUB_TEXT_TIMEOUT_MS = 10_000;

export interface HostClipboard {
  readText(): string;
  availableFormats(): string[];
  writeText(text: string): void;
}

/** Shows the save dialog with a default file name; null when the user cancels. */
export type ChooseSavePath = (defaultName: string) => Promise<string | null>;

export interface DeviceFeatureDeps {
  service: DeviceFeaturePort;
  recorder: DeviceRecorder;
  clipboard: HostClipboard;
  /** Moves a finished temp file to the chosen path, replacing what the user agreed to overwrite. */
  moveFile(from: string, to: string): Promise<void>;
  removeFile(file: string): Promise<void>;
  writeFile(file: string, bytes: Uint8Array): Promise<void>;
  now(): Date;
  /** Loopback requests to the local hub (Android paste). Redirects must fail. */
  fetch(
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<DeviceFeatureHubResponse>;
  sleep(ms: number): Promise<void>;
}

export interface DeviceFeatures {
  /**
   * Erases one device and leaves it shut down. `deviceId` is its id now: an
   * Android emulator's id goes back from its serial to its AVD name.
   */
  erase(
    target: DeviceFeatureTarget,
    onPhase?: (phase: DeviceErasePhase) => void,
  ): Promise<{ wasBooted: boolean; deviceId: string }>;
  /** Host clipboard text → the device: the simulator pasteboard, or typed into the emulator's focused field. */
  pasteFromHost(target: DeviceFeatureTarget): Promise<{ bytes: number }>;
  /** Simulator pasteboard text → host clipboard. Android Emulators refuse it. */
  copyToHost(target: DeviceFeatureTarget): Promise<{ bytes: number }>;
  startRecording(chatId: string, target: DeviceFeatureTarget): Promise<DeviceRecordingInfo>;
  stopRecording(id: string): Promise<DeviceRecordingInfo>;
  /** Moves a finished recording where the user chooses, or deletes it if they cancel. */
  saveRecording(id: string, choose: ChooseSavePath): Promise<DeviceSaveResult>;
  discardRecording(id: string): Promise<void>;
  recordings(): DeviceRecordingInfo[];
  onRecordings(listener: (recordings: DeviceRecordingInfo[]) => void): () => void;
  saveScreenshot(target: { hostId: string; deviceId: string }, choose: ChooseSavePath): Promise<DeviceSaveResult>;
  /** Only files this launch saved can be revealed in Finder. */
  isSavedPath(file: string): boolean;
  /** A deleted chat's recordings are stopped and deleted. */
  discardForChat(chatId: string): Promise<void>;
  /** App quit: stops and deletes every recording. */
  stop(): Promise<void>;
}

const MAX_REMEMBERED_SAVES = 64;
const ACTIVE = new Set<DeviceRecordingInfo["status"]>(["recording", "stopping"]);

function deviceName(state: DeviceServiceState, target: { hostId: string; deviceId: string }): string {
  return (
    state.devices.find((device) => device.hostId === target.hostId && device.id === target.deviceId)?.name ??
    "Simulator"
  );
}

export function createDeviceFeatures(deps: DeviceFeatureDeps): DeviceFeatures {
  const { service, recorder } = deps;
  const saved: string[] = [];
  const remember = (file: string) => {
    saved.push(file);
    if (saved.length > MAX_REMEMBERED_SAVES) saved.splice(0, saved.length - MAX_REMEMBERED_SAVES);
  };

  // A simulator that shuts down or disappears (shut down, erased, streaming turned off) ends its recordings.
  const unsubscribe = service.onState((state) => {
    const live = new Set(
      state.devices.filter((device) => device.booted).map((device) => JSON.stringify([device.hostId, device.id])),
    );
    void recorder.discardWhere(
      (info) => ACTIVE.has(info.status) && !live.has(JSON.stringify([info.hostId, info.deviceId])),
    );
  });

  /** The listed device for a target. Its platform must be the one the caller named. */
  const resolve = async (target: DeviceFeatureTarget, booted?: boolean) => {
    const resolved = await service.localTarget({
      hostId: target.hostId,
      deviceId: target.deviceId,
      ...(booted ? { booted } : {}),
    });
    if (resolved.device.platform !== target.platform) throw new Error("That device is no longer available.");
    return resolved;
  };
  /** AVD names being wiped, so a second Erase never races the first one's cold boot. */
  const erasing = new Set<string>();

  const eraseAndroid = async (ready: DeviceHostReady, device: DeviceSummary, onPhase?: (phase: DeviceErasePhase) => void) => {
    // A stopped AVD is listed under its name; a running one under its serial, with the AVD as its name.
    const avdName = device.booted ? device.name : device.id;
    if (erasing.has(avdName)) throw new Error("This emulator is already being erased.");
    erasing.add(avdName);
    try {
      await eraseAndroidEmulator(
        {
          run: ready.run,
          shutdown: () => service.shutdownLocal({ hostId: device.hostId, deviceId: device.id }),
          sleep: deps.sleep,
          now: () => deps.now().getTime(),
        },
        { avdName, booted: device.booted },
        onPhase,
      );
      return { wasBooted: device.booted, deviceId: avdName };
    } finally {
      erasing.delete(avdName);
    }
  };

  /** Types text into the emulator's focused field through serve-emu, one gesture per 300-byte piece. */
  const typeOnAndroid = async (ready: DeviceHostReady, serial: string, text: string) => {
    const url = `${ready.hub.origin}/vendor/serve-emu/api/text?${new URLSearchParams({ device: serial }).toString()}`;
    for (const piece of chunkDeviceText(text)) {
      const response = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: piece }),
        signal: AbortSignal.timeout(HUB_TEXT_TIMEOUT_MS),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = JSON.parse(await response.text()) as { error?: unknown };
          if (typeof payload.error === "string") detail = payload.error;
        } catch {
          // The status alone is reported.
        }
        throw new Error(`The emulator did not accept the text${detail ? `: ${detail}` : ` (HTTP ${response.status}).`}`);
      }
    }
  };

  /** `adb shell screenrecord` writes on the emulator; these hooks stop it there, pull it here, and delete it there. */
  const androidRecording = (ready: DeviceHostReady, serial: string) => (id: string): DeviceRecordingRemote => {
    const remotePath = androidRecordingRemotePath(id);
    const step = async (command: { command: string; args: string[] }, timeoutMs = ADB_RECORDING_STEP_TIMEOUT_MS) =>
      ready.run(command.command, command.args, { timeoutMs });
    return {
      async stop() {
        const stop = androidStopScreenrecordCommand(serial, remotePath);
        await step(stop);
      },
      async collect(file) {
        const pull = androidPullCommand(serial, remotePath, file);
        const result = await step(pull, ADB_PULL_TIMEOUT_MS);
        if (result.code !== 0) throw new Error("The recording could not be copied from the emulator.");
      },
      async cleanup() {
        // A recorder still running (its local adb was killed) stops before its file goes.
        await step(androidStopScreenrecordCommand(serial, remotePath)).catch(() => undefined);
        await step(androidRemoveRemoteFileCommand(serial, remotePath));
      },
    };
  };

  return {
    async erase(target, onPhase) {
      const { ready, device } = await resolve(target);
      if (!deviceFeatureCapabilities(device.platform, { local: true }).erase) {
        throw new DeviceActionUnavailableError("Erasing is not available for this device.");
      }
      await recorder.discardWhere((info) => info.hostId === target.hostId && info.deviceId === target.deviceId);
      try {
        if (device.platform === "android") return await eraseAndroid(ready, device, onPhase);
        const result = await eraseDevice(
          ready.run,
          { platform: device.platform, deviceId: device.id, booted: device.booted },
          onPhase,
        );
        return { ...result, deviceId: device.id };
      } finally {
        // The listing learns the device is off whether or not the erase finished.
        await service.refreshLocal().catch(() => undefined);
      }
    },
    async pasteFromHost(target) {
      const { ready, device } = await resolve(target, true);
      const text = deps.clipboard.readText();
      if (!text) {
        const formats = deps.clipboard.availableFormats();
        throw new Error(formats.length > 0 ? "Only text can be pasted to the device." : "The clipboard has no text.");
      }
      if (device.platform === "android") {
        const checked = checkDeviceClipboardText(text);
        if (!checked.ok) throw new Error(checked.reason);
        await typeOnAndroid(ready, device.id, checked.text);
        return { bytes: checked.bytes };
      }
      return writeDeviceClipboard(ready.run, { platform: device.platform, deviceId: device.id }, text);
    },
    async copyToHost(target) {
      const { ready, device } = await resolve(target, true);
      const copy = deviceFeatureCapabilities(device.platform, { local: true }).clipboardCopy;
      if (!copy.available) throw new DeviceActionUnavailableError(copy.reason);
      const { text, bytes } = await readDeviceClipboard(ready.run, { platform: device.platform, deviceId: device.id });
      deps.clipboard.writeText(text);
      return { bytes };
    },
    async startRecording(chatId, target) {
      const { ready, device } = await resolve(target, true);
      const base = { chatId, platform: device.platform, hostId: target.hostId, deviceId: device.id };
      if (device.platform === "android") {
        return recorder.start({
          ...base,
          command: (_file, id) => androidScreenrecordCommand(device.id, androidRecordingRemotePath(id)),
          ...(ready.env ? { env: ready.env } : {}),
          maxDurationMs: ANDROID_RECORDING_MAX_MS,
          remote: androidRecording(ready, device.id),
        });
      }
      return recorder.start({
        ...base,
        command: (file) => deviceRecordVideoCommand(device.platform, device.id, file),
      });
    },
    stopRecording: (id) => recorder.stop(id, "user"),
    async saveRecording(id, choose) {
      const info = recorder.get(id);
      if (!info) throw new Error("That recording is no longer available.");
      if (info.status === "failed") {
        await recorder.discard(id);
        throw new Error(info.error ?? "The recording failed.");
      }
      if (info.status !== "ready") throw new Error("Stop the recording before saving it.");
      const taken = recorder.take(id);
      if (!taken) throw new Error("That recording is no longer available.");
      const name = deviceCaptureFileName(deviceName(service.state(), info), new Date(info.startedAt), "mp4");
      let destination: string | null;
      try {
        destination = await choose(name);
      } catch (error) {
        await deps.removeFile(taken.file).catch(() => undefined);
        throw error;
      }
      if (!destination) {
        await deps.removeFile(taken.file).catch(() => undefined);
        return { status: "cancelled" };
      }
      try {
        await deps.moveFile(taken.file, destination);
      } catch (error) {
        await deps.removeFile(taken.file).catch(() => undefined);
        throw error;
      }
      remember(destination);
      return { status: "saved", path: destination };
    },
    discardRecording: (id) => recorder.discard(id),
    recordings: () => recorder.list(),
    onRecordings: (listener) => recorder.onChange(listener),
    async saveScreenshot(target, choose) {
      const png = await service.screenshot(target);
      const destination = await choose(deviceCaptureFileName(deviceName(service.state(), target), deps.now(), "png"));
      if (!destination) return { status: "cancelled" };
      await deps.writeFile(destination, new Uint8Array(png));
      remember(destination);
      return { status: "saved", path: destination };
    },
    isSavedPath: (file) => saved.includes(file),
    discardForChat: (chatId) => recorder.discardWhere((info) => info.chatId === chatId),
    async stop() {
      unsubscribe();
      await recorder.discardWhere(() => true);
    },
  };
}
