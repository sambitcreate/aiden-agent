/** Device-local text drafts. Attachment bytes stay in the attachment picker. */
interface StoredComposerDraft {
  version: 1;
  text: string;
  unresolvedText?: string;
}

const prefix = "aiden:composer-draft:";

function key(chatId: string): string {
  return `${prefix}${chatId}`;
}

function read(chatId: string): StoredComposerDraft {
  try {
    const value = JSON.parse(localStorage.getItem(key(chatId)) ?? "null") as Partial<StoredComposerDraft> | null;
    if (value?.version === 1 && typeof value.text === "string" &&
        (value.unresolvedText === undefined || typeof value.unresolvedText === "string")) {
      return { version: 1, text: value.text, unresolvedText: value.unresolvedText };
    }
  } catch { /* Corrupt or unavailable storage is treated as an empty draft. */ }
  return { version: 1, text: "" };
}

function write(chatId: string, record: StoredComposerDraft): void {
  try {
    if (!record.text && !record.unresolvedText) localStorage.removeItem(key(chatId));
    else localStorage.setItem(key(chatId), JSON.stringify(record));
  } catch { /* Sending remains available when browser storage is unavailable. */ }
}

export function loadComposerDraft(chatId: string): StoredComposerDraft {
  const record = read(chatId);
  return { ...record, text: record.text || record.unresolvedText || "" };
}

export function saveComposerDraftText(chatId: string, text: string): void {
  write(chatId, { ...read(chatId), text });
}

export function markComposerSubmission(chatId: string, text: string): void {
  try {
    localStorage.setItem(key(chatId), JSON.stringify({ version: 1, text, unresolvedText: text }));
  } catch {
    throw new Error("Aiden could not save this draft on this Mac. Free local storage before sending.");
  }
}

export function settleComposerSubmission(chatId: string, accepted: boolean, currentText: string): void {
  const record = read(chatId);
  write(chatId, {
    version: 1,
    text: accepted && currentText === record.unresolvedText ? "" : currentText,
  });
}

export function discardComposerDraft(chatId: string): void {
  try { localStorage.removeItem(key(chatId)); } catch { /* Deletion still proceeds. */ }
}

type GuidanceRestoreListener = (guidance: readonly string[]) => void;
const restoreListeners = new Map<string, Set<GuidanceRestoreListener>>();
const MAX_RESTORED_GUIDANCE = 32;

/** Accepted Steer text that the Mac reports was never read into the chat. */
export function undeliveredGuidanceFromTerminal(payload: unknown): string[] {
  const value = (payload as { undeliveredGuidance?: unknown } | null | undefined)
    ?.undeliveredGuidance;
  if (!Array.isArray(value)) return [];
  return value
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .slice(0, MAX_RESTORED_GUIDANCE);
}

export function mergeRestoredGuidance(current: string, guidance: readonly string[]): string {
  return [current, ...guidance].filter((part) => part.trim().length > 0).join("\n\n");
}

/**
 * Return undelivered guidance to the chat's draft. A mounted composer merges
 * it with its live text (and persists that); otherwise the device-local draft
 * is updated so the text is there when the chat is reopened.
 */
export function restoreUndeliveredGuidance(chatId: string, guidance: readonly string[]): void {
  if (guidance.length === 0) return;
  const listeners = restoreListeners.get(chatId);
  if (listeners?.size) {
    for (const listener of [...listeners]) listener(guidance);
    return;
  }
  const record = read(chatId);
  const current = record.text || record.unresolvedText || "";
  write(chatId, { ...record, text: mergeRestoredGuidance(current, guidance) });
}

export function subscribeGuidanceRestore(
  chatId: string,
  listener: GuidanceRestoreListener,
): () => void {
  let listeners = restoreListeners.get(chatId);
  if (!listeners) {
    listeners = new Set();
    restoreListeners.set(chatId, listeners);
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current.size === 0 && restoreListeners.get(chatId) === current) {
      restoreListeners.delete(chatId);
    }
  };
}
