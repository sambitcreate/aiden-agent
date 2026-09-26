import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { JsonStore, readJson } from "./state.ts";
import { createCliWorkspaceApplication } from "./workspace-application.ts";
import { remoteDaemonCommand } from "./daemon-control.ts";
import { acquireLease } from "./state.ts";

export type AccessTier = "full" | "ask" | "none";
export interface CliWorkspace { id: string; name: string; folderPath: string; access: AccessTier; scratch?: boolean; createdAt?: number; updatedAt?: number; memoryEnabled?: boolean; managedWorktree?: import("../../../main/services/types.js").ManagedWorktree; }
export const workspaceId = (folder: string) => `cli-${createHash("sha256").update(folder).digest("hex").slice(0, 24)}`;
export const workspaceStore = (agentDir: string) => new JsonStore<CliWorkspace[]>(join(agentDir, "workspaces.json"), []);
export function accessFor(agentDir: string, cwd: string): AccessTier {
  const canonical = realpathSync(cwd);
  const entries = readJson<CliWorkspace[]>(join(agentDir, "workspaces.json"), []);
  const tier = entries.find((entry) => entry.folderPath === canonical)?.access;
  if (tier !== undefined && !["ask", "full", "none"].includes(tier)) throw new Error("Invalid workspace access tier.");
  return tier ?? "ask";
}
export async function workspaceCommand(agentDir: string, args: string[], application?: ReturnType<typeof createCliWorkspaceApplication>["application"]): Promise<unknown> {
  if (!application) {
    try { return await remoteDaemonCommand(agentDir, "workspace", args); }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    const release = acquireLease(join(agentDir, "serve"));
    try {
      return await workspaceCommand(agentDir, args, createCliWorkspaceApplication(agentDir, {
        cancelGeneration: async () => {}, cancelSchedules: async () => {}, resumeSchedules: async () => {},
      }).application);
    } finally { release(); }
  }
  const [action = "list", target, tier] = args;
  const project = (workspace: import("../../../main/services/types.js").Workspace) => ({ ...workspace, folderPath: workspace.folderPath ?? "", access: workspace.permission });
  if (action === "list") return (await application.list()).map(project);
  if (action === "scratch") return project(await application.createScratch());
  if (!target) throw new Error("Usage: workspace list | add <path> | remove <id> | access <id> <full|ask|none> | scratch");
  if (action === "add") return project(await application.createFromFolder(realpathSync(resolve(target))));
  const workspace = (await application.list()).find((entry) => entry.id === target || entry.folderPath === resolve(target));
  if (!workspace) throw new Error("Workspace not found.");
  if (action === "remove") { await application.remove(workspace.id); return project(workspace); }
  if (action !== "access" || !["full", "ask", "none"].includes(tier)) throw new Error("Expected access <id> <full|ask|none>.");
  return project(await application.update(workspace.id, { permission: tier }));
}
