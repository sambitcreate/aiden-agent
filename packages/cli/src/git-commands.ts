import { dirname, join } from "node:path";
import { gitInfo, gitReview, gitBranches, gitWorktrees, GitService, type GitCreatedWorktree } from "../../../main/services/git.js";
import { removeManagedWorktreeDirectory, finalizeManagedWorktreeRemovalManifest } from "../../../main/services/managed-worktree-remover.js";
import { JsonStore } from "./state.ts";
import { listWorkspaceFiles, readWorkspaceFile } from "../../../main/services/workspace-files.js";

export async function filesCommand(cwd: string, args: string[]) {
  if (args.length === 0 || (args.length === 1 && args[0] === "list")) return listWorkspaceFiles(cwd);
  if (args[0] === "read" && args.length === 2) return readWorkspaceFile(cwd, args[1]);
  throw new Error("Usage: files list | read <relative-path>");
}

interface ManagedWorktree { repository: string; created: GitCreatedWorktree; }
export function createCliGitService() {
  const binary = join(dirname(process.env.AIDEN_CLI_ENTRY!), "native", "aiden-worktree-remover");
  return new GitService({ worktreeDirectoryRemover: (identity) => removeManagedWorktreeDirectory(identity, binary), worktreeRemovalManifestFinalizer: (path, digest) => finalizeManagedWorktreeRemovalManifest(path, digest, binary) });
}
export async function gitCommand(cwd: string, args: string[]) {
  if (args.length > 1) throw new Error("Usage: git status | review | branches | worktrees");
  switch (args[0] ?? "status") {
    case "status": return gitInfo(cwd);
    case "review": return gitReview(cwd);
    case "branches": return gitBranches(cwd);
    case "worktrees": return gitWorktrees(cwd);
    default: throw new Error("Usage: git status | review | branches | worktrees");
  }
}
export async function worktreeCommand(agentDir: string, cwd: string, args: string[]) {
  const git = createCliGitService();
  const store = new JsonStore<ManagedWorktree[]>(join(agentDir, "managed-worktrees.json"), []);
  if ((args[0] ?? "list") === "list") return store.load();
  if (args[0] === "create" && args[1]) {
    return store.update(async (entries) => {
      const created = await git.createWorktree(cwd, join(agentDir, "worktrees"), args[1]);
      entries.push({ repository: cwd, created });
      return created;
    });
  }
  if (args[0] === "remove" && args[1]) {
    return store.update(async (entries) => {
      const index = entries.findIndex((entry) => entry.created.path === args[1]);
      if (index < 0) throw new Error("Only CLI-managed worktrees can be removed.");
      const { repository, created } = entries[index];
      await git.deleteManagedWorktree(repository, created.path, created.branch!, created.createdFromHead, undefined, created.worktreeGitDir, created.ownershipToken, created.worktreeDevice, created.worktreeInode);
      entries.splice(index, 1);
      return { removed: created.path };
    });
  }
  throw new Error("Usage: worktree list | create <branch> | remove <managed-path>");
}
