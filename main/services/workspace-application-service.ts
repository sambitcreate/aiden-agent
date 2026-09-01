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

const PERMISSIONS: readonly WorkspacePermission[] = ["full", "ask", "none"];

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
  createId(): string;
  now(): number;
  logError(area: string, message: string, error: unknown): void;
}

export interface WorkspaceApplicationMutationOptions {
  assertCurrent?: (workspace: Workspace) => void;
}

export interface WorkspaceFolderCreationOptions {
  assertCurrent?: (identity: {
    canonicalPath: string;
    filesystemDevice?: string;
    filesystemInode?: string;
  }) => Promise<void> | void;
}

export function createWorkspaceApplicationService(deps: WorkspaceApplicationDependencies) {
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
      });
    });
  };

  return {
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
        };
        const authorityChanged =
          next.permission !== existing.permission ||
          next.memoryEnabled !== existing.memoryEnabled;
        if (!authorityChanged) {
          return await deps.configStore.saveWorkspace(next);
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
            await deps.llmClient.cancelWorkspaceAndSettle(existing.id);
            await deps.scheduleService.cancelWorkspace(existing.id);
            const saved = await deps.configStore.saveWorkspace(next);
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
        assertWorkspaceRecordRemovalAllowed(existing);
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
            keepPaused();
          },
        );
      } finally {
        finishMutation();
      }
    },
  };
}

export { defaultWorkspaceId };
