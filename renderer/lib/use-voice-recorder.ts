// Microphone capture → transcription for the composer mic button. Thin React
// wrapper over voice-recorder-core (shared with the dictation pill). On-device
// voice records raw PCM (pcm-recorder); cloud voice records with MediaRecorder.

import * as React from "react";
import { toast } from "../components/ui";
import {
  ensureMicrophoneAccess,
  microphoneCaptureErrorMessage,
  MICROPHONE_PERMISSION_OFF_MESSAGE,
  cancelTranscription,
  transcribeBlob,
  transcribePcm16,
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
import { createVoiceRecorder, PcmRecorder, recorderStopTailMs } from "./pcm-recorder";
import { GeminiLiveCapture, type LiveTranscriptSnapshot } from "./live-pcm-capture";
import { LocalLivePreview } from "./local-live-preview";
import { shouldUseGeminiLiveTranscription } from "../shared/voice-models";
import { GeminiRecordedRetryConsent, needsGeminiRecordedRetry } from "./gemini-recorded-retry";
import { localVoiceApi, voiceApi } from "./ipc";
import type { SlowModelLoadNotice } from "./slow-model-load";
import { useSlowModelLoad } from "./use-slow-model-load";
import { voiceSetupMessage } from "../shared/voice-provider";

type RecorderOptions = TranscribeOptions;

/** The provider is resolved at mic press; callers choose only the cloud model. */
export interface VoiceRecorderOptions {
  model?: string;
}

export function useVoiceRecorder(onTranscript: (text: string) => void, options: VoiceRecorderOptions) {
  const [lastError, setLastError] = React.useState<string | null>(null);
  const reportError = React.useCallback((message: string) => {
    setLastError(message);
    toast.error(message);
  }, []);
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  /** An on-device model load outlasted the grace period while transcribing. */
  const { loadingModel, begin: beginSlowLoad, end: endSlowLoad } = useSlowModelLoad();
  const [awaitingRecordedRetryConsent, setAwaitingRecordedRetryConsent] = React.useState(false);
  const [liveTranscript, setLiveTranscript] = React.useState<LiveTranscriptSnapshot>({
    committed: "",
    tentative: "",
  });
  /** On-device capture records raw 16 kHz PCM; cloud providers take a MediaRecorder file. */
  const recorderRef = React.useRef<MediaRecorder | PcmRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const liveRef = React.useRef<GeminiLiveCapture | null>(null);
  const liveStartRef = React.useRef<Promise<GeminiLiveCapture | null> | null>(null);
  /** Live words from an on-device model fast enough to decode while you speak. */
  const localPreviewRef = React.useRef<LocalLivePreview | null>(null);
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
    // Resolve the provider (on-device first) before opening the microphone.
    let selected: RecorderOptions;
    try {
      const resolution = await voiceApi.resolveProvider();
      if (!operationGate.isCurrent(token)) return;
      if (resolution.kind === "needs-setup") {
        operationGate.finishStart(token);
        reportError(voiceSetupMessage(resolution.reason));
        return;
      }
      selected = {
        provider: resolution.provider,
        localModel: resolution.provider === "local" ? resolution.modelId : undefined,
        model: optionsRef.current.model,
      };
    } catch (error) {
      if (!operationGate.isCurrent(token)) return;
      operationGate.finishStart(token);
      reportError(voiceErrorMessage(error));
      return;
    }
    // Load the on-device model while the microphone opens so the first
    // transcription does not pay the cold-start cost. Best effort.
    if (selected.provider === "local" && selected.localModel) {
      void localVoiceApi.warm(selected.localModel).catch(() => {});
    }
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
      const recorder = await createVoiceRecorder(stream, selected.provider);
      if (!operationGate.isCurrent(token)) {
        if (recorder instanceof PcmRecorder) recorder.dispose();
        stopTracks();
        return;
      }
      const liveEnabled = shouldUseGeminiLiveTranscription(selected.provider, selected.model);
      const operationId = crypto.randomUUID();
      batchOperationIdRef.current = operationId;
      batchProviderRef.current = selected.provider;
      const transcriptionController = new AbortController();
      transcriptionControllerRef.current = transcriptionController;
      let startedAt = performance.now();
      if (!(recorder instanceof PcmRecorder)) {
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
      }
      let localPreview: LocalLivePreview | null = null;
      recorder.onstop = async () => {
        const liveStart = liveStartRef.current;
        liveRef.current = null;
        // The preview's last words stay on screen until the final text replaces them.
        localPreview?.stop();
        if (localPreviewRef.current === localPreview) localPreviewRef.current = null;
        const isCurrent = operationGate.isCurrent(token);
        stopTracks();
        if (!isCurrent) {
          void liveStart?.then((live) => live?.cancel()).catch(() => {});
          return;
        }
        setRecording(false);
        const pcm = recorder instanceof PcmRecorder ? recorder.takePcm() : null;
        const blob = new Blob(chunksRef.current, {
          type: recorder instanceof PcmRecorder ? "" : recorder.mimeType || "audio/webm",
        });
        const hasAudio = pcm ? pcm.length > 0 : blob.size > 0;
        if (!hasAudio && !liveEnabled) {
          if (batchOperationIdRef.current === operationId) batchOperationIdRef.current = null;
          if (batchProviderRef.current === selected.provider) batchProviderRef.current = null;
          if (transcriptionControllerRef.current === transcriptionController) {
            transcriptionControllerRef.current = null;
          }
          if (recorderRef.current === recorder) recorderRef.current = null;
          return;
        }
        setTranscribing(true);
        const audioSeconds = Math.max(0, (performance.now() - startedAt) / 1_000);
        const slowLoad: SlowModelLoadNotice | undefined =
          selected.provider === "local" && selected.localModel
            ? beginSlowLoad(selected.localModel)
            : undefined;
        const deadline = new DictationDeadline(transcriptionBudgetMs(selected.provider, audioSeconds));
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
          if (needsGeminiRecordedRetry(liveEnabled, text, hasAudio)) {
            setAwaitingRecordedRetryConsent(true);
            const approved = await recordedRetryConsent.request();
            setAwaitingRecordedRetryConsent(false);
            if (!approved || !operationGate.isCurrent(token)) return;
          }
          if (liveEnabled && !text && !hasAudio) {
            reportError("No speech detected.");
            return;
          }
          if (!text) {
            text =
              pcm && selected.provider === "local"
                ? await transcribePcm16(pcm, {
                    localModel: selected.localModel,
                    operationId,
                    signal: transcriptionController.signal,
                    audioSeconds,
                  })
                : await transcribeBlob(blob, {
                    ...selected,
                    operationId,
                    signal: transcriptionController.signal,
                    audioSeconds,
                  });
          }
          if (!operationGate.isCurrent(token)) return;
          if (text) onTranscript(text);
          else reportError("No speech detected.");
        } catch (error) {
          if (!operationGate.isCurrent(token)) return;
          reportError(voiceErrorMessage(error));
        } finally {
          endSlowLoad(slowLoad);
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
      if (recorder instanceof PcmRecorder && selected.provider === "local" && selected.localModel) {
        const preview = LocalLivePreview.start(selected.localModel, setLiveTranscript);
        localPreview = preview;
        localPreviewRef.current = preview;
        recorder.onchunk = (chunk) => preview.push(chunk);
      }
      if (liveEnabled) {
        liveStartRef.current = GeminiLiveCapture.start(stream, setLiveTranscript).catch(() => null);
      } else {
        liveStartRef.current = Promise.resolve(null);
      }
      if (!operationGate.isCurrent(token)) {
        transcriptionController.abort();
        localPreviewRef.current?.stop();
        localPreviewRef.current = null;
        void liveStartRef.current?.then((live) => live?.cancel()).catch(() => {});
        liveStartRef.current = null;
        liveRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (recorder instanceof PcmRecorder) recorder.dispose();
        else {
          recorder.ondataavailable = null;
          recorder.onstop = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      startChunkedMediaRecorder(recorder);
      startedAt = performance.now();
      operationGate.finishStart(token);
      setRecording(true);
      if (pendingStopRef.current && recorder.state !== "inactive") {
        scheduleRecorderStopWithTail(recorder, setTimeout, recorderStopTailMs(recorder));
      }
    } catch (error) {
      localPreviewRef.current?.stop();
      localPreviewRef.current = null;
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
      const recorder = recorderRef.current;
      if (recorder instanceof PcmRecorder) recorder.dispose();
      if (!operationGate.isCurrent(token)) return;
      operationGate.finishStart(token);
      recorderRef.current = null;
      stopTracks();
      reportError(microphoneCaptureErrorMessage(error));
    }
  }, [beginSlowLoad, endSlowLoad, onTranscript, operationGate, recordedRetryConsent, stopTracks, reportError]);

  const stop = React.useCallback(() => {
    pendingStopRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      scheduleRecorderStopWithTail(recorder, setTimeout, recorderStopTailMs(recorder));
    }
  }, []);

  React.useEffect(
    () => () => {
      operationGate.cancel();
      recordedRetryConsent.resolve(false);
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder instanceof PcmRecorder) recorder.dispose();
      else if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      chunksRef.current = [];
      localPreviewRef.current?.stop();
      localPreviewRef.current = null;
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
    loadingModel,
    liveTranscript,
    awaitingRecordedRetryConsent,
    resolveRecordedRetryConsent,
    start,
    stop,
  };
}
