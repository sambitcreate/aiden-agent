// Floating dictation pill. While the global dictation hotkey is toggled on,
// this window records microphone audio, transcribes it through the shared
// voice pipeline (voice-recorder-core), and reports the transcript to the
// main-process coordinator — which pastes it into the focused app or leaves
// it on the clipboard.

import * as React from "react";
import { Check, ClipboardCopy, Loader2, X } from "lucide-react";
import { dictationApi, onNotification, settingsApi } from "../lib/ipc";
import type { DictationStatePayload } from "../shared/dictation";
import {
  ensureMicrophoneAccess,
  microphoneCaptureErrorMessage,
  MICROPHONE_PERMISSION_OFF_MESSAGE,
  cancelTranscription,
  transcribeBlob,
} from "../lib/voice-recorder-core";
import {
  DictationDeadline,
  DictationOperationGate,
  recoverCommittedLiveTranscript,
  transcriptionBudgetMs,
  voiceErrorMessage,
} from "../lib/dictation-operation-gate";
import { analyserRms, SilenceStopDetector } from "../lib/dictation-vad";
import { playDictationCue } from "../lib/dictation-sounds";
import {
  scheduleRecorderStopWithTail,
  startChunkedMediaRecorder,
} from "../lib/media-recorder-stop";
import { startPillAppearanceSync } from "../lib/pill-appearance";
import { GeminiLiveCapture, type LiveTranscriptSnapshot } from "../lib/live-pcm-capture";
import { shouldUseGeminiLiveTranscription } from "../shared/voice-models";
import { GeminiRecordedRetryConsent, needsGeminiRecordedRetry } from "../lib/gemini-recorded-retry";

type Phase =
  | "idle"
  | "recording"
  | "finalizing"
  | "fallback-consent"
  | "fallback"
  | "delivering"
  | "pasted"
  | "copied"
  | "error";

const WAVEFORM_BARS = 9;

interface ActiveRecording {
  operationId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  audioContext: AudioContext;
  analyser: AnalyserNode;
  cancelled: boolean;
  transcriptionController: AbortController;
  liveStart?: Promise<GeminiLiveCapture | undefined>;
  batchOperationId?: string;
  batchProvider?: "openai" | "gemini" | "local";
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function PillApp() {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [recordingHint, setRecordingHint] = React.useState("");
  const [copiedMessage, setCopiedMessage] = React.useState("Copied to clipboard");
  const [elapsed, setElapsed] = React.useState(0);
  const [liveTranscript, setLiveTranscript] = React.useState<LiveTranscriptSnapshot>({
    committed: "",
    tentative: "",
  });
  const recordingRef = React.useRef<ActiveRecording | null>(null);
  const transcriptionRef = React.useRef<ActiveRecording | null>(null);
  const operationIdRef = React.useRef<string | null>(null);
  const barRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const rafRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationGateRef = React.useRef(new DictationOperationGate());
  const pendingStopRef = React.useRef(false);
  const liveTranscriptRef = React.useRef<LiveTranscriptSnapshot>({ committed: "", tentative: "" });
  const appearanceReadyRef = React.useRef<Promise<void>>(Promise.resolve());
  const silenceStopRef = React.useRef(false);
  const soundsEnabledRef = React.useRef(false);
  const silenceDetectorRef = React.useRef<SilenceStopDetector | null>(null);
  const recordedRetryConsentRef = React.useRef<GeminiRecordedRetryConsent | null>(null);
  if (recordedRetryConsentRef.current === null) {
    recordedRetryConsentRef.current = new GeminiRecordedRetryConsent();
  }
  const recordedRetryConsent = recordedRetryConsentRef.current;

  React.useEffect(() => {
    const sync = startPillAppearanceSync();
    appearanceReadyRef.current = sync.ready;
    return sync.stop;
  }, []);

  const stopWaveform = React.useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearStopTimer = React.useCallback(() => {
    if (!stopTimerRef.current) return;
    clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
  }, []);

  const releaseRecording = React.useCallback(
    (active: ActiveRecording) => {
      stopWaveform();
      active.stream.getTracks().forEach((track) => track.stop());
      void active.audioContext.close().catch(() => {});
      if (recordingRef.current === active) recordingRef.current = null;
    },
    [stopWaveform],
  );

  const startWaveform = React.useCallback((analyser: AnalyserNode) => {
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const timeDomain = new Uint8Array(analyser.fftSize);
    const paint = () => {
      analyser.getByteFrequencyData(bins);
      if (silenceStopRef.current) {
        analyser.getByteTimeDomainData(timeDomain);
        silenceDetectorRef.current?.sample(analyserRms(timeDomain));
      }
      // Skip the DC/lowest bins and bucket the useful range into the bar count.
      const usable = Math.floor(bins.length * 0.7);
      for (let i = 0; i < WAVEFORM_BARS; i += 1) {
        const start = 1 + Math.floor((i * usable) / WAVEFORM_BARS);
        const end = 1 + Math.floor(((i + 1) * usable) / WAVEFORM_BARS);
        let sum = 0;
        for (let b = start; b < end; b += 1) sum += bins[b];
        const level = sum / Math.max(1, end - start) / 255;
        const bar = barRefs.current[i];
        if (bar) bar.style.height = `${Math.round(4 + level * 18)}px`;
      }
      rafRef.current = requestAnimationFrame(paint);
    };
    rafRef.current = requestAnimationFrame(paint);
  }, []);

  const startRecording = React.useCallback(
    async (operationId: string) => {
      if (recordingRef.current) return;
      const token = operationGateRef.current.beginStart();
      if (token === null) return;
      setPhase("idle");
      setRecordingHint("");
      operationIdRef.current = operationId;
      pendingStopRef.current = false;
      let pendingStream: MediaStream | null = null;
      let pendingAudioContext: AudioContext | null = null;
      try {
        const allowed = await ensureMicrophoneAccess();
        if (!operationGateRef.current.isCurrent(token)) return;
        if (!allowed) {
          operationGateRef.current.finishStart(token);
          await dictationApi.reportError(operationId, MICROPHONE_PERMISSION_OFF_MESSAGE);
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        pendingStream = stream;
        if (!operationGateRef.current.isCurrent(token)) {
          stream.getTracks().forEach((track) => track.stop());
          pendingStream = null;
          return;
        }
        const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const audioContext = new AudioContext();
        pendingAudioContext = audioContext;
        void audioContext.resume().catch(() => {});
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const settings = await settingsApi.get();
        if (!operationGateRef.current.isCurrent(token)) {
          stream.getTracks().forEach((track) => track.stop());
          void audioContext.close().catch(() => {});
          pendingStream = null;
          pendingAudioContext = null;
          return;
        }
        const active: ActiveRecording = {
          operationId,
          recorder,
          stream,
          chunks: [],
          audioContext,
          analyser,
          cancelled: false,
          transcriptionController: new AbortController(),
        };
        const publishLiveTranscript = (snapshot: LiveTranscriptSnapshot) => {
          liveTranscriptRef.current = snapshot;
          setLiveTranscript(snapshot);
        };
        liveTranscriptRef.current = { committed: "", tentative: "" };
        setLiveTranscript(liveTranscriptRef.current);
        if (
          shouldUseGeminiLiveTranscription(settings.voiceProvider ?? "openai", settings.voiceModel)
        ) {
          active.liveStart = GeminiLiveCapture.start(stream, publishLiveTranscript).catch(
            () => undefined,
          );
        }
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) active.chunks.push(event.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(active.chunks, { type: recorder.mimeType || "audio/webm" });
          releaseRecording(active);
          if (active.cancelled || (blob.size === 0 && !active.liveStart)) return;
          transcriptionRef.current = active;
          setPhase("finalizing");
          void (async () => {
            const deadline = new DictationDeadline(
              transcriptionBudgetMs(settings.voiceProvider ?? "openai"),
            );
            try {
              let text = "";
              let live: GeminiLiveCapture | undefined;
              if (active.liveStart) {
                try {
                  live = await deadline.run(active.liveStart, () => {
                    void active.liveStart?.then((capture) => capture?.cancel()).catch(() => {});
                  });
                } catch {
                  live = undefined;
                }
              }
              if (live) {
                try {
                  await dictationApi.reportProgress(operationId, "finalizing");
                  text = recoverCommittedLiveTranscript(
                    await deadline.run(live.finish(), () => live?.cancel()),
                    live.snapshot().committed,
                  );
                } catch {
                  text = recoverCommittedLiveTranscript(
                    live.snapshot().committed,
                    liveTranscriptRef.current.committed,
                  );
                }
              }
              if (needsGeminiRecordedRetry(active.liveStart !== undefined, text, blob.size > 0)) {
                const consent = recordedRetryConsent.request();
                setPhase("fallback-consent");
                await dictationApi.reportProgress(operationId, "fallback-consent");
                const approved = await consent;
                if (!approved || active.cancelled || !operationGateRef.current.isCurrent(token)) {
                  return;
                }
              }
              if (active.liveStart && !text && blob.size === 0) {
                await dictationApi.reportResult(operationId, "");
                return;
              }
              if (!text) {
                setPhase("fallback");
                await dictationApi.reportProgress(operationId, "fallback");
                active.batchOperationId = `${operationId}-batch`;
                active.batchProvider = settings.voiceProvider ?? "openai";
                const batchDeadline = new DictationDeadline(
                  transcriptionBudgetMs(active.batchProvider),
                );
                text = await batchDeadline.run(
                  transcribeBlob(blob, {
                    provider: active.batchProvider,
                    localModel: settings.localVoiceModel,
                    model: settings.voiceModel,
                    operationId: active.batchOperationId,
                    signal: active.transcriptionController.signal,
                  }),
                  () =>
                    active.batchOperationId
                      ? cancelTranscription(active.batchProvider!, active.batchOperationId)
                      : undefined,
                );
              }
              if (!operationGateRef.current.isCurrent(token)) return;
              await dictationApi.reportResult(operationId, text);
            } catch (error) {
              if (!operationGateRef.current.isCurrent(token)) return;
              const message = voiceErrorMessage(error);
              setErrorMessage(message);
              setPhase("error");
              await dictationApi.reportError(operationId, message).catch(() => {});
            } finally {
              active.batchOperationId = undefined;
              active.batchProvider = undefined;
              if (transcriptionRef.current === active) transcriptionRef.current = null;
            }
          })();
        };
        recordingRef.current = active;
        pendingStream = null;
        pendingAudioContext = null;
        operationGateRef.current.finishStart(token);
        if (!operationGateRef.current.isCurrent(token)) {
          active.cancelled = true;
          active.transcriptionController.abort();
          void active.liveStart?.then((live) => live?.cancel()).catch(() => {});
          if (active.recorder.state !== "inactive") active.recorder.stop();
          else releaseRecording(active);
          return;
        }
        silenceStopRef.current = settings.dictationSilenceStop === true;
        soundsEnabledRef.current = settings.dictationSounds === true;
        if (silenceStopRef.current) {
          silenceDetectorRef.current = new SilenceStopDetector(() => {
            void dictationApi.stopRecording();
          });
          silenceDetectorRef.current.reset();
        } else {
          silenceDetectorRef.current = null;
        }
        startChunkedMediaRecorder(recorder);
        setElapsed(0);
        setPhase("recording");
        if (soundsEnabledRef.current) void playDictationCue("start");
        startWaveform(analyser);
        timerRef.current = setInterval(() => setElapsed((value) => value + 1), 1_000);
        if (pendingStopRef.current) {
          clearStopTimer();
          stopTimerRef.current = scheduleRecorderStopWithTail(active.recorder, setTimeout);
        }
      } catch (error) {
        const active = recordingRef.current;
        if (active) {
          active.cancelled = true;
          active.transcriptionController.abort();
          await active.liveStart?.then((live) => live?.cancel()).catch(() => {});
          if (active.recorder.state !== "inactive") active.recorder.stop();
          releaseRecording(active);
        }
        pendingStream?.getTracks().forEach((track) => track.stop());
        if (pendingAudioContext) void pendingAudioContext.close().catch(() => {});
        if (!operationGateRef.current.isCurrent(token)) return;
        operationGateRef.current.finishStart(token);
        await dictationApi
          .reportError(operationId, microphoneCaptureErrorMessage(error))
          .catch(() => {});
      }
    },
    [recordedRetryConsent, releaseRecording, startWaveform],
  );

  const stopRecording = React.useCallback(() => {
    pendingStopRef.current = true;
    const active = recordingRef.current;
    if (!active || active.recorder.state === "inactive") return;
    clearStopTimer();
    stopTimerRef.current = scheduleRecorderStopWithTail(active.recorder, setTimeout);
  }, [clearStopTimer]);

  const discardRecording = React.useCallback(() => {
    operationGateRef.current.cancel();
    recordedRetryConsent.resolve(false);
    clearStopTimer();
    const active = recordingRef.current;
    if (active) {
      active.cancelled = true;
      active.transcriptionController.abort();
      void active.liveStart?.then((live) => live?.cancel()).catch(() => {});
      if (active.batchOperationId && active.batchProvider) {
        void cancelTranscription(active.batchProvider, active.batchOperationId);
      }
      if (active.recorder.state !== "inactive") active.recorder.stop();
      else releaseRecording(active);
    }
    const transcribing = transcriptionRef.current;
    if (transcribing && transcribing !== active) {
      transcribing.cancelled = true;
      transcribing.transcriptionController.abort();
      void transcribing.liveStart?.then((live) => live?.cancel()).catch(() => {});
      if (transcribing.batchOperationId && transcribing.batchProvider) {
        void cancelTranscription(transcribing.batchProvider, transcribing.batchOperationId);
      }
      transcriptionRef.current = null;
    }
    operationIdRef.current = null;
    stopWaveform();
    setPhase("idle");
  }, [clearStopTimer, recordedRetryConsent, releaseRecording, stopWaveform]);

  React.useEffect(() => {
    let active = true;
    const unsubscribe = onNotification<DictationStatePayload>("dictation:state", (payload) => {
      switch (payload.state) {
        case "recording":
          if (payload.message) setRecordingHint(payload.message);
          if (payload.operationId && payload.operationId !== operationIdRef.current) {
            void startRecording(payload.operationId);
          }
          break;
        case "stopping":
          if (soundsEnabledRef.current) void playDictationCue("stop");
          stopRecording();
          break;
        case "finalizing":
          setPhase("finalizing");
          break;
        case "fallback-consent":
          setPhase("fallback-consent");
          break;
        case "fallback":
          setPhase("fallback");
          break;
        case "delivering":
          setPhase("delivering");
          break;
        case "pasted":
          if (soundsEnabledRef.current) void playDictationCue("success");
          setPhase("pasted");
          break;
        case "copied":
          if (soundsEnabledRef.current) void playDictationCue("success");
          setCopiedMessage(
            payload.message ??
              (payload.reason === "accessibility-required"
                ? "Copied — allow Accessibility to paste"
                : "Copied to clipboard"),
          );
          setPhase("copied");
          break;
        case "error":
          recordedRetryConsent.resolve(false);
          stopWaveform();
          if (soundsEnabledRef.current) void playDictationCue("error");
          setErrorMessage(payload.message ?? "Dictation failed.");
          setPhase("error");
          break;
        case "cancelled":
          discardRecording();
          break;
      }
    });
    // Signal the coordinator that the subscription is live (replays a missed
    // "recording" broadcast when the pill window was freshly created). Wait
    // for the authoritative appearance first so the first rendered pill frame
    // never exposes the entrypoint fallback palette.
    void appearanceReadyRef.current.then(() => {
      if (active) return dictationApi.ready();
      return undefined;
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [discardRecording, recordedRetryConsent, startRecording, stopRecording, stopWaveform]);

  React.useEffect(
    () => () => {
      operationGateRef.current.cancel();
      recordedRetryConsent.resolve(false);
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      const active = recordingRef.current;
      if (active) {
        active.cancelled = true;
        active.transcriptionController.abort();
        void active.liveStart?.then((live) => live?.cancel()).catch(() => {});
        active.recorder.ondataavailable = null;
        active.recorder.onstop = null;
        if (active.recorder.state !== "inactive") active.recorder.stop();
        releaseRecording(active);
      }
      const transcribing = transcriptionRef.current;
      if (transcribing) {
        transcribing.cancelled = true;
        transcribing.transcriptionController.abort();
        void transcribing.liveStart?.then((live) => live?.cancel()).catch(() => {});
        if (transcribing.batchOperationId && transcribing.batchProvider) {
          void cancelTranscription(transcribing.batchProvider, transcribing.batchOperationId);
        }
      }
    },
    [recordedRetryConsent, releaseRecording],
  );

  return (
    <div
      className="flex h-full w-full items-center justify-center"
      role="status"
      aria-live="polite"
    >
      {phase === "idle" ? null : (
        <div className="aiden-pill flex min-h-10 max-w-[272px] items-center gap-2.5 rounded-pill bg-popover px-3.5 py-2 shadow-popover">
          {phase === "recording" ? (
            <>
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-support-red" />
              {recordingHint ? (
                <span className="max-w-48 text-mini leading-tight text-secondary">
                  {recordingHint}
                </span>
              ) : liveTranscript.committed || liveTranscript.tentative ? (
                <span className="max-w-48 truncate text-small" aria-label="Live transcription">
                  <span className="text-primary">{liveTranscript.committed}</span>{" "}
                  <span className="text-tertiary">{liveTranscript.tentative}</span>
                </span>
              ) : (
                <div className="flex h-[22px] items-center gap-[3px]" aria-hidden="true">
                  {Array.from({ length: WAVEFORM_BARS }, (_, i) => (
                    <div
                      key={i}
                      ref={(el) => {
                        barRefs.current[i] = el;
                      }}
                      className="w-[3px] rounded-full bg-accent"
                      style={{ height: 4 }}
                    />
                  ))}
                </div>
              )}
              <span className="text-mini tabular-nums text-secondary">
                {formatElapsed(elapsed)}
              </span>
              <button
                type="button"
                aria-label="Cancel dictation"
                onClick={() => void dictationApi.cancel()}
                className="flex size-5 items-center justify-center rounded-full text-tertiary transition-colors duration-150 ease-out hover:bg-control hover:text-primary"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : phase === "fallback-consent" ? (
            <>
              <span className="max-w-36 text-mini leading-tight text-secondary">
                Retry saved audio? May cost more.
              </span>
              <button
                type="button"
                onClick={() => recordedRetryConsent.resolve(true)}
                className="rounded-control bg-accent px-2 py-1 text-mini font-medium text-accent-foreground"
              >
                Retry
              </button>
              <button
                type="button"
                aria-label="Cancel paid Gemini retry"
                onClick={() => void dictationApi.cancel()}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-tertiary transition-colors duration-150 ease-out hover:bg-control hover:text-primary"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : phase === "finalizing" || phase === "fallback" || phase === "delivering" ? (
            <>
              <Loader2 className="size-4 animate-spin text-secondary" />
              <span className="text-small text-secondary">
                {phase === "finalizing"
                  ? "Finishing transcript…"
                  : phase === "fallback"
                    ? "Retrying with recorded audio…"
                    : "Pasting…"}
              </span>
              <button
                type="button"
                aria-label="Cancel dictation"
                onClick={() => void dictationApi.cancel()}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-tertiary transition-colors duration-150 ease-out hover:bg-control hover:text-primary"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : phase === "pasted" ? (
            <>
              <Check className="size-4 text-support-green" />
              <span className="text-small-strong">Pasted</span>
            </>
          ) : phase === "copied" ? (
            <>
              <ClipboardCopy className="size-4 text-secondary" />
              <span className="max-w-52 text-small-strong leading-tight">{copiedMessage}</span>
            </>
          ) : (
            <span className="max-w-60 text-mini leading-tight text-support-red">
              {errorMessage}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
