// Workspace artifact IPC. The renderer names a workspace and an artifact by
// id; every value is parsed here, and only main reads or writes the files.

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import {
  isWorkspaceArtifactId,
  isWorkspaceArtifactWorkspaceId,
} from "../../renderer/shared/workspace-artifacts.js";
import {
  notifyWorkspaceArtifactsChanged,
  workspaceArtifactStore,
} from "../services/workspace-artifacts/main.js";
import { parseUiVisualState } from "./chat-ui-visual-state.js";

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

async function existingWorkspace(value: unknown): Promise<string> {
  const id = asWorkspaceId(value);
  if (!(await configStore.getWorkspace(id))) throw new Error("That workspace no longer exists.");
  return id;
}

export function registerWorkspaceArtifactHandlers(): void {
  ipcMain.handle("workspaces:artifacts:list", async (_event, workspaceId: unknown) =>
    workspaceArtifactStore.list(await existingWorkspace(workspaceId)),
  );

  ipcMain.handle(
    "workspaces:artifacts:rename",
    async (_event, workspaceId: unknown, artifactId: unknown, title: unknown) => {
      const workspace = await existingWorkspace(workspaceId);
      const artifact = await workspaceArtifactStore.rename(workspace, asArtifactId(artifactId), asText(title, "title", 200));
      notifyWorkspaceArtifactsChanged({ workspaceId: workspace, artifactId: artifact.id, reason: "updated" });
      return artifact;
    },
  );

  ipcMain.handle("workspaces:artifacts:delete", async (_event, workspaceId: unknown, artifactId: unknown) => {
    const workspace = await existingWorkspace(workspaceId);
    const id = asArtifactId(artifactId);
    const removed = await workspaceArtifactStore.delete(workspace, id);
    if (removed) notifyWorkspaceArtifactsChanged({ workspaceId: workspace, artifactId: id, reason: "deleted" });
    return { removed };
  });

  ipcMain.handle(
    "workspaces:artifacts:saveState",
    async (_event, workspaceId: unknown, artifactId: unknown, state: unknown) => {
      const workspace = await existingWorkspace(workspaceId);
      // State saves are frequent and local to the page, so they notify nobody.
      await workspaceArtifactStore.saveState(workspace, asArtifactId(artifactId), parseUiVisualState(state));
    },
  );

  ipcMain.handle(
    "workspaces:artifacts:approve",
    async (_event, workspaceId: unknown, artifactId: unknown, digest: unknown) => {
      const workspace = await existingWorkspace(workspaceId);
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid approval.");
      const artifact = await workspaceArtifactStore.approve(workspace, asArtifactId(artifactId), digest);
      notifyWorkspaceArtifactsChanged({ workspaceId: workspace, artifactId: artifact.id, reason: "updated" });
      return artifact;
    },
  );
}
