// The transcript while a New worktree draft's first message is being sent:
// the message itself, shown straight away, then one activity-style row with
// the worktree's progress, or the failure and what the user can do next.

import { AlertCircle, Check } from "lucide-react";
import { Button, Text } from "./ui";
import { AidenActivityMark } from "./aiden-activity-mark";
import { MessageBubble } from "./message-bubble";
import type { Attachment } from "../lib/types";
import { worktreeProgressText } from "../lib/draft-git-menu";
import type { WorktreeSendDecision, WorktreeSendView } from "../lib/draft-worktree-send";
import { pauseWhenUnseen } from "../lib/offscreen-pause";

export function DraftWorktreeSendView({
  text,
  attachments,
  view,
  onDecide,
}: {
  text: string;
  attachments: readonly Attachment[];
  view: WorktreeSendView;
  onDecide: (decision: WorktreeSendDecision) => void;
}) {
  return (
    <div
      className="aiden-dock-inset chat-content-column flex flex-col gap-5 py-6"
      data-draft-worktree-send={view.status}
    >
      <MessageBubble
        role="user"
        content={text}
        attachments={attachments.length > 0 ? [...attachments] : undefined}
      />
      {view.status === "failed" ? (
        <div
          role="alert"
          className="agent-event-in flex flex-col gap-2 rounded-card bg-status-red-surface px-3 py-2.5"
          data-worktree-send-failure
        >
          <div className="flex min-w-0 items-start gap-2">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-red" />
            <div className="min-w-0 flex-1">
              <Text variant="small-strong" className="block text-status-red">
                {view.reason}
              </Text>
              {view.detail ? (
                <Text variant="small" color="secondary" className="mt-0.5 block break-words">
                  {view.detail}
                </Text>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            {view.existing ? (
              <Button variant="filled" size="small" onClick={() => onDecide("use-existing")}>
                Use {view.existing.branch}
              </Button>
            ) : (
              <Button variant="filled" size="small" onClick={() => onDecide("retry")}>
                Retry
              </Button>
            )}
            <Button variant="transparent" size="small" onClick={() => onDecide("checkout")}>
              Run in this checkout instead
            </Button>
            <Button variant="transparent" size="small" onClick={() => onDecide("cancel")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="agent-activity-layer agent-event-in flex h-6 w-fit max-w-full items-center gap-2"
          data-worktree-send-progress={view.progress.phase ?? "starting"}
        >
          {view.progress.phase === "ready" && view.status === "running" ? (
            <Check aria-hidden="true" className="size-5 shrink-0 text-status-green" />
          ) : (
            <AidenActivityMark mark="bounce" size={20} className="shrink-0 text-primary" />
          )}
          <Text
            variant="small"
            color="secondary"
            ref={view.progress.phase === "ready" && view.status === "running" ? undefined : pauseWhenUnseen}
            className={
              view.progress.phase === "ready" && view.status === "running"
                ? "min-w-0 truncate"
                : "agent-thinking-shimmer min-w-0 truncate"
            }
          >
            {view.status === "checkout"
              ? "Sending in this checkout…"
              : worktreeProgressText(view.progress, view.request)}
          </Text>
        </div>
      )}
    </div>
  );
}
