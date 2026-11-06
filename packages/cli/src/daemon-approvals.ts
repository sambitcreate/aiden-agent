/**
 * The daemon's tool approvals, on the shared `ToolApprovalCoordinator` that owns
 * one-shot settlement, owner scoping and abort. This adds what is the daemon's:
 * the prompt's expiry and the decision its run journal records.
 * See docs/state-machines/serve-daemon.md.
 */
import { randomUUID } from "node:crypto";
import { ToolApprovalCoordinator, type ToolApprovalOutcome, type ToolApprovalPrompt } from "../../../main/services/tool-approval.js";

export type DaemonApprovalDecision = "allow" | "deny" | "expired" | "cancelled";

interface OpenPrompt {
  publish(prompt: ToolApprovalPrompt): void;
  expiry: AbortController;
  raised: boolean;
  reported: boolean;
}

export interface DaemonApprovalsOptions {
  /** A prompt is about to reach its owner. */
  raised(prompt: ToolApprovalPrompt): void;
  /** A raised prompt ended, however it ended. */
  resolved(approvalId: string, decision: DaemonApprovalDecision): void;
  expiryMs?: number;
}

export function createDaemonApprovals(options: DaemonApprovalsOptions) {
  const open = new Map<string, OpenPrompt>();
  const decisionFor = (outcome: ToolApprovalOutcome, prompt?: OpenPrompt): DaemonApprovalDecision => {
    if (outcome === "allowed") return "allow";
    if (outcome === "denied") return "deny";
    return prompt?.expiry.signal.aborted ? "expired" : "cancelled";
  };
  /** One report per raised prompt, from the outcome that settled it. */
  const report = (approvalId: string, outcome: ToolApprovalOutcome, prompt?: OpenPrompt) => {
    if (!prompt?.raised || prompt.reported) return;
    prompt.reported = true;
    options.resolved(approvalId, decisionFor(outcome, prompt));
  };
  const coordinator = new ToolApprovalCoordinator(
    (prompt) => {
      const entry = open.get(prompt.approvalId);
      // Marked first: a `raised` that throws may already have changed attention.
      if (entry) entry.raised = true;
      options.raised(prompt);
      entry?.publish(prompt);
    },
    (approvalId, outcome) => { report(approvalId, outcome, open.get(approvalId)); },
  );
  return {
    /** Waits for one answer. `publish` delivers the prompt to this run's owner. */
    async request(descriptor: Omit<ToolApprovalPrompt, "approvalId">, signal: AbortSignal, ownerId: string, publish: OpenPrompt["publish"]): Promise<ToolApprovalOutcome> {
      const approvalId = `approval_${randomUUID()}`, expiry = new AbortController();
      const timer = setTimeout(() => expiry.abort(), options.expiryMs ?? 300_000);
      const prompt: OpenPrompt = { publish, expiry, raised: false, reported: false };
      open.set(approvalId, prompt);
      try {
        const outcome = await coordinator.request({ ...descriptor, approvalId }, AbortSignal.any([signal, expiry.signal]), ownerId);
        // The coordinator withdraws only what it saw published, so a failed or re-entrant publish lands here.
        report(approvalId, outcome, prompt);
        return outcome;
      } finally { clearTimeout(timer); open.delete(approvalId); }
    },
    approve: (id: string, decision: "allow" | "deny", ownerId: string) => coordinator.decide(id, decision === "allow", ownerId),
    /** A paired desktop holding `runs:control` answers any run's approval, as the desktop host's own controls do. */
    approveAsHost: (id: string, decision: "allow" | "deny") => coordinator.decideAsHost(id, decision === "allow"),
  };
}
