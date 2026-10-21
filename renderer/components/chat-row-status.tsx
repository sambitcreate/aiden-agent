import { CircleAlert, Loader2, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import {
  CHAT_ROW_FAILED_LABEL,
  CHAT_ROW_STATE_LABELS,
  type ChatRowState,
} from "../shared/chat-row-state";

/**
 * Trailing status for a chat list row. Attention states use soft semantic
 * fills (no borders), Working keeps the compact spinner, and Idle renders
 * nothing. The unread dot is independent of the row state: a chat can be
 * both working and holding unseen output from an earlier turn. When that
 * unseen output is a failed turn, a soft red Failed pill replaces the dot so a
 * failure never reads as a fresh reply.
 */
export function ChatRowStatus({
  state,
  unread,
  failed = false,
}: {
  state: ChatRowState;
  unread: boolean;
  /** The newest assistant output is a failed turn; shown only while unread. */
  failed?: boolean;
}) {
  if (state === "idle" && !unread) return null;
  return (
    <span className="flex items-center gap-1" data-chat-row-state={state}>
      {state === "needs_approval" ? (
        <span
          role="img"
          aria-label={CHAT_ROW_STATE_LABELS.needs_approval}
          title={CHAT_ROW_STATE_LABELS.needs_approval}
          className="inline-flex h-5 items-center gap-1 rounded-full bg-status-warning-surface px-1.5 text-mini font-medium text-status-warning"
        >
          <ShieldAlert className="size-3.5" aria-hidden="true" />
          <span aria-hidden="true">Approve</span>
        </span>
      ) : state === "needs_input" ? (
        <span
          role="img"
          aria-label={CHAT_ROW_STATE_LABELS.needs_input}
          title={CHAT_ROW_STATE_LABELS.needs_input}
          className="inline-flex h-5 items-center gap-1 rounded-full bg-status-accent-surface px-1.5 text-mini font-medium text-status-accent"
        >
          <MessageCircleQuestion className="size-3.5" aria-hidden="true" />
          <span aria-hidden="true">Reply</span>
        </span>
      ) : state === "working" ? (
        <span
          role="img"
          aria-label={CHAT_ROW_STATE_LABELS.working}
          title={CHAT_ROW_STATE_LABELS.working}
          className="inline-flex size-5 items-center justify-center text-accent-text"
        >
          {/* Reduced-motion mode collapses this continuous rotation via the global motion contract. */}
          <Loader2 className="size-4 animate-[spin_1.5s_linear_infinite]" aria-hidden="true" />
        </span>
      ) : null}
      {unread && failed ? (
        <span
          role="img"
          aria-label={CHAT_ROW_FAILED_LABEL}
          title="The last run failed"
          data-chat-unread="true"
          data-chat-row-failed="true"
          className="inline-flex h-5 items-center gap-1 rounded-full bg-status-red-surface px-1.5 text-mini font-medium text-status-red"
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
          <span aria-hidden="true">{CHAT_ROW_FAILED_LABEL}</span>
        </span>
      ) : unread ? (
        <span
          role="img"
          aria-label="Unread"
          title="New reply"
          data-chat-unread="true"
          className="inline-flex size-5 items-center justify-center"
        >
          <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
}
