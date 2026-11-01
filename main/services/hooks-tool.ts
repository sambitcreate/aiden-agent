/**
 * The agent's `hooks` tool for desktop workspace chats
 * (docs/plans/aiden-hooks-plan.md §9).
 *
 * The agent can read this chat's hooks, propose a workspace or chat hook, and
 * turn one off. It can never make a hook run on its own authority:
 *
 * - `propose` stages a proposal in the hook service and raises a host-only
 *   card for the owner. Only "allowed" applies it; every other outcome
 *   withdraws it. The card offers no remembered scope, and it is raised from
 *   inside the tool, so Full access, remembered approvals and a PreToolUse
 *   hook's "allow" never answer it.
 * - `disable` turns off only hooks the agent itself proposed for this chat or
 *   its workspace. A hook the owner added (often a guard meant to hold the
 *   agent back), a Bot's hook, and global and repo (`.aiden/hooks.json`) hooks
 *   stay with Settings.
 * - `test` never runs the command. The owner presses Test in Settings → Hooks.
 *
 * Everything a hook or repo file wrote (commands, names, output) reaches the
 * model fenced as data.
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { fenceAsData } from "../../renderer/shared/agent-notices.js";
import {
  HOOK_PROPOSAL_APPROVAL_KIND,
  HOOK_PROPOSAL_LABEL_LIMIT,
  HOOK_PROPOSAL_MAX_SCRIPT_FILES,
  HOOK_PROPOSAL_MAX_WARNINGS,
  HOOK_PROPOSAL_SCRIPT_FILE_LIMIT,
  HOOK_PROPOSAL_WARNING_LIMIT,
  isHookProposalApprovalDetails,
  type HookProposalApprovalDetails,
  type HookProposalApprovalHook,
} from "../../renderer/shared/hook-proposal-approval.js";
import { clampHookTimeout, hookScopeKey, MAX_AGENT_HOOK_TIMEOUT_SECONDS, MAX_HOOK_COMMAND_LENGTH } from "./hooks/hook-config.js";
import type { HookProposal, HookService } from "./hooks/hook-service.js";
import { HOOK_EVENTS, type HookCommandHandler, type HookListing, type HookRunRecord, type HookScope } from "./hooks/hook-types.js";
import type { PiRuntimeTool } from "./pi-runtime-tool.js";
import { toolApprovalBlockReason, type ToolApprovalOutcome } from "./tool-approval.js";
import { workspaceChatHookScopes } from "./workspace-chat-hooks.js";

export const HOOKS_TOOL_NAME = "hooks";

/** Run records `logs` returns, newest first. */
export const HOOKS_TOOL_MAX_LOG_RECORDS = 10;
/** Characters of one run's output excerpt the model sees. */
export const HOOKS_TOOL_LOG_EXCERPT_CHARS = 1_000;

/**
 * Where the `hooks` tool is offered: the surfaces that run workspace chat
 * hooks (an ordinary desktop chat; not a Bot, Design Studio, the Assistant,
 * an ACP harness, a routine, Telegram or a side question), and only while a
 * person is there to answer the card. Subagents build their own inventory and
 * never get it.
 */
export interface HooksToolSurface {
  /** `options.usageSource`; only `"chat"` (the default) runs chat hooks. */
  usageSource?: string;
  interactionSurface?: string;
  bot: boolean;
  design: boolean;
  assistant: boolean;
  harnessProvider: boolean;
  /** A follow-up turn nobody watches: its approvals settle as unavailable. */
  unattended: boolean;
  /**
   * A turn a phone or paired Mac drives. Its approvals reach that device,
   * which may only deny a hook proposal, so the tool is withheld.
   */
  remoteAudience?: boolean;
  excludedToolNames?: ReadonlySet<string>;
}

/** The same gate as workspace chat hooks: the surfaces that run them. */
export function runsWorkspaceChatHooks(
  surface: Omit<HooksToolSurface, "unattended" | "remoteAudience" | "excludedToolNames">,
): boolean {
  return (
    (surface.usageSource ?? "chat") === "chat" &&
    surface.interactionSurface !== "telegram" &&
    !surface.bot &&
    !surface.design &&
    !surface.assistant &&
    !surface.harnessProvider
  );
}

export function offersHooksTool(surface: HooksToolSurface): boolean {
  return (
    runsWorkspaceChatHooks(surface) &&
    !surface.unattended &&
    surface.remoteAudience !== true &&
    surface.excludedToolNames?.has(HOOKS_TOOL_NAME) !== true
  );
}

export interface HooksToolApprovalCard {
  summary: string;
  details: HookProposalApprovalDetails;
}

export interface HooksToolDependencies {
  chatId: string;
  /** The chat's folder; a folderless chat can only have chat hooks. */
  workspaceRoot?: string;
  service: () => HookService | undefined;
  /**
   * Raise the owner's card for this tool call and wait for the answer. The
   * card is "once" only: implementations must not offer remembered scopes.
   */
  requestApproval: (toolCallId: string, card: HooksToolApprovalCard, signal?: AbortSignal) => Promise<ToolApprovalOutcome>;
}

interface HooksToolParams {
  action: "list" | "propose" | "disable" | "test" | "logs";
  change?: "create" | "update" | "delete";
  hookId?: string;
  scope?: "workspace" | "chat";
  event?: string;
  matcher?: string;
  command?: string;
  timeout?: number;
  failClosed?: boolean;
  async?: boolean;
  envAllow?: string[];
  name?: string;
}

const DESCRIPTION = [
  "Read and propose Aiden hooks: shell commands Aiden runs at lifecycle events of this chat (before or after a tool, when a prompt is sent, at session start, when a turn stops).",
  'Actions: "list" shows this chat\'s hooks and pending proposals; "propose" asks the owner to add, change (hookId) or delete (change "delete", hookId) a workspace or chat hook, and waits for their answer on the Mac;',
  '"disable" turns off a workspace or chat hook an agent proposed (hooks the owner added are turned off only in Settings → Hooks, and only the owner can turn one back on); "test" shows the last run, since only the owner can run a test from Settings → Hooks; "logs" shows recent runs.',
  `Agent hooks stop after at most ${MAX_AGENT_HOOK_TIMEOUT_SECONDS} seconds. Global hooks and a repo's .aiden/hooks.json are managed in Settings → Hooks only. Load the aiden-hooks skill for the hook protocol.`,
].join(" ");

const PARAMETERS = Type.Object(
  {
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("propose"), Type.Literal("disable"), Type.Literal("test"), Type.Literal("logs")],
      { description: "What to do." },
    ),
    change: Type.Optional(
      Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")], {
        description: 'propose only. Defaults to "update" with hookId, else "create".',
      }),
    ),
    hookId: Type.Optional(
      Type.String({ maxLength: 300, description: 'The hook\'s id from "list". Required for disable, test, logs, and to update or delete.' }),
    ),
    scope: Type.Optional(
      Type.Union([Type.Literal("workspace"), Type.Literal("chat")], {
        description: 'propose create: "workspace" runs in every chat of this folder, "chat" only in this chat.',
      }),
    ),
    event: Type.Optional(
      Type.String({
        maxLength: 40,
        description: `propose: one of ${HOOK_EVENTS.join(", ")}. WorktreeSetup takes scope "workspace" only; RoutineRun and RoutineFailed run only for global and Bot hooks, which the owner adds in Settings → Hooks.`,
      }),
    ),
    matcher: Type.Optional(
      Type.String({
        maxLength: 500,
        description:
          'propose: tool names for PreToolUse/PostToolUse (for example "run_command|Bash" or "write_file|edit_file"); startup, resume or compact for SessionStart; manual or auto for PreCompact; permission_prompt or elicitation_dialog for Notification. Other events ignore it. Empty matches all.',
      }),
    ),
    command: Type.Optional(
      Type.String({
        maxLength: MAX_HOOK_COMMAND_LENGTH,
        description: "propose: the shell command. It receives the event as JSON on stdin and runs in the workspace folder.",
      }),
    ),
    timeout: Type.Optional(
      Type.Number({ minimum: 1, maximum: MAX_AGENT_HOOK_TIMEOUT_SECONDS, description: `propose: seconds, at most ${MAX_AGENT_HOOK_TIMEOUT_SECONDS}.` }),
    ),
    failClosed: Type.Optional(
      Type.Boolean({ description: "propose, PreToolUse only: block the tool when the hook crashes or times out." }),
    ),
    async: Type.Optional(
      Type.Boolean({
        description: "propose: run it in the background. Aiden doesn't wait for it, so it can't block or add context; its systemMessage reaches the person when it finishes. Not with failClosed.",
      }),
    ),
    envAllow: Type.Optional(
      Type.Array(Type.String({ maxLength: 128 }), {
        maxItems: 32,
        description: "propose: extra environment variable names the command may read. Names only, never values.",
      }),
    ),
    name: Type.Optional(Type.String({ maxLength: 80, description: "propose: a short name shown in Settings → Hooks." })),
  },
  { additionalProperties: false },
);

function text(value: string): AgentToolResult<null> {
  return { content: [{ type: "text", text: value }], details: null };
}

// C0/C1 controls, bidi marks and overrides, and line/paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE_LINE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]+/gu;

/** Control and bidi characters out, whitespace folded, trimmed and bounded: safe for one card line. */
function cardLine(value: string, limit: number): string {
  const cleaned = value.replace(UNSAFE_LINE_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

function approvalHook(event: string, matcher: string, handler: HookCommandHandler): HookProposalApprovalHook {
  return {
    event,
    matcher,
    command: handler.command,
    timeoutSeconds: clampHookTimeout(handler.timeout, handler.async),
    async: handler.async === true,
    failClosed: handler.failClosed === true,
    envAllow: [...(handler.envAllow ?? [])],
  };
}

function scopeLabel(scope: HookScope): string {
  switch (scope.kind) {
    case "workspace": {
      const folder = cardLine(path.basename(scope.workspaceRoot), 120);
      return folder ? `This workspace (${folder})` : "This workspace";
    }
    case "chat":
      return "This chat";
    case "bot":
      return "This Bot";
    case "global":
      return "Every chat";
  }
}

function describeScope(scope: HookScope): string {
  switch (scope.kind) {
    case "workspace":
      return "workspace";
    case "chat":
      return "chat";
    case "bot":
      return "bot";
    case "global":
      return "global";
  }
}

function describeRun(run: HookRunRecord): string {
  const exit = run.timedOut ? "timed out" : `exit ${run.exitCode ?? "none"}`;
  return `${new Date(run.startedAt).toISOString()} ${run.event}: ${run.result}, ${exit}, ${run.durationMs} ms`;
}

function describeListing(hook: HookListing): string {
  const lines = [
    `- ${hook.id} (${describeScope(hook.scope)}${hook.source === "workspace-file" ? ", repo .aiden/hooks.json" : ""}): ${hook.status}`,
    `  name: ${hook.name}`,
    `  event: ${hook.configuredEvent}${hook.matcher ? `, matcher: ${hook.matcher}` : ""}`,
    `  command: ${hook.handler.command}`,
    `  timeout: ${clampHookTimeout(hook.handler.timeout, hook.handler.async)} s${hook.handler.async ? ", runs in the background" : ""}${hook.handler.failClosed ? ", fail closed" : ""}${hook.handler.envAllow?.length ? `, env: ${hook.handler.envAllow.join(", ")}` : ""}`,
  ];
  if (hook.scriptFiles?.length) lines.push(`  approval covers: ${hook.scriptFiles.join(", ")}${hook.scriptCoverage === "partial" ? " (not everything the command runs)" : ""}`);
  else if (hook.scriptCoverage === "partial") lines.push("  approval covers: the command only, not everything it runs");
  if (hook.unsupportedReason) lines.push(`  not supported: ${hook.unsupportedReason}`);
  if (hook.lastRun) lines.push(`  last run: ${describeRun(hook.lastRun)}`);
  return lines.join("\n");
}

function describeProposal(proposal: HookProposal): string {
  return `- ${proposal.id}: ${proposal.action} ${proposal.hookId} (${describeScope(proposal.definition.scope)}), waiting for the owner. ${proposal.summary}`;
}

function cappedExcerpt(excerpt: string): string {
  return excerpt.length <= HOOKS_TOOL_LOG_EXCERPT_CHARS ? excerpt : `${excerpt.slice(0, HOOKS_TOOL_LOG_EXCERPT_CHARS)}… (truncated)`;
}

export function createHooksTool(deps: HooksToolDependencies): PiRuntimeTool {
  const scopes = workspaceChatHookScopes({ chatId: deps.chatId, ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}) });
  const ownScopeKeys = new Set(scopes.filter((scope) => scope.kind !== "global").map(hookScopeKey));
  const allScopeKeys = new Set(scopes.map(hookScopeKey));

  const requireService = (): HookService => {
    const service = deps.service();
    if (!service) throw new Error("Hooks are not available right now.");
    return service;
  };

  const requireHookId = (params: HooksToolParams): string => {
    const hookId = params.hookId?.trim();
    if (!hookId) throw new Error(`"${params.action}" needs the hookId from "list".`);
    return hookId;
  };

  /** A hook this chat can see (global, its workspace, or itself). */
  const findVisible = async (service: HookService, hookId: string): Promise<HookListing> => {
    const listing = (await service.listHooks(scopes)).hooks.find((hook) => hook.id === hookId);
    if (!listing || !allScopeKeys.has(hookScopeKey(listing.scope))) {
      throw new Error(`There is no hook ${hookId} in this chat. Use "list" for the ids.`);
    }
    return listing;
  };

  /** A hook the agent may change or turn off: this chat's or its workspace's, stored by Aiden. */
  const findOwn = async (service: HookService, hookId: string, verb: string): Promise<HookListing> => {
    const listing = await findVisible(service, hookId);
    if (listing.scope.kind === "global") {
      throw new Error(`Global hooks can only be ${verb} by the owner in Settings → Hooks.`);
    }
    if (listing.source === "workspace-file") {
      throw new Error(`Hooks in the repo's .aiden/hooks.json can't be ${verb} from a chat. The owner manages them in Settings → Hooks, or the file can be edited.`);
    }
    if (!ownScopeKeys.has(hookScopeKey(listing.scope))) {
      throw new Error(`Hook ${hookId} does not belong to this chat or its workspace.`);
    }
    return listing;
  };

  const list = async (): Promise<AgentToolResult<null>> => {
    const service = requireService();
    const listed = await service.listHooks(scopes);
    const proposals = service.listProposals().filter((proposal) => ownScopeKeys.has(hookScopeKey(proposal.definition.scope)));
    const notes: string[] = [];
    if (listed.disabledByEnvironment) notes.push("Hooks are turned off on this Mac (AIDEN_HOOKS=0), so none run.");
    else if (listed.paused) notes.push("The owner paused all hooks in Settings → Hooks, so none run until they resume them.");
    if (!deps.workspaceRoot) notes.push("This chat has no folder, so only chat hooks can be proposed.");
    for (const file of listed.workspaceFiles) {
      if (file.problems.length > 0) notes.push(`The repo's .aiden/hooks.json has ${file.problems.length} problem(s); the owner sees them in Settings → Hooks.`);
    }
    const body = [
      listed.hooks.length > 0 ? listed.hooks.map(describeListing).join("\n") : "No hooks apply to this chat.",
      ...(proposals.length > 0 ? ["", "Pending proposals:", ...proposals.map(describeProposal)] : []),
    ].join("\n");
    return text([...notes, fenceAsData("Hooks for this chat", body)].join("\n\n"));
  };

  const disable = async (params: HooksToolParams): Promise<AgentToolResult<null>> => {
    const service = requireService();
    const hookId = requireHookId(params);
    const listing = await findOwn(service, hookId, "turned off");
    // A hook the owner added may be the guard that holds this agent back, so the
    // agent may only switch off what an agent proposed.
    if (listing.source !== "agent") {
      throw new Error(
        `Hook ${hookId} was added by the owner, so only they can turn it off. Ask them to switch it off in Settings → Hooks.`,
      );
    }
    if (listing.status === "disabled" || listing.status === "disabled-after-failures") {
      return text(`Hook ${hookId} is already off.`);
    }
    await service.setEnabled(hookId, false);
    return text(`Turned off hook ${hookId}. Only the owner can turn it back on, from Settings → Hooks or by approving a new proposal.`);
  };

  const recentRuns = (service: HookService, hookId: string): HookRunRecord[] =>
    [...service.getRunLog(hookId)].sort((a, b) => b.startedAt - a.startedAt).slice(0, HOOKS_TOOL_MAX_LOG_RECORDS);

  const fencedRuns = (runs: readonly HookRunRecord[]): string =>
    fenceAsData(
      "Hook runs",
      runs
        .map((run) => [describeRun(run), run.outputExcerpt ? cappedExcerpt(run.outputExcerpt) : "(no output)"].join("\n"))
        .join("\n\n"),
    );

  const testHook = async (params: HooksToolParams): Promise<AgentToolResult<null>> => {
    const service = requireService();
    const hookId = requireHookId(params);
    await findVisible(service, hookId);
    // Never run the command from here: a test run is the owner's action.
    const [last] = recentRuns(service, hookId);
    const lead = `You can't run a hook. Ask the owner to press Test on hook ${hookId} in Settings → Hooks; it runs against a sample event and shows the result there.`;
    return text(last ? `${lead}\n\nIts last run:\n\n${fencedRuns([last])}` : `${lead}\n\nIt has not run yet.`);
  };

  const logs = async (params: HooksToolParams): Promise<AgentToolResult<null>> => {
    const service = requireService();
    const hookId = requireHookId(params);
    await findVisible(service, hookId);
    const runs = recentRuns(service, hookId);
    return text(runs.length > 0 ? `The last ${runs.length} run(s) of hook ${hookId}, newest first:\n\n${fencedRuns(runs)}` : `Hook ${hookId} has not run yet.`);
  };

  const proposalScope = (requested: HooksToolParams["scope"]): HookScope => {
    if (requested === "workspace") {
      if (!deps.workspaceRoot) throw new Error("This chat has no folder, so it can't have workspace hooks. Propose a chat hook instead.");
      return { kind: "workspace", workspaceRoot: deps.workspaceRoot };
    }
    if (requested === "chat") return { kind: "chat", chatId: deps.chatId };
    throw new Error('Say which scope: "workspace" (every chat in this folder) or "chat" (this chat only). Global hooks are added in Settings → Hooks.');
  };

  const propose = async (toolCallId: string, params: HooksToolParams, signal?: AbortSignal): Promise<AgentToolResult<null>> => {
    const service = requireService();
    const change = params.change ?? (params.hookId ? "update" : "create");
    let existing: HookListing | undefined;
    let proposed: Awaited<ReturnType<HookService["proposeHook"]>>;
    if (change === "create") {
      if (params.hookId) throw new Error('To change an existing hook use change "update".');
      if (!params.event || !params.command) throw new Error("A new hook needs an event and a command.");
      proposed = await service.proposeHook({
        origin: "agent",
        scope: proposalScope(params.scope),
        event: params.event,
        ...(params.matcher !== undefined ? { matcher: params.matcher.trim() } : {}),
        handler: handlerFrom(params, undefined),
        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
      });
    } else {
      const hookId = requireHookId(params);
      existing = await findOwn(service, hookId, change === "delete" ? "deleted" : "changed");
      if (params.scope && hookScopeKey(proposalScope(params.scope)) !== hookScopeKey(existing.scope)) {
        throw new Error("A hook can't move to another scope. Propose a new one there instead.");
      }
      if (existing.event === "unknown") throw new Error(`Hook ${hookId} uses an event Aiden does not support; the owner manages it in Settings → Hooks.`);
      proposed = await service.proposeHook({
        origin: "agent",
        scope: existing.scope,
        existingId: hookId,
        ...(change === "delete"
          ? { delete: true, event: existing.event }
          : {
              event: params.event ?? existing.event,
              matcher: (params.matcher ?? existing.matcher).trim(),
              handler: handlerFrom(params, existing.handler),
              ...(params.name?.trim() ? { name: params.name.trim() } : {}),
            }),
      });
    }
    if (!proposed.ok) throw new Error(proposed.reason);
    const proposal = proposed.value;
    const details = approvalDetails(proposal, existing);
    if (!isHookProposalApprovalDetails(details)) {
      service.rejectProposal(proposal.id);
      throw new Error("The owner couldn't review this hook safely: its command or matcher has control or invisible characters, or a field is too long. Rewrite it in plain text.");
    }
    const verb = proposal.action === "delete" ? "delete" : proposal.action === "update" ? "change" : "add";
    const card: HooksToolApprovalCard = {
      // Phones and paired Macs see only this line and can't approve it.
      summary: `Aiden wants to ${verb} a hook. Review and approve it on the computer running this chat. ${cardLine(proposal.summary, 600)}`,
      details,
    };
    let outcome: ToolApprovalOutcome;
    try {
      outcome = await deps.requestApproval(toolCallId, card, signal);
    } catch (error) {
      service.rejectProposal(proposal.id);
      throw error;
    }
    if (outcome !== "allowed") {
      service.rejectProposal(proposal.id);
      return text(
        outcome === "denied"
          ? "The owner declined this hook. Don't propose it again unless they ask for it."
          : `${toolApprovalBlockReason(outcome, false)} The hook proposal was withdrawn.`,
      );
    }
    const applied = await service.approveProposal(proposal.id);
    if (!applied.ok) return text(`The owner approved the hook, but it could not be saved: ${applied.reason}`);
    if (proposal.action === "delete") return text(`The owner approved. Hook ${proposal.hookId} is deleted and won't run again.`);
    const state = await service.listHooks(scopes);
    const pausedNote = state.disabledByEnvironment
      ? " Hooks are turned off on this Mac (AIDEN_HOOKS=0), so it won't run until they're turned back on."
      : state.paused
        ? " All hooks are paused in Settings → Hooks, so it won't run until the owner resumes them."
        : "";
    return text(
      `The owner approved. Hook ${proposal.hookId} is ${proposal.action === "update" ? "updated" : "saved"} and runs from the next matching ${proposal.definition.event} event; it doesn't run for this tool call.${pausedNote}`,
    );
  };

  return {
    name: HOOKS_TOOL_NAME,
    label: "Hooks",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    // Scripts can't raise the owner's card; a crash is never replayed.
    codemode: false,
    execute: async (toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
      if (signal?.aborted) throw new Error("The hooks action was cancelled.");
      const params = rawParams as HooksToolParams;
      switch (params.action) {
        case "list":
          return list();
        case "propose":
          return propose(toolCallId, params, signal);
        case "disable":
          return disable(params);
        case "test":
          return testHook(params);
        case "logs":
          return logs(params);
        default:
          throw new Error('Use action "list", "propose", "disable", "test" or "logs".');
      }
    },
  };
}

function handlerFrom(params: HooksToolParams, existing: HookCommandHandler | undefined): HookCommandHandler {
  const command = (params.command ?? existing?.command ?? "").trim();
  const timeout = params.timeout ?? existing?.timeout;
  const failClosed = params.failClosed ?? existing?.failClosed;
  const runsAsync = params.async ?? existing?.async;
  const envAllow = params.envAllow ?? existing?.envAllow;
  return {
    type: "command",
    command,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(failClosed !== undefined ? { failClosed } : {}),
    ...(runsAsync !== undefined ? { async: runsAsync } : {}),
    ...(envAllow && envAllow.length > 0 ? { envAllow: [...envAllow] } : {}),
  };
}

function approvalDetails(proposal: HookProposal, existing: HookListing | undefined): HookProposalApprovalDetails {
  const { definition } = proposal;
  // Paths are display-only here (the digest already covers the files); clean them the way the card expects.
  const scriptFiles = (proposal.scriptFiles ?? [])
    .map((file) => cardLine(file, HOOK_PROPOSAL_SCRIPT_FILE_LIMIT))
    .filter(Boolean)
    .slice(0, HOOK_PROPOSAL_MAX_SCRIPT_FILES);
  return {
    kind: HOOK_PROPOSAL_APPROVAL_KIND,
    action: proposal.action,
    name: cardLine(definition.name, HOOK_PROPOSAL_LABEL_LIMIT) || "Hook",
    scopeLabel: scopeLabel(definition.scope),
    warnings: proposal.warnings
      .map((warning) => cardLine(warning, HOOK_PROPOSAL_WARNING_LIMIT))
      .filter(Boolean)
      .slice(0, HOOK_PROPOSAL_MAX_WARNINGS),
    previous:
      proposal.action === "update" && existing && existing.event !== "unknown"
        ? approvalHook(existing.event, existing.matcher, existing.handler)
        : null,
    digestPrefix: definition.digest.slice(0, 12),
    ...approvalHook(definition.event, definition.matcher, definition.handler),
    ...(scriptFiles.length > 0 ? { scriptFiles } : {}),
    ...(proposal.scriptCoverage ? { scriptCoverage: proposal.scriptCoverage } : {}),
  };
}
