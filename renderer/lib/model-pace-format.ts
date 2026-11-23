// The device-local speed line in the model detail card. Display-only: since
// the Model Pad was retired nothing orders, places or routes models by it.

import type { ModelPaceSummary } from "../shared/model-pace";

/** "0.4 s first token · 62 tok/s": one decimal under ten seconds, whole seconds above. */
export function formatModelPace(summary: ModelPaceSummary): string {
  const seconds = summary.medianTtftMs / 1_000;
  const ttft = Number(seconds.toFixed(1)) < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return `${ttft} s first token · ${Math.round(summary.medianTokensPerSecond)} tok/s`;
}
