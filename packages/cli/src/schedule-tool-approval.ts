import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { accessFor, type CliWorkspace } from "./workspaces.ts";
import { readJson } from "./state.ts";

export interface ScheduleToolApproval {
  cwd: string;
  action: string;
  input: { id?: string; workspaceId?: string };
  snapshot: string;
  expiresAt: number;
  approvalFile: string;
}

export const isScheduleMutation = (action: unknown): boolean =>
  action === "save" || action === "pause" || action === "resume" || action === "remove";

function folderIdentity(folder: string) {
  const canonical = realpathSync(folder), stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error("The scheduled workspace is not a folder.");
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

/** Captured before consent and checked synchronously at the durable publication boundary. */
export function scheduleApprovalSnapshot(agentDir: string, approval: Pick<ScheduleToolApproval, "cwd" | "action" | "input">, includeTask = true): string {
  const access = accessFor(agentDir, approval.cwd);
  if (access === "none") throw new Error("Workspace tool access is disabled.");
  const tasks = readJson<Array<{ id?: string; workspaceId?: string }>>(join(agentDir, "schedules.json"), []);
  const task = approval.input.id === undefined ? undefined : tasks.find(({ id }) => id === approval.input.id);
  if (approval.input.id !== undefined && !task) throw new Error("The scheduled task no longer exists.");
  const workspaceId = approval.action === "save" ? approval.input.workspaceId : task?.workspaceId;
  const workspace = readJson<CliWorkspace[]>(join(agentDir, "workspaces.json"), []).find(({ id }) => id === workspaceId);
  if (!workspace?.folderPath || workspace.access === "none") throw new Error("Choose an available scheduled workspace.");
  const providerConfiguration = createHash("sha256").update(JSON.stringify([
    readJson(join(agentDir, "models.json"), {}), readJson(join(agentDir, "models-store.json"), {}),
  ])).digest("hex");
  return JSON.stringify({ caller: folderIdentity(approval.cwd), access, workspace, folder: folderIdentity(workspace.folderPath), providerConfiguration,
    ...(includeTask ? { task: task ?? null } : {}) });
}

export function assertScheduleApproval(agentDir: string, approval: ScheduleToolApproval, firstWrite = true): void {
  if (!Number.isFinite(approval.expiresAt) || Date.now() >= approval.expiresAt || !isScheduleMutation(approval.action)) {
    throw new Error("Scheduled-task approval expired. Review the task again.");
  }
  if (!approval.approvalFile || readJson(approval.approvalFile, null) !== approval.snapshot) {
    throw new Error("Scheduled-task approval was cancelled. Review the task again.");
  }
  const expected = JSON.parse(approval.snapshot) as Record<string, unknown>;
  if (!firstWrite) delete expected.task;
  if (scheduleApprovalSnapshot(agentDir, approval, firstWrite) !== JSON.stringify(expected)) {
    throw new Error("Scheduled workspace, provider or task changed after approval. Review it again.");
  }
}
