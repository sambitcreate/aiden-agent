// A workspace run's approval policy under the global mode (§3.1), and the
// legacy access every part of a run that predates modes still reads.

import {
  effectiveApprovalMode,
  workspaceApprovalPatch,
  workspaceApprovalPolicy,
  type ApprovalMode,
  type ApprovalModeSettings,
  type MacGrantClass,
  type WorkspaceApprovalPolicy,
} from "../../../renderer/shared/approval-mode.js";
import type { AppSettings, Workspace } from "../types.js";

/**
 * The legacy access for the parts of a run that predate modes (tool lists,
 * ACP agents' native modes, subagent run grants, the system prompt). Full
 * access is exactly "Never ask with shell and files allowed", its old reach;
 * everything else is Ask, so those parts never gain reach from a mode.
 */
/**
 * Whether a run's Auto judge may decide a call. An ACP agent's run has no model
 * Aiden can ask, and a run answering a tainted lead may not pass a call on the
 * lead's word (Phase 5), so either shows the card instead.
 */
export function runJudgeAvailable(input: { harnessProvider: boolean; leadRequestTrusted: boolean }): boolean {
  return !input.harnessProvider && input.leadRequestTrusted;
}

export function legacyAccessOf(policy: WorkspaceApprovalPolicy): "full" | "ask" | "none" {
  if (policy.chatOnly) return "none";
  return policy.mode === "never" && policy.macGrants.has("shell") && policy.macGrants.has("files") ? "full" : "ask";
}

/**
 * The most a lead chat lets a chat it started do (Phase 5, D2): its approval
 * mode, its Mac grants and whether it could reach the folder at all, taken
 * when it started the chat. A started chat runs under the stricter of this and
 * its own workspace's policy.
 */
export interface ApprovalCeiling {
  mode: ApprovalMode;
  macGrants: readonly MacGrantClass[];
  chatOnly: boolean;
}

/** Ask is the strictest mode, Never ask the most permissive. */
const MODE_STRICTNESS: Readonly<Record<ApprovalMode, number>> = { ask: 0, auto: 1, never: 2 };

/** The ceiling a lead's policy puts on the chats it starts. */
export function approvalCeilingOf(policy: WorkspaceApprovalPolicy): ApprovalCeiling {
  return { mode: policy.mode, macGrants: [...policy.macGrants], chatOnly: policy.chatOnly };
}

/**
 * Both ceilings at once: the stricter mode, only the Mac grants both allow,
 * and Chat only if either is. Without `other`, `ceiling` is unchanged.
 */
export function narrowApprovalCeiling(ceiling: ApprovalCeiling, other: ApprovalCeiling | undefined): ApprovalCeiling {
  if (!other) return ceiling;
  const allowed = new Set(other.macGrants);
  return {
    mode: MODE_STRICTNESS[other.mode] < MODE_STRICTNESS[ceiling.mode] ? other.mode : ceiling.mode,
    macGrants: ceiling.macGrants.filter((grant) => allowed.has(grant)),
    chatOnly: ceiling.chatOnly || other.chatOnly,
  };
}

/**
 * `policy` held under `ceiling`: the stricter mode, only the Mac grants both
 * allow, and Chat only if either is. Without a ceiling the policy is unchanged.
 */
export function withApprovalCeiling(
  policy: WorkspaceApprovalPolicy,
  ceiling: ApprovalCeiling | undefined,
): WorkspaceApprovalPolicy {
  if (!ceiling) return policy;
  const mode = MODE_STRICTNESS[ceiling.mode] < MODE_STRICTNESS[policy.mode] ? ceiling.mode : policy.mode;
  const allowed = new Set(ceiling.macGrants);
  const macGrants = new Set([...policy.macGrants].filter((grant) => allowed.has(grant)));
  const chatOnly = policy.chatOnly || ceiling.chatOnly;
  const legacyFull = policy.legacyFull && mode === "never" && macGrants.has("shell") && macGrants.has("files") && !chatOnly;
  return { ...policy, mode, macGrants, chatOnly, legacyFull };
}

export interface RunApprovalPorts {
  getSettings(): Promise<Pick<AppSettings, "approvalMode">>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
}

/**
 * The workspace's policy now, read fresh before every decision, so a mode
 * change or a removed grant applies to the next call of a running reply.
 * A run always has a model, so Auto is available to it.
 */
export async function currentWorkspaceApproval(
  ports: RunApprovalPorts,
  workspaceId: string,
  /** A started chat's ceiling, applied again on every read so a mode change can't lift it. */
  ceiling?: ApprovalCeiling,
): Promise<WorkspaceApprovalPolicy | undefined> {
  const [settings, workspace] = await Promise.all([ports.getSettings(), ports.getWorkspace(workspaceId)]);
  if (!workspace) return undefined;
  return withApprovalCeiling(workspaceApprovalPolicy(workspace, effectiveApprovalMode(settings, true)), ceiling);
}

/** The workspace after "Allow in this workspace" on a Mac card. */
export function workspaceWithMacGrant(workspace: Workspace, grant: MacGrantClass): Workspace {
  const patch = workspaceApprovalPatch(workspace, { grantMac: grant });
  const next: Workspace = { ...workspace, ...(patch.permission ? { permission: patch.permission } : {}) };
  if (patch.approvalMode) next.approvalMode = patch.approvalMode;
  else delete next.approvalMode;
  if (patch.macGrants) next.macGrants = patch.macGrants;
  else delete next.macGrants;
  return next;
}

export interface GenerationApprovalInput {
  /** The run's workspace, when it has one. */
  workspace: Workspace | undefined;
  /** The run speaks for a Bot, which keeps its own grants. */
  botBound: boolean;
  /** The chat turn's mode; every Assistant mode keeps its own access. */
  mode: "assistant" | "assistant-unattended" | "assistant-automation" | undefined;
  /** An access a main-owned caller set for the run (scheduled runs). */
  permission: string | undefined;
  /** The ceiling of a chat another chat started, when this run is in one. */
  ceiling?: ApprovalCeiling;
}

/**
 * The approval policy a generation runs under, or `undefined` when it keeps
 * its legacy access instead (plan §3.1). A person's workspace chat follows
 * the global approval mode, or the workspace's own when it is customized.
 * Internal policies (scheduled runs), Bot-bound turns and the Assistant keep
 * their access. Settings are read only when the mode applies.
 */
export async function generationApprovalPolicy(
  input: GenerationApprovalInput,
  getSettings: () => Promise<ApprovalModeSettings>,
): Promise<WorkspaceApprovalPolicy | undefined> {
  if (!input.workspace || input.botBound || input.mode !== undefined || input.permission !== undefined) return undefined;
  return withApprovalCeiling(
    workspaceApprovalPolicy(input.workspace, effectiveApprovalMode(await getSettings(), true)),
    input.ceiling,
  );
}
