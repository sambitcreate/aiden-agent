// Whether a workspace chat's tool call runs, asks, or is refused, from the
// facts `llm-client.ts` has gathered at the point it decides.
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

/**
 * Today's decision, in the order llm-client applied it inline: hooks, then
 * the approval classes, then remembered scopes. Computer Use and Form Fill
 * reach here only once they are enabled and the chat's Computer Use access
 * was granted (`computer-use/access-gate.ts`).
 */
export function workspaceToolApproval(input: WorkspaceToolApprovalInput): WorkspaceToolApprovalDecision {
  const { toolName, args, permission, hook } = input;
  if (toolName === WORKSPACE_COMPUTER_USE_TOOL) {
    if (hook === "block") return { decision: { outcome: "block", reason: "hook" } };
    if (hook === "ask") return { decision: { outcome: "ask" } };
    return { decision: { outcome: "allow" } };
  }
  if (toolName === WORKSPACE_FORM_FILL_TOOL) {
    if (hook === "block") return { decision: { outcome: "block", reason: "hook" } };
    return { decision: { outcome: "ask" } };
  }
  if (hook === "block") return { decision: { outcome: "block", reason: "hook" } };
  const scheduleApproval =
    (toolName === SCHEDULE_TOOL_NAME && scheduleToolRequiresApproval(args)) ||
    toolName === EDIT_AUTOMATION_TOOL_NAME;
  const workspaceApproval =
    permission === "ask" &&
    (APPROVAL_TOOL_NAMES.has(toolName) ||
      BROWSER_MUTATION_TOOL_NAMES.has(toolName) ||
      deviceToolRequiresApproval(toolName, args) ||
      backgroundJobRequiresApproval(toolName, args));
  const disclosureApproval = DISCLOSURE_APPROVAL_TOOL_NAMES.has(toolName);
  const memoryApproval = toolName === REMEMBER_MEMORY_TOOL_NAME || toolName === FORGET_MEMORY_TOOL_NAME;
  const hookAsk = hook === "ask";
  if (
    !scheduleApproval &&
    !workspaceApproval &&
    !disclosureApproval &&
    !memoryApproval &&
    !input.botMutating &&
    !input.artifactRequired &&
    !input.browserFileRequired &&
    !hookAsk
  ) {
    return { decision: { outcome: "allow" } };
  }
  let ruleTarget: ToolApprovalRuleTarget | undefined;
  if (workspaceApproval && !hookAsk && !input.botBound && APPROVAL_TOOL_NAMES.has(toolName)) {
    ruleTarget = toolApprovalRuleTarget(toolName, args, input.workspaceId);
    if (ruleTarget && hook === "allow") return { decision: { outcome: "allow", via: "hook-allow" } };
    if (ruleTarget && input.remembered) return { decision: { outcome: "allow", via: "remembered" } };
  }
  if (memoryApproval) return { decision: { outcome: "memory" } };
  return {
    decision: { outcome: "ask", ...(ruleTarget ? { ruleTarget } : {}) },
    ...(ruleTarget && input.remembered === undefined ? { readsRemembered: ruleTarget } : {}),
  };
}
