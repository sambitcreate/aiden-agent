export type ManagedWorktreeRemovalPhase =
  | "prepared"
  | "quarantined"
  | "checkout_cleanup_started"
  | "checkout_complete"
  | "admin_cleanup_started"
  | "needs_review"
  | "filesystem_complete";

const REMOVAL_PHASE_ORDER: readonly ManagedWorktreeRemovalPhase[] = [
  "prepared",
  "quarantined",
  "checkout_cleanup_started",
  "checkout_complete",
  "admin_cleanup_started",
  "filesystem_complete",
];

/**
 * The deletion journal moves one step forward, or to `needs_review` from any
 * phase. A write may repeat its phase to record a manifest digest. Nothing
 * leaves `needs_review`: a person has to look at what it preserved, so no
 * recovery path may walk it back into deletion.
 */
export function managedWorktreeRemovalPhaseAllowed(
  from: ManagedWorktreeRemovalPhase,
  to: ManagedWorktreeRemovalPhase,
): boolean {
  if (from === to || to === "needs_review") return true;
  if (from === "needs_review") return false;
  return REMOVAL_PHASE_ORDER.indexOf(to) === REMOVAL_PHASE_ORDER.indexOf(from) + 1;
}

export interface ManagedWorktreeRemovalDependencies<TResult> {
  deleteWorktree(): Promise<TResult>;
  destructiveMutationAttempted?(error: unknown): boolean | undefined;
  deletionPending?(): Promise<boolean>;
  workspacePathExists(): Promise<boolean>;
  worktreeRegistered(): Promise<boolean>;
  worktreeUsable?(): Promise<boolean>;
  removeWorkspaceRecord(): Promise<void>;
  onDestructiveBoundary(): void;
  reconciledResult?(error: unknown): TResult;
}

export class ManagedWorktreeRemovalError extends Error {
  readonly name = "ManagedWorktreeRemovalError";

  constructor(
    message: string,
    readonly errors: readonly unknown[],
  ) {
    super(message);
  }
}

/**
 * Distinguish a reversible pre-delete failure from a failure after Git removed
 * the worktree. Once that boundary is crossed, callers must never restore
 * workspace-scoped background work, even if metadata cleanup also fails.
 */
export async function removeManagedWorkspace<TResult>(
  dependencies: ManagedWorktreeRemovalDependencies<TResult>,
): Promise<TResult> {
  let result: TResult;
  try {
    result = await dependencies.deleteWorktree();
  } catch (error) {
    const destructiveMutationAttempted = dependencies.destructiveMutationAttempted?.(error);
    // Only a resolved deletion transaction may discard its durable workspace
    // ownership record. Git deregistration is an intermediate observation, not
    // proof that descriptor-bound quarantine cleanup and its journal finished.
    if (destructiveMutationAttempted !== false) dependencies.onDestructiveBoundary();
    throw error;
  }

  dependencies.onDestructiveBoundary();
  try {
    await dependencies.removeWorkspaceRecord();
  } catch (cleanupError) {
    throw new ManagedWorktreeRemovalError(
      "Git removed the managed worktree, but Aiden could not remove its workspace record.",
      [cleanupError],
    );
  }
  return result;
}
