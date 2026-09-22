import { ModelInsightsError } from "./openrouter-benchmark-runtime-core.js";
import type { ModelInsightsActionResult, ModelInsightsStatus } from "./types.js";

export async function runModelInsightsAction(
  operation: () => Promise<ModelInsightsStatus>,
  fallbackMessage: string,
  onUnexpected?: (error: unknown) => void,
): Promise<ModelInsightsActionResult> {
  try {
    return { ok: true, status: await operation() };
  } catch (error) {
    if (error instanceof ModelInsightsError) {
      return { ok: false, code: error.code, message: error.message };
    }
    try {
      onUnexpected?.(error);
    } catch {
      /* diagnostics cannot change IPC output */
    }
    return { ok: false, code: "local_error", message: fallbackMessage };
  }
}
