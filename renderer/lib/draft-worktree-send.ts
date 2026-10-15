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
import type { Attachment } from "./types";

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

export type WorktreeFirstSendResult<C> = (
  | { chat: C; worktree: FirstMessageWorktreeInfo; keptWorktreeBranch?: undefined }
  | {
      chat: C;
      worktree?: undefined;
      /** Run in this checkout after a worktree was already created: it is kept, not deleted. */
      keptWorktreeBranch?: string;
    }
) & {
  /**
   * The chat was saved after the user answered a failure (Retry, Use
   * <branch>, Run in this checkout), possibly from a later view of the draft.
   */
  answered: boolean;
};

export interface WorktreeFirstSend<C> {
  result: Promise<WorktreeFirstSendResult<C>>;
  /** Answer a failure. Ignored unless the send is waiting for one. */
  decide(decision: WorktreeSendDecision): void;
  /**
   * Stop publishing this send. The caller releases it once the saved chat (or
   * the restored composer text) has replaced the progress view.
   */
  release(): void;
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
 * A draft's worktree send, readable by any view of that draft. A send outlives
 * the pane that started it: a failure waits here until the user comes back to
 * the draft and answers it.
 */
export interface ActiveWorktreeSend {
  draftId: string;
  text: string;
  attachments: readonly Attachment[];
  view: WorktreeSendView;
  /** Answer a failure. Ignored unless the send is waiting for one. */
  decide(decision: WorktreeSendDecision): void;
}

const activeSends = new Map<string, ActiveWorktreeSend>();
const activeListeners = new Set<() => void>();

function publish(draftId: string, entry: ActiveWorktreeSend | undefined): void {
  if (entry) activeSends.set(draftId, entry);
  else if (!activeSends.delete(draftId)) return;
  for (const listener of activeListeners) listener();
}

export function subscribeActiveWorktreeSends(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

/** The draft's running or failed worktree send; a stable object between changes. */
export function activeWorktreeSend(draftId: string): ActiveWorktreeSend | undefined {
  return activeSends.get(draftId);
}

/**
 * Start a worktree first send for `draftId`. Progress and failures are
 * published as the draft's active send (and to `onView`) until `release`.
 * An IPC rejection rejects `result` as an ordinary send failure.
 */
export function startWorktreeFirstSend<Input, C>(options: {
  api: WorktreeSendApi<Input, C>;
  input: Input;
  worktree: FirstMessageWorktreeRequest;
  /** What the progress view shows as the user's message. */
  message: { text: string; attachments: readonly Attachment[] };
  onView?: (view: WorktreeSendView) => void;
}): WorktreeFirstSend<C> {
  const { api, input, onView, message } = options;
  const draftId = options.worktree.idempotencyKey;
  let request = options.worktree;
  let progress: WorktreeSendProgress = {};
  let waiting: ((decision: WorktreeSendDecision) => void) | undefined;
  let settled = false;
  let released = false;
  let answered = false;

  const decide = (decision: WorktreeSendDecision) => {
    waiting?.(decision);
  };
  const show = (view: WorktreeSendView) => {
    if (settled || released) return;
    publish(draftId, { draftId, ...message, view, decide });
    onView?.(view);
  };
  const unsubscribe = api.onProgress((event) => {
    if (event.draftId.toLowerCase() !== draftId.toLowerCase()) return;
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
      if (result.ok) return { chat: result.chat, worktree: result.worktree, answered };
      const existing = existingWorktreeOf(result);
      // A worktree that reported ready before the chat failed to save is kept.
      const created = existing?.branch ?? (progress.phase === "ready" ? progress.branch : undefined);
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
      answered = true;
      if (decision === "checkout") {
        show({ status: "checkout", request, progress });
        const chat = await api.createInCheckout(input);
        return created ? { chat, keptWorktreeBranch: created, answered } : { chat, answered };
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
    decide,
    release() {
      released = true;
      if (activeSends.get(draftId)?.decide === decide) publish(draftId, undefined);
    },
  };
}

type WorktreeSendContinuation = (turnId: string, workspaceId: string | undefined) => void;
const continuations = new Map<string, WorktreeSendContinuation>();

/**
 * The view currently showing `chatId` registers how it starts a reply. A
 * worktree send the user continued from that view (after leaving the pane
 * that sent it) hands its saved turn here instead of abandoning it.
 */
export function registerWorktreeSendContinuation(
  chatId: string,
  start: WorktreeSendContinuation,
): () => void {
  continuations.set(chatId, start);
  return () => {
    if (continuations.get(chatId) === start) continuations.delete(chatId);
  };
}

/** Start the reply in the view showing `chatId`; false when none is. */
export function continueWorktreeSendInView(
  chatId: string,
  turnId: string,
  workspaceId: string | undefined,
): boolean {
  const start = continuations.get(chatId);
  if (!start) return false;
  start(turnId, workspaceId);
  return true;
}
