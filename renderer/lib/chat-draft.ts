import type { Chat } from "./types";
import { discardComposerDraft, loadComposerDraft } from "./composer-draft-store";

/** A new-agent surface is renderer-only until its first user message commits. */
export interface ChatDraft {
  readonly chat: Chat;
  readonly sending: boolean;
  /** Optional one-shot composer seed supplied by an explicit app entry point. */
  readonly initialText?: string;
  /** The composer holds text or attachments. A draft with content is never reused. */
  readonly hasContent: boolean;
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
  };
  drafts.set(id, draft);
  notify();
  return draft;
}

export function updateChatDraft(id: string, update: Pick<Partial<Chat>, "workspaceId" | "title">): void {
  const draft = drafts.get(id);
  if (!draft || draft.sending) throw new Error("Wait for the first message to finish saving.");
  drafts.set(id, { ...draft, chat: { ...draft.chat, ...update } });
  notify();
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
