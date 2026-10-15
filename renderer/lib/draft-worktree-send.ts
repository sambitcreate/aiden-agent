// The first send of a draft that chose New worktree. Main creates the worktree
// and saves the chat there; this drives the progress row in between and, when
// creation fails, waits for the user: Retry (same idempotency key), use the
// worktree an earlier attempt already created, run in this checkout instead,
// or cancel and get the text back in the composer.

import type {
  FirstMessageWorktreeInfo,
  FirstMessageWorktreeProgress,
  FirstMessageWorktreeRequest,
  FirstMessageWorktreeResult,
} from "../shared/worktree-on-send";
import type { WorktreeSendProgress } from "./draft-git-menu";

/** Rejection used when the user cancels; the composer restores the text without an error toast. */
export class WorktreeSendCancelledError extends Error {
  constructor() {
    super("Sending was cancelled.");
    this.name = "WorktreeSendCancelledError";
  }
}

export function isWorktreeSendCancelled(error: unknown): boolean {
  return error instanceof WorktreeSendCancelledError;
}

/** The worktree an earlier attempt for this draft created, and the settings it was sent with. */
export interface ExistingDraftWorktree {
  workspaceId: string;
  branch: string;
  baseRef: string;
  fromOrigin: boolean;
  /** The explicit name that attempt asked for; undefined for Auto. */
  branchName?: string;
}

export type WorktreeSendView =
  | {
      status: "running";
      request: FirstMessageWorktreeRequest;
      progress: WorktreeSendProgress;
    }
  | {
      status: "failed";
      request: FirstMessageWorktreeRequest;
      progress: WorktreeSendProgress;
      reason: string;
      detail?: string;
      /** Set when this draft already has a worktree with other settings. */
      existing?: ExistingDraftWorktree;
    }
  | {
      /** Run in this checkout instead was chosen; the plain send is running. */
      status: "checkout";
      request: FirstMessageWorktreeRequest;
      progress: WorktreeSendProgress;
    };

export type WorktreeSendDecision = "retry" | "use-existing" | "checkout" | "cancel";

export interface WorktreeSendApi<Input, C> {
  createInWorktree(input: Input & { worktree: FirstMessageWorktreeRequest }): Promise<FirstMessageWorktreeResult<C>>;
  createInCheckout(input: Input): Promise<C>;
  onProgress(handler: (progress: FirstMessageWorktreeProgress) => void): () => void;
}

export type WorktreeFirstSendResult<C> =
  | { chat: C; worktree: FirstMessageWorktreeInfo }
  | { chat: C; worktree?: undefined };

export interface WorktreeFirstSend<C> {
  result: Promise<WorktreeFirstSendResult<C>>;
  /** Answer a failure. Ignored unless the send is waiting for one. */
  decide(decision: WorktreeSendDecision): void;
}

function existingWorktreeOf(result: unknown): ExistingDraftWorktree | undefined {
  const worktree = (result as { worktree?: unknown }).worktree;
  if (!worktree || typeof worktree !== "object") return undefined;
  const record = worktree as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    typeof record.branch !== "string" ||
    typeof record.baseRef !== "string" ||
    typeof record.fromOrigin !== "boolean"
  ) {
    return undefined;
  }
  return {
    workspaceId: record.workspaceId,
    branch: record.branch,
    baseRef: record.baseRef,
    fromOrigin: record.fromOrigin,
    ...(typeof record.branchName === "string" ? { branchName: record.branchName } : {}),
  };
}

/**
 * Start a worktree first send. `onView` receives every progress and failure
 * state; it is not called again once `result` settles. An IPC rejection
 * rejects `result` as an ordinary send failure.
 */
export function startWorktreeFirstSend<Input, C>(options: {
  api: WorktreeSendApi<Input, C>;
  input: Input;
  worktree: FirstMessageWorktreeRequest;
  onView: (view: WorktreeSendView) => void;
}): WorktreeFirstSend<C> {
  const { api, input, onView } = options;
  let request = options.worktree;
  let progress: WorktreeSendProgress = {};
  let waiting: ((decision: WorktreeSendDecision) => void) | undefined;
  let settled = false;

  const show = (view: WorktreeSendView) => {
    if (!settled) onView(view);
  };
  const unsubscribe = api.onProgress((event) => {
    if (event.draftId.toLowerCase() !== request.idempotencyKey.toLowerCase()) return;
    progress = {
      phase: event.phase,
      ...(event.branch ? { branch: event.branch } : {}),
      ...(event.startPoint ? { startPoint: event.startPoint } : {}),
    };
    if (!waiting) show({ status: "running", request, progress });
  });

  const run = async (): Promise<WorktreeFirstSendResult<C>> => {
    for (;;) {
      progress = {};
      show({ status: "running", request, progress });
      const result = await api.createInWorktree({ ...input, worktree: request });
      if (result.ok) return { chat: result.chat, worktree: result.worktree };
      const existing = existingWorktreeOf(result);
      show({
        status: "failed",
        request,
        progress,
        reason: result.reason,
        ...("detail" in result && typeof result.detail === "string" ? { detail: result.detail } : {}),
        ...(existing ? { existing } : {}),
      });
      const decision = await new Promise<WorktreeSendDecision>((resolve) => {
        waiting = resolve;
      });
      waiting = undefined;
      if (decision === "cancel") throw new WorktreeSendCancelledError();
      if (decision === "checkout") {
        show({ status: "checkout", request, progress });
        return { chat: await api.createInCheckout(input) };
      }
      if (decision === "use-existing" && existing) {
        // Resend exactly as the attempt that created it, so main reuses it.
        const { branchName: _changedName, ...rest } = request;
        request = {
          ...rest,
          baseRef: existing.baseRef,
          fromOrigin: existing.fromOrigin,
          ...(existing.branchName ? { branchName: existing.branchName } : {}),
        };
      }
    }
  };

  const result = run().finally(() => {
    settled = true;
    unsubscribe();
  });
  return {
    result,
    decide(decision) {
      waiting?.(decision);
    },
  };
}
