import type { Attachment } from "./types";
import type { GrabbedElementContextV1 } from "../shared/browser-element-grab";

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
    throw new Error("Aiden could not save this draft here. Free local storage before sending.");
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
  attachmentSeeds.delete(chatId);
  grabbedElementDrafts.delete(chatId);
  try { localStorage.removeItem(key(chatId)); } catch { /* Deletion still proceeds. */ }
}

// One-shot, in-memory attachment seeds for a composer that is about to open
// (Edit in fork). Never persisted: attachment bytes stay out of storage.
const attachmentSeeds = new Map<string, Attachment[]>();

// Per-chat in-memory grabbed browser element drafts (and their linked cropped
// thumbnails). Never persisted to localStorage.
const grabbedElementDrafts = new Map<
  string,
  { elements: GrabbedElementContextV1[]; thumbnails: Attachment[] }
>();

// In-memory grabbed elements attached to an in-flight worktree first-send so
// DraftWorktreeSendView keeps showing them if the user leaves and returns.
const activeWorktreeGrabbedElements = new Map<string, GrabbedElementContextV1[]>();

export function saveComposerDraftGrabbedElements(
  chatId: string,
  elements: readonly GrabbedElementContextV1[],
  thumbnails: readonly Attachment[] = [],
): void {
  if (elements.length === 0) {
    grabbedElementDrafts.delete(chatId);
    return;
  }
  const thumbnailIds = new Set(
    elements.map((element) => element.thumbnailAttachmentId).filter((id): id is string => Boolean(id)),
  );
  const matchingThumbnails = thumbnails
    .filter((attachment) => thumbnailIds.has(attachment.id) && Boolean(attachment.data))
    .map((attachment) => ({ ...attachment }));
  grabbedElementDrafts.set(chatId, {
    elements: elements.map((element) => structuredClone(element)),
    thumbnails: matchingThumbnails,
  });
}

export function loadComposerDraftGrabbedElements(chatId: string): GrabbedElementContextV1[] {
  const entry = grabbedElementDrafts.get(chatId);
  return entry ? entry.elements.map((element) => structuredClone(element)) : [];
}

export function loadComposerDraftGrabbedThumbnails(chatId: string): Attachment[] {
  const entry = grabbedElementDrafts.get(chatId);
  return entry ? entry.thumbnails.map((attachment) => ({ ...attachment })) : [];
}

export function seedComposerGrabbedElements(
  chatId: string,
  elements: readonly GrabbedElementContextV1[] | undefined,
  thumbnails?: readonly Attachment[],
): void {
  if (!elements || elements.length === 0) {
    grabbedElementDrafts.delete(chatId);
    return;
  }
  const existingThumbnails = grabbedElementDrafts.get(chatId)?.thumbnails ?? [];
  saveComposerDraftGrabbedElements(chatId, elements, thumbnails ?? existingThumbnails);
}

export function setActiveWorktreeGrabbedElements(
  draftId: string,
  elements: readonly GrabbedElementContextV1[] | undefined,
): void {
  if (!elements || elements.length === 0) activeWorktreeGrabbedElements.delete(draftId);
  else activeWorktreeGrabbedElements.set(draftId, elements.map((element) => structuredClone(element)));
}

export function getActiveWorktreeGrabbedElements(
  draftId: string,
): GrabbedElementContextV1[] | undefined {
  const saved = activeWorktreeGrabbedElements.get(draftId);
  return saved ? saved.map((element) => structuredClone(element)) : undefined;
}

export function seedComposerAttachments(chatId: string, attachments: readonly Attachment[]): void {
  const usable = attachments.filter((attachment) =>
    attachment.kind === "image" ? Boolean(attachment.data) : attachment.text !== undefined,
  );
  if (usable.length > 0) attachmentSeeds.set(chatId, usable.map((attachment) => ({ ...attachment })));
  else attachmentSeeds.delete(chatId);
}

export function takeComposerAttachmentSeed(chatId: string): Attachment[] | undefined {
  const seed = attachmentSeeds.get(chatId);
  attachmentSeeds.delete(chatId);
  return seed;
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

/**
 * Guidance returned after its stream's terminal: Stop stopped waiting for its
 * visible save and that save then failed. Routed by chat, not by stream.
 */
export function subscribeLateReturnedGuidance(
  subscribe: (channel: "chat:guidance-returned", handler: (payload: unknown) => void) => () => void,
): () => void {
  return subscribe("chat:guidance-returned", (payload) => {
    const chatId = (payload as { chatId?: unknown } | null | undefined)?.chatId;
    if (typeof chatId !== "string" || chatId.length === 0) return;
    restoreUndeliveredGuidance(chatId, undeliveredGuidanceFromTerminal(payload));
  });
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

export interface StageComposerTextOptions {
  /**
   * What a mounted composer says when the text arrives. Left out, it says a
   * visual added a follow-up; `null` says nothing, for a person's own action
   * that already moves them to the message box.
   */
  notice?: string | null;
  /** Leave the draft alone when it already holds this text, so a repeated action adds it once. */
  once?: boolean;
}

/** The draft with staged text added after it, or unchanged when `once` finds it already there. */
export function mergeStagedComposerText(current: string, staged: string, once = false): string {
  if (once && current.includes(staged.trim())) return current;
  return mergeRestoredGuidance(current, [staged]);
}

type StagedTextListener = (text: string, options: StageComposerTextOptions) => void;
const stagedTextListeners = new Map<string, Set<StagedTextListener>>();

/**
 * Put text in the chat's draft for the user to review and send, for example a
 * follow-up an inline visual asked for while a reply was still running. A
 * mounted composer merges it into its live text; otherwise the saved draft is
 * extended so the text is there when the chat is reopened.
 */
export function stageComposerText(chatId: string, text: string, options: StageComposerTextOptions = {}): void {
  if (!text.trim()) return;
  const listeners = stagedTextListeners.get(chatId);
  if (listeners?.size) {
    for (const listener of [...listeners]) listener(text, options);
    return;
  }
  const record = read(chatId);
  const current = record.text || record.unresolvedText || "";
  write(chatId, { ...record, text: mergeStagedComposerText(current, text, options.once) });
}

export function subscribeStagedComposerText(
  chatId: string,
  listener: StagedTextListener,
): () => void {
  let listeners = stagedTextListeners.get(chatId);
  if (!listeners) {
    listeners = new Set();
    stagedTextListeners.set(chatId, listeners);
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current.size === 0 && stagedTextListeners.get(chatId) === current) {
      stagedTextListeners.delete(chatId);
    }
  };
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

type RestoredMessageListener = (restored: {
  text: string;
  attachments: Attachment[];
  grabbedElements?: GrabbedElementContextV1[];
}) => void;
const restoredMessageListeners = new Map<string, Set<RestoredMessageListener>>();

/**
 * Give an unsent message back to its draft: text, attachments, and grabbed
 * browser elements. A mounted composer takes all now; otherwise the text is
 * saved and attachments / grabbed elements are seeded in memory for the
 * composer that opens next.
 */
export function restoreUnsentMessage(
  chatId: string,
  text: string,
  attachments: readonly Attachment[],
  grabbedElements: readonly GrabbedElementContextV1[] = [],
): void {
  const copy = attachments.map((attachment) => ({ ...attachment }));
  const elementsCopy = grabbedElements.map((element) => structuredClone(element));
  const listeners = restoredMessageListeners.get(chatId);
  if (listeners?.size) {
    for (const listener of [...listeners]) {
      listener({
        text,
        attachments: copy,
        ...(elementsCopy.length > 0 ? { grabbedElements: elementsCopy } : {}),
      });
    }
    return;
  }
  if (text.trim()) {
    const record = read(chatId);
    const current = record.text || record.unresolvedText || "";
    write(chatId, { ...record, text: mergeRestoredGuidance(current, [text]) });
  }
  if (copy.length > 0) seedComposerAttachments(chatId, copy);
  if (elementsCopy.length > 0) saveComposerDraftGrabbedElements(chatId, elementsCopy, copy);
}

export function subscribeRestoredUnsentMessage(
  chatId: string,
  listener: RestoredMessageListener,
): () => void {
  let listeners = restoredMessageListeners.get(chatId);
  if (!listeners) {
    listeners = new Set();
    restoredMessageListeners.set(chatId, listeners);
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current.size === 0 && restoredMessageListeners.get(chatId) === current) {
      restoredMessageListeners.delete(chatId);
    }
  };
}
