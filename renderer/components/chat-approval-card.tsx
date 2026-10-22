import { ClassifierApproval } from "./classifier-approval";
import { classifierApprovalState } from "../shared/classifier-approval";
import * as React from "react";
import { CalendarClock, ChevronDown, FilePen, FilePlus, ShieldQuestion, SquareTerminal, type LucideIcon } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Text,
} from "./ui";
import { CopyButton } from "./copy-button";
import { cn } from "../lib/ui-utils";
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
import { SCHEDULE_APPROVAL_FOOTER, ScheduledTaskApproval, scheduleApprovalHeadline } from "./scheduled-task-approval";
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

const TOOL_LABELS: Record<string, string> = {
  edit_file: "Edit file",
  run_command: "Run command",
  write_file: "Write file",
  read_file: "Read file",
  delete_file: "Delete file",
  move_file: "Move file",
  web_fetch: "Fetch web page",
  agent_tool: "Agent tool",
  computer_use: "Computer Use",
  form_fill: "Form fill",
};

/** A tool's name as an approval heading: known labels, otherwise sentence case. */
export function toolLabel(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  const words = toolName.replace(/[_-]+/gu, " ").trim();
  return words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : "Tool";
}

const COMMAND_SUMMARY_PREFIX = "Run command: ";

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/**
 * The exact command a command approval would run: from the desktop preview, or
 * from Aiden's own "Run command: …" summary when the approval came from a
 * paired host that sends only the summary.
 */
export function approvalCommand(pending: Pick<ApprovalPrompt, "toolName" | "summary" | "preview">): string | undefined {
  if (pending.preview?.kind === "command") return pending.preview.command;
  if (pending.toolName === "run_command" && pending.summary.startsWith(COMMAND_SUMMARY_PREFIX)) {
    const command = pending.summary.slice(COMMAND_SUMMARY_PREFIX.length);
    return command.trim() ? command : undefined;
  }
  return undefined;
}

/** Aiden's own file summaries, which name one path, by tool. */
const FILE_SUMMARY_PREFIXES: Record<string, { prefix: string; verb: string }> = {
  edit_file: { prefix: "Edit file: ", verb: "Edit" },
  write_file: { prefix: "Create or replace file: ", verb: "Write" },
};

/** The one file a file approval names: from the desktop preview, or from Aiden's own summary. */
function approvalFilePath(pending: Pick<ApprovalPrompt, "toolName" | "summary" | "preview">): string | undefined {
  if (pending.preview?.kind === "file") return pending.preview.path;
  const fileSummary = FILE_SUMMARY_PREFIXES[pending.toolName];
  if (!fileSummary || !pending.summary.startsWith(fileSummary.prefix)) return undefined;
  const path = pending.summary.slice(fileSummary.prefix.length).trim();
  return path && !/[\r\n]/u.test(path) ? path : undefined;
}

/** The approval card's question, in plain words: "Run this command?", "Edit forecast.ts?". */
export function approvalHeadline(pending: Pick<ApprovalPrompt, "toolName" | "summary" | "preview">): string {
  const { preview } = pending;
  if (preview?.kind === "file") {
    return `${preview.operation === "edit" ? "Edit" : "Write"} ${fileName(preview.path)}?`;
  }
  const fileSummary = FILE_SUMMARY_PREFIXES[pending.toolName];
  const path = approvalFilePath(pending);
  if (fileSummary && path) return `${fileSummary.verb} ${fileName(path)}?`;
  switch (pending.toolName) {
    case "run_command":
      return "Run this command?";
    case "edit_file":
      return "Edit files?";
    case "write_file":
      return "Write a file?";
    case "delete_file":
      return "Delete files?";
    case "move_file":
      return "Move files?";
    case "read_file":
      return "Read a file?";
    case "web_fetch":
      return "Open a web page?";
    case "agent_tool":
      return "Use a tool?";
    case "schedule_task":
      return "Save this scheduled task?";
    case "edit_automation":
      return "Change this automation?";
    case "generate_image":
      return "Generate an image?";
    case "share_image":
      return "Share this image in the chat?";
    default:
      return `Allow ${toolLabel(pending.toolName)}?`;
  }
}

/** The quiet line under the headline: the file and its size of change, or that Aiden is waiting. */
function approvalMeta(preview: ToolApprovalPreview | undefined): string {
  if (preview?.kind !== "file") return "Aiden is paused until you choose.";
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
  return (
    <span className="approval-icon-tile grid size-11 shrink-0 place-items-center bg-fill-accent text-fill-accent-foreground">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
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
  return scope === "always"
    ? `Won't ask again for ${target} here. Undo in Settings → Tool approvals.`
    : `Won't ask again for ${target} until Aiden quits.`;
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
  computerUseHost = "local",
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
}) {
  const details = pending.details as unknown;
  const schedule = isScheduledTaskApprovalDetails(details) || isAssistantAutomationApprovalDetails(details) ? details : undefined;
  const pendingWorkspaceWrite = isSubagentWorkspaceWriteApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingMcpMutation = isSubagentMcpMutationApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingShell = isSubagentShellApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingRunGrant = isSubagentRunGrantApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingFormFill = isFormFillBatchApprovalDetails(pending.details) ? pending.details : undefined;
  const pendingClassifier = classifierApprovalState(pending.toolName, details);
  const invalidPendingPrivilegedApproval =
    (claimsKind(details, "scheduled-task") && !schedule) ||
    (claimsKind(details, "assistant-automation") && !schedule) ||
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
  if (isComputerUseAccessApprovalDetails(details)) {
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
  const disabled = deciding || disabledReason !== undefined;
  const summaryId = `approval-summary-${pending.approvalId}`;
  // Plain coding approvals show the exact command or file change; specialized
  // and invalid approvals keep their own review bodies.
  const plainApproval =
    !invalidPendingPrivilegedApproval && pendingCanAllow && !schedule && !pendingClassifier.details &&
    !pendingWorkspaceWrite && !pendingMcpMutation && !pendingShell && !pendingRunGrant && !pendingFormFill;
  const plainPreview = plainApproval ? pending.preview : undefined;
  const plainCommand = plainApproval ? approvalCommand(pending) : undefined;

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
        className="approval-shell composer-shell bg-popover p-4 shadow-composer"
      >
        <div className="flex flex-col items-center text-center">
          <ApprovalIcon
            preview={plainPreview}
            command={plainCommand !== undefined}
            icon={schedule && pendingCanAllow ? CalendarClock : undefined}
          />
          <Text variant="strong" as="p" id={`approval-title-${pending.approvalId}`} className="mt-2.5 text-balance">
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
                      : schedule
                        ? scheduleApprovalHeadline(schedule)
                        : approvalHeadline(pending)}
            {pendingCount > 1 ? <span className="ml-1.5 font-normal text-tertiary">1 of {pendingCount}</span> : null}
          </Text>
        </div>
        {!pendingCanAllow ? (
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
        <Text variant="small" color="secondary" as="p" className="mt-2.5 text-center text-pretty">
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
                    : schedule
                      ? SCHEDULE_APPROVAL_FOOTER
                      : approvalMeta(plainPreview)}
        </Text>
        {disabledReason ? (
          <Text variant="small" color="secondary" as="p" role="note" className="mt-1.5 text-center">
            {disabledReason}
          </Text>
        ) : null}
        <div className="mt-3.5 flex gap-2">
          <Button ref={denyRef} variant="filled" size="large" className="flex-1" disabled={disabled} onClick={() => onDecide("deny")}>
            {pendingFormFill ? "Cancel" : "Deny"}
          </Button>
          {pendingCanAllow ? (
            <div className={cn("flex min-w-0 flex-1", pendingRememberScopes.length > 0 && "squircle-action-group squircle-control shadow-control")}>
              <Button
                variant="accent"
                size="large"
                className={cn("min-w-0 flex-1", pendingRememberScopes.length > 0 && "shadow-none hover:shadow-none active:shadow-none")}
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
              {pendingRememberScopes.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="accent"
                      size="large"
                      iconOnly
                      disabled={disabled}
                      className="w-10 border-l border-fill-accent-foreground/25 shadow-none hover:shadow-none active:shadow-none"
                      aria-label="More ways to allow"
                    >
                      <ChevronDown aria-hidden="true" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end" className="w-80">
                    {pendingRememberScopes.map((scope) => (
                      <DropdownMenuItem key={scope} onSelect={() => onDecide("allow", { scope })} className="py-1.5">
                        <span className="flex min-w-0 flex-col">
                          <span>{scope === "always" ? "Always allow in this workspace" : toolApprovalScopeLabel(scope)}</span>
                          <span className="text-small text-tertiary">{rememberScopeHint(scope, pending)}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
