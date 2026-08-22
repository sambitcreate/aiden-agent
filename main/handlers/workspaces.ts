// Workspace CRUD + folder helpers (git status, reveal in Finder).

import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { BrowserWindow, dialog, ipcMain, shell } from "../platform.js";
import { listExternalEditors, openFolderInExternalEditor } from "../services/external-editors.js";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCompare,
  gitComparisonDiff,
  gitCreateBranch,
  gitDiff,
  gitInfo,
  gitPush,
  gitPushCapability,
  gitReview,
  gitWorktrees,
  type GitCommitInput,
  type GitComparisonDiffInput,
  type GitDiffInput,
  type GitPushInput,
} from "../services/git.js";
import { workspaceApplicationService } from "../services/workspace-application-service-main.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
} from "../services/workspace-files.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { parseWorktreeCreateParams } from "./worktree-create-params.js";
import { workspaceEnvironmentApplicationService } from "../services/workspace-environment-application-service-main.js";
import type { WorkspaceEnvironmentDirectory } from "../services/workspace-environment-application-service.js";
import { workspaceWorktreeApplicationService } from "../services/workspace-worktree-application-service-main.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function asText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected text for "${name}".`);
  return value;
}

function asGitCommitInput(value: unknown): GitCommitInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const mode = input.mode;
  if (mode !== "staged" && mode !== "all") {
    throw new Error('Expected "mode" to be "staged" or "all".');
  }
  return {
    expectedSnapshot: asString(input.expectedSnapshot, "expectedSnapshot"),
    message: asText(input.message, "message"),
    mode,
  };
}

function asGitDiffInput(value: unknown): GitDiffInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    expectedSnapshot: asString(input.expectedSnapshot, "expectedSnapshot"),
    path: asString(input.path, "path"),
  };
}

function asGitPushInput(value: unknown): GitPushInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (typeof input.setUpstream !== "boolean") throw new Error('Expected boolean "setUpstream".');
  return {
    destinationBranch: asString(input.destinationBranch, "destinationBranch"),
    expectedBranch: asString(input.expectedBranch, "expectedBranch"),
    expectedHead: asString(input.expectedHead, "expectedHead"),
    expectedRemoteIdentity: asString(input.expectedRemoteIdentity, "expectedRemoteIdentity"),
    remote: asString(input.remote, "remote"),
    setUpstream: input.setUpstream,
  };
}

function asGitComparisonDiffInput(value: unknown): GitComparisonDiffInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    expectedHead: asString(input.expectedHead, "expectedHead"),
    expectedTarget: asString(input.expectedTarget, "expectedTarget"),
    mergeBase: asString(input.mergeBase, "mergeBase"),
    path: asString(input.path, "path"),
    targetRef: asString(input.targetRef, "targetRef"),
  };
}

async function withWorkspaceOperation<T>(
  event: IpcMainInvokeEvent,
  workspaceIdValue: unknown,
  operation: (resolved: WorkspaceEnvironmentDirectory, signal: AbortSignal) => Promise<T>,
  allowNoAccess = false,
): Promise<T> {
  const owner = rendererDocumentOwner(
    event,
    () => new Error("Workspace access requires the active renderer document."),
  );
  return workspaceEnvironmentApplicationService.run(
    owner,
    asString(workspaceIdValue, "workspaceId"),
    operation,
    { allowNoAccess },
  );
}

async function withOptionalWorkspaceOperation<T>(
  event: IpcMainInvokeEvent,
  workspaceIdValue: unknown,
  operation: (resolved: WorkspaceEnvironmentDirectory | undefined, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const owner = rendererDocumentOwner(
    event,
    () => new Error("Workspace access requires the active renderer document."),
  );
  return workspaceEnvironmentApplicationService.runOptional(
    owner,
    asString(workspaceIdValue, "workspaceId"),
    operation,
  );
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle("workspaces:list", async () => workspaceApplicationService.list());

  ipcMain.handle(
    "workspaces:get",
    async (_event, id: unknown) => workspaceApplicationService.get(asString(id, "id")),
  );

  ipcMain.handle("workspaces:create", async (_event, input: unknown) =>
    workspaceApplicationService.create(input),
  );

  ipcMain.handle("workspaces:createFromFolder", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return workspaceApplicationService.createFromFolder(result.filePaths[0]);
  });

  ipcMain.handle("workspaces:createScratch", async () =>
    workspaceApplicationService.createScratch(),
  );

  ipcMain.handle("workspaces:update", async (_event, id: unknown, patch: unknown) =>
    workspaceApplicationService.update(asString(id, "id"), patch),
  );

  ipcMain.handle("workspaces:remove", async (_event, id: unknown) =>
    workspaceApplicationService.remove(asString(id, "id")),
  );

  ipcMain.handle("workspaces:gitInfo", async (event, workspaceId: unknown) =>
    withOptionalWorkspaceOperation(event, workspaceId, async (resolved, signal) =>
      resolved ? gitInfo(resolved.folderPath, signal) : { isRepo: false },
    ),
  );

  // ── Environment panel: Files + Review ────────────────────────────────
  ipcMain.handle("workspaces:files", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      listWorkspaceFiles(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("workspaces:readFile", async (event, workspaceId: unknown, filePath: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      readWorkspaceFile(resolved.folderPath, asString(filePath, "path"), signal),
    ),
  );

  ipcMain.handle(
    "workspaces:writeFile",
    async (
      event,
      workspaceId: unknown,
      filePath: unknown,
      content: unknown,
      expectedVersion: unknown,
    ) =>
      withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
        writeWorkspaceFile(
          resolved.folderPath,
          asString(filePath, "path"),
          asText(content, "content"),
          asString(expectedVersion, "expectedVersion"),
          signal,
        ).then(
          (document) => ({ ok: true as const, document }),
          (error: unknown) => ({
            ok: false as const,
            code: error instanceof WorkspaceFileError ? error.code : ("io_error" as const),
            message: error instanceof Error ? error.message : "Aiden could not save this file.",
          }),
        ),
      ),
  );

  ipcMain.handle("git:review", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitReview(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("git:diff", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitDiff(resolved.folderPath, asGitDiffInput(input), signal),
    ),
  );

  ipcMain.handle("git:commit", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCommit(resolved.folderPath, asGitCommitInput(input), signal),
    ),
  );

  ipcMain.handle("git:pushCapability", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitPushCapability(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("git:push", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitPush(resolved.folderPath, asGitPushInput(input), signal),
    ),
  );

  ipcMain.handle("git:compare", async (event, workspaceId: unknown, targetRef: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCompare(resolved.folderPath, asString(targetRef, "targetRef"), signal),
    ),
  );

  ipcMain.handle("git:comparisonDiff", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitComparisonDiff(resolved.folderPath, asGitComparisonDiffInput(input), signal),
    ),
  );

  // ── Git branch picker ────────────────────────────────────────────────
  ipcMain.handle("git:branches", async (event, workspaceId: unknown) =>
    withOptionalWorkspaceOperation(event, workspaceId, async (resolved, signal) =>
      resolved
        ? gitBranches(resolved.folderPath, signal)
        : { isRepo: false, branches: [], remoteBranches: [], uncommitted: 0 },
    ),
  );

  ipcMain.handle("git:checkout", async (event, workspaceId: unknown, name: unknown) => {
    await withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCheckout(resolved.folderPath, asString(name, "name"), signal),
    );
  });

  ipcMain.handle("git:createBranch", async (event, workspaceId: unknown, name: unknown) => {
    await withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCreateBranch(resolved.folderPath, asString(name, "name"), signal),
    );
  });

  ipcMain.handle("git:worktrees", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitWorktrees(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("git:createWorktree", async (event, workspaceId: unknown, name: unknown) => {
    const { workspaceId: sourceWorkspaceId, branch } = parseWorktreeCreateParams(
      workspaceId,
      name,
    );
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Workspace access requires the active renderer document."),
    );
    return workspaceWorktreeApplicationService.create(owner, sourceWorkspaceId, branch);
  });

  ipcMain.handle("git:deleteManagedWorktree", async (event, workspaceId: unknown) => {
    const id = asString(workspaceId, "workspaceId");
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Workspace access requires the active renderer document."),
    );
    return workspaceWorktreeApplicationService.remove(owner, id);
  });

  // Reveal the workspace folder in Finder. shell.openPath opens a directory itself.
  ipcMain.handle("workspaces:openFolder", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, async (resolved) => {
      const error = await shell.openPath(resolved.folderPath);
      if (error) throw new Error(`Could not open folder: ${error}`);
    }),
  );

  ipcMain.handle("workspaces:externalEditors", async (_event, forceRefresh: unknown) =>
    listExternalEditors(forceRefresh === true),
  );

  ipcMain.handle(
    "workspaces:openInEditor",
    async (event, workspaceId: unknown, editorId: unknown) =>
      withWorkspaceOperation(event, workspaceId, async (resolved) => {
        await openFolderInExternalEditor(resolved.folderPath, asString(editorId, "editorId"));
      }),
  );
}
