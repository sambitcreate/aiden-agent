import {
  ArtificialAnalysisFetchError,
  ArtificialAnalysisInputError,
  ArtificialAnalysisStateError,
  type ArtificialAnalysisActionResult,
  type ArtificialAnalysisStatus,
} from "./artificial-analysis-runtime-core.js";

interface ArtificialAnalysisActionOptions {
  fallbackMessage: string;
  onUnexpected?(error: unknown): void;
}

/** Keep renderer-visible failures structured without serializing Error objects over Electron IPC. */
export async function runArtificialAnalysisAction(
  operation: () => Promise<ArtificialAnalysisStatus>,
  options: ArtificialAnalysisActionOptions,
): Promise<ArtificialAnalysisActionResult> {
  try {
    return { ok: true, status: await operation() };
  } catch (error) {
    if (
      error instanceof ArtificialAnalysisFetchError ||
      error instanceof ArtificialAnalysisInputError ||
      error instanceof ArtificialAnalysisStateError
    ) {
      return { ok: false, code: error.code, message: error.message };
    }
    try {
      options.onUnexpected?.(error);
    } catch {
      // Diagnostics must not change the renderer-visible action contract.
    }
    return { ok: false, code: "local_error", message: options.fallbackMessage };
  }
}
