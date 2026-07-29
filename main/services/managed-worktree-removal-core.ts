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
