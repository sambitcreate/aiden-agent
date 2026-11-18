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

export interface RunApproval {
  mode: ApprovalMode;
  macGrants: ReadonlySet<MacGrantClass>;
}

/**
 * The legacy access for the parts of a run that predate modes (tool lists,
 * ACP agents' native modes, subagent run grants, the system prompt). Full
 * access is exactly "Never ask with shell and files allowed", its old reach;
 * everything else is Ask, so those parts never gain reach from a mode.
 */
export function legacyAccessOf(policy: WorkspaceApprovalPolicy): "full" | "ask" | "none" {
  if (policy.chatOnly) return "none";
  return policy.mode === "never" && policy.macGrants.has("shell") && policy.macGrants.has("files") ? "full" : "ask";
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
): Promise<WorkspaceApprovalPolicy | undefined> {
  const [settings, workspace] = await Promise.all([ports.getSettings(), ports.getWorkspace(workspaceId)]);
  if (!workspace) return undefined;
  return workspaceApprovalPolicy(workspace, effectiveApprovalMode(settings, true));
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
  return workspaceApprovalPolicy(input.workspace, effectiveApprovalMode(await getSettings(), true));
}
