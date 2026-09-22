export const DICTATION_PRESS_DEBOUNCE_MS = 30;

/** Ignore OS key chatter; a later press still cancels or stops. */
export function shouldAcceptDictationPress(
  lastPressAt: number,
  now: number,
  debounceMs: number = DICTATION_PRESS_DEBOUNCE_MS,
): boolean {
  return now - lastPressAt >= debounceMs;
}
