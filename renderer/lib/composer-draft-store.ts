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
