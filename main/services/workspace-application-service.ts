import * as path from "node:path";
import type { configStore } from "./config-store.js";
import type { llmClient } from "./llm-client.js";
import type { scheduleService } from "./schedule-service.js";
import type { createScratchWorkspaceDirectory } from "./scratch-workspace.js";
import type { terminalService } from "./terminal.js";
import type { Workspace, WorkspacePermission } from "./types.js";
import type { workspaceMutationGate } from "./workspace-mutation-gate.js";
import type { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import { assertWorkspaceRecordRemovalAllowed } from "./workspace-record-removal.js";
import { withWorkspaceScheduleRestoration } from "./workspace-schedule-restoration.js";
import { normalizeDisabledMcpServerIds, normalizeDisabledSkills } from "./workspace-capabilities.js";

const PERMISSIONS: readonly WorkspacePermission[] = ["full", "ask", "none"];

/** Every install's first workspace. Without a folder it becomes the shared No workspace home. */
export const DEFAULT_WORKSPACE_ID = "default";
export const NO_WORKSPACE_NAME = "No workspace";

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function defaultWorkspaceId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WorkspaceApplicationDependencies {
  onChanged?(): void;
  configStore: Pick<
    typeof configStore,
    "listWorkspaces" | "getWorkspace" | "saveWorkspace" | "removeWorkspace"
  >;
  llmClient: Pick<typeof llmClient, "cancelWorkspaceAndSettle">;
  scheduleService: Pick<
    typeof scheduleService,
    "cancelWorkspace" | "resumeWorkspace"
  >;
  terminalService: Pick<typeof terminalService, "closeForWorkspace">;
  browserService?: { closeForWorkspace(workspaceId: string): void };
  /** Closes the workspace's Git metadata watcher; a later display read re-observes. */
  gitWatcher?: { close(workspaceId: string): void };
  /** Stops background jobs and done-when checks that run in the workspace folder. */
  followThrough?: { closeForWorkspace(workspaceId: string): Promise<void> };
  /** Drops the workspace's artifacts once its record is gone. */
  workspaceArtifacts?: { removeWorkspace(workspaceId: string): Promise<void> };
  workspaceMutationGate: Pick<typeof workspaceMutationGate, "begin">;
  workspaceOperationRegistry: Pick<typeof workspaceOperationRegistry, "cancelAndSettle">;
  createScratchWorkspaceDirectory: typeof createScratchWorkspaceDirectory;
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<{
    isDirectory(): boolean;
    dev?: number | bigint;
    ino?: number | bigint;
  }>;
  removeEmptyDirectory(value: string): Promise<void>;
  /** The hidden folders behind "No workspace" chats. */
  noWorkspace?: {
    /** Makes a new, uniquely named folder in Aiden's app-data `chat-folders/`. */
    createDirectory(): Promise<{ folderPath: string }>;
    /** Workspace ids that still own at least one chat. */
    workspaceIdsWithChats(): Promise<ReadonlySet<string>>;
    /** The ids of the chats saved in one workspace. */
    chatIdsIn(workspaceId: string): Promise<readonly string[]>;
    /** Moves a released folder to the Trash. */
    trash(folderPath: string): Promise<void>;
  };
  createId(): string;
  now(): number;
  logError(area: string, message: string, error: unknown): void;
}

export interface WorkspaceApplicationMutationOptions {
  assertCurrent?: (workspace: Workspace) => void;
  beforeSave?: (workspace: Workspace | undefined) => void | Promise<void>;
}

export interface WorkspaceFolderCreationOptions {
  assertCurrent?: (identity: {
    canonicalPath: string;
    filesystemDevice?: string;
    filesystemInode?: string;
  }) => Promise<void> | void;
}

export function createWorkspaceApplicationService(deps: WorkspaceApplicationDependencies) {
  const closeFollowThrough = (workspaceId: string) =>
    deps.followThrough?.closeForWorkspace(workspaceId).catch((error: unknown) => {
      deps.logError("follow-through", "Could not stop the workspace's background jobs.", error);
    });
  let folderCreationTail: Promise<void> = Promise.resolve();

  const serializeFolderCreation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = folderCreationTail.then(operation, operation);
    folderCreationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const saveFolderWorkspace = async (
    folderPath: string,
    permission: WorkspacePermission,
    name?: string,
    options: WorkspaceFolderCreationOptions = {},
  ): Promise<Workspace> => {
    return serializeFolderCreation(async () => {
      const canonicalPath = await deps.realpath(folderPath);
      const identity = await deps.stat(canonicalPath);
      if (!identity.isDirectory()) {
        throw new Error("Choose a folder for this workspace.");
      }
      await options.assertCurrent?.({
        canonicalPath,
        ...(identity.dev === undefined ? {} : { filesystemDevice: String(identity.dev) }),
        ...(identity.ino === undefined ? {} : { filesystemInode: String(identity.ino) }),
      });
      const existing = await deps.configStore.listWorkspaces();
      if (existing.some((workspace) => workspace.folderPath === canonicalPath)) {
        throw new Error("That folder is already registered as an Aiden workspace.");
      }
      const now = deps.now();
      return deps.configStore.saveWorkspace({
        id: deps.createId(),
        name: name?.trim() || path.basename(canonicalPath) || "Workspace",
        folderPath: canonicalPath,
        permission,
        createdAt: now,
        updatedAt: now,
      }, options.assertCurrent ? async () => {
        // Revalidate after list/save admission awaits, inside the storage mutation.
        const currentPath = await deps.realpath(folderPath);
        const current = await deps.stat(currentPath);
        if (!current.isDirectory() || currentPath !== canonicalPath) throw new Error("The workspace folder changed before registration.");
        await options.assertCurrent!({ canonicalPath: currentPath,
          ...(current.dev === undefined ? {} : { filesystemDevice: String(current.dev) }),
          ...(current.ino === undefined ? {} : { filesystemInode: String(current.ino) }),
        });
      } : undefined);
    });
  };

  const requireNoWorkspace = () => {
    if (!deps.noWorkspace) throw new Error("No workspace chats are unavailable.");
    return deps.noWorkspace;
  };

  /** Removes the record first so nothing can start in the folder, then clears the folder away. */
  const releaseNoWorkspace = async (workspace: Workspace) => {
    try {
      await service.remove(workspace.id, {
        assertCurrent: (current) => {
          if (!current.noWorkspace) throw new Error("Only a No workspace folder is released with its chat.");
        },
      });
    } catch (error) {
      deps.logError("workspace", "Could not release a No workspace record.", error);
      return;
    }
    const folderPath = workspace.folderPath;
    if (!folderPath) return;
    try {
      await deps.removeEmptyDirectory(folderPath);
    } catch {
      await deps.noWorkspace?.trash(folderPath).catch((error: unknown) => {
        deps.logError("workspace", "Could not move a released No workspace folder to the Trash.", error);
      });
    }
  };

  const service = {
    list() {
      return deps.configStore.listWorkspaces();
    },

    async get(workspaceId: string) {
      return (await deps.configStore.getWorkspace(workspaceId)) ?? null;
    },

    create(input: unknown) {
      const fields = (
        typeof input === "object" && input !== null ? input : {}
      ) as Record<string, unknown>;
      if ("folderPath" in fields) {
        throw new Error("Choose workspace folders through Aiden's folder picker.");
      }
      const name =
        (typeof fields.name === "string" && fields.name.trim()) || "Workspace";
      const permission = PERMISSIONS.includes(fields.permission as WorkspacePermission)
        ? (fields.permission as WorkspacePermission)
        : "ask";
      const now = deps.now();
      return deps.configStore.saveWorkspace({
        id: deps.createId(),
        name,
        permission,
        createdAt: now,
        updatedAt: now,
      });
    },

    createFromFolder(
      folderPath: string,
      name?: string,
      options: WorkspaceFolderCreationOptions = {},
    ) {
      return saveFolderWorkspace(
        nonEmptyString(folderPath, "folderPath"),
        "ask",
        name,
        options,
      );
    },

    async createScratch() {
      const scratch = await deps.createScratchWorkspaceDirectory();
      const now = deps.now();
      const workspace: Workspace = {
        id: deps.createId(),
        name: scratch.name,
        folderPath: scratch.folderPath,
        permission: "ask",
        scratch: true,
        createdAt: now,
        updatedAt: now,
      };
      try {
        return await deps.configStore.saveWorkspace(workspace);
      } catch (error) {
        await deps.removeEmptyDirectory(scratch.folderPath).catch(() => undefined);
        throw error;
      }
    },

    /**
     * A fresh hidden workspace for one "No workspace" chat. It runs in its own
     * folder with global settings, so files, skills and Git work without a project.
     */
    async createNoWorkspace() {
      const noWorkspace = requireNoWorkspace();
      return serializeFolderCreation(async () => {
        const { folderPath } = await noWorkspace.createDirectory();
        const now = deps.now();
        try {
          return await deps.configStore.saveWorkspace({
            id: deps.createId(),
            name: NO_WORKSPACE_NAME,
            folderPath,
            permission: "ask",
            noWorkspace: true,
            createdAt: now,
            updatedAt: now,
          });
        } catch (error) {
          await deps.removeEmptyDirectory(folderPath).catch(() => undefined);
          throw error;
        }
      });
    },

    /**
     * Startup, before any renderer or draft exists: the folderless default
     * workspace becomes the No workspace home of the chats already in it, and
     * hidden workspaces left without a chat (an abandoned draft) are released.
     */
    async prepareNoWorkspaceChats() {
      const noWorkspace = requireNoWorkspace();
      const workspaces = await deps.configStore.listWorkspaces();
      const legacy = workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID);
      if (legacy && !legacy.folderPath && !legacy.noWorkspace && !legacy.managedWorktree) {
        await serializeFolderCreation(async () => {
          const { folderPath } = await noWorkspace.createDirectory();
          try {
            await deps.configStore.saveWorkspace(
              { ...legacy, name: NO_WORKSPACE_NAME, folderPath, noWorkspace: true },
              (current) => {
                if (!current || current.folderPath || current.noWorkspace) {
                  throw new Error("The default workspace changed while Aiden was preparing it.");
                }
              },
            );
          } catch (error) {
            await deps.removeEmptyDirectory(folderPath).catch(() => undefined);
            throw error;
          }
        });
      }
      const owners = await noWorkspace.workspaceIdsWithChats();
      for (const workspace of workspaces) {
        if (!workspace.noWorkspace || workspace.id === DEFAULT_WORKSPACE_ID || owners.has(workspace.id)) continue;
        await releaseNoWorkspace(workspace);
      }
    },

    /**
     * A paired device's new chat aimed at a hidden No workspace that already
     * holds another chat gets a fresh one, so each chat keeps its own folder.
     * Returns the workspace to use; any other workspace is unchanged.
     */
    async workspaceForNoWorkspaceChat(workspaceId: string) {
      if (!deps.noWorkspace) return workspaceId;
      const workspace = await deps.configStore.getWorkspace(workspaceId);
      if (!workspace?.noWorkspace) return workspaceId;
      if ((await deps.noWorkspace.chatIdsIn(workspaceId)).length === 0) return workspaceId;
      return (await service.createNoWorkspace()).id;
    },

    /** After a chat is deleted: its hidden No workspace folder goes too once no chat uses it. */
    async releaseNoWorkspaceAfterChat(workspaceId: string) {
      if (!deps.noWorkspace || workspaceId === DEFAULT_WORKSPACE_ID) return;
      const workspace = await deps.configStore.getWorkspace(workspaceId);
      if (!workspace?.noWorkspace) return;
      if ((await deps.noWorkspace.workspaceIdsWithChats()).has(workspaceId)) return;
      await releaseNoWorkspace(workspace);
    },

    async update(
      workspaceId: string,
      patch: unknown,
      options: WorkspaceApplicationMutationOptions = {},
    ) {
      const id = nonEmptyString(workspaceId, "id");
      const finishMutation = deps.workspaceMutationGate.begin(id);
      try {
        await deps.workspaceOperationRegistry.cancelAndSettle(id);
        const existing = await deps.configStore.getWorkspace(id);
        if (!existing) throw new Error(`Workspace ${id} not found.`);
        options.assertCurrent?.(existing);
        const fields = (
          typeof patch === "object" && patch !== null ? patch : {}
        ) as Record<string, unknown>;
        if ("folderPath" in fields) {
          throw new Error("Workspace folders cannot be changed from renderer input.");
        }
        const next: Workspace = {
          ...existing,
          name:
            typeof fields.name === "string" && fields.name.trim()
              ? fields.name.trim()
              : existing.name,
          permission: PERMISSIONS.includes(fields.permission as WorkspacePermission)
            ? (fields.permission as WorkspacePermission)
            : existing.permission,
          memoryEnabled:
            typeof fields.memoryEnabled === "boolean"
              ? fields.memoryEnabled
              : existing.memoryEnabled,
          // Off-lists apply from the next message, so they never stop a reply.
          disabledSkills:
            "disabledSkills" in fields
              ? normalizeDisabledSkills(fields.disabledSkills)
              : existing.disabledSkills,
          disabledMcpServerIds:
            "disabledMcpServerIds" in fields
              ? normalizeDisabledMcpServerIds(fields.disabledMcpServerIds)
              : existing.disabledMcpServerIds,
        };
        if (!next.disabledSkills) delete next.disabledSkills;
        if (!next.disabledMcpServerIds) delete next.disabledMcpServerIds;
        const authorityChanged =
          next.permission !== existing.permission ||
          next.memoryEnabled !== existing.memoryEnabled;
        if (!authorityChanged) {
          const saved = await deps.configStore.saveWorkspace(next, options.beforeSave);
          deps.onChanged?.();
          return saved;
        }
        return await withWorkspaceScheduleRestoration(
          {
            restoreOnExit: existing.permission !== "none",
            resume: () => deps.scheduleService.resumeWorkspace(existing.id),
            onResumeError: (error) => {
              deps.logError(
                "schedule",
                "Could not restore scheduled tasks after workspace update failed.",
                error,
              );
            },
          },
          async ({ ensureResumedOnExit, keepPaused }) => {
            deps.terminalService.closeForWorkspace(existing.id);
            deps.browserService?.closeForWorkspace(existing.id);
            if (next.permission !== existing.permission) await closeFollowThrough(existing.id);
            await deps.llmClient.cancelWorkspaceAndSettle(existing.id);
            await deps.scheduleService.cancelWorkspace(existing.id);
            options.assertCurrent?.(await deps.configStore.getWorkspace(id) ?? existing);
            const saved = await deps.configStore.saveWorkspace(next, options.beforeSave);
            deps.onChanged?.();
            if (saved.permission !== "none") {
              ensureResumedOnExit();
              await deps.scheduleService.resumeWorkspace(saved.id);
            }
            keepPaused();
            return saved;
          },
        );
      } finally {
        finishMutation();
      }
    },

    async remove(
      workspaceId: string,
      options: WorkspaceApplicationMutationOptions = {},
    ): Promise<void> {
      const id = nonEmptyString(workspaceId, "id");
      const finishMutation = deps.workspaceMutationGate.begin(id);
      try {
        await deps.workspaceOperationRegistry.cancelAndSettle(id);
        const existing = await deps.configStore.getWorkspace(id);
        if (existing) options.assertCurrent?.(existing);
        deps.terminalService.closeForWorkspace(id);
        deps.browserService?.closeForWorkspace(id);
        assertWorkspaceRecordRemovalAllowed(existing);
        await closeFollowThrough(id);
        await withWorkspaceScheduleRestoration(
          {
            restoreOnExit: existing?.permission !== "none",
            resume: () => deps.scheduleService.resumeWorkspace(id),
            onResumeError: (error) => {
              deps.logError(
                "schedule",
                "Could not restore scheduled tasks after workspace removal failed.",
                error,
              );
            },
          },
          async ({ keepPaused }) => {
            await deps.llmClient.cancelWorkspaceAndSettle(id);
            await deps.scheduleService.cancelWorkspace(id);
            await deps.configStore.removeWorkspace(id);
            await deps.workspaceArtifacts?.removeWorkspace(id).catch((error: unknown) => {
              deps.logError("workspace", "Could not remove the workspace's artifacts.", error);
            });
            deps.onChanged?.();
            keepPaused();
          },
        );
      } finally {
        finishMutation();
        // Every client's removal (this Mac's IPC, a paired device's Remote
        // request) lands here. Closing after a failed remove is harmless.
        deps.gitWatcher?.close(id);
      }
    },
  };
  return service;
}

export { defaultWorkspaceId };
