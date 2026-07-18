// Microphone capture → transcription. Records via MediaRecorder, then either
// sends compressed audio to a cloud provider, or (for the on-device provider)
// decodes to a 16 kHz mono WAV in the renderer and runs whisper.cpp locally.

import * as React from "react";
import { toast } from "@glaze/core/components";
import { voiceApi } from "./ipc";
import type { VoiceProvider } from "./types";

interface RecorderOptions {
  provider: VoiceProvider;
  /** Selected on-device model id — required when provider === "local". */
  localModel?: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode recorded audio and resample to 16 kHz mono Float32 PCM (base64) for the on-device engine. */
async function blobToPcm16k(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  // Copy into a standalone Float32Array so the base64 covers exactly the samples.
  return float32ToBase64(Float32Array.from(rendered.getChannelData(0)));
}

export function useVoiceRecorder(onTranscript: (text: string) => void, options: RecorderOptions) {
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  // Keep the latest options available to the recorder's stop callback.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    try {
      // Native permission gate before capture (see glaze-native-permissions).
      const status = await window.glazeAPI.systemPreferences.getMediaAccessStatus("microphone");
      if (status === "denied" || status === "restricted") {
        toast.error("Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone.");
        return;
      }
      if (status === "not-determined") {
        const granted = await window.glazeAPI.systemPreferences.askForMediaAccess("microphone");
        if (!granted) {
          toast.error("Microphone permission was not granted.");
          return;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stopTracks();
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) return;
        const opts = optionsRef.current;
        setTranscribing(true);
        try {
          let text: string;
          if (opts.provider === "local") {
            if (!opts.localModel) {
              toast.error("Download and select an on-device model in Settings → Voice.");
              return;
            }
            const pcm = await blobToPcm16k(blob);
            text = await voiceApi.transcribeLocal(pcm, opts.localModel);
          } else {
            const base64 = await blobToBase64(blob);
            text = await voiceApi.transcribe(base64, blob.type);
          }
          if (text.trim()) onTranscript(text.trim());
          else toast.error("No speech detected.");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      toast.error("Microphone access is needed for voice input. Allow it in System Settings → Privacy & Security → Microphone.");
    }
  }, [onTranscript, stopTracks]);

  const stop = React.useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  React.useEffect(() => () => stopTracks(), [stopTracks]);

  return { recording, transcribing, start, stop };
}
