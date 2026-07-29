// Floating dictation pill. While the global dictation hotkey is toggled on,
// this window records microphone audio, transcribes it through the shared
// voice pipeline (voice-recorder-core), and reports the transcript to the
// main-process coordinator — which pastes it into the focused app or leaves
// it on the clipboard.

import * as React from "react";
import { Check, ClipboardCopy, Loader2, X } from "lucide-react";
import { dictationApi, onNotification, settingsApi } from "../lib/ipc";
import type { DictationStatePayload } from "../shared/dictation";
import { ensureMicrophoneAccess, transcribeBlob } from "../lib/voice-recorder-core";
import {
  DictationOperationGate,
  withDictationTimeout,
} from "../lib/dictation-operation-gate";
import { startPillAppearanceSync } from "../lib/pill-appearance";

type Phase = "idle" | "recording" | "transcribing" | "pasted" | "copied" | "error";

const WAVEFORM_BARS = 9;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

interface ActiveRecording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  audioContext: AudioContext;
  analyser: AnalyserNode;
  cancelled: boolean;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function PillApp() {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [elapsed, setElapsed] = React.useState(0);
  const recordingRef = React.useRef<ActiveRecording | null>(null);
  const barRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const rafRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const operationGateRef = React.useRef(new DictationOperationGate());
  const appearanceReadyRef = React.useRef<Promise<void>>(Promise.resolve());

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
    const paint = () => {
      analyser.getByteFrequencyData(bins);
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

  const startRecording = React.useCallback(async () => {
    if (recordingRef.current) return;
    const token = operationGateRef.current.beginStart();
    if (token === null) return;
    setPhase("idle");
    try {
      if (!(await ensureMicrophoneAccess())) {
        operationGateRef.current.finishStart(token);
        void dictationApi.reportError(
          "Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone.",
        );
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!operationGateRef.current.isCurrent(token)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const active: ActiveRecording = {
        recorder,
        stream,
        chunks: [],
        audioContext,
        analyser,
        cancelled: false,
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) active.chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(active.chunks, { type: recorder.mimeType || "audio/webm" });
        releaseRecording(active);
        if (active.cancelled || blob.size === 0) return;
        setPhase("transcribing");
        void (async () => {
          try {
            const settings = await settingsApi.get();
            const text = await withDictationTimeout(
              transcribeBlob(blob, {
                provider: settings.voiceProvider ?? "openai",
                localModel: settings.localVoiceModel,
              }),
              TRANSCRIPTION_TIMEOUT_MS,
            );
            if (!operationGateRef.current.isCurrent(token)) return;
            void dictationApi.reportResult(text);
          } catch (error) {
            if (!operationGateRef.current.isCurrent(token)) return;
            void dictationApi.reportError(error instanceof Error ? error.message : String(error));
          }
        })();
      };
      recordingRef.current = active;
      operationGateRef.current.finishStart(token);
      recorder.start();
      setElapsed(0);
      setPhase("recording");
      startWaveform(analyser);
      timerRef.current = setInterval(() => setElapsed((value) => value + 1), 1_000);
    } catch {
      if (!operationGateRef.current.isCurrent(token)) return;
      operationGateRef.current.finishStart(token);
      const active = recordingRef.current;
      if (active) releaseRecording(active);
      void dictationApi.reportError(
        "Microphone access is needed for dictation. Allow it in System Settings → Privacy & Security → Microphone.",
      );
    }
  }, [releaseRecording, startWaveform]);

  const stopRecording = React.useCallback(() => {
    const active = recordingRef.current;
    if (active && active.recorder.state !== "inactive") active.recorder.stop();
  }, []);

  const discardRecording = React.useCallback(() => {
    operationGateRef.current.cancel();
    const active = recordingRef.current;
    if (active) {
      active.cancelled = true;
      if (active.recorder.state !== "inactive") active.recorder.stop();
      else releaseRecording(active);
    }
    stopWaveform();
    setPhase("idle");
  }, [releaseRecording, stopWaveform]);

  React.useEffect(() => {
    let active = true;
    const unsubscribe = onNotification<DictationStatePayload>("dictation:state", (payload) => {
      switch (payload.state) {
        case "recording":
          void startRecording();
          break;
        case "stopping":
          stopRecording();
          break;
        case "pasted":
          setPhase("pasted");
          break;
        case "copied":
          setPhase("copied");
          break;
        case "error":
          stopWaveform();
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
  }, [discardRecording, startRecording, stopRecording, stopWaveform]);

  return (
    <div className="flex h-full w-full items-center justify-center" role="status" aria-live="polite">
      {phase === "idle" ? null : (
        <div className="aiden-pill flex h-10 items-center gap-2.5 rounded-pill bg-popover px-3.5 shadow-popover">
          {phase === "recording" ? (
            <>
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-support-red" />
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
              <span className="text-mini tabular-nums text-secondary">{formatElapsed(elapsed)}</span>
              <button
                type="button"
                aria-label="Cancel dictation"
                onClick={() => void dictationApi.cancel()}
                className="flex size-5 items-center justify-center rounded-full text-tertiary transition-colors duration-150 ease-out hover:bg-control hover:text-primary"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : phase === "transcribing" ? (
            <>
              <Loader2 className="size-4 animate-spin text-secondary" />
              <span className="text-small text-secondary">Transcribing…</span>
            </>
          ) : phase === "pasted" ? (
            <>
              <Check className="size-4 text-support-green" />
              <span className="text-small-strong">Pasted</span>
            </>
          ) : phase === "copied" ? (
            <>
              <ClipboardCopy className="size-4 text-secondary" />
              <span className="text-small-strong">Copied to clipboard</span>
            </>
          ) : (
            <span className="max-w-56 truncate text-small text-support-red">{errorMessage}</span>
          )}
        </div>
      )}
    </div>
  );
}
