import type { DesignProjectSnapshot as DesignProjectSnapshotV1 } from "./design-project-contract.js";
import {
  DesignProjectConflictError,
  DesignProjectNotFoundError,
  DesignProjectRevisionConflictError,
} from "./design-project-store.js";
import type { WorkspaceEnvironmentDirectory } from "./workspace-environment-application-service.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";

export interface DesignProjectGenerationPreflightV1 {
  projectId: string;
  projectRevision: number;
  chatId: string;
  connectionState: "prototype-only" | "connected";
  workspaceId?: string;
}

export interface DesignProjectConnectionDependencies {
  projects: {
    get(id: string): Promise<DesignProjectSnapshotV1 | undefined>;
    connect(input: {
      id: string;
      expectedRevision: number;
      workspaceId: string;
    }): Promise<DesignProjectSnapshotV1>;
  };
  workspaces: {
    run<T>(
      owner: WorkspaceOperationDocumentOwner,
      workspaceId: string,
      operation: (resolved: WorkspaceEnvironmentDirectory, signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  };
  runProjectMutation<T>(operation: () => Promise<T>): Promise<T>;
  chatWorkspaceId(chatId: string): Promise<string | undefined>;
  isChatBusy?(chatId: string): boolean;
  prepareRebind?(owner: RendererDocumentOwner, current: DesignProjectSnapshotV1): Promise<void>;
  finalizeRebind?(
    previous: DesignProjectSnapshotV1,
    connected: DesignProjectSnapshotV1,
  ): Promise<void>;
}

function preflightProjection(project: DesignProjectSnapshotV1): DesignProjectGenerationPreflightV1 {
  return {
    projectId: project.id,
    projectRevision: project.revision,
    chatId: project.chatId,
    connectionState: project.connectionState,
    ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
  };
}

export function assertDesignProjectGenerationClaim(
  project: DesignProjectSnapshotV1 | undefined,
  claim: DesignProjectGenerationPreflightV1,
): DesignProjectSnapshotV1 {
  const current = requireProject(project);
  if (
    current.id !== claim.projectId ||
    current.revision !== claim.projectRevision ||
    current.chatId !== claim.chatId ||
    current.connectionState !== claim.connectionState ||
    current.workspaceId !== claim.workspaceId
  ) {
    throw new DesignProjectRevisionConflictError(current.revision);
  }
  return current;
}

function requireProject(project: DesignProjectSnapshotV1 | undefined): DesignProjectSnapshotV1 {
  if (!project) throw new DesignProjectNotFoundError();
  return project;
}

export function requireConnectedDesignProject(
  project: DesignProjectSnapshotV1 | undefined,
): DesignProjectSnapshotV1 & { connectionState: "connected"; workspaceId: string } {
  const current = requireProject(project);
  if (current.connectionState !== "connected" || !current.workspaceId) {
    throw new DesignProjectConflictError("Connect this Design Project to a local app first.");
  }
  return current as DesignProjectSnapshotV1 & {
    connectionState: "connected";
    workspaceId: string;
  };
}

export function assertSameConnectedDesignProjectBinding(
  current: DesignProjectSnapshotV1 | undefined,
  expected: DesignProjectSnapshotV1 & { connectionState: "connected"; workspaceId: string },
): asserts current is DesignProjectSnapshotV1 & {
  connectionState: "connected";
  workspaceId: string;
} {
  const connected = requireConnectedDesignProject(current);
  if (
    connected.id !== expected.id ||
    connected.revision !== expected.revision ||
    connected.workspaceId !== expected.workspaceId
  ) {
    throw new DesignProjectRevisionConflictError(connected.revision);
  }
}

function requireConnectRevision(
  project: DesignProjectSnapshotV1,
  expectedRevision: number,
  workspaceId: string,
): void {
  if (project.revision !== expectedRevision) {
    throw new DesignProjectRevisionConflictError(project.revision);
  }
  if (project.connectionState === "connected" && project.workspaceId === workspaceId) {
    throw new DesignProjectConflictError("This Design Project is already connected.");
  }
}

/**
 * Owns the authority boundary between repository-free prototypes and explicit
 * Connected Apps. Folder paths never cross IPC, and the selected workspace is
 * resolved under the ordinary workspace operation/mutation admission before
 * the durable project binding is published.
 */
export function createDesignProjectConnectionService(
  dependencies: DesignProjectConnectionDependencies,
) {
  return {
    async runGenerationAppend<T>(
      owner: RendererDocumentOwner,
      claim: DesignProjectGenerationPreflightV1,
      append: (isCurrent: () => boolean) => Promise<T>,
    ): Promise<T> {
      return dependencies.runProjectMutation(async () => {
        const project = assertDesignProjectGenerationClaim(
          await dependencies.projects.get(claim.projectId),
          claim,
        );
        if (
          persistedChatWorkspaceId(await dependencies.chatWorkspaceId(project.chatId)) ===
          ASSISTANT_WORKSPACE_ID
        ) {
          throw new DesignProjectConflictError(
            "Aiden Assistant conversations cannot back a Design Project.",
          );
        }
        if (project.connectionState === "prototype-only") {
          return append(() => true);
        }
        const connected = requireConnectedDesignProject(project);
        return dependencies.workspaces.run(
          owner,
          connected.workspaceId,
          async (_resolved, signal) => {
            if (signal.aborted) throw signal.reason;
            // Workspace resolution may await the filesystem. Re-prove the
            // exact project relationship after it completes, while the
            // project mutation lane is still held.
            assertDesignProjectGenerationClaim(
              await dependencies.projects.get(claim.projectId),
              claim,
            );
            if (signal.aborted) throw signal.reason;
            return append(() => !signal.aborted);
          },
        );
      });
    },

    async connect(
      owner: RendererDocumentOwner,
      input: { projectId: string; expectedRevision: number; workspaceId: string },
    ): Promise<DesignProjectSnapshotV1> {
      requireConnectRevision(
        requireProject(await dependencies.projects.get(input.projectId)),
        input.expectedRevision,
        input.workspaceId,
      );
      return dependencies.workspaces.run(owner, input.workspaceId, async (_resolved, signal) => {
        if (signal.aborted) throw signal.reason;
        // Re-read after workspace resolution. A competing project update must
        // conflict rather than being overwritten by the connection change.
        const current = requireProject(await dependencies.projects.get(input.projectId));
        requireConnectRevision(current, input.expectedRevision, input.workspaceId);
        if (signal.aborted) throw signal.reason;
        let previous = current;
        const connected = await dependencies.runProjectMutation(async () => {
          previous = requireProject(await dependencies.projects.get(input.projectId));
          requireConnectRevision(previous, input.expectedRevision, input.workspaceId);
          if (dependencies.isChatBusy?.(previous.chatId)) {
            throw new DesignProjectConflictError(
              "Finish or stop the current Design response before connecting an app.",
            );
          }
          if (previous.connectionState === "connected") {
            await dependencies.prepareRebind?.(owner, previous);
          }
          if (signal.aborted) throw signal.reason;
          return dependencies.projects.connect({
            id: previous.id,
            expectedRevision: previous.revision,
            workspaceId: input.workspaceId,
          });
        });
        if (previous.connectionState === "connected") {
          await dependencies.finalizeRebind?.(previous, connected);
        }
        return connected;
      });
    },

    async preflightGeneration(
      owner: RendererDocumentOwner,
      projectId: string,
    ): Promise<DesignProjectGenerationPreflightV1> {
      const project = requireProject(await dependencies.projects.get(projectId));
      if (project.connectionState === "prototype-only") return preflightProjection(project);
      if (!project.workspaceId) {
        throw new DesignProjectConflictError(
          "This Connected App does not have a workspace binding.",
        );
      }
      return dependencies.workspaces.run(owner, project.workspaceId, async (_resolved, signal) => {
        if (signal.aborted) throw signal.reason;
        const current = requireProject(await dependencies.projects.get(project.id));
        if (
          current.connectionState !== "connected" ||
          current.workspaceId !== project.workspaceId
        ) {
          throw new DesignProjectRevisionConflictError(current.revision);
        }
        return preflightProjection(current);
      });
    },
  };
}

export type DesignProjectConnectionService = ReturnType<
  typeof createDesignProjectConnectionService
>;
