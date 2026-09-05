// Microphone capture → transcription for the composer mic button. Thin React
// wrapper over voice-recorder-core (shared with the dictation pill).

import * as React from "react";
import { toast } from "../components/ui";
import {
  ensureMicrophoneAccess,
  microphoneCaptureErrorMessage,
  MICROPHONE_PERMISSION_OFF_MESSAGE,
  cancelTranscription,
  transcribeBlob,
  type TranscribeOptions,
} from "./voice-recorder-core";
import {
  DictationDeadline,
  DictationOperationGate,
  recoverCommittedLiveTranscript,
  transcriptionBudgetMs,
  voiceErrorMessage,
} from "./dictation-operation-gate";
import { scheduleRecorderStopWithTail, startChunkedMediaRecorder } from "./media-recorder-stop";
import { GeminiLiveCapture, type LiveTranscriptSnapshot } from "./live-pcm-capture";
import { shouldUseGeminiLiveTranscription } from "../shared/voice-models";
import { GeminiRecordedRetryConsent, needsGeminiRecordedRetry } from "./gemini-recorded-retry";

type RecorderOptions = TranscribeOptions;

export function useVoiceRecorder(onTranscript: (text: string) => void, options: RecorderOptions) {
  const [lastError, setLastError] = React.useState<string | null>(null);
  const reportError = React.useCallback((message: string) => {
    setLastError(message);
    toast.error(message);
  }, []);
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [awaitingRecordedRetryConsent, setAwaitingRecordedRetryConsent] = React.useState(false);
  const [liveTranscript, setLiveTranscript] = React.useState<LiveTranscriptSnapshot>({
    committed: "",
    tentative: "",
  });
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const liveRef = React.useRef<GeminiLiveCapture | null>(null);
  const liveStartRef = React.useRef<Promise<GeminiLiveCapture | null> | null>(null);
  const pendingStopRef = React.useRef(false);
  const batchOperationIdRef = React.useRef<string | null>(null);
  const batchProviderRef = React.useRef<RecorderOptions["provider"] | null>(null);
  const transcriptionControllerRef = React.useRef<AbortController | null>(null);
  const operationGateRef = React.useRef<DictationOperationGate | null>(null);
  const recordedRetryConsentRef = React.useRef<GeminiRecordedRetryConsent | null>(null);
  if (operationGateRef.current === null) {
    operationGateRef.current = new DictationOperationGate();
  }
  const operationGate = operationGateRef.current;
  if (recordedRetryConsentRef.current === null) {
    recordedRetryConsentRef.current = new GeminiRecordedRetryConsent();
  }
  const recordedRetryConsent = recordedRetryConsentRef.current;
  // Keep the latest options available to the recorder's stop callback.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const resolveRecordedRetryConsent = React.useCallback(
    (approved: boolean) => {
      setAwaitingRecordedRetryConsent(false);
      recordedRetryConsent.resolve(approved);
    },
    [recordedRetryConsent],
  );

  const start = React.useCallback(async () => {
    if (recorderRef.current) return;
    const token = operationGate.beginStart();
    if (token === null) return;
    pendingStopRef.current = false;
    setLastError(null);
    try {
      // Native permission gate before capture.
      const status = await window.aidenAPI.systemPreferences.getMediaAccessStatus("microphone");
      const allowed = await ensureMicrophoneAccess();
      if (!operationGate.isCurrent(token)) return;
      if (!allowed) {
        operationGate.finishStart(token);
        reportError(
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
      setLiveTranscript({ committed: "", tentative: "" });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const selected: RecorderOptions = { ...optionsRef.current };
      const liveEnabled = shouldUseGeminiLiveTranscription(selected.provider, selected.model);
      const operationId = crypto.randomUUID();
      batchOperationIdRef.current = operationId;
      batchProviderRef.current = selected.provider;
      const transcriptionController = new AbortController();
      transcriptionControllerRef.current = transcriptionController;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const liveStart = liveStartRef.current;
        liveRef.current = null;
        const isCurrent = operationGate.isCurrent(token);
        stopTracks();
        if (!isCurrent) {
          void liveStart?.then((live) => live?.cancel()).catch(() => {});
          return;
        }
        setRecording(false);
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        if (blob.size === 0 && !liveEnabled) {
          if (batchOperationIdRef.current === operationId) batchOperationIdRef.current = null;
          if (batchProviderRef.current === selected.provider) batchProviderRef.current = null;
          if (transcriptionControllerRef.current === transcriptionController) {
            transcriptionControllerRef.current = null;
          }
          if (recorderRef.current === recorder) recorderRef.current = null;
          return;
        }
        setTranscribing(true);
        const deadline = new DictationDeadline(transcriptionBudgetMs(selected.provider));
        try {
          let text = "";
          let live: GeminiLiveCapture | null = null;
          if (liveStart) {
            try {
              live = await deadline.run(liveStart, () => {
                void liveStart.then((capture) => capture?.cancel()).catch(() => {});
              });
            } catch {
              live = null;
            }
          }
          if (live) {
            if (!operationGate.isCurrent(token)) {
              await live.cancel();
              return;
            }
            liveRef.current = live;
            try {
              text = recoverCommittedLiveTranscript(
                await deadline.run(live.finish(), () => live?.cancel()),
                live.snapshot().committed,
              );
            } catch {
              // A committed Live segment is safer than discarding text the
              // user already saw just because the closing handshake failed.
              text = recoverCommittedLiveTranscript("", live.snapshot().committed);
            }
          }
          if (needsGeminiRecordedRetry(liveEnabled, text, blob.size > 0)) {
            setAwaitingRecordedRetryConsent(true);
            const approved = await recordedRetryConsent.request();
            setAwaitingRecordedRetryConsent(false);
            if (!approved || !operationGate.isCurrent(token)) return;
          }
          if (liveEnabled && !text && blob.size === 0) {
            reportError("No speech detected.");
            return;
          }
          if (!text) {
            const batchDeadline = new DictationDeadline(transcriptionBudgetMs(selected.provider));
            text = await batchDeadline.run(
              transcribeBlob(blob, {
                ...selected,
                operationId,
                signal: transcriptionController.signal,
              }),
              () => cancelTranscription(selected.provider, operationId),
            );
          }
          if (!operationGate.isCurrent(token)) return;
          if (text) onTranscript(text);
          else reportError("No speech detected.");
        } catch (error) {
          if (!operationGate.isCurrent(token)) return;
          reportError(voiceErrorMessage(error));
        } finally {
          if (liveStartRef.current === liveStart) liveStartRef.current = null;
          if (batchOperationIdRef.current === operationId) batchOperationIdRef.current = null;
          if (batchProviderRef.current === selected.provider) batchProviderRef.current = null;
          if (transcriptionControllerRef.current === transcriptionController) {
            transcriptionControllerRef.current = null;
          }
          if (recorderRef.current === recorder) recorderRef.current = null;
          if (operationGate.isCurrent(token)) setTranscribing(false);
          if (operationGate.isCurrent(token)) {
            setLiveTranscript({ committed: "", tentative: "" });
          }
        }
      };
      recorderRef.current = recorder;
      if (liveEnabled) {
        liveStartRef.current = GeminiLiveCapture.start(stream, setLiveTranscript).catch(() => null);
      } else {
        liveStartRef.current = Promise.resolve(null);
      }
      if (!operationGate.isCurrent(token)) {
        transcriptionController.abort();
        void liveStartRef.current?.then((live) => live?.cancel()).catch(() => {});
        liveStartRef.current = null;
        liveRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      startChunkedMediaRecorder(recorder);
      operationGate.finishStart(token);
      setRecording(true);
      if (pendingStopRef.current && recorder.state !== "inactive") {
        scheduleRecorderStopWithTail(recorder, setTimeout);
      }
    } catch (error) {
      const live = liveRef.current;
      liveRef.current = null;
      const liveStart = liveStartRef.current;
      liveStartRef.current = null;
      await live?.cancel().catch(() => {});
      void liveStart?.then((capture) => capture?.cancel()).catch(() => {});
      transcriptionControllerRef.current?.abort();
      transcriptionControllerRef.current = null;
      batchOperationIdRef.current = null;
      batchProviderRef.current = null;
      if (!operationGate.isCurrent(token)) return;
      operationGate.finishStart(token);
      recorderRef.current = null;
      stopTracks();
      reportError(microphoneCaptureErrorMessage(error));
    }
  }, [onTranscript, operationGate, recordedRetryConsent, stopTracks, reportError]);

  const stop = React.useCallback(() => {
    pendingStopRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      scheduleRecorderStopWithTail(recorder, setTimeout);
    }
  }, []);

  React.useEffect(
    () => () => {
      operationGate.cancel();
      recordedRetryConsent.resolve(false);
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      chunksRef.current = [];
      void liveRef.current?.cancel();
      liveRef.current = null;
      void liveStartRef.current?.then((live) => live?.cancel()).catch(() => {});
      liveStartRef.current = null;
      const operationId = batchOperationIdRef.current;
      batchOperationIdRef.current = null;
      const batchProvider = batchProviderRef.current;
      batchProviderRef.current = null;
      transcriptionControllerRef.current?.abort();
      transcriptionControllerRef.current = null;
      if (operationId && batchProvider) void cancelTranscription(batchProvider, operationId);
      setLiveTranscript({ committed: "", tentative: "" });
      stopTracks();
    },
    [operationGate, recordedRetryConsent, stopTracks],
  );

  return {
    lastError,
    dismissError: () => setLastError(null),
    recording,
    transcribing,
    liveTranscript,
    awaitingRecordedRetryConsent,
    resolveRecordedRetryConsent,
    start,
    stop,
  };
}
