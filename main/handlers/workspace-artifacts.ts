// Workspace artifact IPC. The renderer names a workspace and an artifact by
// id; every value is parsed here, and only main reads or writes the files.

import {
  isWorkspaceArtifactId,
  isWorkspaceArtifactName,
  isWorkspaceArtifactWorkspaceId,
  WORKSPACE_ARTIFACT_LIMITS,
  type WorkspaceArtifactsChangedEvent,
} from "../../renderer/shared/workspace-artifacts.js";
import type { WorkspaceArtifactRunContext, WorkspaceArtifactRunner } from "../services/workspace-artifacts/runner.js";
import type { WorkspaceArtifactStore } from "../services/workspace-artifacts/store.js";
import { parseUiVisualState } from "./chat-ui-visual-state.js";

export const WORKSPACE_ARTIFACT_CHANNELS = {
  list: "workspaces:artifacts:list",
  rename: "workspaces:artifacts:rename",
  delete: "workspaces:artifacts:delete",
  saveState: "workspaces:artifacts:saveState",
  approve: "workspaces:artifacts:approve",
  refresh: "workspaces:artifacts:refresh",
  run: "workspaces:artifacts:run",
} as const;

export interface WorkspaceArtifactHandlerDependencies {
  handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void;
  store: Pick<WorkspaceArtifactStore, "list" | "rename" | "delete" | "saveState" | "approve">;
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  notify: (event: WorkspaceArtifactsChangedEvent) => void;
  runner: Pick<WorkspaceArtifactRunner, "refresh" | "runAction">;
  /**
   * Resolves the workspace's folder for the calling window (realpath, access
   * checked) and runs `operation` while the window owns it.
   */
  runInWorkspace: <T>(
    event: unknown,
    workspaceId: string,
    operation: (context: WorkspaceArtifactRunContext, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

function asWorkspaceId(value: unknown): string {
  if (!isWorkspaceArtifactWorkspaceId(value)) throw new Error("The workspace identifier is invalid.");
  return value;
}

function asArtifactId(value: unknown): string {
  if (!isWorkspaceArtifactId(value)) throw new Error("The artifact identifier is invalid.");
  return value;
}

function asText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}

export function registerWorkspaceArtifactHandlers(dependencies: WorkspaceArtifactHandlerDependencies): void {
  const { handle, store, notify } = dependencies;

  async function existingWorkspace(value: unknown): Promise<string> {
    const id = asWorkspaceId(value);
    if (!(await dependencies.workspaceExists(id))) throw new Error("That workspace no longer exists.");
    return id;
  }

  handle(WORKSPACE_ARTIFACT_CHANNELS.list, async (_event, workspaceId) => store.list(await existingWorkspace(workspaceId)));

  handle(WORKSPACE_ARTIFACT_CHANNELS.rename, async (_event, workspaceId, artifactId, title) => {
    const workspace = await existingWorkspace(workspaceId);
    const artifact = await store.rename(workspace, asArtifactId(artifactId), asText(title, "title", 200));
    notify({ workspaceId: workspace, artifactId: artifact.id, reason: "updated" });
    return artifact;
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.delete, async (_event, workspaceId, artifactId) => {
    const workspace = await existingWorkspace(workspaceId);
    const id = asArtifactId(artifactId);
    const removed = await store.delete(workspace, id);
    if (removed) notify({ workspaceId: workspace, artifactId: id, reason: "deleted" });
    return { removed };
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.saveState, async (_event, workspaceId, artifactId, state) => {
    const workspace = await existingWorkspace(workspaceId);
    // State saves are frequent and local to the page, so they notify nobody.
    await store.saveState(workspace, asArtifactId(artifactId), parseUiVisualState(state));
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.approve, async (_event, workspaceId, artifactId, digest) => {
    const workspace = await existingWorkspace(workspaceId);
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid approval.");
    const artifact = await store.approve(workspace, asArtifactId(artifactId), digest);
    notify({ workspaceId: workspace, artifactId: artifact.id, reason: "updated" });
    return artifact;
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.refresh, async (event, workspaceId, artifactId) => {
    const workspace = await existingWorkspace(workspaceId);
    const id = asArtifactId(artifactId);
    return dependencies.runInWorkspace(event, workspace, (context, signal) =>
      dependencies.runner.refresh(workspace, id, context, signal),
    );
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.run, async (event, workspaceId, artifactId, actionName, args, digest) => {
    const workspace = await existingWorkspace(workspaceId);
    const id = asArtifactId(artifactId);
    if (!isWorkspaceArtifactName(actionName)) throw new Error("Invalid button.");
    if (!Array.isArray(args) || args.length > WORKSPACE_ARTIFACT_LIMITS.params) throw new Error("Invalid button values.");
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid button request.");
    return dependencies.runInWorkspace(event, workspace, (context, signal) =>
      dependencies.runner.runAction(workspace, id, actionName, args, context, signal, digest),
    );
  });
}
