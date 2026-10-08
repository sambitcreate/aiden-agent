// What a Bot chat shows, row by row, from the durable projection.
//
// Everything a Bot did on the way to its answer folds into ONE "Updates" line
// per reply: narration written before tool calls, and the in-flight partial
// while the reply runs. A reply's turn starts at the person's message (or a
// routine, or their answer to a question) and ends at the next one.

import {
  botRetryableFailedTurn,
  type BotTranscriptEntry,
} from "../../shared/bot-live";
import type { ConnectCardEntry } from "../../shared/bot-connections";
import { resolveBotReplyProjection } from "./bot-reply-projection";

export type BotTranscriptRow =
  | { kind: "user"; id: string; text: string }
  | { kind: "routine"; id: string; label: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  /** The one collapsed progress line of a reply; `active` while it runs. */
  | { kind: "updates"; id: string; progressText: string; active: boolean }
  | { kind: "file"; id: string; path: string; operation: "written" | "edited" }
  | { kind: "image"; id: string; name: string; mimeType: string; size: number; data: string }
  | { kind: "notice"; id: string; notice: "interrupted" | "session_reset" }
  | { kind: "connect"; id: string; card: ConnectCardEntry }
  /** `retryText` is set only on the newest failed turn, when Retry applies. */
  | { kind: "failed"; id: string; retryText: string | null; errorMessage?: string };

type UpdatesRow = Extract<BotTranscriptRow, { kind: "updates" }>;

function joinProgress(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function botTranscriptRows(
  entries: readonly BotTranscriptEntry[],
  partial: string | null,
  running: boolean,
): BotTranscriptRow[] {
  const rows: BotTranscriptRow[] = [];
  const retryable = running ? null : botRetryableFailedTurn(entries);
  // The current reply's Updates row and the narration folded into it so far.
  let updates: { row: UpdatesRow; parts: string[] } | null = null;
  const fold = (id: string, text: string) => {
    if (!updates) {
      const row: UpdatesRow = { kind: "updates", id: `${id}:updates`, progressText: "", active: false };
      rows.push(row);
      updates = { row, parts: [] };
    }
    updates.parts.push(text);
    updates.row.progressText = joinProgress(updates.parts);
  };
  const endTurn = () => {
    updates = null;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        endTurn();
        rows.push({ kind: "user", id: entry.id, text: entry.text });
        break;
      case "question_answer":
        endTurn();
        rows.push({ kind: "user", id: entry.id, text: entry.text });
        break;
      case "routine":
        endTurn();
        rows.push({ kind: "routine", id: entry.id, label: entry.label, text: entry.text });
        break;
      case "assistant":
        if (entry.toolCalls.length > 0) fold(entry.id, entry.text);
        else if (entry.text.trim()) rows.push({ kind: "assistant", id: entry.id, text: entry.text });
        break;
      case "file":
        rows.push({ kind: "file", id: entry.id, path: entry.path, operation: entry.operation });
        break;
      case "shared_image":
        rows.push({ kind: "image", id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size, data: entry.data });
        break;
      case "notice":
        endTurn();
        rows.push({ kind: "notice", id: entry.id, notice: entry.notice });
        break;
      case "connect_card":
        rows.push({ kind: "connect", id: entry.id, card: entry.card });
        break;
      case "failed_turn":
        rows.push({
          kind: "failed",
          id: entry.id,
          retryText: retryable?.id === entry.id ? entry.retryText : null,
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        });
        break;
      case "tool_result":
        break;
    }
  }

  if (running) {
    // Everything streamed so far is progress until the reply commits.
    const { progressText } = partial === null ? { progressText: "" } : resolveBotReplyProjection(partial, null, true);
    // The reply's existing Updates line carries it, even with chips below it.
    const current = updates as { row: UpdatesRow; parts: string[] } | null;
    if (current) {
      current.row.active = true;
      if (progressText) current.row.progressText = joinProgress([...current.parts, progressText]);
    } else {
      rows.push({ kind: "updates", id: "working", progressText, active: true });
    }
  } else if (partial !== null) {
    // A paused reply keeps what it wrote, as a bubble.
    const text = partial.trim();
    if (text) rows.push({ kind: "assistant", id: "partial", text: partial });
  }
  return rows;
}
