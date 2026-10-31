// How a chat retries a model request that failed for a passing reason: a
// dropped connection, a server error or a timeout. Usage limits wait in their
// own gate before any content, and errors that cannot pass (a bad key, a bad
// request, billing) are never retried; Pi's classifier decides which is which.

import { retryDelayMs, type AssistantMessage, type RetryPolicy } from "@earendil-works/pi-ai";

/** Five retries after the first try, waiting 2, 4, 8, 16 and 32 seconds (each capped at a minute). */
export const MODEL_CALL_RETRY_POLICY: Readonly<Required<RetryPolicy>> = Object.freeze({
  enabled: true,
  maxRetries: 5,
  baseDelayMs: 2_000,
  maxAgentDelayMs: 60_000,
});

/** A request that timed out is tried at most three times in all. */
export const MODEL_CALL_TIMEOUT_MAX_RETRIES = 2;

const TIMEOUT_ERROR = /\btimed? ?out\b|\btimeout\b|\bETIMEDOUT\b/iu;

export function isModelCallTimeout(message: Pick<AssistantMessage, "errorMessage">): boolean {
  return typeof message.errorMessage === "string" && TIMEOUT_ERROR.test(message.errorMessage);
}

/** The wait before retry `retry` (1 for the first retry). */
export function modelCallRetryDelayMs(policy: RetryPolicy, retry: number): number {
  return Math.max(0, retryDelayMs(policy, retry));
}
