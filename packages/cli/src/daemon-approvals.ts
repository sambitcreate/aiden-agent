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
  const coordinator = new ToolApprovalCoordinator(
    (prompt) => {
      options.raised(prompt);
      // The coordinator withdraws only what it saw published.
      try { open.get(prompt.approvalId)?.publish(prompt); }
      catch (error) { options.resolved(prompt.approvalId, "cancelled"); throw error; }
    },
    (approvalId, outcome) => { options.resolved(approvalId, decisionFor(outcome, open.get(approvalId))); },
  );
  return {
    /** Waits for one answer. `publish` delivers the prompt to this run's owner. */
    async request(descriptor: Omit<ToolApprovalPrompt, "approvalId">, signal: AbortSignal, ownerId: string, publish: OpenPrompt["publish"]): Promise<ToolApprovalOutcome> {
      const approvalId = `approval_${randomUUID()}`, expiry = new AbortController();
      const timer = setTimeout(() => expiry.abort(), options.expiryMs ?? 300_000);
      open.set(approvalId, { publish, expiry });
      try { return await coordinator.request({ ...descriptor, approvalId }, AbortSignal.any([signal, expiry.signal]), ownerId); }
      finally { clearTimeout(timer); open.delete(approvalId); }
    },
    approve: (id: string, decision: "allow" | "deny", ownerId: string) => coordinator.decide(id, decision === "allow", ownerId),
    /** A paired desktop holding `runs:control` answers any run's approval, as the desktop host's own controls do. */
    approveAsHost: (id: string, decision: "allow" | "deny") => coordinator.decideAsHost(id, decision === "allow"),
  };
}
