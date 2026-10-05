import { ClassifierApproval } from "./classifier-approval";
import { classifierApprovalState } from "../shared/classifier-approval";
import * as React from "react";
import { ShieldQuestion } from "lucide-react";
import { Button, Text } from "./ui";
import {
  SubagentWorkspaceWriteApproval,
  subagentWorkspaceWriteOperationLabel,
} from "./subagent-workspace-write-approval";
import {
  SubagentMcpMutationApproval,
  subagentMcpMutationAllowLabel,
} from "./subagent-mcp-mutation-approval";
import { SubagentShellApproval } from "./subagent-shell-approval";
import { SubagentRunGrantApproval } from "./subagent-run-grant-approval";
import { FormFillApproval } from "./form-fill-approval";
import type { ApprovalPrompt } from "../lib/ipc";
import {
  isFormFillBatchApprovalDetails,
  isSubagentMcpMutationApprovalDetails,
  isSubagentRunGrantApprovalDetails,
  isSubagentShellApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant";
import {
  rememberableApprovalScopes,
  toolApprovalScopeLabel,
  type ToolApprovalScope,
} from "../shared/tool-approval-scope";

const TOOL_LABELS: Record<string, string> = {
  edit_file: "Edit file",
  run_command: "Run command",
  write_file: "Write file",
  computer_use: "Computer Use",
  form_fill: "Form fill",
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}

export interface ChatApprovalDecisionOptions {
  formFillExcludedOrders?: number[];
  scope?: ToolApprovalScope;
}

function claimsKind(details: unknown, kind: string): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as Record<string, unknown>).kind === kind
  );
}

/**
 * The pending tool approval above the composer, shared by local and remote
 * chats. A details payload that claims a specialized kind but fails its guard
 * can never be allowed.
 */
export function ChatApprovalCard({
  pending,
  deciding,
  onDecide,
  cardRef,
  denyRef,
  disabledReason,
  pendingCount = 1,
}: {
  pending: ApprovalPrompt;
  deciding: boolean;
  onDecide: (decision: "allow" | "deny", options?: ChatApprovalDecisionOptions) => void;
  cardRef?: React.Ref<HTMLElement>;
  denyRef?: React.Ref<HTMLButtonElement>;
  /** Why this approval cannot be answered from here right now (an offline host). */
  disabledReason?: string;
  /** Approvals waiting in this chat when they are shown one at a time, this one first. */
  pendingCount?: number;
}) {
  const details = pending.details as unknown;
  const pendingWorkspaceWrite = isSubagentWorkspaceWriteApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingMcpMutation = isSubagentMcpMutationApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingShell = isSubagentShellApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingRunGrant = isSubagentRunGrantApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingFormFill = isFormFillBatchApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingClassifier = classifierApprovalState(pending.toolName, details);
  const invalidPendingPrivilegedApproval =
    pendingClassifier.invalid ||
    (claimsKind(details, "subagent-workspace-write") && pendingWorkspaceWrite === undefined) ||
    (claimsKind(details, "subagent-mcp-mutation") && pendingMcpMutation === undefined) ||
    (claimsKind(details, "subagent-shell") && pendingShell === undefined) ||
    (claimsKind(details, "subagent-run-grant") && pendingRunGrant === undefined) ||
    (claimsKind(details, "form-fill-batch") && pendingFormFill === undefined);
  const [formFillExcludedOrders, setFormFillExcludedOrders] = React.useState<number[]>([]);
  React.useEffect(() => {
    setFormFillExcludedOrders([]);
  }, [pending.approvalId]);
  const pendingCanAllow = pending.canAllow !== false && !invalidPendingPrivilegedApproval;
  // Only plain workspace writes and shell commands can be remembered; the main
  // process offers scopes solely for those, and specialized cards keep once.
  const pendingRememberScopes =
    !pendingClassifier.details && !pendingFormFill && !pendingMcpMutation && !pendingRunGrant
      ? rememberableApprovalScopes(pending.scopes, pendingCanAllow)
      : [];
  const disabled = deciding || disabledReason !== undefined;
  const summaryId = `approval-summary-${pending.approvalId}`;

  return (
    <div>
      <p className="sr-only" role="status">
        {invalidPendingPrivilegedApproval
          ? "Invalid privileged approval blocked"
          : `Approval needed for ${pendingWorkspaceWrite?.childLabel ?? pendingMcpMutation?.childLabel ?? pendingShell?.childLabel ?? toolLabel(pending.toolName)}${pendingCount > 1 ? `, 1 of ${pendingCount}` : ""}`}
      </p>
      <section
        ref={cardRef}
        aria-labelledby={`approval-title-${pending.approvalId}`}
        aria-describedby={summaryId}
        className="rounded-card bg-popover p-3 shadow-popover"
      >
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-status-warning-surface text-status-warning">
            <ShieldQuestion className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <Text variant="small-strong" as="p" id={`approval-title-${pending.approvalId}`}>
              {invalidPendingPrivilegedApproval
                ? "Invalid privileged approval blocked"
                : pendingWorkspaceWrite
                  ? `${pendingWorkspaceWrite.childLabel} wants to ${subagentWorkspaceWriteOperationLabel(
                      pendingWorkspaceWrite.operation,
                    ).toLocaleLowerCase("en-US")}`
                  : pendingMcpMutation
                    ? `${pendingMcpMutation.childLabel} wants to call ${pendingMcpMutation.serverId}:${pendingMcpMutation.toolName}`
                    : pendingShell
                      ? `${pendingShell.childLabel} wants to run a full-host command`
                      : pendingRunGrant
                        ? `Allow ${pendingRunGrant.lane === "write" ? "writes" : "shell"} for ${pendingRunGrant.childLabel}`
                        : `${toolLabel(pending.toolName)} needs approval`}
              {pendingCount > 1 ? <span className="ml-1.5 font-normal text-tertiary">1 of {pendingCount}</span> : null}
            </Text>
            <Text variant="small" color="secondary" as="p" className="mt-0.5">
              {invalidPendingPrivilegedApproval
                ? "This malformed privileged action cannot be allowed. Deny it to continue."
                : pendingWorkspaceWrite
                  ? "Review this one exact file change before Aiden continues."
                  : pendingMcpMutation
                    ? "Review this one exact external mutation before Aiden continues."
                    : pendingShell
                      ? "Review this one exact full-host command before Aiden continues."
                      : pendingRunGrant
                        ? "Review this grant for the entire subagent run."
                        : "Review this one action before Aiden continues."}
            </Text>
          </div>
        </div>
        {!pendingCanAllow ? (
          <Text variant="small" as="p" id={summaryId} className="mt-2.5 rounded-control bg-well px-3 py-2">
            Aiden cannot safely authorize this action from this view. Deny it here or review the exact action on the
            device that owns this chat.
          </Text>
        ) : pendingClassifier.details ? (
          <ClassifierApproval details={pendingClassifier.details} descriptionId={summaryId} />
        ) : pendingWorkspaceWrite ? (
          <SubagentWorkspaceWriteApproval details={pendingWorkspaceWrite} descriptionId={summaryId} />
        ) : pendingMcpMutation ? (
          <SubagentMcpMutationApproval details={pendingMcpMutation} descriptionId={summaryId} />
        ) : pendingShell ? (
          <SubagentShellApproval details={pendingShell} descriptionId={summaryId} />
        ) : pendingRunGrant ? (
          <SubagentRunGrantApproval details={pendingRunGrant} descriptionId={summaryId} />
        ) : pendingFormFill ? (
          <FormFillApproval
            details={pendingFormFill}
            descriptionId={summaryId}
            onDeselectChange={setFormFillExcludedOrders}
          />
        ) : (
          <Text
            variant="small"
            as="p"
            id={summaryId}
            className="mt-2.5 max-h-24 select-text overflow-y-auto rounded-control bg-well px-3 py-2 font-mono break-words"
          >
            {pending.summary}
          </Text>
        )}
        {disabledReason ? (
          <Text variant="small" color="secondary" as="p" role="note" className="mt-2.5">
            {disabledReason}
          </Text>
        ) : null}
        <div className="mt-2.5 flex justify-end gap-2">
          <Button ref={denyRef} variant="transparent" size="small" disabled={disabled} onClick={() => onDecide("deny")}>
            {pendingFormFill ? "Cancel" : "Deny"}
          </Button>
          {pendingRememberScopes.map((scope) => {
            const scopeHint =
              scope === "always"
                ? "Remember this exact action for this workspace. Revoke it in Settings → Tool approvals."
                : "Remember this exact action in this chat until Aiden quits.";
            const scopeHintId = `approval-scope-${scope}-${pending.approvalId}`;
            return (
              <React.Fragment key={scope}>
                <span id={scopeHintId} className="sr-only">
                  {scopeHint}
                </span>
                <Button
                  variant="transparent"
                  size="small"
                  disabled={disabled}
                  title={scopeHint}
                  aria-describedby={scopeHintId}
                  onClick={() => onDecide("allow", { scope })}
                >
                  {toolApprovalScopeLabel(scope)}
                </Button>
              </React.Fragment>
            );
          })}
          {pendingCanAllow ? (
            <Button
              variant="accent"
              size="small"
              disabled={disabled}
              onClick={() => onDecide("allow", pendingFormFill ? { formFillExcludedOrders } : undefined)}
            >
              {deciding
                ? "Sending…"
                : pendingFormFill
                  ? `Fill ${pendingFormFill.rows.length - formFillExcludedOrders.length} field${pendingFormFill.rows.length - formFillExcludedOrders.length === 1 ? "" : "s"}`
                  : pendingMcpMutation
                    ? subagentMcpMutationAllowLabel(pendingMcpMutation)
                    : pendingRunGrant
                      ? "Allow for run"
                      : "Allow once"}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
