export interface LiveAudioDevices {
  input: string;
  output: string;
}

const STORAGE_KEY = "aiden.live.audio-devices.v1";
export const DEFAULT_LIVE_AUDIO_DEVICES: LiveAudioDevices = { input: "default", output: "default" };

export function readLiveAudioDevices(storage: Pick<Storage, "getItem"> = localStorage): LiveAudioDevices {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    return {
      input: typeof value?.input === "string" && value.input ? value.input : "default",
      output: typeof value?.output === "string" && value.output ? value.output : "default",
    };
  } catch {
    return { ...DEFAULT_LIVE_AUDIO_DEVICES };
  }
}

export function saveLiveAudioDevices(value: LiveAudioDevices, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export class LiveAudioDeviceError extends Error {}

/** Never silently route a specifically selected speaker to another device. */
export async function routeLiveAudioOutput(context: AudioContext, deviceId: string): Promise<void> {
  if (deviceId === "default") return;
  const sinkContext = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!sinkContext.setSinkId) {
    throw new LiveAudioDeviceError("Speaker selection is unavailable. Choose System default in Aiden Live settings.");
  }
  try {
    await sinkContext.setSinkId(deviceId);
  } catch {
    throw new LiveAudioDeviceError("The selected speaker is unavailable. Reconnect it or choose another output in Aiden Live settings.");
  }
}

export async function captureLiveMicrophone(deviceId: string, mediaDevices: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices): Promise<MediaStream> {
  try {
    return await mediaDevices.getUserMedia({
      audio: {
        ...(deviceId === "default" ? {} : { deviceId: { exact: deviceId } }),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  } catch (error) {
    if (error instanceof Error && ["NotFoundError", "OverconstrainedError", "NotReadableError"].includes(error.name)) {
      throw new LiveAudioDeviceError("The selected microphone is unavailable or busy. Reconnect it or choose another input in Aiden Live settings.");
    }
    throw error;
  }
}
