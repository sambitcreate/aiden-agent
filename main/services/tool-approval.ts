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
  ownerDocumentId?: string;
  settle(outcome: ToolApprovalOutcome): void;
}

export type ToolApprovalOutcome =
  | "allowed"
  | "denied"
  | "cancelled"
  | "detached"
  | "unavailable";

/**
 * Owns approval promises and their abort listeners. A decision is one-shot;
 * every settlement path removes both the map entry and signal listener.
 */
export class ToolApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly detachedStreams = new Set<string>();

  constructor(private readonly publish: (prompt: ToolApprovalPrompt) => void) {}

  request(
    descriptor: Omit<ToolApprovalPrompt, "approvalId">,
    signal?: AbortSignal,
    ownerDocumentId?: string,
  ): Promise<ToolApprovalOutcome> {
    if (signal?.aborted) {
      return Promise.resolve("cancelled");
    }
    if (this.detachedStreams.has(descriptor.streamId)) {
      return Promise.resolve("detached");
    }
    const approvalId = `a-${randomUUID()}`;
    return new Promise<ToolApprovalOutcome>((resolve) => {
      let settled = false;
      const aborted = () => finish("cancelled");
      const finish = (outcome: ToolApprovalOutcome) => {
        if (settled) return;
        settled = true;
        this.pending.delete(approvalId);
        signal?.removeEventListener("abort", aborted);
        resolve(outcome);
      };
      this.pending.set(approvalId, {
        streamId: descriptor.streamId,
        ownerDocumentId,
        settle: finish,
      });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) {
        finish("cancelled");
        return;
      }
      if (this.detachedStreams.has(descriptor.streamId)) {
        finish("detached");
        return;
      }
      try {
        this.publish({ ...descriptor, approvalId });
      } catch {
        finish("unavailable");
      }
    });
  }

  decide(approvalId: string, allowed: boolean, ownerDocumentId?: string): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.ownerDocumentId !== ownerDocumentId) return false;
    entry.settle(allowed ? "allowed" : "denied");
    return true;
  }

  cancelStream(streamId: string, outcome: "cancelled" | "detached" = "cancelled"): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.streamId === streamId) entry.settle(outcome);
    }
  }

  /** A detached renderer cannot attend pending or future approval prompts. */
  detachStream(streamId: string): void {
    this.detachedStreams.add(streamId);
    this.cancelStream(streamId, "detached");
  }

  /** Release bounded per-stream state after the owning generation settles. */
  releaseStream(streamId: string): void {
    this.cancelStream(streamId);
    this.detachedStreams.delete(streamId);
  }

  shutdown(): void {
    for (const entry of [...this.pending.values()]) entry.settle("cancelled");
    this.detachedStreams.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
