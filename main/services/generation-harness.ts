// The one constructor for foreground generation harnesses. A non-default
// profile refuses to build when any composed tool falls outside its
// allowlist, or when its extensions or resources are not exactly its own, so a
// leak fails before the first provider request instead of relying on scattered
// !design checks.
import {
  PiAgentRuntimeHarness,
  resolvePiAgentRuntimeStaticContributions,
  type PiAgentRuntimeHarnessOptions,
} from "./pi-agent-runtime-harness.js";
import {
  assertGenerationProfileComposition,
  assertGenerationProfileTools,
  type GenerationProfile,
} from "./generation-profile.js";

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

/** The extensions, skills and prompt templates a harness built from these options composes. */
export function generationHarnessComposition(options: PiAgentRuntimeHarnessOptions): {
  extensionIds: string[];
  resourceNames: string[];
} {
  // Mirrors the harness: a contribution snapshot replaces the extensions and resources.
  const extensions = options.contributions?.extensions ?? options.extensions ?? [];
  const resources = options.contributions
    ? [options.contributions.resources]
    : [options.resources ?? {}, ...extensions.map((extension) => extension.resources ?? {})];
  return {
    extensionIds: extensions.map((extension) => extension.id),
    resourceNames: resources.flatMap((entry) =>
      [...(entry.skills ?? []), ...(entry.promptTemplates ?? [])].map((resource) => resource.name),
    ),
  };
}

export function createGenerationHarness(
  profile: GenerationProfile,
  options: PiAgentRuntimeHarnessOptions,
): PiAgentRuntimeHarness {
  assertGenerationProfileTools(profile, generationHarnessToolNames(options));
  assertGenerationProfileComposition(profile, generationHarnessComposition(options));
  return new PiAgentRuntimeHarness(options);
}
