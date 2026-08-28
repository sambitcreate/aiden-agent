export const RENDERER_CRASH_WINDOW_MS = 60_000;
export const MAX_RENDERER_RECOVERIES_PER_WINDOW = 3;
const BASE_RECOVERY_BACKOFF_MS = 250;
const MAX_RECOVERY_BACKOFF_MS = 2_000;

export interface RendererRecoveryDecision {
  recentCrashTimes: number[];
  retry: boolean;
  attempt: number;
  backoffMs: number;
}

export function decideRendererRecovery(
  priorCrashTimes: readonly number[],
  atMs: number,
): RendererRecoveryDecision {
  const recentCrashTimes = priorCrashTimes
    .filter((value) => Number.isFinite(value) && value > atMs - RENDERER_CRASH_WINDOW_MS && value <= atMs)
    .concat(atMs)
    .slice(-(MAX_RENDERER_RECOVERIES_PER_WINDOW + 1));
  const attempt = recentCrashTimes.length;
  const retry = attempt <= MAX_RENDERER_RECOVERIES_PER_WINDOW;
  return {
    recentCrashTimes,
    retry,
    attempt,
    backoffMs: retry
      ? Math.min(MAX_RECOVERY_BACKOFF_MS, BASE_RECOVERY_BACKOFF_MS * 2 ** (attempt - 1))
      : 0,
  };
}
