import {
  createAgentsInstructionTracker,
  type AgentsInstructionOptions,
  type AgentsInstructionRoots,
} from "./agents-instructions.js";
import type { GenerationContextOptions } from "./generation-context.js";

/**
 * The exact GenerationContextOptions the last generation for a chat resolved
 * (system prompt + tool schemas after host-disclosed updates). The options
 * object is mutated in place by the generation path, so a stored reference
 * stays live for the rest of the session.
 */
export interface GenerationContextProfile {
  options: GenerationContextOptions;
  /** Present when the generation appended AGENTS.md guidance to its prompt. */
  instructions?: ReturnType<typeof createAgentsInstructionTracker>;
  instructionRoots?: AgentsInstructionRoots;
  /** Effective workspace permission; `ask` and `full` build different prompts. */
  permission?: string;
}

export interface GenerationContextScope {
  instructionRoots?: AgentsInstructionRoots;
  permission?: string;
}

/**
 * Register right after the runtime applied AGENTS.md to `options`, so the
 * tracker's baseline is the file state that prompt was built from.
 */
export function createGenerationContextProfile(
  options: GenerationContextOptions,
  scope: GenerationContextScope = {},
  read?: AgentsInstructionOptions["read"],
): GenerationContextProfile {
  const { instructionRoots, permission } = scope;
  return {
    options,
    instructions: instructionRoots
      ? createAgentsInstructionTracker(instructionRoots, read)
      : undefined,
    instructionRoots,
    permission,
  };
}

export interface ContextProfileRequest {
  providerId: string;
  modelId: string;
  contextWindow: number;
  supportsImages: boolean;
  /** AGENTS.md roots a generation started now would read. */
  instructionRoots: AgentsInstructionRoots;
  /** The chat workspace's current effective permission. */
  permission: string;
}

/**
 * Reuse a remembered profile only while it describes the next request: same
 * model shape, workspace permission and currently authorized AGENTS.md scope.
 * A workspace path or permission change discards it (without touching the old roots), so
 * the caller rebuilds from the current ambient scope instead.
 */
export async function rememberedContextOptions(
  profile: GenerationContextProfile | undefined,
  request: ContextProfileRequest,
): Promise<GenerationContextOptions | undefined> {
  if (!profile) return undefined;
  const { options } = profile;
  if (
    options.providerId !== request.providerId ||
    options.modelId !== request.modelId ||
    options.contextWindow !== request.contextWindow ||
    options.supportsImages !== request.supportsImages ||
    (profile.permission !== undefined && profile.permission !== request.permission)
  ) {
    return undefined;
  }
  if (!profile.instructions || !profile.instructionRoots) return options;
  if (
    profile.instructionRoots.globalRoot !== request.instructionRoots.globalRoot ||
    profile.instructionRoots.workspaceRoot !== request.instructionRoots.workspaceRoot
  ) {
    return undefined;
  }
  // The next request re-reads AGENTS.md; price an edit made since.
  return {
    ...options,
    systemPrompt: await profile.instructions.current(options.systemPrompt),
  };
}
