// Pure capability profile for one generation. A design-owned chat can only run
// with the matching main-built binding, and a design profile composes exactly
// its own extension and exposes exactly its allowlisted tools. Callers resolve
// the profile first; createGenerationHarness checks the final composition.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatOwnerV1 } from "../../renderer/shared/chat-visibility.js";
import { RENDER_ARTIFACT_TOOL_NAME } from "../../renderer/shared/generative-ui.js";
import { DESIGN_RENDER_EXTENSION_ID } from "./design/design-render-extension.js";
import type { DesignRunOutcome } from "./design/store-core.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";

export interface DesignRunBinding {
  projectId: string;
  runId: string;
  /** The only extension a design run composes; DesignRunService builds it. */
  extension: PiAgentRuntimeExtension;
  /** Accepted revisions so far; they count as visible output at completion. */
  acceptedCount(): number;
  /** Replace render_artifact HTML before the Pi journal or the stored assistant message keeps it. */
  redactForStorage<T extends AgentMessage>(message: T): T;
  /** Called once when the started run's completion settles. */
  onSettled(outcome: DesignRunOutcome): void;
}

export type GenerationProfile =
  | { kind: "default" }
  | {
      kind: "design";
      projectId: string;
      runId: string;
      toolAllowlist: readonly string[];
      /** Every extension the run composes, exactly: none may be added or left out. */
      extensionIds: readonly string[];
    };

export function resolveGenerationProfile(
  chat: { owner?: ChatOwnerV1 },
  options: { designRun?: Pick<DesignRunBinding, "projectId" | "runId"> },
): GenerationProfile {
  const run = options.designRun;
  if (chat.owner === undefined) {
    if (run) throw new Error("Design runs require a Design project conversation.");
    return { kind: "default" };
  }
  if (!run || chat.owner.kind !== "design-project" || run.projectId !== chat.owner.projectId) {
    throw new Error("This conversation belongs to a Design project. Open it in Design to continue.");
  }
  return {
    kind: "design",
    projectId: run.projectId,
    runId: run.runId,
    toolAllowlist: [RENDER_ARTIFACT_TOOL_NAME],
    extensionIds: [DESIGN_RENDER_EXTENSION_ID],
  };
}

/**
 * The extensions one generation composes, in order. A design profile composes
 * exactly its base list (the design extension); advisor and codemode never join
 * it, so the harness allowlist is not tripped by ordinary runtime extensions.
 */
export function selectRuntimeExtensions<E>(
  profile: GenerationProfile,
  parts: { base: readonly E[]; advisor?: E | null; codemode?: E | null },
): E[] {
  if (profile.kind === "design") return [...parts.base];
  return [...parts.base, ...(parts.advisor ? [parts.advisor] : []), ...(parts.codemode ? [parts.codemode] : [])];
}

/**
 * Tool names alone miss an extension that only rewrites context, adds to the
 * system prompt or brings skills. A non-default profile therefore composes its
 * own extensions exactly, and no skill or prompt template.
 */
export function assertGenerationProfileComposition(
  profile: GenerationProfile,
  composition: { extensionIds: readonly string[]; resourceNames: readonly string[] },
): void {
  if (profile.kind === "default") return;
  const expected = new Set(profile.extensionIds);
  const present = new Set(composition.extensionIds);
  const problems = [
    ...[...present].filter((id) => !expected.has(id)).sort(),
    ...[...expected].filter((id) => !present.has(id)).sort().map((id) => `missing ${id}`),
    ...(composition.extensionIds.length !== present.size ? ["a duplicated extension"] : []),
    ...composition.resourceNames.map((name) => `the resource ${name}`),
  ];
  if (problems.length > 0) {
    throw new Error(`The ${profile.kind} profile cannot compose: ${problems.join(", ")}.`);
  }
}

export function assertGenerationProfileTools(profile: GenerationProfile, toolNames: readonly string[]): void {
  if (profile.kind === "default") return;
  const allowed = new Set(profile.toolAllowlist);
  const extra = [...new Set(toolNames.filter((name) => !allowed.has(name)))].sort();
  if (extra.length > 0) {
    throw new Error(`The ${profile.kind} profile cannot expose: ${extra.join(", ")}.`);
  }
}
