// The one approval card model (plan §3.3, §6): the card's question, the
// arguments it shows, the buttons it offers and the line an answer collapses
// to. The desktop card (`chat-approval-card.tsx`) reads its words from here,
// and the Aiden Remote host projects the same model as the typed `card`
// (contract revision 61, `approval:cards`), so phones render what the Mac does.

import type {
  AssistantAutomationApprovalDetails,
  FormFillBatchApprovalDetails,
  ScheduledTaskApprovalDetails,
  SubagentMcpMutationApprovalDetails,
  SubagentRunGrantApprovalDetails,
  SubagentShellApprovalDetails,
  SubagentWorkspaceWriteApprovalDetails,
} from "./assistant";
import type { HookProposalApprovalDetails, HookProposalApprovalHook } from "./hook-proposal-approval";
import type { ToolApprovalPreview } from "./tool-approval-preview";
import type { ToolApprovalScope } from "./tool-approval-scope";

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
  workspace_artifact: "Artifact",
};

/** A tool's name as an approval heading: known labels, otherwise sentence case. */
export function toolLabel(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  const words = toolName.replace(/[_-]+/gu, " ").trim();
  return words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : "Tool";
}

/** The part of an approval the card's words are read from. */
export interface ApprovalCardSource {
  toolName: string;
  summary: string;
  preview?: ToolApprovalPreview;
}

const COMMAND_SUMMARY_PREFIX = "Run command: ";

/**
 * The exact command a command approval would run: from the desktop preview, or
 * from Aiden's own "Run command: …" summary when the approval came from a
 * paired host that sends only the summary.
 */
export function approvalCommand(pending: ApprovalCardSource): string | undefined {
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
export function approvalFilePath(pending: ApprovalCardSource): string | undefined {
  if (pending.preview?.kind === "file") return pending.preview.path;
  const fileSummary = FILE_SUMMARY_PREFIXES[pending.toolName];
  if (!fileSummary || !pending.summary.startsWith(fileSummary.prefix)) return undefined;
  const path = pending.summary.slice(fileSummary.prefix.length).trim();
  return path && !/[\r\n]/u.test(path) ? path : undefined;
}

const MAC_COMMAND_TOOLS: ReadonlySet<string> = new Set(["run_command", "background_job"]);
const MAC_FILE_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file", "delete_file", "move_file"]);

/** The site a generic card's call reaches, when its summary names one. */
export function approvalTarget(summary: string): string | undefined {
  const match = /\bhttps?:\/\/[^\s<>"'()[\]{}]+/iu.exec(summary);
  if (!match) return undefined;
  try {
    // Prose punctuation after the link ("…example.com, Tue") is not part of it.
    return new URL(match[0].replace(/[.,;:!?…]+$/u, "")).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Which part of the Mac a Mac card is about, if it is one. */
export function approvalMacPart(pending: ApprovalCardSource): "shell" | "files" | "computer_use" | undefined {
  if (pending.preview?.kind === "command" || MAC_COMMAND_TOOLS.has(pending.toolName)) return "shell";
  if (pending.preview?.kind === "file" || MAC_FILE_TOOLS.has(pending.toolName)) return "files";
  return pending.toolName === "computer_use" ? "computer_use" : undefined;
}

/**
 * The approval card's question. Calls on the person's Mac name the Mac: "Run on
 * your Mac?", "Change files on your Mac?", "Use your Mac with Computer Use?".
 * Everything else reads "Review before {tool → target}".
 */
export function approvalHeadline(pending: ApprovalCardSource): string {
  switch (approvalMacPart(pending)) {
    case "shell":
      return "Run on your Mac?";
    case "files":
      return "Change files on your Mac?";
    case "computer_use":
      return "Use your Mac with Computer Use?";
  }
  switch (pending.toolName) {
    case "schedule_task":
      return "Save this scheduled task?";
    case "edit_automation":
      return "Change this automation?";
  }
  const target = approvalTarget(pending.summary);
  return `Review before ${toolLabel(pending.toolName)}${target ? ` → ${target}` : ""}`;
}

export type ScheduleApprovalDetails = ScheduledTaskApprovalDetails | AssistantAutomationApprovalDetails;

const SCHEDULE_HEADLINES: Record<ScheduledTaskApprovalDetails["action"], string> = {
  create: "Save this scheduled task?",
  update: "Update this scheduled task?",
  pause: "Pause this scheduled task?",
  resume: "Resume this scheduled task?",
  remove: "Delete this scheduled task?",
  run_now: "Run this scheduled task now?",
};

/** The card's question for a schedule approval, by what saving it would do. */
export function scheduleApprovalHeadline(details: ScheduleApprovalDetails): string {
  if (details.kind === "scheduled-task") return SCHEDULE_HEADLINES[details.action];
  return details.action === "create" ? SCHEDULE_HEADLINES.create : "Change this automation?";
}

export function hookProposalHeadline(details: Pick<HookProposalApprovalDetails, "action">): string {
  return details.action === "delete" ? "Delete this hook?" : details.action === "update" ? "Change this hook?" : "Add this hook?";
}

const SUBAGENT_WRITE_LABELS: Record<SubagentWorkspaceWriteApprovalDetails["operation"], string> = {
  create: "Create file",
  replace: "Replace file",
  edit: "Edit file",
};

export function subagentWorkspaceWriteOperationLabel(operation: SubagentWorkspaceWriteApprovalDetails["operation"]): string {
  return SUBAGENT_WRITE_LABELS[operation];
}

export function subagentMcpMutationAllowLabel(
  details: Pick<SubagentMcpMutationApprovalDetails, "priorUnknownEffect">,
): "Allow once" | "Allow once after unknown outcome" {
  return details.priorUnknownEffect ? "Allow once after unknown outcome" : "Allow once";
}

/** How an answered card reads once it collapses, or that it went away unanswered. */
export type ApprovalStatus =
  | { decision: "deny" }
  | {
      decision: "allow";
      /** How far the allow reached. `always` is the workspace's list, a Bot's list, or every chat for Computer Use. */
      scope?: ToolApprovalScope;
      always?: "workspace" | "everywhere";
    }
  | { decision: "stale" };

/** "Allowed once", "Allowed in this chat", "Allowed in this workspace", "Always allowed", "Denied", "No longer active". */
export function approvalStatusLabel(status: ApprovalStatus): string {
  if (status.decision === "deny") return "Denied";
  if (status.decision === "stale") return "No longer active";
  if (status.scope === "chat") return "Allowed in this chat";
  if (status.scope === "workspace") return "Allowed in this workspace";
  if (status.scope === "always") return status.always === "workspace" ? "Allowed in this workspace" : "Always allowed";
  return "Allowed once";
}

/** The specialized question a details kind asks, or undefined for a plain card. */
export function approvalDetailsHeadline(details: unknown): string | undefined {
  const record = typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
  switch (record?.kind) {
    case "subagent-workspace-write": {
      const write = record as unknown as SubagentWorkspaceWriteApprovalDetails;
      return `${write.childLabel} wants to ${subagentWorkspaceWriteOperationLabel(write.operation).toLocaleLowerCase("en-US")}`;
    }
    case "subagent-mcp-mutation": {
      const mutation = record as unknown as SubagentMcpMutationApprovalDetails;
      return `${mutation.childLabel} wants to call ${mutation.serverId}:${mutation.toolName}`;
    }
    case "subagent-shell":
      return `${(record as unknown as SubagentShellApprovalDetails).childLabel} wants to run a full-host command`;
    case "subagent-run-grant": {
      const grant = record as unknown as SubagentRunGrantApprovalDetails;
      return `Allow ${grant.lane === "write" ? "writes" : "shell"} for ${grant.childLabel}`;
    }
    case "hook-proposal":
      return hookProposalHeadline(record as unknown as HookProposalApprovalDetails);
    case "scheduled-task":
    case "assistant-automation":
      return scheduleApprovalHeadline(record as unknown as ScheduleApprovalDetails);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The typed card on the wire (Aiden Remote contract revision 61)
// ---------------------------------------------------------------------------

export const APPROVAL_CARD_KINDS = ["generic", "explicit", "mac", "batch", "held_change", "schedule"] as const;
export type ApprovalCardKind = (typeof APPROVAL_CARD_KINDS)[number];

export interface ApprovalCardArgument {
  key: string;
  value: string;
}

/** One button. Pressing it sends exactly `{decision, scope?}` to the approval's existing respond route. */
export interface ApprovalCardButton {
  label: string;
  decision: "allow" | "deny";
  /** Absent for a one-time allow and for deny. */
  scope?: "chat" | "always";
  /** The status line the card collapses to once this answer is accepted. */
  answered: string;
}

export interface ApprovalCardBatchRow {
  label: string;
  value: string;
}

export interface ApprovalCard {
  kind: ApprovalCardKind;
  /** Mac cards only: which part of the Mac. */
  mac?: "shell" | "files" | "computer_use";
  title: string;
  /** `key: value`, short values first, so recipients and destinations are visible. */
  arguments: ApprovalCardArgument[];
  /** The whole thing under review: the exact command, the hook, the task's prompt or the request text. */
  body?: { format: "command" | "text"; text: string };
  /** For a changed hook: the hook as it is now. */
  previous?: { format: "command" | "text"; text: string };
  /** Batch cards: one row per action, in order. */
  rows?: ApprovalCardBatchRow[];
  notes?: string[];
  /** Deny first, then the allows, as the desktop card lists them. */
  buttons: ApprovalCardButton[];
  /** Set when this device may only deny: why, and where to allow it. */
  allowOnMac?: string;
}

export const APPROVAL_CARD_LIMITS = {
  title: 200,
  argumentCount: 16,
  key: 40,
  value: 500,
  body: 16_000,
  rows: 60,
  notes: 6,
  note: 400,
} as const;

/** "No longer active": what a card that went away unanswered reads. */
export const APPROVAL_CARD_STALE_LABEL = approvalStatusLabel({ decision: "stale" });

/** Rakazo's order: short values first (stable for equal lengths), so a recipient never hides behind a long body. */
export function orderApprovalArguments(entries: readonly ApprovalCardArgument[]): ApprovalCardArgument[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => [...a.entry.value].length - [...b.entry.value].length || a.index - b.index)
    .map(({ entry }) => entry);
}

/** What the card is built from: the approval as the host holds it. */
export interface ApprovalCardInput extends ApprovalCardSource {
  canAllow: boolean;
  /** Broader-than-once scopes the host offers this device (never `workspace`). */
  scopes?: readonly ToolApprovalScope[];
  details?: unknown;
  /** True when the host could not keep the details (too large): the card can only be denied here. */
  detailsOmitted?: boolean;
  /** Who asks: a Bot by name, else Aiden. */
  requester?: string;
  /** A Bot's Always reads "Always allow for {Bot}". */
  alwaysLabel?: string;
  /** "You’ve allowed this 4 times in the last 2 weeks." */
  notes?: readonly string[];
}

const DENY: ApprovalCardButton = { label: "Deny", decision: "deny", answered: approvalStatusLabel({ decision: "deny" }) };
const ALLOW_ON_MAC = "Allow it on your Mac.";

function clip(text: string, max: number): { text: string; complete: boolean } {
  const points = [...text];
  return points.length <= max ? { text, complete: true } : { text: `${points.slice(0, max - 1).join("")}…`, complete: false };
}

function kindOf(details: unknown): string | undefined {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (typeof (details as Record<string, unknown>).kind === "string" ? (details as { kind: string }).kind : undefined)
    : undefined;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  return value;
}

function hookText(hook: HookProposalApprovalHook): string {
  // The event, matcher and command are what the person approves: a hook
  // missing any of them is not shown, so the card fails closed.
  requireText(hook.event, "Hook event");
  requireText(hook.matcher, "Hook matcher");
  requireText(hook.command, "Hook command");
  return [
    `event: ${hook.event}`,
    `matcher: ${hook.matcher === "" ? "Everything" : hook.matcher}`,
    `command: ${hook.command}`,
    `timeout: ${hook.timeoutSeconds}s`,
    `runs: ${hook.async ? "in the background" : "before the chat goes on"}`,
    `if it fails: ${hook.failClosed ? "block" : "continue"}`,
    ...(hook.envAllow.length > 0 ? [`environment: ${hook.envAllow.join(", ")}`] : []),
  ].join("\n");
}

/**
 * The typed card for one pending approval. It is complete or deny-only: when
 * any part under review would not fit the wire bounds, or the host kept no
 * details, the card offers only Deny and says to allow it on the Mac, so a
 * device never allows something it could not see. A sub-agent's run-wide
 * grant is given on the Mac only. Disclosure
 * tools (`classify`, `generate_image`) stay allow-on-Mac in this revision. A
 * plain `computer_use` call (a Bot's) acts on the Mac's screen and is allowed
 * there; the Computer Use access grant card can be answered anywhere.
 */
export function buildApprovalCard(input: ApprovalCardInput): ApprovalCard {
  const details = input.details;
  const detailsKind = kindOf(details);
  const args: ApprovalCardArgument[] = [];
  const notes: string[] = [...(input.notes ?? [])];
  let complete = input.detailsOmitted !== true;
  let kind: ApprovalCardKind = "generic";
  let mac: ApprovalCard["mac"];
  let body: ApprovalCard["body"];
  let previous: ApprovalCard["previous"];
  let rows: ApprovalCardBatchRow[] | undefined;
  let allowLabel = "Allow once";
  let denyLabel = "Deny";
  let title = approvalDetailsHeadline(details) ?? approvalHeadline(input);
  let hostOnly = false;
  const scopes = new Set(input.scopes ?? []);
  const text = (value: string, format: "command" | "text" = "text") => {
    const clipped = clip(value, APPROVAL_CARD_LIMITS.body);
    complete &&= clipped.complete;
    return { format, text: clipped.text };
  };

  // Details the host could not keep, or that are not the shape their kind
  // promises, are reviewed on the Mac: the card fails closed, never open.
  try {
  switch (input.detailsOmitted === true && detailsKind !== undefined ? "omitted" : detailsKind) {
    case "omitted":
      hostOnly = true;
      break;
    case undefined: {
      const part = approvalMacPart(input);
      const command = approvalCommand(input);
      const path = approvalFilePath(input);
      const site = approvalTarget(input.summary);
      if (part) { kind = "mac"; mac = part; }
      if (part === "computer_use") hostOnly = true;
      if (input.toolName === "classify" || input.toolName === "generate_image") { kind = "explicit"; hostOnly = true; }
      if (site) args.push({ key: "site", value: site });
      if (path) args.push({ key: "path", value: path });
      args.push({ key: "tool", value: toolLabel(input.toolName) });
      body = command !== undefined ? text(command, "command") : text(input.summary);
      break;
    }
    case "scheduled-task":
    case "assistant-automation": {
      const schedule = details as ScheduleApprovalDetails;
      kind = "schedule";
      args.push({ key: "name", value: schedule.name }, { key: "when", value: schedule.cron }, { key: "time zone", value: schedule.timezone },
        { key: "access", value: schedule.permission === "full" ? "Full access" : "Read-only" });
      const work = schedule.kind === "scheduled-task" ? schedule.prompt ?? schedule.script ?? "" : schedule.prompt;
      if (work) body = text(work, schedule.kind === "scheduled-task" && schedule.mode === "script" ? "command" : "text");
      break;
    }
    case "hook-proposal": {
      const hook = details as HookProposalApprovalDetails;
      kind = "held_change";
      allowLabel = "Apply";
      denyLabel = "Dismiss";
      args.push({ key: "name", value: hook.name }, { key: "where", value: hook.scopeLabel }, { key: "event", value: hook.event });
      body = text(hookText(hook), "command");
      if (hook.previous) previous = text(hookText(hook.previous), "command");
      notes.push(...hook.warnings);
      if (hook.scriptCoverage === "partial") notes.push("The command also runs something Aiden can’t follow to a file.");
      break;
    }
    case "subagent-shell": {
      const shell = details as SubagentShellApprovalDetails;
      kind = "mac"; mac = "shell";
      args.push({ key: "who", value: shell.childLabel }, { key: "folder", value: shell.initialCwd },
        { key: "workspace", value: shell.worktreeLabel ?? shell.workspaceLabel });
      body = text(shell.command, "command");
      break;
    }
    case "subagent-workspace-write": {
      const write = details as SubagentWorkspaceWriteApprovalDetails;
      kind = "mac"; mac = "files";
      args.push({ key: "who", value: write.childLabel }, { key: "path", value: write.path },
        { key: "workspace", value: write.worktreeLabel ?? write.workspaceLabel },
        { key: "size", value: `${write.beforeBytes} → ${write.afterBytes} bytes` });
      // The change itself is what the person allows: a diff the host had to
      // cut short, or one that does not fit, can only be allowed on the Mac.
      body = text(requireText(write.diffPreview, "Diff preview"), "command");
      if (write.diffTruncated !== false) complete = false;
      break;
    }
    case "subagent-mcp-mutation": {
      const mutation = details as SubagentMcpMutationApprovalDetails;
      args.push({ key: "who", value: mutation.childLabel }, { key: "server", value: mutation.serverId }, { key: "tool", value: mutation.toolName },
        { key: "effect", value: mutation.destructive }, { key: "changes", value: mutation.classification === "declared_mutating" ? "declared" : "not proven read-only" });
      allowLabel = subagentMcpMutationAllowLabel(mutation);
      body = text(requireText(mutation.canonicalArguments, "Tool arguments"), "command");
      break;
    }
    case "subagent-run-grant": {
      const grant = details as SubagentRunGrantApprovalDetails;
      kind = "explicit";
      allowLabel = "Allow for run";
      args.push({ key: "who", value: grant.childLabel }, { key: "workspace", value: grant.worktreeLabel ?? grant.workspaceLabel },
        { key: "reach", value: grant.fullHostAccess ? "Full host" : "This workspace" });
      if (grant.noRollback) notes.push("Changes in this run can’t be rolled back.");
      // A run-wide grant reaches more than one call; it is given on the Mac.
      hostOnly = true;
      break;
    }
    case "form-fill-batch": {
      const form = details as FormFillBatchApprovalDetails;
      kind = "batch";
      denyLabel = "Cancel";
      allowLabel = `Fill ${form.rows.length} field${form.rows.length === 1 ? "" : "s"}`;
      args.push({ key: "app", value: form.targetApp }, { key: "window", value: form.targetTitle }, { key: "from", value: form.sourceDocument });
      complete &&= form.rows.length <= APPROVAL_CARD_LIMITS.rows;
      rows = form.rows.slice(0, APPROVAL_CARD_LIMITS.rows).map((row) => {
        const value = clip(row.value, APPROVAL_CARD_LIMITS.value);
        complete &&= value.complete;
        return { label: clip(row.label, APPROVAL_CARD_LIMITS.key * 2).text, value: value.text };
      });
      break;
    }
    case "model-classification":
      kind = "explicit";
      hostOnly = true;
      break;
    case "computer-use-access":
      // The grant can be answered anywhere; macOS's own permission prompts
      // (deviation d) are still set up on the Mac.
      kind = "mac"; mac = "computer_use";
      title = "Use your Mac with Computer Use?";
      args.push({ key: "reach", value: "Every app" });
      notes.push("macOS permissions for Computer Use are set up on the Mac.");
      break;
    default:
      // A details kind this model does not know is reviewed on the Mac.
      hostOnly = true;
  }
  } catch {
    hostOnly = true;
    args.length = 0;
    rows = undefined;
    body = undefined;
    previous = undefined;
  }

  const bounded = orderApprovalArguments(args.filter((entry) => entry.value.trim() !== "").slice(0, APPROVAL_CARD_LIMITS.argumentCount).map((entry) => {
    const value = clip(entry.value, APPROVAL_CARD_LIMITS.value);
    complete &&= value.complete;
    return { key: clip(entry.key, APPROVAL_CARD_LIMITS.key).text, value: value.text };
  }));
  title = clip(title, APPROVAL_CARD_LIMITS.title).text;
  const mayAllow = input.canAllow && complete && !hostOnly;
  const deny: ApprovalCardButton = denyLabel === DENY.label ? DENY : { ...DENY, label: denyLabel };
  const buttons: ApprovalCardButton[] = [deny];
  if (mayAllow) {
    buttons.push({ label: allowLabel, decision: "allow", answered: allowLabel === "Apply" ? "Applied" : approvalStatusLabel({ decision: "allow" }) });
    // Remembered allows exist only for plain cards, as on the desktop.
    if (detailsKind === undefined) {
      if (scopes.has("chat")) buttons.push({ label: "Allow in this chat", decision: "allow", scope: "chat", answered: approvalStatusLabel({ decision: "allow", scope: "chat" }) });
      if (scopes.has("always")) {
        buttons.push(input.alwaysLabel
          ? { label: input.alwaysLabel, decision: "allow", scope: "always", answered: approvalStatusLabel({ decision: "allow", scope: "always" }) }
          : { label: "Allow in this workspace", decision: "allow", scope: "always", answered: approvalStatusLabel({ decision: "allow", scope: "always", always: "workspace" }) });
      }
    }
  }
  return {
    kind,
    ...(mac ? { mac } : {}),
    title,
    arguments: bounded,
    ...(body && body.text.trim() ? { body } : {}),
    ...(previous ? { previous } : {}),
    ...(rows ? { rows } : {}),
    ...(notes.length > 0 ? { notes: notes.slice(0, APPROVAL_CARD_LIMITS.notes).map((note) => clip(note, APPROVAL_CARD_LIMITS.note).text) } : {}),
    buttons,
    ...(!mayAllow ? { allowOnMac: ALLOW_ON_MAC } : {}),
  };
}

/** Whether a card lets this device allow (any allow button), the single answer the respond routes check. */
export function approvalCardAllows(card: ApprovalCard, scope?: ToolApprovalScope): boolean {
  return card.buttons.some((button) => button.decision === "allow" && (button.scope ?? "once") === (scope ?? "once"));
}
