import * as React from "react";
import { chatsApi, onNotification, type ApprovalPrompt } from "../../lib/ipc";

export interface AssistantLiveApprovals {
  approvals: ApprovalPrompt[];
  decidingApprovalId: string | null;
  decideApproval(prompt: ApprovalPrompt, decision: "allow" | "deny"): Promise<void>;
}

/** Live-only approval state; deliberately does not mount or list the legacy Assistant workspace. */
export function useAssistantLiveApprovals(): AssistantLiveApprovals {
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const removeApproval = onNotification<ApprovalPrompt & { streamId: string }>(
      "chat:approval",
      (prompt) => {
        if (!prompt.streamId.startsWith("live:") || prompt.toolName !== "computer_use") return;
        setApprovals((current) =>
          current.some((candidate) => candidate.approvalId === prompt.approvalId)
            ? current
            : [...current, prompt],
        );
      },
    );
    const removeWithdrawal = onNotification<{ approvalId: string }>(
      "chat:approval-withdrawn",
      ({ approvalId }) => {
        setApprovals((current) =>
          current.filter((candidate) => candidate.approvalId !== approvalId),
        );
        setDecidingApprovalId((current) => (current === approvalId ? null : current));
      },
    );
    return () => {
      removeApproval();
      removeWithdrawal();
    };
  }, []);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (decidingApprovalId) return;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        setApprovals((current) =>
          current.filter((candidate) => candidate.approvalId !== prompt.approvalId),
        );
      } finally {
        setDecidingApprovalId((current) =>
          current === prompt.approvalId ? null : current,
        );
      }
    },
    [decidingApprovalId],
  );

  return { approvals, decidingApprovalId, decideApproval };
}
