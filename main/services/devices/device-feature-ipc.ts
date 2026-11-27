/**
 * IPC for the device power features (erase, clipboard, recording, screenshot
 * files), free of Electron so it can be tested. Like the rest of `devices:*`,
 * every channel is refused unless the devices flag is on, and every call must
 * come from the active application document. Inputs are parsed fail-closed
 * before the features run. Save locations come only from the user's dialog.
 */
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  isDeviceChatId,
  isDeviceRecordingId,
  parseDeviceFeatureTarget,
  type DeviceFeatureTarget,
} from "../../../renderer/shared/device-features.js";
import { DEVICE_HOST_ID_PATTERN, DEVICE_ID_PATTERN } from "../../../renderer/shared/devices.js";
import type { ChooseSavePath, DeviceFeatures } from "./device-features.js";
import {
  createDeviceIpcGuard,
  ownerSubscribers,
  requireRecord,
  type DeviceIpcEvent,
} from "./device-ipc-support.js";

export interface DeviceFeatureHandlerDeps {
  handle(channel: string, listener: (event: DeviceIpcEvent, ...args: unknown[]) => unknown): void;
  enabled(): boolean;
  owner(event: DeviceIpcEvent): RendererDocumentOwner;
  features(): DeviceFeatures;
  /** The save dialog for the calling window, starting in Downloads. */
  chooseSavePath(event: DeviceIpcEvent, options: { defaultName: string; kind: "png" | "mp4" }): Promise<string | null>;
  revealInFinder(file: string): void;
}

function requireTarget(value: unknown): DeviceFeatureTarget {
  const target = parseDeviceFeatureTarget(value);
  if (!target) throw new Error("A valid simulator is required.");
  return target;
}

function requireRecordingId(value: unknown): string {
  const id = requireRecord(value).id;
  if (!isDeviceRecordingId(id)) throw new Error("A valid recording is required.");
  return id;
}

function requireSaveTarget(request: Record<string, unknown>): { hostId: string; deviceId: string } {
  const { hostId, deviceId } = request;
  if (typeof hostId !== "string" || !DEVICE_HOST_ID_PATTERN.test(hostId)) {
    throw new Error("A valid device host is required.");
  }
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error("A valid simulator is required.");
  }
  return { hostId, deviceId };
}

/** The 3D view's framed capture is drawn in the renderer; accept only a bounded PNG. */
export const MAX_FRAMED_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function requirePng(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength <= PNG_SIGNATURE.length ||
    value.byteLength > MAX_FRAMED_SCREENSHOT_BYTES ||
    PNG_SIGNATURE.some((byte, index) => value[index] !== byte)
  ) {
    throw new Error("The framed screenshot was not a valid image.");
  }
  return value;
}

export function registerDeviceFeatureHandlersWith(deps: DeviceFeatureHandlerDeps): void {
  const subscribers = ownerSubscribers<"devices:recordings">();
  let unsubscribe: (() => void) | null = null;
  const subscribe = (owner: RendererDocumentOwner, features: DeviceFeatures) => {
    unsubscribe ??= features.onRecordings((recordings) => subscribers.broadcast("devices:recordings", recordings));
    subscribers.add(owner);
  };

  const guarded = createDeviceIpcGuard(deps, deps.features);

  const chooser =
    (event: DeviceIpcEvent, owner: RendererDocumentOwner, kind: "png" | "mp4"): ChooseSavePath =>
    async (defaultName) => {
      const chosen = await deps.chooseSavePath(event, { defaultName, kind });
      // A document that went away while the dialog was open never gets a file written for it.
      if (owner.isDestroyed()) return null;
      return chosen;
    };

  deps.handle(
    "devices:erase",
    guarded(async (features, _owner, [input]) => features.erase(requireTarget(input))),
  );
  deps.handle(
    "devices:clipboard-paste",
    guarded(async (features, _owner, [input]) => features.pasteFromHost(requireTarget(input))),
  );
  deps.handle(
    "devices:clipboard-copy",
    guarded(async (features, _owner, [input]) => features.copyToHost(requireTarget(input))),
  );
  deps.handle(
    "devices:recordings-list",
    guarded(async (features, owner) => {
      subscribe(owner, features);
      return features.recordings();
    }),
  );
  deps.handle(
    "devices:recording-start",
    guarded(async (features, owner, [input]) => {
      const request = requireRecord(input);
      if (!isDeviceChatId(request.chatId)) throw new Error("A valid chat is required for a recording.");
      subscribe(owner, features);
      return features.startRecording(request.chatId, requireTarget(request));
    }),
  );
  deps.handle(
    "devices:recording-stop",
    guarded(async (features, _owner, [input]) => features.stopRecording(requireRecordingId(input))),
  );
  deps.handle(
    "devices:recording-save",
    guarded(async (features, owner, [input], event) =>
      features.saveRecording(requireRecordingId(input), chooser(event, owner, "mp4")),
    ),
  );
  deps.handle(
    "devices:recording-discard",
    guarded(async (features, _owner, [input]) => features.discardRecording(requireRecordingId(input))),
  );
  deps.handle(
    "devices:screenshot-save",
    guarded(async (features, owner, [input], event) =>
      features.saveScreenshot(requireSaveTarget(requireRecord(input)), chooser(event, owner, "png")),
    ),
  );
  deps.handle(
    "devices:framed-screenshot-save",
    guarded(async (features, owner, [input], event) => {
      const request = requireRecord(input);
      const target = requireSaveTarget(request);
      return features.saveFramedScreenshot(target, requirePng(request.png), chooser(event, owner, "png"));
    }),
  );
  deps.handle(
    "devices:reveal-saved",
    guarded(async (features, _owner, [input]) => {
      const file = requireRecord(input).path;
      if (typeof file !== "string" || !features.isSavedPath(file)) {
        throw new Error("Only files saved from the Simulator tab can be revealed.");
      }
      deps.revealInFinder(file);
    }),
  );
}
