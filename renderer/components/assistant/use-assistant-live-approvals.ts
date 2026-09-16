import * as React from "react";
import { chatsApi, onNotification, type ApprovalPrompt } from "../../lib/ipc";
import type { AssistantLiveCaption } from "./use-assistant-live";

export interface AssistantLiveApprovals {
  approvals: ApprovalPrompt[];
  decidingApprovalId: string | null;
  decideApproval(prompt: ApprovalPrompt, decision: "allow" | "deny"): Promise<void>;
}

export function assistantLiveVoiceApprovalDecision(
  transcript: string,
): "allow" | "deny" | null {
  const normalized = transcript
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[.,!?;:'’“”"-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized === "allow once") return "allow";
  if (normalized === "deny") return "deny";
  return null;
}

function latestVoiceApprovalReceipt(
  captions: readonly AssistantLiveCaption[],
): NonNullable<AssistantLiveCaption["voiceApprovalReceipt"]> | null {
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    const caption = captions[index];
    if (caption?.direction === "input" && caption.voiceApprovalReceipt) {
      return caption.voiceApprovalReceipt;
    }
  }
  return null;
}

export function assistantLiveVoiceApprovalForReceipt(
  receipt: NonNullable<AssistantLiveCaption["voiceApprovalReceipt"]> | null,
  baselineReceiptId: number | undefined,
  alreadyConsumed: boolean,
): "allow" | "deny" | null {
  if (
    !receipt ||
    baselineReceiptId === undefined ||
    receipt.id <= baselineReceiptId ||
    alreadyConsumed
  ) {
    return null;
  }
  return assistantLiveVoiceApprovalDecision(receipt.text);
}

/** Live-only approval state; deliberately does not mount or list the legacy Assistant workspace. */
export function useAssistantLiveApprovals(
  captions: readonly AssistantLiveCaption[],
  latestVoiceApprovalReceiptId: () => number,
): AssistantLiveApprovals {
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const receiptBaselines = React.useRef(new Map<string, number>());
  const consumedReceiptIds = React.useRef(new Set<number>());

  React.useEffect(() => {
    const removeApproval = onNotification<ApprovalPrompt & { streamId: string }>(
      "chat:approval",
      (prompt) => {
        if (!prompt.streamId.startsWith("live:") || prompt.toolName !== "computer_use") return;
        receiptBaselines.current.set(prompt.approvalId, latestVoiceApprovalReceiptId());
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
        receiptBaselines.current.delete(approvalId);
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
  }, [latestVoiceApprovalReceiptId]);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (decidingApprovalId) return;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        receiptBaselines.current.delete(prompt.approvalId);
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

  React.useEffect(() => {
    const prompt = approvals[0];
    if (!prompt || decidingApprovalId) return;
    const receipt = latestVoiceApprovalReceipt(captions);
    const baseline = receiptBaselines.current.get(prompt.approvalId);
    const decision = assistantLiveVoiceApprovalForReceipt(
      receipt,
      baseline,
      receipt ? consumedReceiptIds.current.has(receipt.id) : false,
    );
    if (!decision || !receipt) return;
    consumedReceiptIds.current.add(receipt.id);
    void decideApproval(prompt, decision);
  }, [approvals, captions, decideApproval, decidingApprovalId]);

  return { approvals, decidingApprovalId, decideApproval };
}
