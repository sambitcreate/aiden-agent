// Microphone capture → transcription for the composer mic button. Thin React
// wrapper over voice-recorder-core (shared with the dictation pill).

import * as React from "react";
import { toast } from "../components/ui";
import {
  ensureMicrophoneAccess,
  microphoneCaptureErrorMessage,
  MICROPHONE_PERMISSION_OFF_MESSAGE,
  transcribeBlob,
  type TranscribeOptions,
} from "./voice-recorder-core";
import { DictationOperationGate } from "./dictation-operation-gate";
import { scheduleRecorderStopWithTail, startChunkedMediaRecorder } from "./media-recorder-stop";

type RecorderOptions = TranscribeOptions;

export function useVoiceRecorder(
  onTranscript: (text: string) => void,
  options: RecorderOptions,
) {
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const operationGateRef = React.useRef<DictationOperationGate | null>(null);
  if (operationGateRef.current === null) {
    operationGateRef.current = new DictationOperationGate();
  }
  const operationGate = operationGateRef.current;
  // Keep the latest options available to the recorder's stop callback.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    if (recorderRef.current) return;
    const token = operationGate.beginStart();
    if (token === null) return;
    try {
      // Native permission gate before capture.
      const status =
        await window.aidenAPI.systemPreferences.getMediaAccessStatus(
          "microphone",
        );
      const allowed = await ensureMicrophoneAccess();
      if (!operationGate.isCurrent(token)) return;
      if (!allowed) {
        operationGate.finishStart(token);
        toast.error(
          status === "not-determined"
            ? "Microphone permission was not granted. Enable it in System Settings, then restart Aiden."
            : MICROPHONE_PERMISSION_OFF_MESSAGE,
        );
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!operationGate.isCurrent(token)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stopTracks();
        if (!operationGate.isCurrent(token)) return;
        setRecording(false);
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        if (blob.size === 0) {
          if (recorderRef.current === recorder) recorderRef.current = null;
          return;
        }
        setTranscribing(true);
        try {
          const text = await transcribeBlob(blob, optionsRef.current);
          if (!operationGate.isCurrent(token)) return;
          if (text) onTranscript(text);
          else toast.error("No speech detected.");
        } catch (error) {
          if (!operationGate.isCurrent(token)) return;
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          if (recorderRef.current === recorder) recorderRef.current = null;
          if (operationGate.isCurrent(token)) setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      startChunkedMediaRecorder(recorder);
      operationGate.finishStart(token);
      setRecording(true);
    } catch (error) {
      if (!operationGate.isCurrent(token)) return;
      operationGate.finishStart(token);
      recorderRef.current = null;
      stopTracks();
      toast.error(microphoneCaptureErrorMessage(error));
    }
  }, [onTranscript, operationGate, stopTracks]);

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      scheduleRecorderStopWithTail(recorder, setTimeout);
    }
  }, []);

  React.useEffect(
    () => () => {
      operationGate.cancel();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      chunksRef.current = [];
      stopTracks();
    },
    [operationGate, stopTracks],
  );

  return { recording, transcribing, start, stop };
}
