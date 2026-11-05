/**
 * Ends a generation's ownership exactly once, on every terminal path. Which map
 * holds the entry (initializing, then active) is the run's phase. This module
 * owns what happens when it leaves. See docs/state-machines/generation-run.md.
 */

export interface GenerationOwnershipEntry {
  workspaceId?: string;
  releaseSkillReservation: () => void;
  releaseBotAuthority: () => void;
  removeOwnerInvalidation: () => void;
}

export interface GenerationOwnershipPorts {
  forgetApprovedArtifacts(): void;
  releaseApprovals(): void;
  releaseQuestionnaires(): void;
  broadcastSettled(): void;
}

const settledEntries = new WeakSet<GenerationOwnershipEntry>();

/** Run every step even if one throws, then rethrow the first failure. */
export function runEveryStep(steps: readonly (() => unknown)[]): void {
  let failure: { error: unknown } | undefined;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/**
 * Returns false when this entry already settled. A failing step cannot skip the
 * later ones, because any of them left undone keeps the chat busy for good. Only
 * this entry leaves `owners`: a replacement under the same stream ID stays.
 */
export function settleGenerationOwnership<Entry extends GenerationOwnershipEntry>(
  streamId: string,
  entry: Entry,
  owners: Map<string, Entry>,
  ports: GenerationOwnershipPorts,
): boolean {
  if (settledEntries.has(entry)) return false;
  settledEntries.add(entry);
  runEveryStep([
    () => {
      const release = entry.releaseSkillReservation;
      entry.releaseSkillReservation = () => {};
      release();
    },
    () => {
      const release = entry.releaseBotAuthority;
      entry.releaseBotAuthority = () => {};
      release();
    },
    ports.forgetApprovedArtifacts,
    () => {
      if (owners.get(streamId) === entry) owners.delete(streamId);
    },
    entry.removeOwnerInvalidation,
    ports.releaseApprovals,
    ports.releaseQuestionnaires,
    ports.broadcastSettled,
  ]);
  return true;
}

/**
 * Runs an admitted generation up to the point its completion task takes over.
 * Anything that escapes before then has no other owner, so `settleEscaped` ends
 * the run before the caller sees the failure. A failure while settling is
 * reported but never replaces the original error.
 */
export async function runAdmittedGeneration<T>(
  run: () => Promise<T>,
  settleEscaped: () => Promise<void>,
  onSettleFailure: (error: unknown) => void,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    try {
      await settleEscaped();
    } catch (settleError) {
      onSettleFailure(settleError);
    }
    throw error;
  }
}

/** Facts the terminal decision reads once the runtime has returned. */
export interface GenerationTerminalInput {
  runtime:
    | { kind: "provider_failed"; reason?: string }
    | { kind: "host_failed" }
    | { kind: "app_cancelled" }
    | { kind: "completed" };
  emergencyError: string | null | undefined;
  spendingRefusal: string | undefined;
  wasCancelled: boolean;
  /** Read only when no failure already decided the outcome. */
  hasVisibleOutput: () => boolean;
}

export type GenerationTerminalDecision =
  | { kind: "failed"; message: string; attachProviderFailure: boolean }
  | { kind: "empty" }
  | { kind: "finished"; timeline: "completed" | "cancelled" };

function providerFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case "output-limit":
      return "The model reached its output limit.";
    case "context-overflow":
      return "The model context was too large to recover safely.";
    case "compaction-failed":
      return "The model context could not be compacted safely.";
    case "interrupted":
      return "The provider interrupted the response.";
    default:
      return "The model could not complete this response.";
  }
}

/** What the run reports before its save is attempted. */
export function decideGenerationTerminal(input: GenerationTerminalInput): GenerationTerminalDecision {
  const { runtime } = input;
  const spendingError = runtime.kind === "provider_failed" ? input.spendingRefusal : undefined;
  const message =
    input.emergencyError ??
    spendingError ??
    (runtime.kind === "provider_failed"
      ? providerFailureMessage(runtime.reason)
      : runtime.kind === "host_failed"
        ? "The local agent runtime could not complete this response safely."
        : null);
  if (message) {
    return {
      kind: "failed",
      message,
      attachProviderFailure: runtime.kind === "provider_failed" && !spendingError,
    };
  }
  if (!input.wasCancelled && !input.hasVisibleOutput()) return { kind: "empty" };
  return { kind: "finished", timeline: input.wasCancelled ? "cancelled" : "completed" };
}
