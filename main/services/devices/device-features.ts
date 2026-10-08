/**
 * Device power features on top of the device service: erase, clipboard
 * transfer, screen recording, and saving screenshots to a file.
 *
 * Every action targets one simulator the last listing reported, on this Mac,
 * through a typed argv builder in `device-actions.ts` (never a shell, never the
 * hub's exec route). Only the user reaches these; agents get no erase tool.
 * Save locations always come from the user's own save dialog.
 */
import {
  deviceCaptureFileName,
  type DeviceFeatureTarget,
  type DeviceRecordingInfo,
  type DeviceSaveResult,
} from "../../../renderer/shared/device-features.js";
import type { DeviceServiceState } from "../../../renderer/shared/devices.js";
import {
  deviceRecordVideoCommand,
  eraseDevice,
  readDeviceClipboard,
  writeDeviceClipboard,
  type DeviceErasePhase,
} from "./device-actions.js";
import type { DeviceRecorder } from "./device-recording.js";
import type { DeviceService } from "./device-service.js";

export type DeviceFeaturePort = Pick<DeviceService, "localTarget" | "refreshLocal" | "state" | "onState" | "screenshot">;

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
}

export interface DeviceFeatures {
  erase(target: DeviceFeatureTarget, onPhase?: (phase: DeviceErasePhase) => void): Promise<{ wasBooted: boolean }>;
  /** Host clipboard text → simulator pasteboard. */
  pasteFromHost(target: DeviceFeatureTarget): Promise<{ bytes: number }>;
  /** Simulator pasteboard text → host clipboard. */
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

  return {
    async erase(target, onPhase) {
      const { ready, device } = await service.localTarget({ hostId: target.hostId, deviceId: target.deviceId });
      await recorder.discardWhere((info) => info.hostId === target.hostId && info.deviceId === target.deviceId);
      try {
        return await eraseDevice(
          ready.run,
          { platform: target.platform, deviceId: device.id, booted: device.booted },
          onPhase,
        );
      } finally {
        // The listing learns the simulator is off whether or not the erase finished.
        await service.refreshLocal().catch(() => undefined);
      }
    },
    async pasteFromHost(target) {
      const { ready, device } = await service.localTarget({ ...target, booted: true });
      const text = deps.clipboard.readText();
      if (!text) {
        const formats = deps.clipboard.availableFormats();
        throw new Error(
          formats.length > 0 ? "Only text can be pasted to the simulator." : "The clipboard has no text.",
        );
      }
      return writeDeviceClipboard(ready.run, { platform: target.platform, deviceId: device.id }, text);
    },
    async copyToHost(target) {
      const { ready, device } = await service.localTarget({ ...target, booted: true });
      const { text, bytes } = await readDeviceClipboard(ready.run, { platform: target.platform, deviceId: device.id });
      deps.clipboard.writeText(text);
      return { bytes };
    },
    async startRecording(chatId, target) {
      const { device } = await service.localTarget({ ...target, booted: true });
      return recorder.start({
        chatId,
        platform: target.platform,
        hostId: target.hostId,
        deviceId: device.id,
        command: (file) => deviceRecordVideoCommand(target.platform, device.id, file),
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
