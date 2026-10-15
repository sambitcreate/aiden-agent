// Audio-scaled deadlines for on-device transcription. The speech worker's
// supervisor (main/services/local-speech-process-core.ts) and the renderer's
// outer budget both read these, so the layers cannot drift apart.

export const LOAD_DEADLINE_MS = 180_000;
export const STATUS_DEADLINE_MS = 30_000;
/** setTimeout fires immediately for delays above a signed 32-bit millisecond count. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Transcription gets at least two minutes, and 20× real time for long clips. */
export function transcribeDeadlineMs(audioSeconds: number): number {
  return Math.max(120_000, Math.ceil(20_000 * audioSeconds));
}

/**
 * The outer budget for one supervised on-device transcription: a load, then a
 * transcribe, then one retry in a fresh worker after a hang or crash, each
 * with its own deadline, plus 15 s of settlement headroom.
 */
export function localSupervisedBudgetMs(audioSeconds: number): number {
  const seconds = Number.isFinite(audioSeconds) ? Math.max(0, audioSeconds) : 0;
  return Math.min(MAX_TIMER_DELAY_MS, 2 * (LOAD_DEADLINE_MS + transcribeDeadlineMs(seconds)) + 15_000);
}
