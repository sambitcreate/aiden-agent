export class WorkspaceMutationGate {
  private readonly changing = new Set<string>();
  private readonly admissions = new Map<string, Set<AbortController>>();

  isChanging(workspaceId: string | undefined): boolean {
    return workspaceId !== undefined && this.changing.has(workspaceId);
  }

  begin(workspaceId: string): () => void {
    if (this.changing.has(workspaceId)) {
      throw new Error("The workspace is already changing.");
    }
    this.changing.add(workspaceId);
    for (const controller of this.admissions.get(workspaceId) ?? []) {
      controller.abort(new Error("The workspace is changing."));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.changing.delete(workspaceId);
    };
  }

  admit(workspaceId: string): {
    signal: AbortSignal;
    release: () => void;
  } {
    if (this.changing.has(workspaceId)) {
      throw new Error("The workspace is changing. Try again in a moment.");
    }
    const controller = new AbortController();
    const admissions = this.admissions.get(workspaceId) ?? new Set<AbortController>();
    admissions.add(controller);
    this.admissions.set(workspaceId, admissions);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        admissions.delete(controller);
        if (admissions.size === 0) this.admissions.delete(workspaceId);
      },
    };
  }
}

/**
 * Prepare an operation while holding workspace admission, then cross its
 * synchronous commit boundary only if no mutation began during preparation.
 */
export async function commitWithWorkspaceMutationAdmission<T>(
  gate: WorkspaceMutationGate,
  workspaceId: string,
  prepare: (signal: AbortSignal) => Promise<() => T>,
): Promise<T> {
  const admission = gate.admit(workspaceId);
  try {
    const commit = await prepare(admission.signal);
    if (admission.signal.aborted) {
      throw admission.signal.reason instanceof Error
        ? admission.signal.reason
        : new Error("The workspace is changing; the operation was paused.");
    }
    return commit();
  } finally {
    admission.release();
  }
}

export async function waitForWorkspaceGenerationSettlement(input: {
  completions: () => readonly Promise<void>[];
  isBusy: () => boolean;
  timeoutMessage: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (input.isBusy()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(input.timeoutMessage);
    const pause = new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    const completions = input.completions();
    if (completions.length > 0) {
      await Promise.race([Promise.allSettled(completions), pause]);
    } else {
      await pause;
    }
  }
}

interface WorkspaceGenerationSettlementEntry {
  workspaceId?: string;
  completion?: Promise<void> | null;
}

interface WorkspaceGenerationSettlementEntries {
  initializations: () => ReadonlyMap<string, WorkspaceGenerationSettlementEntry>;
  active: () => ReadonlyMap<string, WorkspaceGenerationSettlementEntry>;
}

/**
 * An initialization without an authoritative persisted workspace could belong
 * to any workspace. Treat it as matching every mutation until its chat read
 * resolves; a renderer-supplied workspace hint must never narrow this barrier.
 */
export function generationCouldBelongToWorkspace(
  entry: WorkspaceGenerationSettlementEntry,
  workspaceId: string,
): boolean {
  return entry.workspaceId === undefined || entry.workspaceId === workspaceId;
}

/** Cancel and drain every generation that could cross a workspace mutation. */
export async function cancelWorkspaceGenerationsAndSettle(
  input: WorkspaceGenerationSettlementEntries & {
    workspaceId: string;
    cancel: (streamId: string) => void;
    abortChildren: (workspaceId: string) => void;
    hasChildren: (workspaceId: string) => boolean;
    timeoutMessage: string;
    timeoutMs: number;
  },
): Promise<void> {
  for (const [streamId, initialization] of [...input.initializations()]) {
    if (generationCouldBelongToWorkspace(initialization, input.workspaceId)) {
      input.cancel(streamId);
    }
  }
  for (const [streamId, active] of [...input.active()]) {
    if (generationCouldBelongToWorkspace(active, input.workspaceId)) {
      input.cancel(streamId);
    }
  }
  input.abortChildren(input.workspaceId);
  await waitForWorkspaceGenerationSettlement({
    completions: () =>
      [...input.active().values()]
        .filter((entry) => generationCouldBelongToWorkspace(entry, input.workspaceId))
        .flatMap((entry) => (entry.completion ? [entry.completion] : [])),
    isBusy: () =>
      [...input.initializations().values()].some((entry) =>
        generationCouldBelongToWorkspace(entry, input.workspaceId),
      ) ||
      [...input.active().values()].some((entry) =>
        generationCouldBelongToWorkspace(entry, input.workspaceId),
      ) ||
      input.hasChildren(input.workspaceId),
    timeoutMessage: input.timeoutMessage,
    timeoutMs: input.timeoutMs,
  });
}

export const workspaceMutationGate = new WorkspaceMutationGate();
