// A workspace chat's tool call through the approval gate, from the facts
// `llm-client.ts` has gathered at the point it decides.
//
// The caller keeps every side effect: running PreToolUse hooks, preparing
// artifact, browser-file, schedule and Form Fill reviews, reading remembered
// approvals and publishing the card. This module only decides.

import { APPROVAL_TOOL_NAMES, DISCLOSURE_APPROVAL_TOOL_NAMES } from "../coding-tools.js";
import { BROWSER_MUTATION_TOOL_NAMES } from "../browser-tools.js";
import { deviceToolRequiresApproval } from "../devices/device-tools.js";
import { backgroundJobRequiresApproval } from "../follow-through/background-job-tool.js";
import { FORGET_MEMORY_TOOL_NAME, REMEMBER_MEMORY_TOOL_NAME } from "../memory-context.js";
import {
  EDIT_AUTOMATION_TOOL_NAME,
  SCHEDULE_TOOL_NAME,
  scheduleToolRequiresApproval,
} from "../schedule-tool.js";
import { toolApprovalRuleTarget, type ToolApprovalRuleTarget } from "../tool-approval-rules.js";
import { planActionGate, type GateAction, type GateContext } from "./gate.js";

/** Aiden's own names for the two tools that drive the Mac's screen. */
export const WORKSPACE_COMPUTER_USE_TOOL = "computer_use";
export const WORKSPACE_FORM_FILL_TOOL = "form_fill";

export type WorkspaceGatePermission = "full" | "ask" | "read-only" | "none";

export interface WorkspaceToolApprovalInput {
  toolName: string;
  args: unknown;
  /** The generation's workspace access. */
  permission: WorkspaceGatePermission;
  /** The PreToolUse hooks' verdict, when a hook answered. */
  hook?: "block" | "ask" | "allow";
  /** A legacy Bot-bound turn: its authority is policy-owned and never remembered. */
  botBound?: boolean;
  /** A Bot-bound turn's mutating connection tool. */
  botMutating?: boolean;
  /** `workspaceArtifactCallApproval` said this artifact call needs a card. */
  artifactRequired?: boolean;
  /** The browser's local-file review said this document needs a card. */
  browserFileRequired?: boolean;
  workspaceId?: string;
  /**
   * A remembered approval for this exact target, read only when
   * `workspaceToolApproval(...).readsRemembered` said so.
   */
  remembered?: "chat" | "always";
}

export type WorkspaceToolApproval =
  | { outcome: "block"; reason: "hook" }
  | { outcome: "allow"; via?: "remembered" | "hook-allow" }
  /** Memory proposals and removals go to the memory policy, which may show its own card. */
  | { outcome: "memory" }
  | {
      outcome: "ask";
      /** Remembered scopes the card offers (`SCOPED_APPROVAL_OFFER`) for this target. */
      ruleTarget?: ToolApprovalRuleTarget;
    };

export interface WorkspaceToolApprovalDecision {
  decision: WorkspaceToolApproval;
  /** The remembered-approval target to read before deciding again, when one applies. */
  readsRemembered?: ToolApprovalRuleTarget;
}

const HOOK_VERDICTS = { block: "deny", ask: "ask", allow: "allow" } as const;

/** The gate's facts for one workspace tool call, from today's fixed tool sets. */
export function workspaceGateAction(input: WorkspaceToolApprovalInput): GateAction {
  const { toolName, args } = input;
  if (toolName === WORKSPACE_COMPUTER_USE_TOOL) {
    // Reached only once the chat's Computer Use access was granted.
    return { toolName, mac: true, consequential: true, granted: true };
  }
  const consequential =
    APPROVAL_TOOL_NAMES.has(toolName) ||
    BROWSER_MUTATION_TOOL_NAMES.has(toolName) ||
    deviceToolRequiresApproval(toolName, args) ||
    backgroundJobRequiresApproval(toolName, args);
  const explicitOnly =
    toolName === WORKSPACE_FORM_FILL_TOOL ||
    (toolName === SCHEDULE_TOOL_NAME && scheduleToolRequiresApproval(args)) ||
    toolName === EDIT_AUTOMATION_TOOL_NAME ||
    DISCLOSURE_APPROVAL_TOOL_NAMES.has(toolName) ||
    input.botMutating === true ||
    input.artifactRequired === true ||
    input.browserFileRequired === true;
  const memory = toolName === REMEMBER_MEMORY_TOOL_NAME || toolName === FORGET_MEMORY_TOOL_NAME;
  // Only the parent's plain workspace tools can be remembered, and never for
  // Bot-bound turns whose authority is policy-owned.
  const ruleTarget = !input.botBound && APPROVAL_TOOL_NAMES.has(toolName)
    ? toolApprovalRuleTarget(toolName, args, input.workspaceId)
    : undefined;
  return {
    toolName,
    ...(consequential ? { consequential: true } : {}),
    ...(explicitOnly ? { explicitOnly: true } : {}),
    ...(memory ? { delegate: "memory" as const } : {}),
    ...(ruleTarget ? { rememberable: true } : {}),
    ...(ruleTarget && input.remembered ? { remembered: input.remembered } : {}),
  };
}

/**
 * Whether a workspace chat's tool call runs, asks or is refused, decided by
 * `planActionGate`. Computer Use and Form Fill reach here only once they are
 * enabled and the chat's Computer Use access was granted
 * (`computer-use/access-gate.ts`).
 */
export function workspaceToolApproval(input: WorkspaceToolApprovalInput): WorkspaceToolApprovalDecision {
  const context: GateContext = {
    surface: "workspace",
    access: input.permission,
    ...(input.hook ? { hook: HOOK_VERDICTS[input.hook] } : {}),
  };
  const action = workspaceGateAction(input);
  const decision = planActionGate(context, action);
  const ruleTarget = action.rememberable
    ? toolApprovalRuleTarget(input.toolName, input.args, input.workspaceId)
    : undefined;
  switch (decision.outcome) {
    case "block":
      return { decision: { outcome: "block", reason: "hook" } };
    case "delegate":
      return { decision: { outcome: "memory" } };
    case "lookup":
      // Until the remembered approval is read, the call would ask with scopes.
      return { decision: { outcome: "ask", ...(ruleTarget ? { ruleTarget } : {}) }, ...(ruleTarget ? { readsRemembered: ruleTarget } : {}) };
    case "ask":
      return { decision: { outcome: "ask", ...(decision.offer === "workspace-scopes" && ruleTarget ? { ruleTarget } : {}) } };
    case "allow":
      return {
        decision: {
          outcome: "allow",
          ...(decision.via === "remembered" || decision.via === "hook-allow" ? { via: decision.via } : {}),
        },
      };
    case "hand-off":
      // Workspace chats have no hand-off rules; refuse rather than run.
      return { decision: { outcome: "block", reason: "hook" } };
  }
}
