import { ClassifierApproval } from "./classifier-approval";
import { classifierApprovalState } from "../shared/classifier-approval";
import * as React from "react";
import { CalendarClock, FilePen, FilePlus, Hand, Mic, ShieldQuestion, SquareTerminal, type LucideIcon } from "lucide-react";
import { Button, Text } from "./ui";
import { ApprovalActions, ApprovalIconTile, type ApprovalRememberOption } from "./approval-card-parts";
import { CopyButton } from "./copy-button";
import { cn } from "../lib/ui-utils";
import { useApprovalShortcuts } from "../lib/approval-shortcuts";
import { SubagentWorkspaceWriteApproval } from "./subagent-workspace-write-approval";
import {
  SubagentMcpMutationApproval,
  subagentMcpMutationAllowLabel,
} from "./subagent-mcp-mutation-approval";
import { SubagentShellApproval } from "./subagent-shell-approval";
import { HOOK_PROPOSAL_APPROVAL_FOOTER, HookProposalApproval } from "./hook-proposal-approval";
import { HOOK_PROPOSAL_APPROVAL_KIND, isHookProposalApprovalDetails } from "../shared/hook-proposal-approval";
import { SubagentRunGrantApproval } from "./subagent-run-grant-approval";
import { FormFillApproval } from "./form-fill-approval";
import { SCHEDULE_APPROVAL_FOOTER, ScheduledTaskApproval } from "./scheduled-task-approval";
import { ComputerUseAccessApproval } from "./computer-use-access-approval";
import { isComputerUseAccessApprovalDetails } from "../shared/computer-use-access";
import type { ApprovalPrompt } from "../lib/ipc";
import {
  isAssistantAutomationApprovalDetails,
  isScheduledTaskApprovalDetails,
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
import type { ToolApprovalPreview } from "../shared/tool-approval-preview";
import {
  approvalCommand,
  approvalDetailsHeadline,
  approvalFilePath,
  approvalHeadline,
  toolLabel,
} from "../shared/approval-card-model";

export { approvalCommand, approvalHeadline, toolLabel } from "../shared/approval-card-model";
import { LiveGuard } from "./live-guard";

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/** The quiet line under the headline: the file and its size of change, or who is waiting. */
function approvalMeta(preview: ToolApprovalPreview | undefined, requester: string): string {
  if (preview?.kind !== "file") return `${requester} is paused until you choose.`;
  if (preview.operation === "write") {
    return `${preview.path} · ${preview.added} ${preview.added === 1 ? "line" : "lines"}`;
  }
  return `${preview.path} · ${preview.added} added, ${preview.removed} removed`;
}

export function ApprovalIcon({
  preview,
  command,
  icon,
}: {
  preview: ToolApprovalPreview | undefined;
  command: boolean;
  icon?: LucideIcon;
}) {
  const Icon = icon ?? (command
    ? SquareTerminal
    : preview?.kind === "file"
      ? preview.operation === "edit"
        ? FilePen
        : FilePlus
      : ShieldQuestion);
  return <ApprovalIconTile icon={Icon} />;
}

function ApprovalCommand({ command, descriptionId }: { command: string; descriptionId: string }) {
  return (
    <div className="approval-well relative mt-3 bg-well">
      <Text
        variant="regular"
        as="p"
        id={descriptionId}
        tabIndex={0}
        className="approval-well max-h-40 select-text overflow-y-auto py-3 pr-10 pl-4 font-mono whitespace-pre-wrap break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <span aria-hidden="true" className="select-none text-tertiary">
          ${" "}
        </span>
        {command}
      </Text>
      <CopyButton text={command} label="Copy command" className="absolute top-2 right-2" />
    </div>
  );
}

function ApprovalFileChange({
  preview,
  descriptionId,
}: {
  preview: Extract<ToolApprovalPreview, { kind: "file" }>;
  descriptionId: string;
}) {
  return (
    <div
      id={descriptionId}
      tabIndex={0}
      role="group"
      aria-label={preview.operation === "edit" ? `Change to ${preview.path}` : `New contents of ${preview.path}`}
      className="approval-well approval-diff mt-3 max-h-56 select-text overflow-auto overscroll-contain bg-well py-2.5 font-mono text-small focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
    >
      {preview.lines.length === 0 ? (
        <p className="px-4 font-sans text-tertiary">{preview.operation === "write" ? "Empty file" : "No visible change"}</p>
      ) : (
        preview.lines.map((line, index) =>
          // A new or replaced file is all new text, so it reads as plain code.
          preview.operation === "write" ? (
            <div key={index} className="w-max min-w-full px-4 whitespace-pre text-primary">
              {line.text || " "}
            </div>
          ) : (
            <div
              key={index}
              data-line={line.type}
              className={cn(
                "w-max min-w-full px-4 whitespace-pre",
                line.type === "removed" && "bg-status-red-surface text-status-red",
                line.type === "added" && "bg-status-green-surface text-status-green",
                line.type === "context" && "text-tertiary",
              )}
            >
              <span aria-hidden="true" className="select-none">
                {line.type === "removed" ? "- " : line.type === "added" ? "+ " : "  "}
              </span>
              <span className="sr-only">{line.type === "removed" ? "Removed: " : line.type === "added" ? "Added: " : ""}</span>
              {line.text || " "}
            </div>
          ),
        )
      )}
      {preview.omittedLines > 0 ? (
        <p className="px-4 pt-1 font-sans text-tertiary">
          {preview.omittedLines} more {preview.omittedLines === 1 ? "line" : "lines"} not shown
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a remembered approval covers. A command rule matches only that exact
 * command, but a file rule matches the tool and path, so it also covers later
 * changes with different contents (see `toolApprovalRuleTarget`).
 */
function rememberScopeHint(
  scope: Exclude<ToolApprovalScope, "once">,
  pending: Pick<ApprovalPrompt, "toolName" | "summary" | "preview">,
): string {
  const path = approvalFilePath(pending);
  const file = path ? fileName(path) : "this file";
  const target =
    pending.toolName === "run_command"
      ? "this exact command"
      : pending.toolName === "edit_file"
        ? `any edit to ${file}`
        : pending.toolName === "write_file"
          ? `any write to ${file}`
          : "this exact action";
  if (scope === "workspace") {
    // A Mac card's grant covers that part of the Mac, not one exact action.
    const reach =
      pending.toolName === "computer_use"
        ? "using your Mac with Computer Use"
        : pending.toolName === "run_command" || pending.preview?.kind === "command"
          ? "running commands"
          : "changing files";
    return `Won't ask again before ${reach} in this workspace. Remove it in Workspace settings.`;
  }
  return scope === "always"
    ? `Won't ask again for ${target} here. Undo in Settings → Approvals.`
    : `Won't ask again for ${target} until Aiden quits.`;
}

/** The quiet line Aiden Live adds while it is on an approval. */
function LiveVoiceApprovalHint({ mode }: { mode: "voice" | "tap" }) {
  const Icon = mode === "voice" ? Mic : Hand;
  return (
    <Text
      variant="small"
      color="secondary"
      as="p"
      role="note"
      className="mt-1.5 flex shrink-0 items-center justify-center gap-1.5 text-center"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
      {mode === "voice" ? "Live is listening. Say “allow” or “deny”." : "Live can’t answer this one. Tap to choose."}
    </Text>
  );
}

export { ApprovalActions, ApprovalStatusLine, approvalStatusLabel, type ApprovalStatus } from "./approval-card-parts";

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
 * The pending approval above the composer, shared by workspace chats, Bot
 * chats and paired hosts' chats. A details payload that claims a specialized
 * kind but fails its guard can never be allowed.
 */
export function ChatApprovalCard({
  pending,
  deciding,
  onDecide,
  cardRef,
  denyRef,
  disabledReason,
  pendingCount = 1,
  computerUseHost = "local",
  keyboardShortcuts = false,
  liveVoice = null,
  requester = "Aiden",
  alwaysOption,
  notes = [],
  suggestion,
  allowElsewhere,
  error,
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
  /**
   * Where a Computer Use access request would run: "local" checks this Mac's
   * permissions live; "remote" leaves setup to the host Mac.
   */
  computerUseHost?: "local" | "remote";
  /**
   * ⌘↩ allows once and ⌘⌫ denies while the message box is empty. Only the
   * chat's own card takes them, so one key never answers two approvals.
   */
  keyboardShortcuts?: boolean;
  /**
   * Aiden Live is on this approval: "voice" takes a spoken allow or deny,
   * "tap" means this one needs a button.
   */
  liveVoice?: "voice" | "tap" | null;
  /** Who asked: Aiden, or a Bot by name. */
  requester?: string;
  /** How the `always` scope reads here; a Bot's always is its own allow list, not the workspace's. */
  alwaysOption?: { label: string; hint: string };
  /** Quiet lines under the request, such as how often it was allowed before. */
  notes?: readonly string[];
  /** A quiet offer under the notes, such as switching to Auto after repeated allows. */
  suggestion?: { text: string; action: string; onAction(): void; busy?: boolean };
  /** This device may only deny: the device where the person can allow it instead. */
  allowElsewhere?: string;
  /** The last answer could not be sent. */
  error?: string | null;
}) {
  const details = pending.details as unknown;
  const schedule = isScheduledTaskApprovalDetails(details) || isAssistantAutomationApprovalDetails(details) ? details : undefined;
  const pendingWorkspaceWrite = isSubagentWorkspaceWriteApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingMcpMutation = isSubagentMcpMutationApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingShell = isSubagentShellApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingRunGrant = isSubagentRunGrantApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingFormFill = isFormFillBatchApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingHook = isHookProposalApprovalDetails(details) ? details : undefined;
  const pendingClassifier = classifierApprovalState(pending.toolName, details);
  const invalidPendingPrivilegedApproval =
    (claimsKind(details, "scheduled-task") && !schedule) ||
    (claimsKind(details, "assistant-automation") && !schedule) ||
    pendingClassifier.invalid ||
    (claimsKind(details, "subagent-workspace-write") && pendingWorkspaceWrite === undefined) ||
    (claimsKind(details, "subagent-mcp-mutation") && pendingMcpMutation === undefined) ||
    (claimsKind(details, "subagent-shell") && pendingShell === undefined) ||
    (claimsKind(details, "subagent-run-grant") && pendingRunGrant === undefined) ||
    (claimsKind(details, "form-fill-batch") && pendingFormFill === undefined) ||
    (claimsKind(details, HOOK_PROPOSAL_APPROVAL_KIND) && pendingHook === undefined);
  const [formFillExcludedOrders, setFormFillExcludedOrders] = React.useState<number[]>([]);
  React.useEffect(() => {
    setFormFillExcludedOrders([]);
  }, [pending.approvalId]);
  const pendingCanAllow = pending.canAllow !== false && !invalidPendingPrivilegedApproval && allowElsewhere === undefined;
  // Only plain workspace writes and shell commands can be remembered; the main
  // process offers scopes solely for those, and specialized cards keep once.
  const pendingRememberScopes =
    !pendingClassifier.details && !pendingFormFill && !pendingMcpMutation && !pendingRunGrant && !pendingHook
      ? rememberableApprovalScopes(pending.scopes, pendingCanAllow)
      : [];
  const computerUseAccess = isComputerUseAccessApprovalDetails(details);
  const disabled = deciding || disabledReason !== undefined;
  useApprovalShortcuts({
    // Computer Use access sets up permissions first, so it keeps its own buttons.
    enabled: keyboardShortcuts && !computerUseAccess && !disabled,
    canAllow: pendingCanAllow,
    onShortcut: (shortcut) =>
      shortcut === "deny"
        ? onDecide("deny")
        : onDecide("allow", pendingFormFill ? { formFillExcludedOrders } : undefined),
  });
  if (computerUseAccess) {
    return (
      <ComputerUseAccessApproval
        pending={pending}
        deciding={deciding}
        onDecide={onDecide}
        cardRef={cardRef}
        denyRef={denyRef}
        disabledReason={disabledReason}
        pendingCount={pendingCount}
        host={computerUseHost}
      />
    );
  }
  const summaryId = `approval-summary-${pending.approvalId}`;
  // A card that can't be allowed here still shows its request when the reason
  // is only where it may be allowed.
  const reviewable = pendingCanAllow || (allowElsewhere !== undefined && !invalidPendingPrivilegedApproval && pending.canAllow !== false);
  // Plain coding approvals show the exact command or file change; specialized
  // and invalid approvals keep their own review bodies.
  const plainApproval =
    !invalidPendingPrivilegedApproval && reviewable && !schedule && !pendingClassifier.details &&
    !pendingWorkspaceWrite && !pendingMcpMutation && !pendingShell && !pendingRunGrant && !pendingFormFill && !pendingHook;
  const plainPreview = plainApproval ? pending.preview : undefined;
  const plainCommand = plainApproval ? approvalCommand(pending) : undefined;
  const rememberOptions: ApprovalRememberOption[] = pendingRememberScopes.map((scope) => ({
    key: scope,
    label: scope === "always" && alwaysOption ? alwaysOption.label : toolApprovalScopeLabel(scope),
    hint: scope === "always" && alwaysOption ? alwaysOption.hint : rememberScopeHint(scope, pending),
    onSelect: () => onDecide("allow", { scope }),
  }));

  return (
    // Approvals are the user's: Aiden Live can never press Allow, Always allow or their menu.
    <LiveGuard guard="you">
    <div className="flex min-h-0 flex-col">
      <p className="sr-only" role="status">
        {invalidPendingPrivilegedApproval
          ? "Invalid privileged approval blocked"
          : `${requester === "Aiden" ? "Approval needed" : `${requester} needs approval`} for ${pendingWorkspaceWrite?.childLabel ?? pendingMcpMutation?.childLabel ?? pendingShell?.childLabel ?? toolLabel(pending.toolName)}${pendingCount > 1 ? `, 1 of ${pendingCount}` : ""}${liveVoice === "voice" && !disabledReason ? ". Live is listening: say allow or deny" : ""}`}
      </p>
      <section
        ref={cardRef}
        aria-labelledby={`approval-title-${pending.approvalId}`}
        aria-describedby={summaryId}
        className={cn(
          // The chat's footer gives the card only the room the composer leaves. A
          // schedule review shrinks first; past that, the card scrolls from its question.
          "approval-shell composer-shell min-h-0 overflow-y-auto overscroll-contain bg-popover p-4 shadow-composer",
          schedule && pendingCanAllow && "flex flex-col",
        )}
      >
        <div className="flex shrink-0 flex-col items-center text-center">
          <ApprovalIcon
            preview={plainPreview}
            command={plainCommand !== undefined}
            icon={schedule && pendingCanAllow ? CalendarClock : undefined}
          />
          <Text variant="strong" as="p" id={`approval-title-${pending.approvalId}`} className="mt-2.5 text-balance">
            {invalidPendingPrivilegedApproval
              ? "Invalid privileged approval blocked"
              : // A hook the person can't apply here reads as the plain card it falls back to.
                (pendingHook && !pendingCanAllow ? undefined : approvalDetailsHeadline(details)) ?? approvalHeadline(pending)}
            {pendingCount > 1 ? <span className="ml-1.5 font-normal text-tertiary">1 of {pendingCount}</span> : null}
          </Text>
        </div>
        {!reviewable ? (
          <Text variant="small" as="p" id={summaryId} className="approval-well mt-3 bg-well px-4 py-3">
            Aiden cannot safely authorize this action from this view. Deny it here or review the exact action on the
            device that owns this chat.
          </Text>
        ) : schedule ? (
          <ScheduledTaskApproval details={schedule} descriptionId={summaryId} />
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
        ) : pendingHook ? (
          <HookProposalApproval details={pendingHook} descriptionId={summaryId} />
        ) : pendingFormFill ? (
          <FormFillApproval
            details={pendingFormFill}
            descriptionId={summaryId}
            onDeselectChange={setFormFillExcludedOrders}
          />
        ) : plainPreview?.kind === "file" ? (
          <ApprovalFileChange preview={plainPreview} descriptionId={summaryId} />
        ) : plainCommand !== undefined ? (
          <ApprovalCommand command={plainCommand} descriptionId={summaryId} />
        ) : (
          <Text
            variant="small"
            as="p"
            id={summaryId}
            tabIndex={0}
            className="approval-well mt-3 max-h-32 select-text overflow-y-auto bg-well px-4 py-3 font-mono whitespace-pre-wrap break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            {pending.summary}
          </Text>
        )}
        <Text variant="small" color="secondary" as="p" className="mt-2.5 shrink-0 text-center text-pretty">
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
                    : pendingHook && pendingCanAllow
                      ? HOOK_PROPOSAL_APPROVAL_FOOTER
                      : schedule
                      ? SCHEDULE_APPROVAL_FOOTER
                      : approvalMeta(plainPreview, requester)}
        </Text>
        {notes.map((note) => (
          <Text key={note} variant="small" color="tertiary" as="p" className="mt-1 shrink-0 text-center text-pretty">
            {note}
          </Text>
        ))}
        {suggestion ? (
          <div className="mt-1 flex shrink-0 flex-wrap items-center justify-center gap-x-1.5" role="group" aria-label={suggestion.text}>
            <Text variant="small" color="tertiary" as="span" className="text-pretty">
              {suggestion.text}
            </Text>
            <Button variant="transparent" size="small" disabled={suggestion.busy === true || deciding} onClick={suggestion.onAction}>
              {suggestion.action}
            </Button>
          </div>
        ) : null}
        {allowElsewhere !== undefined ? (
          <Text variant="small" color="secondary" as="p" role="note" className="mt-1.5 shrink-0 text-center">
            {`Allow it on ${allowElsewhere}.`}
          </Text>
        ) : null}
        {disabledReason ? (
          <Text variant="small" color="secondary" as="p" role="note" className="mt-1.5 shrink-0 text-center">
            {disabledReason}
          </Text>
        ) : null}
        {liveVoice && !disabledReason ? <LiveVoiceApprovalHint mode={liveVoice} /> : null}
        {error ? (
          <Text variant="small" as="p" role="alert" className="mt-1.5 shrink-0 text-center text-status-red">
            {error}
          </Text>
        ) : null}
        <ApprovalActions
          denyRef={denyRef}
          // A held change (a hook the agent proposed) is applied or dismissed, never "allowed".
          denyLabel={pendingFormFill ? "Cancel" : pendingHook ? "Dismiss" : "Deny"}
          onDeny={() => onDecide("deny")}
          {...(pendingCanAllow
            ? {
                allowLabel: deciding
                  ? "Sending…"
                  : pendingFormFill
                    ? `Fill ${pendingFormFill.rows.length - formFillExcludedOrders.length} field${pendingFormFill.rows.length - formFillExcludedOrders.length === 1 ? "" : "s"}`
                    : pendingMcpMutation
                      ? subagentMcpMutationAllowLabel(pendingMcpMutation)
                      : pendingRunGrant
                        ? "Allow for run"
                        : pendingHook
                          ? "Apply"
                          : "Allow once",
                onAllow: () => onDecide("allow", pendingFormFill ? { formFillExcludedOrders } : undefined),
              }
            : {})}
          rememberOptions={rememberOptions}
          disabled={disabled}
          keyboardShortcuts={keyboardShortcuts}
        />
      </section>
    </div>
    </LiveGuard>
  );
}
