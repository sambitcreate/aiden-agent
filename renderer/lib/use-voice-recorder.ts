// Microphone capture → transcription for the composer mic button. Thin React
// wrapper over voice-recorder-core (shared with the dictation pill).

import * as React from "react";
import { toast } from "../components/ui";
import {
  ensureMicrophoneAccess,
  transcribeBlob,
  type TranscribeOptions,
} from "./voice-recorder-core";

type RecorderOptions = TranscribeOptions;

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
      // Native permission gate before capture.
      const status = await window.aidenAPI.systemPreferences.getMediaAccessStatus("microphone");
      if (!(await ensureMicrophoneAccess())) {
        toast.error(
          status === "not-determined"
            ? "Microphone permission was not granted."
            : "Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone.",
        );
        return;
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
        setTranscribing(true);
        try {
          const text = await transcribeBlob(blob, optionsRef.current);
          if (text) onTranscript(text);
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
