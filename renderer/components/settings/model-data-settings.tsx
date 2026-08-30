import { ModelPadSettings } from "./model-pad-settings";
import { AdvisorSettings } from "./advisor-settings";

/**
 * Model data groups the optional reviewer with the personal Model Pad. The
 * retired direct Artificial Analysis credential flow remains absent; benchmark
 * evidence is fetched only through the Pad's dedicated OpenRouter control.
 */
export function ModelDataSettings() {
  return (
    <div className="grid gap-6">
      <AdvisorSettings />
      <ModelPadSettings />
    </div>
  );
}
