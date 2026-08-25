// Stop MediaRecorder only after a short hangover and an encoder flush so the
// last syllables are not cut off when the user ends capture.

export const MEDIA_RECORDER_TIMESLICE_MS = 100;
export const RECORDING_TAIL_FLUSH_MS = 180;

export interface StoppableMediaRecorder {
  state: "inactive" | "recording" | "paused" | string;
  requestData?: () => void;
  stop: () => void;
}

export function startChunkedMediaRecorder(
  recorder: { start: (timeslice?: number) => void },
  timesliceMs: number = MEDIA_RECORDER_TIMESLICE_MS,
): void {
  recorder.start(timesliceMs);
}

/**
 * Flush the encoder, then stop after `hangoverMs`. Safe to call more than once.
 * Returns the timer id so callers can cancel on discard.
 */
export function scheduleRecorderStopWithTail(
  recorder: StoppableMediaRecorder,
  delay: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>,
  hangoverMs: number = RECORDING_TAIL_FLUSH_MS,
): ReturnType<typeof setTimeout> {
  return delay(() => {
    if (recorder.state !== "recording" && recorder.state !== "paused") return;
    try {
      recorder.requestData?.();
    } catch {
      // Chromium throws if the recorder is already stopping.
    }
    if (recorder.state !== "recording" && recorder.state !== "paused") return;
    recorder.stop();
  }, hangoverMs);
}
