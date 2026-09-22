import type { Workspace } from "./types.js";
import type {
  WorkspaceOperationDocumentOwner,
  workspaceOperationRegistry,
} from "./workspace-operation-registry.js";
import { admitOwnedWorkspaceOperation } from "./workspace-operation-registry.js";
import type { workspaceMutationGate } from "./workspace-mutation-gate.js";

export interface WorkspaceEnvironmentDirectory {
  folderPath: string;
  workspace: Workspace;
}

export interface WorkspaceEnvironmentApplicationDependencies {
  configStore: {
    getWorkspace(id: string): Promise<Workspace | undefined>;
  };
  workspaceMutationGate: Pick<typeof workspaceMutationGate, "isChanging">;
  workspaceOperationRegistry: Pick<typeof workspaceOperationRegistry, "admit">;
  assertManagedWorktreeAdmission(workspace: Workspace): Promise<void>;
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<{ isDirectory(): boolean }>;
}

function workspaceId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("The workspace identifier is invalid.");
  }
  return value;
}

/**
 * Shared ownership and persisted-workspace resolution for renderer and remote
 * Files/Git operations. Transport callers never supply a filesystem path.
 */
export function createWorkspaceEnvironmentApplicationService(
  dependencies: WorkspaceEnvironmentApplicationDependencies,
) {
  const resolve = async (
    workspaceIdValue: string,
    required: boolean,
    allowNoAccess = false,
  ): Promise<WorkspaceEnvironmentDirectory | undefined> => {
    const id = workspaceId(workspaceIdValue);
    const workspace = await dependencies.configStore.getWorkspace(id);
    if (!workspace) throw new Error(`Workspace ${id} was not found.`);
    if (workspace.permission === "none" && !allowNoAccess) {
      if (!required) return undefined;
      throw new Error(`${workspace.name} does not allow local file access.`);
    }
    if (!workspace.folderPath) {
      if (!required) return undefined;
      throw new Error(`${workspace.name} does not have a folder.`);
    }
    await dependencies.assertManagedWorktreeAdmission(workspace);
    try {
      const folderPath = await dependencies.realpath(workspace.folderPath);
      const stats = await dependencies.stat(folderPath);
      if (!stats.isDirectory()) throw new Error("not a directory");
      return { folderPath, workspace };
    } catch {
      if (!required) return undefined;
      throw new Error(`${workspace.name}'s folder is no longer available.`);
    }
  };

  const run = async <T>(
    owner: WorkspaceOperationDocumentOwner,
    workspaceIdValue: string,
    operation: (
      resolved: WorkspaceEnvironmentDirectory,
      signal: AbortSignal,
    ) => Promise<T>,
    options: { allowNoAccess?: boolean } = {},
  ): Promise<T> => {
    const id = workspaceId(workspaceIdValue);
    if (dependencies.workspaceMutationGate.isChanging(id)) {
      throw new Error("The workspace is changing. Try again in a moment.");
    }
    const admission = admitOwnedWorkspaceOperation(
      dependencies.workspaceOperationRegistry,
      owner,
      id,
    );
    try {
      const resolved = await resolve(id, true, options.allowNoAccess === true);
      if (
        !resolved ||
        owner.isDestroyed() ||
        admission.signal.aborted ||
        dependencies.workspaceMutationGate.isChanging(id)
      ) {
        throw new Error("The workspace changed before the operation could start.");
      }
      return await operation(resolved, admission.signal);
    } finally {
      admission.release();
    }
  };

  const runRecord = async <T>(
    owner: WorkspaceOperationDocumentOwner,
    workspaceIdValue: string,
    operation: (workspace: Workspace, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const id = workspaceId(workspaceIdValue);
    if (dependencies.workspaceMutationGate.isChanging(id)) {
      throw new Error("The workspace is changing. Try again in a moment.");
    }
    const admission = admitOwnedWorkspaceOperation(
      dependencies.workspaceOperationRegistry,
      owner,
      id,
    );
    try {
      const workspace = await dependencies.configStore.getWorkspace(id);
      if (
        !workspace ||
        owner.isDestroyed() ||
        admission.signal.aborted ||
        dependencies.workspaceMutationGate.isChanging(id)
      ) {
        throw new Error("The workspace changed before the operation could start.");
      }
      return await operation(workspace, admission.signal);
    } finally {
      admission.release();
    }
  };

  const runOptional = async <T>(
    owner: WorkspaceOperationDocumentOwner,
    workspaceIdValue: string,
    operation: (
      resolved: WorkspaceEnvironmentDirectory | undefined,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> => runRecord(owner, workspaceIdValue, async (_workspace, signal) => {
    const resolved = await resolve(workspaceIdValue, false);
    if (signal.aborted || dependencies.workspaceMutationGate.isChanging(workspaceIdValue)) {
      throw new Error("The workspace changed before the operation could start.");
    }
    return operation(resolved, signal);
  });

  return { resolve, run, runRecord, runOptional };
}

export type WorkspaceEnvironmentApplicationService = ReturnType<
  typeof createWorkspaceEnvironmentApplicationService
>;
