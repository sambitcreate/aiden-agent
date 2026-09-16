import * as React from "react";
import { Loader2, Mic2 } from "lucide-react";
import type { ApprovalPrompt } from "../../lib/ipc";
import { Text } from "../ui";

/** Compact attended Allow-once surface for Live's existing Computer Use policy. */
export function AssistantComputerUseApproval({
  prompt,
  deciding,
}: {
  prompt: ApprovalPrompt;
  deciding: boolean;
}): React.ReactElement {
  return (
    <section
      aria-labelledby={`assistant-live-computer-use-title-${prompt.approvalId}`}
      aria-describedby={`assistant-live-computer-use-summary-${prompt.approvalId}`}
      aria-busy={deciding}
      aria-live="assertive"
      data-state="open"
      className="assistant-automation-approval mx-2.5 shrink-0 rounded-card bg-control/70 p-3"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-status-accent-surface text-status-accent">
          {deciding ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Mic2 className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <Text
          as="p"
          variant="small-strong"
          id={`assistant-live-computer-use-title-${prompt.approvalId}`}
        >
          {deciding ? "Applying your voice decision…" : "Voice approval required"}
        </Text>
      </div>
      <Text
        as="p"
        variant="small"
        color="secondary"
        className="mt-2 max-h-24 select-text overflow-y-auto whitespace-pre-wrap break-words"
        id={`assistant-live-computer-use-summary-${prompt.approvalId}`}
      >
        {prompt.summary}
      </Text>
      <Text as="p" variant="small" color="tertiary" className="mt-1.5">
        Say “Allow once” or “Deny.” Approval applies only to this exact action and current
        captured target.
      </Text>
    </section>
  );
}
