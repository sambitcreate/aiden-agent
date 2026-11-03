// Workspace artifact IPC. The renderer names a workspace and an artifact by
// id; every value is parsed here, and only main reads or writes the files.

import {
  isWorkspaceArtifactId,
  isWorkspaceArtifactName,
  isWorkspaceArtifactRevision,
  isWorkspaceArtifactWorkspaceId,
  WORKSPACE_ARTIFACT_LIMITS,
  workspaceArtifactCommandList,
  type WorkspaceArtifactImportPreview,
  type WorkspaceArtifactsChangedEvent,
} from "../../renderer/shared/workspace-artifacts.js";
import type { WorkspaceArtifactRunContext, WorkspaceArtifactRunner } from "../services/workspace-artifacts/runner.js";
import type { WorkspaceArtifactStore } from "../services/workspace-artifacts/store.js";
import {
  parseWorkspaceArtifactPageFileText,
  WORKSPACE_ARTIFACT_FILE_MAX_BYTES,
  WorkspaceArtifactImports,
  workspaceArtifactPageFile,
  workspaceArtifactPageFileName,
} from "../services/workspace-artifacts/transfer.js";
import { parseUiVisualState } from "./chat-ui-visual-state.js";

/** The native file dialogs and file access behind Export page and Import page. */
export interface WorkspaceArtifactFiles {
  /** Asks where to save the page file; null when the person cancels. */
  chooseExportPath: (event: unknown, defaultName: string) => Promise<string | null>;
  /** Asks for a page file to import; null when the person cancels. */
  chooseImportFile: (event: unknown) => Promise<string | null>;
  writeFile: (filePath: string, text: string) => Promise<void>;
  /** Reads a regular file, failing with code EFBIG past `maxBytes`. */
  readFile: (filePath: string, maxBytes: number) => Promise<Uint8Array>;
}

export const WORKSPACE_ARTIFACT_CHANNELS = {
  list: "workspaces:artifacts:list",
  rename: "workspaces:artifacts:rename",
  delete: "workspaces:artifacts:delete",
  saveState: "workspaces:artifacts:saveState",
  approve: "workspaces:artifacts:approve",
  refresh: "workspaces:artifacts:refresh",
  run: "workspaces:artifacts:run",
  history: "workspaces:artifacts:history",
  restore: "workspaces:artifacts:restore",
  exportPage: "workspaces:artifacts:export",
  importPreview: "workspaces:artifacts:importPreview",
  importConfirm: "workspaces:artifacts:importConfirm",
  importDiscard: "workspaces:artifacts:importDiscard",
} as const;

export interface WorkspaceArtifactHandlerDependencies {
  handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void;
  store: Pick<
    WorkspaceArtifactStore,
    "list" | "get" | "create" | "rename" | "delete" | "saveState" | "approve" | "history" | "restore"
  >;
  files: WorkspaceArtifactFiles;
  /**
   * Names the window document that called, so a previewed import can be
   * confirmed only from there.
   */
  owner: (event: unknown) => string;
  /** Clock for import expiry; tests move it. */
  now?: () => number;
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

function asImportToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(value)) throw new Error("Invalid import.");
  return value;
}

function asText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}

export function registerWorkspaceArtifactHandlers(dependencies: WorkspaceArtifactHandlerDependencies): void {
  const { handle, store, notify } = dependencies;
  const imports = new WorkspaceArtifactImports({ ...(dependencies.now ? { now: dependencies.now } : {}) });

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

  handle(WORKSPACE_ARTIFACT_CHANNELS.history, async (_event, workspaceId, artifactId) =>
    store.history(await existingWorkspace(workspaceId), asArtifactId(artifactId)),
  );

  handle(WORKSPACE_ARTIFACT_CHANNELS.restore, async (_event, workspaceId, artifactId, revision) => {
    const workspace = await existingWorkspace(workspaceId);
    const id = asArtifactId(artifactId);
    if (!isWorkspaceArtifactRevision(revision)) throw new Error("Invalid revision.");
    // A restore from the page menu never approves anything: commands that
    // differ from the approved ones wait for the person to allow them.
    const artifact = await store.restore(workspace, id, revision);
    notify({ workspaceId: workspace, artifactId: artifact.id, reason: "updated" });
    return artifact;
  });

  // Export and import are the person's own actions from the Artifacts tab;
  // the workspace_artifact tool has no operation for either.
  handle(WORKSPACE_ARTIFACT_CHANNELS.exportPage, async (event, workspaceId, artifactId) => {
    const workspace = await existingWorkspace(workspaceId);
    const id = asArtifactId(artifactId);
    const view = await store.get(workspace, id);
    if (!view) throw new Error("That artifact no longer exists in this workspace.");
    const target = await dependencies.files.chooseExportPath(event, workspaceArtifactPageFileName(view.artifact.visual.title));
    if (!target) return { status: "cancelled" as const };
    // Written as the page is once the person chose where, not as it was before.
    const latest = await store.get(workspace, id);
    if (!latest) throw new Error("That artifact no longer exists in this workspace.");
    try {
      await dependencies.files.writeFile(target, `${JSON.stringify(workspaceArtifactPageFile(latest.artifact), null, 2)}\n`);
    } catch {
      throw new Error("Aiden could not write the page file.");
    }
    return { status: "saved" as const };
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.importPreview, async (event, workspaceId): Promise<WorkspaceArtifactImportPreview> => {
    const workspace = await existingWorkspace(workspaceId);
    const owner = dependencies.owner(event);
    if ((await store.list(workspace)).length >= WORKSPACE_ARTIFACT_LIMITS.perWorkspace) {
      throw new Error(`This workspace already has ${WORKSPACE_ARTIFACT_LIMITS.perWorkspace} artifacts. Delete one before importing.`);
    }
    const file = await dependencies.files.chooseImportFile(event);
    if (!file) return { status: "cancelled" };
    const tooLarge = () =>
      new Error(`This file is larger than ${WORKSPACE_ARTIFACT_FILE_MAX_BYTES / (1024 * 1024)} MiB, so it isn’t an Aiden page.`);
    let bytes: Uint8Array;
    try {
      bytes = await dependencies.files.readFile(file, WORKSPACE_ARTIFACT_FILE_MAX_BYTES);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "EFBIG") throw tooLarge();
      throw new Error("Aiden could not read that file.");
    }
    if (bytes.byteLength > WORKSPACE_ARTIFACT_FILE_MAX_BYTES) throw tooLarge();
    const content = parseWorkspaceArtifactPageFileText(new TextDecoder().decode(bytes));
    // Nothing is saved yet: the page waits here until the person confirms.
    const token = imports.hold(workspace, owner, content);
    return {
      status: "ready",
      token,
      title: content.title,
      ...(content.description ? { description: content.description } : {}),
      commands: workspaceArtifactCommandList(content.sources, content.actions),
      files: content.sources.flatMap((source) => (source.kind === "file" ? [source.file] : [])),
    };
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.importConfirm, async (event, workspaceId, token) => {
    const workspace = await existingWorkspace(workspaceId);
    const content = imports.take(workspace, dependencies.owner(event), asImportToken(token));
    // Never approved: neither the file nor the renderer can vouch for its
    // commands, so under Ask they wait for the person to allow them.
    const artifact = await store.create(workspace, content, { uniqueTitle: true });
    notify({ workspaceId: workspace, artifactId: artifact.id, reason: "created" });
    return artifact;
  });

  handle(WORKSPACE_ARTIFACT_CHANNELS.importDiscard, (event, workspaceId, token) => ({
    discarded: imports.discard(asWorkspaceId(workspaceId), dependencies.owner(event), asImportToken(token)),
  }));

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
