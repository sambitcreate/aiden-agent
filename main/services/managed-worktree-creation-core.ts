export interface ManagedWorktreeCreationDependencies<TWorkspace> {
  validateBeforeSave(): Promise<void>;
  saveWorkspace(): Promise<TWorkspace>;
  validateAfterSave(workspace: TWorkspace): Promise<void> | void;
  removeWorkspaceRecord(workspace: TWorkspace): Promise<void>;
  rollbackWorktree(): Promise<void>;
}

export class ManagedWorktreeCreationError extends Error {
  readonly name = "ManagedWorktreeCreationError";

  constructor(
    message: string,
    readonly logMessage: string,
    readonly errors: readonly unknown[],
  ) {
    super(message);
  }
}

/**
 * Commit the workspace record for an already-created managed worktree.
 *
 * A failed post-save authority check normally removes the record and rolls Git
 * back. If record removal fails, the record may still be renderer-visible, so
 * preserving the checkout is the only consistent and recoverable outcome.
 */
export async function commitManagedWorktreeCreation<TWorkspace>(
  dependencies: ManagedWorktreeCreationDependencies<TWorkspace>,
): Promise<TWorkspace> {
  try {
    await dependencies.validateBeforeSave();
    const saved = await dependencies.saveWorkspace();
    try {
      await dependencies.validateAfterSave(saved);
    } catch (validationError) {
      try {
        await dependencies.removeWorkspaceRecord(saved);
      } catch (cleanupError) {
        throw new ManagedWorktreeCreationError(
          "Aiden saved the managed workspace but could not finish validation. The worktree was preserved so the workspace record remains usable.",
          "Could not remove a managed workspace record after its source workspace changed; preserved the worktree.",
          [validationError, cleanupError],
        );
      }
      throw validationError;
    }
    return saved;
  } catch (error) {
    if (error instanceof ManagedWorktreeCreationError) throw error;
    try {
      await dependencies.rollbackWorktree();
    } catch (rollbackError) {
      throw new ManagedWorktreeCreationError(
        "Aiden could not save or fully roll back the worktree. Inspect `git worktree list` before retrying.",
        "Could not roll back a managed worktree after workspace persistence failed.",
        [error, rollbackError],
      );
    }
    throw error;
  }
}
