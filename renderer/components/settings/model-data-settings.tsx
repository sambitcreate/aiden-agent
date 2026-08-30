import { ModelPadSettings } from "./model-pad-settings";

/**
 * The Model Pad is the only model-data settings surface. The retired direct
 * Artificial Analysis credential flow is intentionally no longer rendered;
 * benchmark evidence is fetched only through the dedicated OpenRouter control
 * disclosed inside the Pad.
 */
export function ModelDataSettings() {
  return <ModelPadSettings />;
}
