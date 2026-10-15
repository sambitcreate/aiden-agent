import type { Chat } from "./types";
import {
  readChatDraftGitMemory,
  rememberChatDraftGitMemory,
  type ChatDraftGitMode,
} from "./chat-draft-git-memory";
import type { FirstMessageWorktreeRequest } from "../shared/worktree-on-send";
import { discardComposerDraft, loadComposerDraft } from "./composer-draft-store";

export type { ChatDraftGitMode } from "./chat-draft-git-memory";

/** New-worktree settings. Nothing touches disk until the first send. */
export interface ChatDraftWorktree {
  /** Local branch, remote-tracking branch (`origin/main`), or `HEAD`. */
  readonly baseRef: string;
  /** Fetch the base from its upstream remote first. */
  readonly fromOrigin: boolean;
  /** Explicit branch name; omitted means Auto (`aiden/<slug of the first message>`). */
  readonly branchName?: string;
}

/** A new-agent surface is renderer-only until its first user message commits. */
export interface ChatDraft {
  readonly chat: Chat;
  readonly sending: boolean;
  /** Optional one-shot composer seed supplied by an explicit app entry point. */
  readonly initialText?: string;
  /** The composer holds text or attachments. A draft with content is never reused. */
  readonly hasContent: boolean;
  /** Run in this checkout, or in a new worktree created on first send. */
  readonly gitMode: ChatDraftGitMode;
  /**
   * New-worktree settings, kept while toggling back to This checkout. Absent
   * until a base is known (remembered, or chosen in the branch menu).
   */
  readonly worktree?: ChatDraftWorktree;
}

/** The git mode and worktree base remembered for a workspace. */
function rememberedGitState(
  workspaceId: string,
  gitMode?: ChatDraftGitMode,
): Pick<ChatDraft, "gitMode" | "worktree"> {
  const memory = readChatDraftGitMemory(workspaceId);
  return {
    gitMode: gitMode ?? memory.gitMode,
    ...(memory.baseRef
      ? { worktree: { baseRef: memory.baseRef, fromOrigin: memory.fromOrigin ?? false } }
      : {}),
  };
}

const drafts = new Map<string, ChatDraft>();
const owners = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: readonly ChatDraft[] | null = null;
const notify = () => {
  snapshot = null;
  for (const listener of listeners) listener();
};

export function subscribeChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getChatDraft(id: string): ChatDraft | undefined {
  return drafts.get(id);
}

/** Every live draft, oldest first; a stable snapshot between changes. */
export function listChatDrafts(): readonly ChatDraft[] {
  snapshot ??= [...drafts.values()];
  return snapshot;
}

export function createChatDraft(
  workspaceId: string,
  id = crypto.randomUUID(),
  initialText?: string,
  options: { gitMode?: ChatDraftGitMode } = {},
): ChatDraft {
  if (drafts.has(id)) throw new Error("This draft already exists.");
  // Multiple New activations can supersede navigation before a pane mounts.
  // Only keep drafts that acquired a view owner, have a send to settle, or
  // hold text the user can return to.
  for (const [previousId, previous] of drafts) {
    if (!owners.has(previousId) && !previous.sending && !previous.hasContent) {
      drafts.delete(previousId);
      focusRequests.delete(previousId);
      discardComposerDraft(previousId);
    }
  }
  const now = Date.now();
  const draft: ChatDraft = {
    chat: { id, workspaceId, title: "New agent", messages: [], createdAt: now, updatedAt: now },
    sending: false,
    hasContent: Boolean(initialText?.trim()),
    ...(initialText ? { initialText } : {}),
    ...rememberedGitState(workspaceId, options.gitMode),
  };
  drafts.set(id, draft);
  notify();
  return draft;
}

export function updateChatDraft(id: string, update: Pick<Partial<Chat>, "workspaceId" | "title">): void {
  const draft = drafts.get(id);
  if (!draft || draft.sending) throw new Error("Wait for the first message to finish saving.");
  const movesWorkspace = update.workspaceId !== undefined && update.workspaceId !== draft.chat.workspaceId;
  const { worktree: _previousWorktree, ...withoutWorktree } = draft;
  drafts.set(id, {
    ...(movesWorkspace ? withoutWorktree : draft),
    // A draft that moves starts from the git mode remembered for its new workspace.
    ...(movesWorkspace ? rememberedGitState(update.workspaceId!) : {}),
    chat: { ...draft.chat, ...update },
  });
  notify();
}

function settableDraft(id: string): ChatDraft {
  const draft = drafts.get(id);
  if (!draft || draft.sending) throw new Error("Wait for the first message to finish saving.");
  return draft;
}

function rememberDraftGitState(draft: ChatDraft): void {
  if (!draft.chat.workspaceId) return;
  rememberChatDraftGitMemory(draft.chat.workspaceId, {
    gitMode: draft.gitMode,
    ...(draft.worktree
      ? { baseRef: draft.worktree.baseRef, fromOrigin: draft.worktree.fromOrigin }
      : {}),
  });
}

/** Switch between This checkout and New worktree, and remember it for the workspace. */
export function setChatDraftGitMode(id: string, gitMode: ChatDraftGitMode): void {
  const draft = settableDraft(id);
  if (draft.gitMode === gitMode) return;
  const next = { ...draft, gitMode };
  drafts.set(id, next);
  rememberDraftGitState(next);
  notify();
}

/**
 * Change the draft's New worktree settings. The base and from-origin choice
 * are remembered for the workspace; a branch name belongs to this draft only.
 * Pass `branchName: undefined` (or blank) to go back to Auto.
 */
export function updateChatDraftWorktree(
  id: string,
  update: { baseRef?: string; fromOrigin?: boolean; branchName?: string },
): void {
  const draft = settableDraft(id);
  const baseRef = update.baseRef ?? draft.worktree?.baseRef;
  if (!baseRef) throw new Error("Choose a base branch for the new worktree.");
  const branchName = "branchName" in update
    ? update.branchName?.trim() || undefined
    : draft.worktree?.branchName;
  const worktree: ChatDraftWorktree = {
    baseRef,
    fromOrigin: update.fromOrigin ?? draft.worktree?.fromOrigin ?? false,
    ...(branchName ? { branchName } : {}),
  };
  const next = { ...draft, worktree };
  drafts.set(id, next);
  rememberDraftGitState(next);
  notify();
}

/**
 * The `worktree` field of the first-message request, or undefined in This
 * checkout mode. The draft id is the idempotency key, so a retry or a double
 * send never creates a second worktree.
 */
export function chatDraftWorktreeRequest(draft: ChatDraft): FirstMessageWorktreeRequest | undefined {
  if (draft.gitMode !== "worktree") return undefined;
  if (!draft.worktree) throw new Error("Choose a base branch for the new worktree.");
  if (!draft.chat.workspaceId) throw new Error("Choose a workspace for the new worktree.");
  return {
    sourceWorkspaceId: draft.chat.workspaceId,
    baseRef: draft.worktree.baseRef,
    fromOrigin: draft.worktree.fromOrigin,
    ...(draft.worktree.branchName ? { branchName: draft.worktree.branchName } : {}),
    idempotencyKey: draft.chat.id,
  };
}

/** The mounted composer reports whether this draft holds text or attachments. */
export function setChatDraftHasContent(id: string, hasContent: boolean): void {
  const draft = drafts.get(id);
  if (!draft || draft.hasContent === hasContent) return;
  drafts.set(id, { ...draft, hasContent });
  notify();
}

/**
 * An open, empty draft in this workspace that a new-chat entry point should
 * focus instead of creating another. Drafts that are sending, hold text or
 * attachments, or have no mounted view (about to be discarded) never qualify.
 */
export function findReusableChatDraft(workspaceId: string): ChatDraft | undefined {
  for (const [id, draft] of drafts) {
    if (
      draft.chat.workspaceId === workspaceId &&
      !draft.sending &&
      !draft.hasContent &&
      owners.has(id)
    ) {
      return draft;
    }
  }
  return undefined;
}

const focusRequests = new Set<string>();
const focusListeners = new Map<string, Set<() => void>>();

/**
 * Ask the draft's composer to take focus. A composer that is already mounted
 * focuses now; one that mounts later takes the pending request once.
 */
export function requestChatDraftComposerFocus(id: string): void {
  const listeners = focusListeners.get(id);
  if (listeners?.size) {
    for (const listener of listeners) listener();
    return;
  }
  focusRequests.add(id);
}

export function subscribeChatDraftComposerFocus(id: string, focus: () => void): () => void {
  let listeners = focusListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    focusListeners.set(id, listeners);
  }
  listeners.add(focus);
  if (focusRequests.delete(id)) focus();
  return () => {
    listeners.delete(focus);
    if (listeners.size === 0) focusListeners.delete(id);
  };
}

export function beginChatDraftSend(id: string): ChatDraft {
  const draft = drafts.get(id);
  if (!draft || draft.sending) throw new Error("This draft is already being sent.");
  drafts.set(id, { ...draft, sending: true });
  notify();
  return draft;
}

export function finishChatDraftSend(id: string, committed: boolean): void {
  const draft = drafts.get(id);
  if (!draft) return;
  if (committed || (!owners.get(id) && !draft.hasContent)) drafts.delete(id);
  else drafts.set(id, { ...draft, sending: false });
  notify();
}

export function discardChatDraft(id: string): void {
  if (drafts.get(id)?.sending) return;
  focusRequests.delete(id);
  if (drafts.delete(id)) {
    discardComposerDraft(id);
    notify();
  }
}

/** Delay disposal one microtask so StrictMode's effect replay can reacquire it. */
export function retainChatDraft(id: string): () => void {
  if (!drafts.has(id)) return () => {};
  owners.set(id, (owners.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (owners.get(id) ?? 1) - 1;
    if (count > 0) owners.set(id, count);
    else owners.delete(id);
    queueMicrotask(() => {
      if (owners.has(id)) return;
      const draft = drafts.get(id);
      if (!draft?.hasContent) {
        discardChatDraft(id);
        return;
      }
      // A draft with content outlives its view; reopening it restores the
      // composer's saved text rather than the original one-shot seed.
      if (draft.initialText && loadComposerDraft(id).text) {
        const { initialText: _seed, ...kept } = draft;
        drafts.set(id, kept);
        notify();
      }
    });
  };
}
