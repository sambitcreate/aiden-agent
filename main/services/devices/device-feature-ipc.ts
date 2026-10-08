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
  type DeviceRecordingInfo,
} from "../../../renderer/shared/device-features.js";
import { DEVICE_HOST_ID_PATTERN } from "../../../renderer/shared/devices.js";
import type { DeviceIpcEvent } from "./device-ipc.js";
import type { ChooseSavePath, DeviceFeatures } from "./device-features.js";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;

export interface DeviceFeatureHandlerDeps {
  handle(channel: string, listener: (event: DeviceIpcEvent, ...args: unknown[]) => unknown): void;
  enabled(): boolean;
  owner(event: DeviceIpcEvent): RendererDocumentOwner;
  features(): DeviceFeatures;
  /** The save dialog for the calling window, starting in Downloads. */
  chooseSavePath(event: DeviceIpcEvent, options: { defaultName: string; kind: "png" | "mp4" }): Promise<string | null>;
  revealInFinder(file: string): void;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid simulator request.");
  }
  return value as Record<string, unknown>;
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

export function registerDeviceFeatureHandlersWith(deps: DeviceFeatureHandlerDeps): void {
  const subscribers = new Set<RendererDocumentOwner>();
  let unsubscribe: (() => void) | null = null;
  const publish = (recordings: DeviceRecordingInfo[]) => {
    for (const subscriber of [...subscribers]) {
      if (subscriber.isDestroyed()) subscribers.delete(subscriber);
      else subscriber.send("devices:recordings", recordings);
    }
  };
  const subscribe = (owner: RendererDocumentOwner, features: DeviceFeatures) => {
    unsubscribe ??= features.onRecordings(publish);
    if (subscribers.has(owner)) return;
    subscribers.add(owner);
    const cleanup = owner.onInvalidated(() => {
      subscribers.delete(owner);
      cleanup();
    });
  };

  const guarded =
    <T>(run: (features: DeviceFeatures, args: unknown[], event: DeviceIpcEvent, owner: RendererDocumentOwner) => Promise<T>) =>
    async (event: DeviceIpcEvent, ...args: unknown[]): Promise<T> => {
      if (!deps.enabled()) throw new Error("Simulator devices are not enabled.");
      const owner = deps.owner(event);
      return run(deps.features(), args, event, owner);
    };

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
    guarded(async (features, [input]) => features.erase(requireTarget(input))),
  );
  deps.handle(
    "devices:clipboard-paste",
    guarded(async (features, [input]) => features.pasteFromHost(requireTarget(input))),
  );
  deps.handle(
    "devices:clipboard-copy",
    guarded(async (features, [input]) => features.copyToHost(requireTarget(input))),
  );
  deps.handle(
    "devices:recordings-list",
    guarded(async (features, _args, _event, owner) => {
      subscribe(owner, features);
      return features.recordings();
    }),
  );
  deps.handle(
    "devices:recording-start",
    guarded(async (features, [input], _event, owner) => {
      const request = requireRecord(input);
      if (!isDeviceChatId(request.chatId)) throw new Error("A valid chat is required for a recording.");
      subscribe(owner, features);
      return features.startRecording(request.chatId, requireTarget(request));
    }),
  );
  deps.handle(
    "devices:recording-stop",
    guarded(async (features, [input]) => features.stopRecording(requireRecordingId(input))),
  );
  deps.handle(
    "devices:recording-save",
    guarded(async (features, [input], event, owner) =>
      features.saveRecording(requireRecordingId(input), chooser(event, owner, "mp4")),
    ),
  );
  deps.handle(
    "devices:recording-discard",
    guarded(async (features, [input]) => features.discardRecording(requireRecordingId(input))),
  );
  deps.handle(
    "devices:screenshot-save",
    guarded(async (features, [input], event, owner) => {
      const request = requireRecord(input);
      const { hostId, deviceId } = request;
      if (typeof hostId !== "string" || !DEVICE_HOST_ID_PATTERN.test(hostId)) {
        throw new Error("A valid device host is required.");
      }
      if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
        throw new Error("A valid simulator is required.");
      }
      return features.saveScreenshot({ hostId, deviceId }, chooser(event, owner, "png"));
    }),
  );
  deps.handle(
    "devices:reveal-saved",
    guarded(async (features, [input]) => {
      const file = requireRecord(input).path;
      if (typeof file !== "string" || !features.isSavedPath(file)) {
        throw new Error("Only files saved from the Simulator tab can be revealed.");
      }
      deps.revealInFinder(file);
    }),
  );
}
