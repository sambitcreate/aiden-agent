import * as React from "react";
import { Check, Clock3, X } from "lucide-react";
import type { ApprovalPrompt } from "../../lib/ipc";
import {
  isAssistantAutomationApprovalDetails,
  type AssistantAutomationApprovalDetails,
} from "../../shared/assistant";
import { formatSchedule } from "../../lib/scheduled-task-view";
import { Badge, Button, Text } from "../ui";

function automationDetails(prompt: ApprovalPrompt): AssistantAutomationApprovalDetails | undefined {
  return isAssistantAutomationApprovalDetails(prompt.details) ? prompt.details : undefined;
}

function nextRunLabel(details: AssistantAutomationApprovalDetails): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: details.timezone,
    }).format(new Date(details.nextRunAt));
  } catch {
    return new Date(details.nextRunAt).toLocaleString();
  }
}

/** Compact, attended confirmation for Aiden's only mutating capability. */
export function AssistantAutomationApproval({
  prompt,
  deciding,
  onDecision,
}: {
  prompt: ApprovalPrompt;
  deciding: boolean;
  onDecision: (decision: "allow" | "deny") => void;
}): React.ReactElement {
  const declineRef = React.useRef<HTMLButtonElement>(null);
  const details = automationDetails(prompt);
  const editing = details?.action === "edit";
  const fullAccess = details?.permission === "full";
  const actionScope = editing
    ? fullAccess
      ? "Full access automation changes"
      : "automation changes"
    : fullAccess
      ? "Full access automation"
      : "automation";
  const accessLabel = details
    ? [details.permission === "full" ? "Full access" : "Read-only", details.workspaceName]
        .filter(Boolean)
        .join(" · ")
    : "";

  React.useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => declineRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus());
    };
  }, [prompt.approvalId]);

  return (
    <section
      aria-labelledby={`assistant-approval-title-${prompt.approvalId}`}
      aria-describedby={`assistant-approval-description-${prompt.approvalId}`}
      aria-busy={deciding}
      data-state="open"
      className="assistant-automation-approval origin-bottom rounded-card bg-control/70 p-3"
    >
      <p
        className="sr-only"
        role="status"
        id={`assistant-approval-description-${prompt.approvalId}`}
      >
        Automation approval needed. Review the details, then confirm or decline.
      </p>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Text as="p" variant="small-strong" id={`assistant-approval-title-${prompt.approvalId}`}>
            {editing ? "Save these changes?" : "Create this automation?"}
          </Text>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            ref={declineRef}
            iconOnly
            size="small"
            variant="muted"
            aria-label={`Decline ${actionScope}`}
            title="Decline"
            disabled={deciding}
            onClick={() => onDecision("deny")}
          >
            <X />
          </Button>
          <Button
            iconOnly
            size="small"
            variant="accent"
            aria-label={`Confirm ${actionScope}`}
            title={editing ? "Save changes" : fullAccess ? "Allow Full access" : "Confirm once"}
            disabled={deciding || !details}
            onClick={() => {
              if (details) onDecision("allow");
            }}
          >
            <Check />
          </Button>
        </div>
      </div>

      {details ? (
        <div className="mt-2.5 text-small">
          <div>
            <Text as="p" variant="small-strong" className="break-words">
              {details.name}
            </Text>
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-secondary">
              <Clock3 className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 break-words">
                {formatSchedule(details.cron, details.timezone, new Date(details.nextRunAt))}
              </span>
            </span>
            {details.enabled === false ? (
              <Text as="p" variant="small" color="tertiary" className="mt-0.5 pl-5">
                Remains paused
              </Text>
            ) : (
              <Text as="p" variant="small" color="tertiary" className="mt-0.5 pl-5">
                Next run: {nextRunLabel(details)}
              </Text>
            )}
          </div>
          <Text
            as="p"
            variant="small"
            color="secondary"
            className="mt-2 max-h-24 select-text overflow-y-auto whitespace-pre-wrap border-t border-separator pt-2 break-words"
          >
            {details.prompt}
          </Text>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge>{accessLabel}</Badge>
            <Text as="p" variant="small" color="tertiary">
              Runs while Aiden is open.
            </Text>
          </div>
          {details.permission === "full" && details.workspaceName ? (
            <Text as="p" variant="small" className="mt-2 text-support-warning">
              Can edit files and run commands in {details.workspaceName}.
            </Text>
          ) : null}
          {!details.schedulerEnabled ? (
            <Text as="p" variant="small" className="mt-2 text-support-warning">
              Scheduling is off. This will be saved but will not run until Scheduled Tasks are
              enabled.
            </Text>
          ) : null}
        </div>
      ) : (
        <Text as="p" variant="small" className="mt-2.5 text-support-red">
          This automation request is invalid and cannot be confirmed.
        </Text>
      )}
    </section>
  );
}
