// A follow-up notice in the transcript: a background job ended, a followed
// pull request has news, or a "done when" check ran. It is stored as a user
// message for the model, so the card replaces the user bubble. The details
// disclosure shows exactly what the agent was told, output included.

import * as React from "react";
import { ChevronDown, GitPullRequest, ListChecks, TerminalSquare } from "lucide-react";
import type { AgentNoticeV1 } from "../shared/agent-notices";
import { Markdown } from "./markdown";
import { Button, Text } from "./ui";
import { cn } from "../lib/ui-utils";

const SOURCE_ICONS = {
  background_job: TerminalSquare,
  pull_request: GitPullRequest,
  check: ListChecks,
} as const;

const SOURCE_LABELS = {
  background_job: "Background job",
  pull_request: "Pull request",
  check: "Done-when check",
} as const;

export function AgentNoticeCard({ notice, content }: { notice: AgentNoticeV1; content: string }) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();
  const Icon = SOURCE_ICONS[notice.source];
  return (
    <div className="flex w-full" data-agent-notice={notice.source} data-tone={notice.tone}>
      <div
        className={cn(
          "flex w-full min-w-0 flex-col rounded-xl px-3 py-2",
          notice.tone === "success"
            ? "bg-status-green-surface"
            : notice.tone === "failure"
              ? "bg-status-red-surface"
              : "bg-control",
        )}
        role="note"
        aria-label={`${SOURCE_LABELS[notice.source]}: ${notice.title}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              notice.tone === "success"
                ? "text-status-green"
                : notice.tone === "failure"
                  ? "text-status-red"
                  : "text-secondary",
            )}
          />
          <div className="min-w-0 flex-1">
            <Text as="p" variant="small-strong" className="truncate">
              {notice.title}
            </Text>
            {notice.summary ? (
              <Text as="p" variant="small" color="secondary" className="truncate">
                {notice.summary}
              </Text>
            ) : null}
          </div>
          <Button
            variant="transparent"
            size="small"
            className="shrink-0 gap-1 px-2 text-secondary"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
          >
            Details
            <ChevronDown
              aria-hidden="true"
              className={cn("size-3.5 transition-transform duration-200 ease-standard motion-reduce:transition-none", open && "rotate-180")}
            />
          </Button>
        </div>
        {open ? (
          <div id={detailsId} className="mt-2 min-w-0 select-text text-small">
            <p className="mb-1 text-mini text-tertiary">What Aiden told the agent</p>
            <Markdown content={content} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
