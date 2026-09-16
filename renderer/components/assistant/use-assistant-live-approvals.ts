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

function latestFinalInputCaption(
  captions: readonly AssistantLiveCaption[],
): AssistantLiveCaption | null {
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    const caption = captions[index];
    if (caption?.direction === "input" && caption.final) return caption;
  }
  return null;
}

function latestInputCaptionId(captions: readonly AssistantLiveCaption[]): number {
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    const caption = captions[index];
    if (caption?.direction === "input") return caption.id;
  }
  return 0;
}

export function assistantLiveVoiceApprovalForCaption(
  caption: AssistantLiveCaption | null,
  baselineCaptionId: number | undefined,
  alreadyConsumed: boolean,
): "allow" | "deny" | null {
  if (
    !caption ||
    caption.direction !== "input" ||
    !caption.final ||
    baselineCaptionId === undefined ||
    caption.id <= baselineCaptionId ||
    alreadyConsumed
  ) {
    return null;
  }
  return assistantLiveVoiceApprovalDecision(caption.text);
}

/** Live-only approval state; deliberately does not mount or list the legacy Assistant workspace. */
export function useAssistantLiveApprovals(
  captions: readonly AssistantLiveCaption[],
): AssistantLiveApprovals {
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const captionsRef = React.useRef(captions);
  const captionBaselines = React.useRef(new Map<string, number>());
  const consumedCaptionIds = React.useRef(new Set<number>());
  captionsRef.current = captions;

  React.useEffect(() => {
    const removeApproval = onNotification<ApprovalPrompt & { streamId: string }>(
      "chat:approval",
      (prompt) => {
        if (!prompt.streamId.startsWith("live:") || prompt.toolName !== "computer_use") return;
        captionBaselines.current.set(
          prompt.approvalId,
          latestInputCaptionId(captionsRef.current),
        );
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
        captionBaselines.current.delete(approvalId);
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
        captionBaselines.current.delete(prompt.approvalId);
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
    const caption = latestFinalInputCaption(captions);
    const baseline = captionBaselines.current.get(prompt.approvalId);
    const decision = assistantLiveVoiceApprovalForCaption(
      caption,
      baseline,
      caption ? consumedCaptionIds.current.has(caption.id) : false,
    );
    if (!decision || !caption) return;
    consumedCaptionIds.current.add(caption.id);
    void decideApproval(prompt, decision);
  }, [approvals, captions, decideApproval, decidingApprovalId]);

  return { approvals, decidingApprovalId, decideApproval };
}
