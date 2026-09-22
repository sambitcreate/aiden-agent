import { ModelPadSettings } from "./model-pad-settings";

/**
 * The retired direct Artificial Analysis credential flow remains absent;
 * benchmark evidence is fetched only through the Pad's dedicated OpenRouter
 * control. Advisor selection happens at the point of consultation.
 */
export function ModelDataSettings() {
  return <ModelPadSettings />;
}
