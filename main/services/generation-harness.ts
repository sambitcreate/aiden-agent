// The one constructor for foreground generation harnesses, so chat runs share
// a single construction point.
import {
  PiAgentRuntimeHarness,
  type PiAgentRuntimeHarnessOptions,
} from "./pi-agent-runtime-harness.js";

export function createGenerationHarness(options: PiAgentRuntimeHarnessOptions): PiAgentRuntimeHarness {
  return new PiAgentRuntimeHarness(options);
}
