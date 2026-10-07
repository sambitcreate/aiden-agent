// The one constructor for foreground generation harnesses. A non-default
// profile refuses to build when any composed tool falls outside its
// allowlist, so a leak fails before the first provider request instead of
// relying on scattered !design checks.
import {
  PiAgentRuntimeHarness,
  resolvePiAgentRuntimeStaticContributions,
  type PiAgentRuntimeHarnessOptions,
} from "./pi-agent-runtime-harness.js";
import { assertGenerationProfileTools, type GenerationProfile } from "./generation-profile.js";

/** Every tool a harness built from these options declares or admits through codemode. */
export function generationHarnessToolNames(options: PiAgentRuntimeHarnessOptions): string[] {
  const declared = options.contributions
    ? options.contributions.tools
    : resolvePiAgentRuntimeStaticContributions(
        "",
        options.initialState?.tools ?? [],
        options.extensions ?? [],
      ).tools;
  return [...declared, ...(options.deferredTools ?? [])].map((tool) => tool.name);
}

export function createGenerationHarness(
  profile: GenerationProfile,
  options: PiAgentRuntimeHarnessOptions,
): PiAgentRuntimeHarness {
  assertGenerationProfileTools(profile, generationHarnessToolNames(options));
  return new PiAgentRuntimeHarness(options);
}
