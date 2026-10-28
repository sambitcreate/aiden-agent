/** A chat's model request that failed for a passing reason and is about to be sent again. */
export interface ModelCallRetryView {
  /** The try about to start, from 2. */
  attempt: number;
  /** The most tries this run of failures may take. */
  maxAttempts: number;
  /** Epoch ms when the next try is sent. */
  retryAt: number;
}

const MAX_ATTEMPTS = 16;

/** Fail closed on anything that is not a well-formed retry from main. */
export function parseModelCallRetryView(value: unknown): ModelCallRetryView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { attempt, maxAttempts, retryAt } = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(maxAttempts) ||
    typeof retryAt !== "number" ||
    !Number.isFinite(retryAt) ||
    (attempt as number) < 2 ||
    (maxAttempts as number) > MAX_ATTEMPTS ||
    (attempt as number) > (maxAttempts as number)
  ) {
    return null;
  }
  return { attempt: attempt as number, maxAttempts: maxAttempts as number, retryAt };
}

/** "Trying again in 8s (2 of 6)", then "Trying again (2 of 6)…" once the wait is over. */
export function modelCallRetryLabel(view: ModelCallRetryView, now: number): string {
  const seconds = Math.ceil((view.retryAt - now) / 1_000);
  const count = `(${view.attempt} of ${view.maxAttempts})`;
  return seconds > 0 ? `Trying again in ${seconds}s ${count}` : `Trying again ${count}…`;
}
