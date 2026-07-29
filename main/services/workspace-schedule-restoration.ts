export interface WorkspaceScheduleRestorationControl {
  /**
   * Arm a final resume attempt after a mutation has persisted an enabled
   * workspace but before its first rescheduling attempt.
   */
  ensureResumedOnExit(): void;
  /** The workspace mutation crossed its irreversible boundary. */
  keepPaused(): void;
}

export interface WorkspaceScheduleRestorationDependencies {
  restoreOnExit: boolean;
  resume(): Promise<void>;
  onResumeError(error: unknown): void;
}

/**
 * Arm schedule restoration before any fallible cancellation or settlement.
 * Successful destructive mutations explicitly keep the workspace paused.
 */
export async function withWorkspaceScheduleRestoration<T>(
  dependencies: WorkspaceScheduleRestorationDependencies,
  operation: (control: WorkspaceScheduleRestorationControl) => Promise<T>,
): Promise<T> {
  let restoreOnExit = dependencies.restoreOnExit;
  const control: WorkspaceScheduleRestorationControl = {
    ensureResumedOnExit: () => {
      restoreOnExit = true;
    },
    keepPaused: () => {
      restoreOnExit = false;
    },
  };
  try {
    return await operation(control);
  } finally {
    if (restoreOnExit) {
      await dependencies.resume().catch((error) => {
        dependencies.onResumeError(error);
      });
    }
  }
}
