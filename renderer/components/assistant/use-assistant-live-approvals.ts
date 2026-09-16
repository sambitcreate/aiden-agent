import * as React from "react";
import { chatsApi, onNotification, type ApprovalPrompt } from "../../lib/ipc";
import { assistantLiveVoiceApprovalDecision } from "./assistant-live-voice-approval";
import type { AssistantLiveVoiceApprovalReceipt } from "./use-assistant-live";

export { assistantLiveVoiceApprovalDecision } from "./assistant-live-voice-approval";

export interface AssistantLiveApprovals {
  approvals: ApprovalPrompt[];
  decidingApprovalId: string | null;
  decideApproval(prompt: ApprovalPrompt, decision: "allow" | "deny"): Promise<void>;
}

export function assistantLiveVoiceApprovalForReceipt(
  receipt: AssistantLiveVoiceApprovalReceipt | null,
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

export function assistantLiveVoiceApprovalFromReceipts(
  receipts: readonly AssistantLiveVoiceApprovalReceipt[],
  baselineReceiptId: number | undefined,
  consumedReceiptIds: ReadonlySet<number>,
): {
  examinedReceiptIds: number[];
  match: { receiptId: number; decision: "allow" | "deny" } | null;
} {
  const examinedReceiptIds: number[] = [];
  if (baselineReceiptId === undefined) return { examinedReceiptIds, match: null };
  for (const receipt of receipts) {
    if (receipt.id <= baselineReceiptId || consumedReceiptIds.has(receipt.id)) continue;
    examinedReceiptIds.push(receipt.id);
    const decision = assistantLiveVoiceApprovalForReceipt(receipt, baselineReceiptId, false);
    if (decision) {
      return { examinedReceiptIds, match: { receiptId: receipt.id, decision } };
    }
  }
  return { examinedReceiptIds, match: null };
}

/** Live-only approval state; deliberately does not mount or list the legacy Assistant workspace. */
export function useAssistantLiveApprovals(
  receipts: readonly AssistantLiveVoiceApprovalReceipt[],
  latestVoiceApprovalReceiptId: () => number,
  retainVoiceApprovalReceiptsAfter: (receiptId: number | null) => void,
): AssistantLiveApprovals {
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const receiptBaselines = React.useRef(new Map<string, number>());
  const consumedReceiptIds = React.useRef(new Set<number>());

  const syncRetentionFloor = React.useCallback(() => {
    const baselines = [...receiptBaselines.current.values()];
    retainVoiceApprovalReceiptsAfter(baselines.length > 0 ? Math.min(...baselines) : null);
  }, [retainVoiceApprovalReceiptsAfter]);

  React.useEffect(() => {
    const removeApproval = onNotification<ApprovalPrompt & { streamId: string }>(
      "chat:approval",
      (prompt) => {
        if (!prompt.streamId.startsWith("live:") || prompt.toolName !== "computer_use") return;
        receiptBaselines.current.set(prompt.approvalId, latestVoiceApprovalReceiptId());
        syncRetentionFloor();
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
        syncRetentionFloor();
        setApprovals((current) =>
          current.filter((candidate) => candidate.approvalId !== approvalId),
        );
        setDecidingApprovalId((current) => (current === approvalId ? null : current));
      },
    );
    return () => {
      removeApproval();
      removeWithdrawal();
      receiptBaselines.current.clear();
      retainVoiceApprovalReceiptsAfter(null);
    };
  }, [latestVoiceApprovalReceiptId, retainVoiceApprovalReceiptsAfter, syncRetentionFloor]);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (decidingApprovalId) return;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        receiptBaselines.current.delete(prompt.approvalId);
        syncRetentionFloor();
        setApprovals((current) =>
          current.filter((candidate) => candidate.approvalId !== prompt.approvalId),
        );
      } finally {
        setDecidingApprovalId((current) =>
          current === prompt.approvalId ? null : current,
        );
      }
    },
    [decidingApprovalId, syncRetentionFloor],
  );

  React.useEffect(() => {
    const prompt = approvals[0];
    if (!prompt || decidingApprovalId) return;
    const baseline = receiptBaselines.current.get(prompt.approvalId);
    const oldestRetainedId = receipts[0]?.id;
    if (oldestRetainedId !== undefined) {
      for (const id of consumedReceiptIds.current) {
        if (id < oldestRetainedId) consumedReceiptIds.current.delete(id);
      }
    }
    const result = assistantLiveVoiceApprovalFromReceipts(
      receipts,
      baseline,
      consumedReceiptIds.current,
    );
    for (const id of result.examinedReceiptIds) consumedReceiptIds.current.add(id);
    if (result.match) void decideApproval(prompt, result.match.decision);
  }, [approvals, decideApproval, decidingApprovalId, receipts]);

  return { approvals, decidingApprovalId, decideApproval };
}
