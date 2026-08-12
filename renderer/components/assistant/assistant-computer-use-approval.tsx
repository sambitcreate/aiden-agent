import * as React from "react";
import { Check, X } from "lucide-react";
import type { ApprovalPrompt } from "../../lib/ipc";
import { Button, Text } from "../ui";

/** Compact attended Allow-once surface for Live's existing Computer Use policy. */
export function AssistantComputerUseApproval({
  prompt,
  deciding,
  onDecision,
}: {
  prompt: ApprovalPrompt;
  deciding: boolean;
  onDecision(decision: "allow" | "deny"): void;
}): React.ReactElement {
  const denyRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => denyRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (prior?.isConnected) requestAnimationFrame(() => prior.focus());
    };
  }, [prompt.approvalId]);

  return (
    <section
      aria-labelledby={`assistant-live-computer-use-title-${prompt.approvalId}`}
      aria-describedby={`assistant-live-computer-use-summary-${prompt.approvalId}`}
      aria-busy={deciding}
      className="assistant-automation-approval mx-2.5 shrink-0 rounded-card bg-control/70 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <Text
          as="p"
          variant="small-strong"
          id={`assistant-live-computer-use-title-${prompt.approvalId}`}
        >
          Allow this Computer Use action?
        </Text>
        <div className="flex shrink-0 gap-1">
          <Button
            ref={denyRef}
            iconOnly
            size="small"
            variant="muted"
            aria-label="Deny Computer Use action"
            title="Deny"
            disabled={deciding}
            onClick={() => onDecision("deny")}
          >
            <X />
          </Button>
          <Button
            iconOnly
            size="small"
            variant="accent"
            aria-label="Allow this Computer Use action once"
            title="Allow once"
            disabled={deciding}
            onClick={() => onDecision("allow")}
          >
            <Check />
          </Button>
        </div>
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
        Approval applies only to this exact action and current captured target.
      </Text>
    </section>
  );
}
