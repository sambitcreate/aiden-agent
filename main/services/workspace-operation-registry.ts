export interface WorkspaceOperationAdmission {
  signal: AbortSignal;
  cancel(reason?: unknown): void;
  release(): void;
}

export interface WorkspaceOperationDocumentOwner {
  isDestroyed(): boolean;
  onInvalidated(listener: () => void): () => void;
}

interface ActiveWorkspaceOperation {
  controller: AbortController;
  completion: Promise<void>;
  release(): void;
}

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 5_000;

/**
 * Own every file/Git operation from admission through final cleanup so an
 * authority mutation can abort and drain the exact in-flight snapshot.
 */
export class WorkspaceOperationRegistry {
  private readonly active = new Map<string, Set<ActiveWorkspaceOperation>>();

  admit(workspaceId: string): WorkspaceOperationAdmission {
    const controller = new AbortController();
    let resolveCompletion = () => {};
    const operation: ActiveWorkspaceOperation = {
      controller,
      completion: new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
      release: () => {},
    };
    const operations = this.active.get(workspaceId) ?? new Set<ActiveWorkspaceOperation>();
    operations.add(operation);
    this.active.set(workspaceId, operations);
    let released = false;
    operation.release = () => {
      if (released) return;
      released = true;
      operations.delete(operation);
      if (operations.size === 0) this.active.delete(workspaceId);
      resolveCompletion();
    };
    return {
      signal: controller.signal,
      cancel: (reason) => controller.abort(reason),
      release: operation.release,
    };
  }

  async cancelAndSettle(
    workspaceId: string,
    options: { exceptSignal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    const selected = [...(this.active.get(workspaceId) ?? [])].filter(
      ({ controller }) => controller.signal !== options.exceptSignal,
    );
    for (const { controller } of selected) {
      controller.abort(new Error("The workspace operation was cancelled."));
    }
    if (selected.length === 0) return;

    const settlement = Promise.all(selected.map(({ completion }) => completion));
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settlement,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "A workspace operation did not stop in time. The workspace was not changed.",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Bind an admitted capability to the exact renderer document that requested
 * it. A navigation, reload, renderer crash, or WebContents destruction aborts
 * the operation even when the surrounding window survives.
 */
export function admitOwnedWorkspaceOperation(
  registry: Pick<WorkspaceOperationRegistry, "admit">,
  owner: WorkspaceOperationDocumentOwner,
  workspaceId: string,
): WorkspaceOperationAdmission {
  const admission = registry.admit(workspaceId);
  const cancel = (): void => {
    admission.cancel(new Error("The renderer document is no longer active."));
  };
  let removeInvalidation = () => {};
  try {
    removeInvalidation = owner.onInvalidated(cancel);
    if (owner.isDestroyed()) cancel();
  } catch (error) {
    admission.release();
    throw error;
  }

  let released = false;
  return {
    signal: admission.signal,
    cancel: admission.cancel,
    release: () => {
      if (released) return;
      released = true;
      try {
        removeInvalidation();
      } finally {
        admission.release();
      }
    },
  };
}

/** Backward-compatible name for renderer-only call sites during extraction. */
export const admitRendererOwnedWorkspaceOperation = admitOwnedWorkspaceOperation;

export const workspaceOperationRegistry = new WorkspaceOperationRegistry();
