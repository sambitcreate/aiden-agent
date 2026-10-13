/**
 * Device-local pace measured from the user's own chat responses, keyed
 * `${providerId}::${modelId}`. Display-only; never transmitted.
 */
export interface ModelPaceSummary {
  /** Median time from the model request to its first text or thinking delta. */
  medianTtftMs: number;
  /** Median output tokens per second, timed from the first delta to the response end. */
  medianTokensPerSecond: number;
  sampleCount: number;
  /** Epoch milliseconds of the most recent sample. */
  lastSampledAt: number;
}
