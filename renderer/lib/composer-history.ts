import type { ChatMessage } from "./types";
import {
  BOT_FAILED_TURN_TEXT,
  BOT_SILENT_REPLY,
  type BotTranscriptEntry,
} from "../shared/bot-live";
import { withoutGrabbedElementThumbnails } from "../shared/browser-element-grab";
import { providerFailurePresentation } from "../shared/provider-failure";
import { boundedUnicodePrefix, clippedUnicode } from "../shared/unicode-prefix";

export type ComposerHistoryReplyStatus =
  | "answered"
  | "failed"
  | "blocked"
  | "stopped"
  | "pending"
  | "none";

export interface ComposerHistoryEntry {
  id: string;
  /** Exact user-authored prompt text to recall into the composer. */
  prompt: string;
  /** Single-line collapsed prompt preview for compact list display. */
  promptPreview: string;
  /** Readable plain-text preview of the paired assistant reply, if any. */
  replyPreview?: string;
  replyStatus: ComposerHistoryReplyStatus;
  createdAt?: number;
  /** Count of attachments and grabbed browser elements sent with this prompt. */
  attachmentCount?: number;
  /** Present when this turn can be edited in a fork (local settled non-Bot turn). */
  forkMessageId?: string;
}

export interface ComposerHistoryState {
  open: boolean;
  /** Anchors selection by entry id if live messages arrive while browsing. */
  activeId: string | null;
  /** Draft text captured before entering history mode, restored on Escape or ↓ past newest. */
  savedDraft: string;
}

export const CLOSED_COMPOSER_HISTORY: ComposerHistoryState = Object.freeze({
  open: false,
  activeId: null,
  savedDraft: "",
});

const MAX_PROMPT_SCAN_CODE_UNITS = 512;
const MAX_PROMPT_PREVIEW_CODE_UNITS = 160;
const MAX_REPLY_SCAN_CODE_UNITS = 1200;
const MAX_REPLY_PREVIEW_CODE_UNITS = 320;

export function formatHistoryPromptPreview(raw: string): string {
  const collapsed = boundedUnicodePrefix(raw, MAX_PROMPT_SCAN_CODE_UNITS)
    .replace(/\s+/gu, " ")
    .trim();
  return clippedUnicode(collapsed, MAX_PROMPT_PREVIEW_CODE_UNITS);
}

/**
 * Collapses a markdown assistant reply into a clean, readable plain-text snippet
 * for the history popover's previous-reply preview.
 */
export function formatHistoryReplyPreview(raw: string): string {
  const prefix = boundedUnicodePrefix(raw, MAX_REPLY_SCAN_CODE_UNITS);
  const cleaned = prefix
    // Remove fenced code block delimiter lines (` ``` ` or `~~~` with any info string).
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gmu, " ")
    // Replace markdown images and links with their visible label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    // Strip leading heading, blockquote, and bullet/numbered list prefix clusters (including nested `> - ` / `> # `).
    .replace(/^[ \t]*(?:(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*))+/gmu, "")
    // Strip inline code and bold/strikethrough delimiters without mangling snake_case.
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  return clippedUnicode(cleaned, MAX_REPLY_PREVIEW_CODE_UNITS);
}

function nonTextAssistantPreview(message: ChatMessage): string | undefined {
  if ((message.htmlArtifacts?.length ?? 0) > 0 || (message.uiVisuals?.length ?? 0) > 0) {
    return "Visual reply";
  }
  if ((message.attachments?.length ?? 0) > 0) {
    return "Attachment reply";
  }
  if ((message.appPanels?.length ?? 0) > 0) {
    return "Interactive reply";
  }
  return undefined;
}

/**
 * Extracts user-authored prompt history (oldest → newest) from a chat's messages,
 * pairing each prompt with its following assistant reply preview.
 */
export function composerHistoryFromMessages(
  messages: readonly ChatMessage[],
  forkableUserIds?: ReadonlySet<string>,
): ComposerHistoryEntry[] {
  const entries: ComposerHistoryEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.notice || message.fromLeadChat) continue;
    if (message.content.trim().length === 0) continue;

    let replyStatus: ComposerHistoryReplyStatus = "pending";
    let replyPreview: string | undefined;

    if (message.hookBlocked) {
      replyStatus = "blocked";
      const reason = formatHistoryReplyPreview(message.hookBlocked.reason);
      if (reason) replyPreview = reason;
    } else {
      let lastNonEmptyAssistantContent = "";
      let lastNonTextPreview: string | undefined;
      let lastAssistant: ChatMessage | undefined;
      let hasLaterTurn = false;
      for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
        const next = messages[cursor]!;
        // Any subsequent user-role turn (including a follow-up notice) ends this turn.
        if (next.role === "user") {
          hasLaterTurn = true;
          break;
        }
        if (next.role !== "assistant") continue;
        lastAssistant = next;
        if (next.content.trim().length > 0) {
          lastNonEmptyAssistantContent = next.content;
        }
        const nonText = nonTextAssistantPreview(next);
        if (nonText) lastNonTextPreview = nonText;
      }

      const timelineStatus = lastAssistant?.timeline?.status;
      if (lastAssistant && timelineStatus === "cancelled") {
        replyStatus = "stopped";
        const partial = lastNonEmptyAssistantContent
          ? formatHistoryReplyPreview(lastNonEmptyAssistantContent)
          : lastNonTextPreview;
        if (partial) replyPreview = partial;
      } else if (lastAssistant && (lastAssistant.providerFailure || timelineStatus === "failed")) {
        replyStatus = "failed";
        const source =
          lastAssistant.content.trim().length > 0
            ? lastAssistant.content
            : lastAssistant.providerFailure
              ? providerFailurePresentation(lastAssistant.providerFailure).description
              : "";
        const formatted = formatHistoryReplyPreview(source);
        if (formatted) replyPreview = formatted;
      } else if (lastNonEmptyAssistantContent) {
        replyStatus = "answered";
        replyPreview = formatHistoryReplyPreview(lastNonEmptyAssistantContent);
      } else if (lastNonTextPreview) {
        replyStatus = "answered";
        replyPreview = lastNonTextPreview;
      } else if (hasLaterTurn) {
        replyStatus = "none";
      }
    }

    const attachmentCount =
      withoutGrabbedElementThumbnails(message.attachments ?? []).length +
      (message.grabbedElements?.length ?? 0);

    entries.push({
      id: message.id,
      prompt: message.content,
      promptPreview: formatHistoryPromptPreview(message.content),
      ...(replyPreview ? { replyPreview } : {}),
      replyStatus,
      createdAt: message.createdAt,
      ...(attachmentCount > 0 ? { attachmentCount } : {}),
      ...(forkableUserIds?.has(message.id) ? { forkMessageId: message.id } : {}),
    });
  }
  return entries;
}

function isBotTurnBoundary(entry: BotTranscriptEntry): boolean {
  if (
    entry.type === "user" ||
    entry.type === "routine" ||
    entry.type === "notice" ||
    entry.type === "bot_message"
  ) {
    return true;
  }
  if (
    entry.type === "peer" &&
    entry.direction === "received" &&
    (entry.messageKind === "request" ||
      entry.messageKind === "question" ||
      entry.messageKind === "result")
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts person-authored prompt history (oldest → newest) from a Bot transcript,
 * pairing each prompt with the Bot's following assistant reply preview.
 */
export function composerHistoryFromBotEntries(
  entries: readonly BotTranscriptEntry[],
): ComposerHistoryEntry[] {
  const result: ComposerHistoryEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "user" || entry.text.trim().length === 0) continue;

    let replyStatus: ComposerHistoryReplyStatus = "pending";
    let replyPreview: string | undefined;
    let lastAssistant: Extract<BotTranscriptEntry, { type: "assistant" }> | undefined;
    let lastFailedTurn: Extract<BotTranscriptEntry, { type: "failed_turn" }> | undefined;
    let lastNonEmptyText = "";
    let stopped = false;
    let sharedImages = 0;
    const touchedFiles: string[] = [];
    let hasLaterTurn = false;

    for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
      const next = entries[cursor]!;
      if (isBotTurnBoundary(next)) {
        hasLaterTurn = true;
        break;
      }
      if (next.type === "failed_turn") {
        lastFailedTurn = next;
        stopped = false;
        continue;
      }
      if (next.type === "shared_image") {
        sharedImages += 1;
        continue;
      }
      if (next.type === "file") {
        touchedFiles.push(next.path);
        continue;
      }
      if (next.type === "tool_result") {
        if (next.status === "stopped") stopped = true;
        continue;
      }
      if (next.type !== "assistant") continue;
      lastAssistant = next;
      if (next.stopReason === "aborted") {
        stopped = true;
      } else {
        stopped = false;
      }
      const trimmed = next.text.trim();
      if (trimmed.length > 0 && trimmed !== BOT_SILENT_REPLY) {
        lastNonEmptyText = next.text;
      }
    }

    if (
      lastFailedTurn ||
      (lastAssistant && (lastAssistant.stopReason === "error" || Boolean(lastAssistant.errorMessage)))
    ) {
      replyStatus = "failed";
      const source =
        lastFailedTurn?.errorMessage?.trim() ||
        lastNonEmptyText.trim() ||
        lastAssistant?.errorMessage?.trim() ||
        BOT_FAILED_TURN_TEXT;
      const formatted = formatHistoryReplyPreview(source);
      if (formatted) replyPreview = formatted;
    } else if (lastNonEmptyText) {
      replyStatus = "answered";
      replyPreview = formatHistoryReplyPreview(lastNonEmptyText);
    } else if (stopped) {
      replyStatus = "stopped";
    } else if (sharedImages > 0) {
      replyStatus = "answered";
      replyPreview = sharedImages === 1 ? "Shared an image" : `Shared ${sharedImages} images`;
    } else if (touchedFiles.length > 0) {
      replyStatus = "answered";
      replyPreview =
        touchedFiles.length === 1
          ? `Updated ${touchedFiles[0]}`
          : `Updated ${touchedFiles.length} files`;
    } else if (hasLaterTurn) {
      replyStatus = "none";
    }

    result.push({
      id: entry.id,
      prompt: entry.text,
      promptPreview: formatHistoryPromptPreview(entry.text),
      ...(replyPreview ? { replyPreview } : {}),
      replyStatus,
      ...(entry.at !== undefined ? { createdAt: entry.at } : {}),
      ...(entry.imageCount > 0 ? { attachmentCount: entry.imageCount } : {}),
    });
  }
  return result;
}

export function resolveComposerHistoryIndex(
  entries: readonly ComposerHistoryEntry[],
  state: ComposerHistoryState,
): number {
  if (!state.open || entries.length === 0) return -1;
  if (state.activeId !== null) {
    const found = entries.findIndex((entry) => entry.id === state.activeId);
    if (found >= 0) return found;
  }
  return entries.length - 1;
}

export function reconcileComposerHistory(
  entries: readonly ComposerHistoryEntry[],
  state: ComposerHistoryState,
): ComposerHistoryState {
  if (!state.open) return state;
  if (entries.length === 0) return CLOSED_COMPOSER_HISTORY;
  if (state.activeId !== null && entries.some((entry) => entry.id === state.activeId)) {
    return state;
  }
  return { ...state, activeId: entries[entries.length - 1]!.id };
}

export function openComposerHistory(
  entries: readonly ComposerHistoryEntry[],
  savedDraft: string,
): { state: ComposerHistoryState; text: string } | null {
  if (entries.length === 0) return null;
  const newest = entries[entries.length - 1]!;
  return {
    state: {
      open: true,
      activeId: newest.id,
      savedDraft,
    },
    text: newest.prompt,
  };
}

export function stepComposerHistoryUp(
  entries: readonly ComposerHistoryEntry[],
  state: ComposerHistoryState,
): { state: ComposerHistoryState; text: string } | null {
  if (!state.open || entries.length === 0) return null;
  const currentIndex = resolveComposerHistoryIndex(entries, state);
  const nextIndex = Math.max(0, currentIndex - 1);
  const next = entries[nextIndex]!;
  return {
    state: { ...state, activeId: next.id },
    text: next.prompt,
  };
}

export function stepComposerHistoryDown(
  entries: readonly ComposerHistoryEntry[],
  state: ComposerHistoryState,
): { state: ComposerHistoryState; text: string; closed: boolean } | null {
  if (!state.open || entries.length === 0) return null;
  const currentIndex = resolveComposerHistoryIndex(entries, state);
  if (currentIndex >= entries.length - 1) {
    return {
      state: CLOSED_COMPOSER_HISTORY,
      text: state.savedDraft,
      closed: true,
    };
  }
  const next = entries[currentIndex + 1]!;
  return {
    state: { ...state, activeId: next.id },
    text: next.prompt,
    closed: false,
  };
}

export function selectComposerHistoryEntry(
  entries: readonly ComposerHistoryEntry[],
  entryId: string,
): { state: ComposerHistoryState; text: string } | null {
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) return null;
  return {
    state: CLOSED_COMPOSER_HISTORY,
    text: entry.prompt,
  };
}

export function dismissComposerHistory(
  state: ComposerHistoryState,
): { state: ComposerHistoryState; text: string } {
  return {
    state: CLOSED_COMPOSER_HISTORY,
    text: state.savedDraft,
  };
}

export function detachComposerHistory(): ComposerHistoryState {
  return CLOSED_COMPOSER_HISTORY;
}
