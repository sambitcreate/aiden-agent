import type { AssistantMessage } from "@earendil-works/pi-ai";
import { piRuntimePrivateFailure } from "../pi-runtime-failure.js";

export const SUBAGENT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
export const MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS = 2_000;

export function isRetryableSubagentStartupFailure(input: {
  message: AssistantMessage;
  observedModelActivity: boolean;
}): boolean {
  return (
    !input.observedModelActivity &&
    input.message.stopReason === "error" &&
    piRuntimePrivateFailure(input.message) === "inference-startup"
  );
}

export async function waitForSubagentStartupRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (delayMs <= 0) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (retry: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(retry);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
