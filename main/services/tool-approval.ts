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
  settle(allowed: boolean): void;
}

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
  ): Promise<boolean> {
    if (signal?.aborted || this.detachedStreams.has(descriptor.streamId)) {
      return Promise.resolve(false);
    }
    const approvalId = `a-${randomUUID()}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const aborted = () => finish(false);
      const finish = (allowed: boolean) => {
        if (settled) return;
        settled = true;
        this.pending.delete(approvalId);
        signal?.removeEventListener("abort", aborted);
        resolve(allowed);
      };
      this.pending.set(approvalId, {
        streamId: descriptor.streamId,
        ownerDocumentId,
        settle: finish,
      });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted || this.detachedStreams.has(descriptor.streamId)) {
        aborted();
        return;
      }
      try {
        this.publish({ ...descriptor, approvalId });
      } catch {
        finish(false);
      }
    });
  }

  decide(approvalId: string, allowed: boolean, ownerDocumentId?: string): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.ownerDocumentId !== ownerDocumentId) return false;
    entry.settle(allowed);
    return true;
  }

  cancelStream(streamId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.streamId === streamId) entry.settle(false);
    }
  }

  /** A detached renderer cannot attend pending or future approval prompts. */
  detachStream(streamId: string): void {
    this.detachedStreams.add(streamId);
    this.cancelStream(streamId);
  }

  /** Release bounded per-stream state after the owning generation settles. */
  releaseStream(streamId: string): void {
    this.cancelStream(streamId);
    this.detachedStreams.delete(streamId);
  }

  shutdown(): void {
    for (const entry of [...this.pending.values()]) entry.settle(false);
    this.detachedStreams.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
