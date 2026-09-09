import type { Chat } from "./types";

/** A new-agent surface is renderer-only until its first user message commits. */
export interface ChatDraft {
  readonly chat: Chat;
  readonly sending: boolean;
}

const drafts = new Map<string, ChatDraft>();
const owners = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function subscribeChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getChatDraft(id: string): ChatDraft | undefined {
  return drafts.get(id);
}

export function createChatDraft(workspaceId: string, id = crypto.randomUUID()): ChatDraft {
  if (drafts.has(id)) throw new Error("This draft already exists.");
  // Multiple New activations can supersede navigation before a pane mounts.
  // Only keep drafts that acquired a view owner or have a send to settle.
  for (const [previousId, previous] of drafts) {
    if (!owners.has(previousId) && !previous.sending) drafts.delete(previousId);
  }
  const now = Date.now();
  const draft: ChatDraft = {
    chat: { id, workspaceId, title: "New agent", messages: [], createdAt: now, updatedAt: now },
    sending: false,
  };
  drafts.set(id, draft);
  notify();
  return draft;
}

export function updateChatDraft(id: string, update: Pick<Partial<Chat>, "workspaceId" | "computerUseEnabled" | "title">): void {
  const draft = drafts.get(id);
  if (!draft || draft.sending) throw new Error("Wait for the first message to finish saving.");
  drafts.set(id, { ...draft, chat: { ...draft.chat, ...update } });
  notify();
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
  if (committed || !owners.get(id)) drafts.delete(id);
  else drafts.set(id, { ...draft, sending: false });
  notify();
}

export function discardChatDraft(id: string): void {
  if (drafts.get(id)?.sending) return;
  if (drafts.delete(id)) notify();
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
      if (!owners.has(id)) discardChatDraft(id);
    });
  };
}
