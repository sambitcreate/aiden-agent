import { randomUUID } from "node:crypto";
import type { ToolApprovalDetails } from "../../renderer/shared/assistant.js";

export interface ToolApprovalPrompt {
  streamId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  details?: ToolApprovalDetails;
}

interface PendingApproval {
  streamId: string;
  toolCallId: string;
  ownerDocumentId?: string;
  settle(outcome: ToolApprovalOutcome): void;
}

/** Optional structured payload an approval card may return with a decision. */
export interface ToolApprovalDecisionPayload {
  /** Form Fill Specialist: orders the user deselected on the review card. */
  formFillExcludedOrders?: number[];
}

export type ToolApprovalOutcome = "allowed" | "denied" | "cancelled" | "detached" | "unavailable";

/**
 * Owns approval promises and their abort listeners. A decision is one-shot;
 * every settlement path removes both the map entry and signal listener.
 */
export class ToolApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly closedStreams = new Map<string, "cancelled" | "detached">();
  /** Payloads from settled approvals, consumed once by the tool caller. */
  private readonly decisionPayloads = new Map<string, ToolApprovalDecisionPayload>();
  private stopped = false;

  private payloadKey(streamId: string, toolCallId: string): string {
    return `${streamId}\u0000${toolCallId}`;
  }

  constructor(
    private readonly publish: (prompt: ToolApprovalPrompt) => void,
    private readonly withdraw?: (approvalId: string) => void,
  ) {}

  request(
    descriptor: Omit<ToolApprovalPrompt, "approvalId">,
    signal?: AbortSignal,
    ownerDocumentId?: string,
  ): Promise<ToolApprovalOutcome> {
    if (this.stopped || signal?.aborted) {
      return Promise.resolve("cancelled");
    }
    const closedOutcome = this.closedStreams.get(descriptor.streamId);
    if (closedOutcome) {
      return Promise.resolve(closedOutcome);
    }
    const approvalId = `a-${randomUUID()}`;
    return new Promise<ToolApprovalOutcome>((resolve) => {
      let settled = false;
      let published = false;
      const aborted = () => finish("cancelled");
      const finish = (outcome: ToolApprovalOutcome) => {
        if (settled) return;
        settled = true;
        this.pending.delete(approvalId);
        signal?.removeEventListener("abort", aborted);
        if (published) {
          try {
            this.withdraw?.(approvalId);
          } catch {
            // Owner loss can make the withdrawal channel unavailable. The
            // approval capability is still removed and must always settle.
          }
        }
        resolve(outcome);
      };
      this.pending.set(approvalId, {
        streamId: descriptor.streamId,
        toolCallId: descriptor.toolCallId,
        ownerDocumentId,
        settle: finish,
      });
      signal?.addEventListener("abort", aborted, { once: true });
      if (this.stopped || signal?.aborted) {
        finish("cancelled");
        return;
      }
      const closedOutcome = this.closedStreams.get(descriptor.streamId);
      if (closedOutcome) {
        finish(closedOutcome);
        return;
      }
      try {
        this.publish({ ...descriptor, approvalId });
        published = true;
      } catch {
        finish("unavailable");
      }
    });
  }

  decide(
    approvalId: string,
    allowed: boolean,
    ownerDocumentId?: string,
    payload?: ToolApprovalDecisionPayload,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.ownerDocumentId !== ownerDocumentId) return false;
    if (payload) {
      this.decisionPayloads.set(this.payloadKey(entry.streamId, entry.toolCallId), payload);
    }
    entry.settle(allowed ? "allowed" : "denied");
    return true;
  }

  /** Consume the decision payload recorded for a settled tool call, if any. */
  takeDecisionPayload(
    streamId: string,
    toolCallId: string,
  ): ToolApprovalDecisionPayload | undefined {
    const key = this.payloadKey(streamId, toolCallId);
    const payload = this.decisionPayloads.get(key);
    this.decisionPayloads.delete(key);
    return payload;
  }

  cancelStream(streamId: string, outcome: "cancelled" | "detached" = "cancelled"): void {
    // Close admission before settling: delayed child preparation and reentrant
    // withdrawal callbacks must not publish a fresh prompt for this generation.
    const closedOutcome = this.closedStreams.get(streamId) === "cancelled" ? "cancelled" : outcome;
    this.closedStreams.set(streamId, closedOutcome);
    for (const entry of [...this.pending.values()]) {
      if (entry.streamId === streamId) entry.settle(closedOutcome);
    }
    for (const key of [...this.decisionPayloads.keys()]) {
      if (key.startsWith(`${streamId}\u0000`)) this.decisionPayloads.delete(key);
    }
  }

  /** A detached renderer cannot attend pending or future approval prompts. */
  detachStream(streamId: string): void {
    this.cancelStream(streamId, "detached");
  }

  /** Release bounded per-stream state after the owning generation settles. */
  releaseStream(streamId: string): void {
    this.cancelStream(streamId);
    this.closedStreams.delete(streamId);
  }

  shutdown(): void {
    this.stopped = true;
    for (const entry of [...this.pending.values()]) entry.settle("cancelled");
    this.closedStreams.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
