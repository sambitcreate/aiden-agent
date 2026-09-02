import { BrowserWindow, dialog, ipcMain, logger, shell } from "../platform.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { workspaceEnvironmentApplicationService } from "../services/workspace-environment-application-service-main.js";
import {
  admitOwnedWorkspaceOperation,
  workspaceOperationRegistry,
} from "../services/workspace-operation-registry.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { sourceDesignPreviewService } from "../services/source-design-preview.js";
import { sourceDesignerActionService } from "../services/source-designer-actions.js";
import {
  designReferenceAssetStore,
  MAX_DESIGN_REFERENCE_ASSET_BYTES,
} from "../services/design-reference-asset-store.js";
import { parseSourceElementDescriptor } from "../../renderer/shared/source-designer.js";
import { parseDesignElementSelection } from "../../renderer/shared/design-workspace.js";
import { chatApplicationService } from "../services/chat-application-service-main.js";
import { generativeUiArtifactStore } from "../services/generative-ui-artifact-store.js";
import {
  designProjectLifecycle,
  designProjectStore,
} from "../services/design-project-store-main.js";
import {
  isDesignProjectOpaqueId,
  normalizeDesignProjectTitle,
  parseDesignProjectCanvasV1,
  type DesignProjectSnapshotV1,
} from "../services/design-project-contract.js";
import {
  DesignProjectPublicationUncertainError,
  DesignProjectRevisionConflictError,
} from "../services/design-project-store.js";
import { buildDesignProjectExportBundle } from "../services/design-project-export-core.js";
import { writeDesignProjectExport } from "../services/design-project-export.js";
import { designProjectExportHistoryStore } from "../services/design-project-export-history.js";
import { designCommentStore } from "../services/design-comment-store-main.js";
import {
  parseDesignCommentBody,
  parseDesignCommentTarget,
  type DesignCommentTargetV1,
} from "../services/design-comment-contract.js";
import {
  currentDesignSystemModelContext,
  designSystemAttachmentService,
  designSystemSnapshotStore,
} from "../services/design-system-attachment-service-main.js";
import { designHandoffApplicationService } from "../services/design-handoff-application-service-main.js";
import { designDirectEditService } from "../services/design-direct-edit-service-main.js";
import {
  parseDesignDirectEdit,
  parseRendererDirectEditGestureId,
  parseRendererPrototypeGestureId,
} from "../services/design-direct-edit-core.js";
import {
  listSourceDesignerMultifileActions,
  sourceDesignerMultifileAction,
  sourceDesignerMultifileCoordinator,
  sourceDesignerMultifileJournal,
} from "../services/source-designer-multifile-main.js";
import { inspectDesignProjectHealth } from "../services/design-project-health.js";
import { isUsablePublishedDesignSource } from "../services/design-artifact-source-authority.js";
import { designArtifactRecoveryService } from "../services/design-artifact-recovery-main.js";
import { DesignReferenceRecoveryService } from "../services/design-reference-recovery.js";
import { llmClient } from "../services/llm-client.js";
import {
  assertSameConnectedDesignProjectBinding,
  createDesignProjectConnectionService,
  requireConnectedDesignProject,
} from "../services/design-project-connection-service.js";
import {
  parseDesignProjectConnectParams,
  parseDesignProjectActionParams,
  parseDesignProjectBindSelectionParams,
  parseDesignProjectContentUpdateEnvelope,
  parseDesignProjectCreateParams,
  parseDesignProjectPreflightParams,
  parseDesignProjectPreviewParams,
  parseDesignProjectStartPreviewParams,
} from "./design-project-params.js";

const designProjectConnectionService = createDesignProjectConnectionService({
  projects: designProjectStore,
  workspaces: workspaceEnvironmentApplicationService,
  runProjectMutation: (operation) => designProjectLifecycle.runProjectMutation(operation),
  chatWorkspaceId: async (chatId) => (await chatApplicationService.get(chatId)).chat?.workspaceId,
  isChatBusy: (chatId) => llmClient.isChatBusy(chatId),
  prepareRebind: async (_owner, current) => {
    await sourceDesignPreviewService.stopProject(current.id);
  },
  finalizeRebind: async (previous) => {
    if (!previous.designSystemBinding) return;
    await designSystemAttachmentService
      .detach(previous.designSystemBinding.id, previous.designSystemBinding.revision)
      .catch((error) =>
        logger.warn(
          "design-project",
          "A stale design-system attachment could not be removed after reconnecting.",
          error,
        ),
      );
  },
});

const designReferenceRecoveryService = new DesignReferenceRecoveryService({
  projects: designProjectStore,
  assets: designReferenceAssetStore,
});

async function designHandoffPacket(
  project: DesignProjectSnapshotV1,
  lineageIdValue: unknown,
  mediaIdValue: unknown,
) {
  const lineageId = projectId(lineageIdValue);
  const mediaId = projectId(mediaIdValue);
  const artboard = project.canvas.nodes.find(
    (node) =>
      node.kind === "artboard" &&
      node.canonicalOrigin === "generated-artifact" &&
      node.lineageId === lineageId &&
      node.artifactMediaIds?.includes(mediaId),
  );
  if (!artboard) throw new Error("Select a generated Design revision before continuing.");
  const source = await generativeUiArtifactStore.committedRecoverySourceFor(
    project.chatId,
    mediaId,
  );
  if (!source) throw new Error("The selected Design revision is unavailable.");
  if (!isUsablePublishedDesignSource(project, source)) {
    throw new Error("The selected Design revision is damaged. Repair it before continuing.");
  }
  const bytes = Buffer.from(source.html, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const commentView = await designCommentStore.listProject(project.id);
  const designDecisions = commentView.comments
    .filter(({ status }) => status === "resolved")
    .map(({ id, body }) => ({
      id,
      summary: body.replace(/\s+/gu, " ").trim().slice(0, 500),
    }))
    .filter(
      ({ summary }) =>
        summary.length > 0 &&
        !/(?:^|\s)(?:\/\S+|~\/\S+|[A-Za-z]:\\\S*)/u.test(summary) &&
        !/file:\/\//iu.test(summary) &&
        !/(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|authorization\s*:|bearer\s+)/iu.test(
          summary,
        ) &&
        !(
          (summary.startsWith("{") && summary.endsWith("}")) ||
          (summary.startsWith("[") && summary.endsWith("]"))
        ),
    )
    .slice(0, 32);
  return {
    version: 1 as const,
    projectId: project.id,
    projectRevision: project.revision,
    source: {
      bundleId: `bundle:${sha256}`,
      lineageId,
      revisionId: mediaId,
      sha256,
      byteSize: bytes.byteLength,
    },
    referenceAssetIds: project.referenceAssetIds,
    designDecisions,
    responsiveStates: [
      { viewport: "desktop" as const, width: 1200, height: 760 },
      { viewport: "tablet" as const, width: 768, height: 900 },
      { viewport: "phone" as const, width: 390, height: 844 },
    ],
  };
}

function designSystemSources(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error("Choose between 1 and 16 reviewed design-system files.");
  }
  return value.map((candidate) => {
    const source = exactRecord(candidate, new Set(["workspaceRelativePath", "kind"]));
    const workspaceRelativePath = string(
      source.workspaceRelativePath,
      "design-system source path",
      512,
    );
    if (source.kind !== "tokens-v1" && source.kind !== "catalog-v1") {
      throw new Error("Invalid design-system source kind.");
    }
    return {
      sourceId: `${source.kind}:${createHash("sha256")
        .update(`${source.kind}\0${workspaceRelativePath}`, "utf8")
        .digest("hex")
        .slice(0, 32)}`,
      workspaceRelativePath,
      kind: source.kind,
      reviewed: true as const,
    };
  });
}

async function designSystemExtractionInput(
  project: DesignProjectSnapshotV1,
  input?: {
    name: string;
    sources: ReturnType<typeof designSystemSources>;
    packageRoot?: string;
    routeScope?: string;
  },
) {
  if (!project.workspaceId || project.connectionState !== "connected") {
    throw new Error("Connect this Design Project to a local workspace first.");
  }
  const record = project.designSystemBinding
    ? await designSystemSnapshotStore.getRecord(project.designSystemBinding.id)
    : undefined;
  let name = input?.name ?? (record?.state === "attached" ? record.snapshot.name : undefined);
  const sources =
    input?.sources ??
    (record?.state === "attached"
      ? record.provenance.map(({ sourceId, workspaceRelativePath }) => {
          const kind = sourceId.startsWith("tokens-v1:")
            ? ("tokens-v1" as const)
            : sourceId.startsWith("catalog-v1:")
              ? ("catalog-v1" as const)
              : undefined;
          if (!kind) throw new Error("Reattach this design system to verify its source schema.");
          return {
            sourceId,
            workspaceRelativePath,
            kind,
            reviewed: true as const,
          };
        })
      : undefined);
  if (input) {
    const packageRoot = string(input.packageRoot, "design-system package root", 256);
    const routeScope = string(input.routeScope, "design-system route scope", 160);
    if (
      (packageRoot !== "." &&
        (packageRoot.startsWith("/") ||
          packageRoot.includes("\\") ||
          packageRoot.split("/").some((part) => !part || part === "." || part === ".."))) ||
      !routeScope.startsWith("/")
    ) {
      throw new Error("Choose one normalized package root and application route.");
    }
    if (
      packageRoot !== "." &&
      (sources ?? []).some(
        ({ workspaceRelativePath }) => !workspaceRelativePath.startsWith(`${packageRoot}/`),
      )
    ) {
      throw new Error("Every reviewed design-system file must be inside the confirmed package.");
    }
    name = `${name} · ${packageRoot} · ${routeScope}`.slice(0, 160);
  }
  if (!name || !sources) throw new Error("Attach a design system before using it.");
  return { name, sources };
}

async function withDesignSystemWorkspace<T>(
  owner: ReturnType<typeof ownerFor>,
  project: DesignProjectSnapshotV1,
  selection: Awaited<ReturnType<typeof designSystemExtractionInput>>,
  operation: (reviewedInput: unknown) => Promise<T>,
): Promise<T> {
  if (!project.workspaceId) throw new Error("This Design Project has no connected workspace.");
  return workspaceEnvironmentApplicationService.run(
    owner,
    project.workspaceId,
    async (resolved) => {
      const rootPath = await fs.realpath(resolved.folderPath);
      const identity = await fs.stat(rootPath, { bigint: true });
      if (!identity.isDirectory()) throw new Error("The connected workspace is unavailable.");
      return operation({
        name: selection.name,
        authority: {
          rootPath,
          device: identity.dev.toString(),
          inode: identity.ino.toString(),
        },
        sources: selection.sources,
      });
    },
  );
}

const MAX_DESIGN_REFERENCE_BASE64_CHARS = Math.ceil(MAX_DESIGN_REFERENCE_ASSET_BYTES / 3) * 4;

function string(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function ownerFor(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(
    event,
    () => new Error("Designer access requires the active renderer document."),
  );
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Design Project request.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    [...required].some((key) => !(key in record))
  ) {
    throw new Error("Invalid Design Project request.");
  }
  return record;
}

function projectId(value: unknown): string {
  if (!isDesignProjectOpaqueId(value)) throw new Error("Invalid Design Project identity.");
  return value;
}

function projectRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Invalid Design Project revision.");
  }
  return value as number;
}

function projectSummary(project: DesignProjectSnapshotV1) {
  return {
    id: project.id,
    revision: project.revision,
    title: project.title,
    chatId: project.chatId,
    ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
    connectionState: project.connectionState,
    hasPrototypeArtboards: project.canvas.nodes.some(({ kind }) => kind === "artboard"),
    updatedAt: project.updatedAt,
    artboardCount: project.canvas.nodes.filter(({ kind }) => kind === "artboard").length,
  };
}

async function requireStoredReferenceAssets(assetIds: readonly string[]): Promise<void> {
  const available = new Set((await designReferenceAssetStore.list()).map(({ id }) => id));
  if (assetIds.some((id) => !available.has(id))) {
    throw new Error("A Design reference image is unavailable.");
  }
}

async function requireConnectedProject(projectIdValue: string) {
  return requireConnectedDesignProject(await designProjectStore.get(projectIdValue));
}

function requireProjectAction(
  owner: ReturnType<typeof ownerFor>,
  project: Awaited<ReturnType<typeof requireConnectedProject>>,
  actionId: string,
) {
  const action = sourceDesignerActionService
    .list(owner, project.id, project.chatId, project.workspaceId)
    .find(({ id }) => id === actionId);
  if (!action) {
    throw new Error("That Designer Action is outside this Design Project or is stale.");
  }
  return action;
}

async function requireOwnedCommentTarget(
  value: unknown,
  owner: ReturnType<typeof ownerFor>,
): Promise<DesignCommentTargetV1> {
  const target = parseDesignCommentTarget(value);
  if (!target) throw new Error("Invalid Design comment target.");
  const project = await designProjectStore.get(target.projectId);
  if (!project) throw new Error("Design Project was not found.");
  if (target.source.kind === "connected-source") {
    const node = project.canvas.nodes.find(
      (candidate) => candidate.kind === "source-preview" && candidate.id === target.lineageId,
    );
    if (
      !node ||
      project.connectionState !== "connected" ||
      project.workspaceId !== target.source.workspaceId ||
      target.mediaId !== target.source.sourceVersion ||
      !(await sourceDesignerActionService.proveConnectedCommentTarget(
        owner,
        target.source.workspaceId,
        target as DesignCommentTargetV1 & {
          source: Extract<DesignCommentTargetV1["source"], { kind: "connected-source" }>;
        },
      ))
    ) {
      throw new Error("Connected-app comments require a current proven source binding.");
    }
    return target;
  }
  const node = project.canvas.nodes.find(
    (candidate) =>
      candidate.kind === "artboard" &&
      candidate.lineageId === target.lineageId &&
      candidate.artifactMediaIds?.includes(target.mediaId),
  );
  if (!node) throw new Error("That comment target does not belong to this Design Project.");
  const elementId = target.element.elementId;
  if (!elementId || target.element.selector !== `[data-aiden-id="${elementId}"]`) {
    throw new Error("Generated comments require one stable data-aiden-id element target.");
  }
  const source = await generativeUiArtifactStore.committedRecoverySourceFor(
    project.chatId,
    target.mediaId,
  );
  if (!source) throw new Error("That generated revision is unavailable.");
  if (!isUsablePublishedDesignSource(project, source)) {
    throw new Error("That generated revision is damaged. Repair it before adding comments.");
  }
  const artifactId = createHash("sha256").update(source.html, "utf8").digest("hex");
  if (artifactId !== target.source.artifactId) {
    throw new Error("That comment target changed before it could be saved.");
  }
  return target;
}

async function requireProjectComment(
  projectIdValue: unknown,
  commentIdValue: unknown,
): Promise<{ projectId: string; commentId: string }> {
  const requestedProjectId = projectId(projectIdValue);
  const commentId = projectId(commentIdValue);
  if (!(await designProjectStore.get(requestedProjectId))) {
    throw new Error("Design Project was not found.");
  }
  const view = await designCommentStore.listProject(requestedProjectId);
  if (!view.comments.some(({ id }) => id === commentId)) {
    throw new Error("Design comment was not found.");
  }
  return { projectId: requestedProjectId, commentId };
}

export function registerDesignerHandlers(): void {
  ipcMain.handle(
    "designer:connectedCommentTarget",
    async (event, projectIdValue: unknown, selectionIdValue: unknown) => {
      const owner = ownerFor(event);
      const project = await designProjectStore.get(projectId(projectIdValue));
      if (!project?.workspaceId || project.connectionState !== "connected") {
        throw new Error("This Design Project is not connected to a workspace.");
      }
      const binding = await sourceDesignerActionService.resolve(
        owner,
        project.workspaceId,
        string(selectionIdValue, "source selection", 128),
      );
      const sourceNode = project.canvas.nodes.find(({ kind }) => kind === "source-preview");
      if (!sourceNode) throw new Error("The connected preview is not saved on this canvas.");
      return {
        projectId: project.id,
        lineageId: sourceNode.id,
        mediaId: binding.sourceVersion,
        element: {
          selector: binding.selection.selector,
          selectorMatchCount: 1 as const,
          tagName: binding.selection.tagName,
          ...(binding.selection.elementId ? { elementId: binding.selection.elementId } : {}),
        },
        source: {
          kind: "connected-source" as const,
          workspaceId: project.workspaceId,
          path: binding.path,
          sourceVersion: binding.sourceVersion,
          start: binding.start,
          end: binding.end,
          preimageHash: createHash("sha256").update(binding.snippet).digest("hex"),
        },
      } satisfies DesignCommentTargetV1;
    },
  );

  ipcMain.handle("designer:listComments", async (event, projectIdValue: unknown) => {
    ownerFor(event);
    const requestedProjectId = projectId(projectIdValue);
    if (!(await designProjectStore.get(requestedProjectId))) {
      throw new Error("Design Project was not found.");
    }
    return designCommentStore.listProject(requestedProjectId);
  });

  ipcMain.handle("designer:createComment", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = exactRecord(inputValue, new Set(["expectedDatabaseRevision", "target", "body"]));
    if (
      !Number.isSafeInteger(input.expectedDatabaseRevision) ||
      (input.expectedDatabaseRevision as number) < 0
    ) {
      throw new Error("Invalid Design comment revision.");
    }
    const body = parseDesignCommentBody(input.body);
    if (!body) throw new Error("Invalid Design comment body.");
    const target = await designProjectLifecycle.runProjectMutation(async () => {
      const provenTarget = await requireOwnedCommentTarget(input.target, owner);
      await designCommentStore.create({
        expectedDatabaseRevision: input.expectedDatabaseRevision as number,
        target: provenTarget,
        body,
      });
      return provenTarget;
    });
    return designCommentStore.listProject(target.projectId);
  });

  ipcMain.handle("designer:reconcileCommentTarget", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = exactRecord(inputValue, new Set(["expectedDatabaseRevision", "current"]));
    if (
      !Number.isSafeInteger(input.expectedDatabaseRevision) ||
      (input.expectedDatabaseRevision as number) < 0
    ) {
      throw new Error("Invalid Design comment revision.");
    }
    return designProjectLifecycle.runProjectMutation(async () => {
      const current = await requireOwnedCommentTarget(input.current, owner);
      return designCommentStore.reconcileTarget({
        expectedDatabaseRevision: input.expectedDatabaseRevision as number,
        current,
      });
    });
  });

  for (const operation of ["resolve", "reopen"] as const) {
    ipcMain.handle(`designer:${operation}Comment`, async (event, inputValue: unknown) => {
      ownerFor(event);
      const input = exactRecord(
        inputValue,
        new Set(["projectId", "id", "expectedRevision", "expectedDatabaseRevision"]),
      );
      const { projectId: requestedProjectId, commentId } = await requireProjectComment(
        input.projectId,
        input.id,
      );
      const expectedRevision = projectRevision(input.expectedRevision);
      if (
        !Number.isSafeInteger(input.expectedDatabaseRevision) ||
        (input.expectedDatabaseRevision as number) < 0
      ) {
        throw new Error("Invalid Design comment database revision.");
      }
      await designProjectLifecycle.runProjectMutation(() =>
        designCommentStore[operation]({
          id: commentId,
          expectedRevision,
          expectedDatabaseRevision: input.expectedDatabaseRevision as number,
        }),
      );
      return designCommentStore.listProject(requestedProjectId);
    });
  }

  ipcMain.handle("designer:listProjects", async (event) => {
    ownerFor(event);
    const summaries = await designProjectStore.list();
    const availableAssets = new Set((await designReferenceAssetStore.list()).map(({ id }) => id));
    return Promise.all(
      summaries.map(async ({ id }) => {
        const project = await designProjectStore.get(id);
        if (!project) throw new Error("A Design Project changed while it was being listed.");
        const health = await inspectDesignProjectHealth(project, {
          hasReferenceAsset: async (assetId) => availableAssets.has(assetId),
          artifactSource: (chatId, mediaId) =>
            generativeUiArtifactStore.committedRecoverySourceFor(chatId, mediaId),
        });
        return {
          ...projectSummary(project),
          ...health,
        };
      }),
    );
  });

  ipcMain.handle("designer:openProject", async (event, identityValue: unknown) => {
    ownerFor(event);
    const identity = projectId(identityValue);
    return (
      (await designProjectStore.get(identity)) ??
      (await designProjectStore.getOrMigrateLegacyChat(identity))
    );
  });

  ipcMain.handle("designer:inspectArtifactRecovery", async (event, identityValue: unknown) => {
    ownerFor(event);
    return designArtifactRecoveryService.inspect(projectId(identityValue));
  });

  ipcMain.handle("designer:recoverArtifact", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(inputValue, new Set(["projectId", "expectedRevision"]));
    return designProjectLifecycle.runProjectMutation(() =>
      designArtifactRecoveryService.recover(
        projectId(input.projectId),
        projectRevision(input.expectedRevision),
      ),
    );
  });

  ipcMain.handle("designer:createProject", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = parseDesignProjectCreateParams(inputValue);
    const { title } = input;
    const state = input.connectionState;
    const connectedWorkspaceId = input.workspaceId;
    const create = async (signal?: AbortSignal) => {
      const chat = await chatApplicationService.createDesignConversation({ title }, owner);
      if (!chat) throw new Error("Aiden could not create the Design Project conversation.");
      try {
        if (signal?.aborted) throw signal.reason;
        return await designProjectLifecycle.runProjectMutation(() =>
          designProjectStore.create({
            chatId: chat.id,
            title,
            connectionState: state,
            ...(connectedWorkspaceId ? { workspaceId: connectedWorkspaceId } : {}),
          }),
        );
      } catch (error) {
        if (!(error instanceof DesignProjectPublicationUncertainError)) {
        await chatApplicationService.remove(chat.id);
        }
        throw error;
      }
    };
    if (!connectedWorkspaceId) {
      return create();
    }
    return workspaceEnvironmentApplicationService.run(
      owner,
      connectedWorkspaceId,
      async (_resolved, signal) => create(signal),
    );
  });

  ipcMain.handle("designer:connectProject", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = parseDesignProjectConnectParams(inputValue);
    const requestedProjectId = input.projectId;
    try {
      const project = await designProjectConnectionService.connect(owner, input);
      return { status: "updated" as const, project };
    } catch (error) {
      if (!(error instanceof DesignProjectRevisionConflictError)) throw error;
      const current = await designProjectStore.get(requestedProjectId);
      if (!current) throw error;
      return { status: "conflict" as const, current };
    }
  });

  ipcMain.handle("designer:preflightGeneration", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = parseDesignProjectPreflightParams(inputValue);
    return designProjectConnectionService.preflightGeneration(owner, input.projectId);
  });

  ipcMain.handle("designer:updateProject", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = parseDesignProjectContentUpdateEnvelope(inputValue);
    const canvas = parseDesignProjectCanvasV1(input.canvas);
    if (!canvas || !Array.isArray(input.referenceAssetIds)) {
      throw new Error("Invalid Design Project canvas.");
    }
    const referenceAssetIds = input.referenceAssetIds.map(projectId);
    const requestedProjectId = projectId(input.id);
    try {
      const project = await designProjectLifecycle.runProjectMutation(async () => {
        await requireStoredReferenceAssets(referenceAssetIds);
        const current = await designProjectStore.get(requestedProjectId);
        if (!current) throw new Error("Design Project was not found.");
        return designProjectStore.update({
          id: requestedProjectId,
          expectedRevision: projectRevision(input.expectedRevision),
          connectionState: current.connectionState,
          ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
          canvas,
          referenceAssetIds,
          ...(input.designSystemBinding === undefined
            ? {}
            : {
                designSystemBinding: exactRecord(
                  input.designSystemBinding,
                  new Set(["id", "revision"]),
                ) as unknown as DesignProjectSnapshotV1["designSystemBinding"],
              }),
          ...(input.previewScriptId === undefined
            ? {}
            : { previewScriptId: projectId(input.previewScriptId) }),
        });
      });
      return { status: "updated" as const, project };
    } catch (error) {
      if (!(error instanceof DesignProjectRevisionConflictError)) throw error;
      const current = await designProjectStore.get(requestedProjectId);
      if (!current) throw error;
      return { status: "conflict" as const, current };
    }
  });

  ipcMain.handle("designer:renameProject", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(inputValue, new Set(["id", "expectedRevision", "title"]));
    try {
      const title = normalizeDesignProjectTitle(input.title);
      if (!title) throw new Error("Invalid Design Project title.");
      const project = await designProjectLifecycle.runProjectMutation(() =>
        designProjectStore.rename({
          id: projectId(input.id),
          expectedRevision: projectRevision(input.expectedRevision),
          title,
        }),
      );
      return { status: "updated" as const, project };
    } catch (error) {
      if (!(error instanceof DesignProjectRevisionConflictError)) throw error;
      const current = await designProjectStore.get(projectId(input.id));
      if (!current) throw error;
      return { status: "conflict" as const, current };
    }
  });

  ipcMain.handle("designer:duplicateProject", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set(["id", "expectedRevision", "title"]),
      new Set(["id", "expectedRevision"]),
    );
    return designProjectLifecycle.duplicate({
      id: projectId(input.id),
      expectedRevision: projectRevision(input.expectedRevision),
      ...(input.title === undefined
        ? {}
        : { title: string(input.title, "Design Project title", 160) }),
    });
  });

  ipcMain.handle("designer:previewDeleteProject", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(inputValue, new Set(["id", "expectedRevision"]));
    return designProjectLifecycle.previewDelete({
      id: projectId(input.id),
      expectedRevision: projectRevision(input.expectedRevision),
    });
  });

  ipcMain.handle("designer:deleteProject", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(inputValue, new Set(["id", "expectedRevision"]));
    await designProjectLifecycle.deleteProject(
      {
        id: projectId(input.id),
        expectedRevision: projectRevision(input.expectedRevision),
      },
      (plan) => {
        if (llmClient.isChatBusy(plan.chatId)) {
          throw new Error(
            "Finish or stop the current Design response before deleting this project.",
          );
        }
      },
    );
    return { status: "deleted" as const };
  });

  ipcMain.handle("designer:applyPrototypeDirectEdit", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set(["operationId", "projectId", "lineageId", "mediaId", "selection", "edit"]),
    );
    const operationId = parseRendererPrototypeGestureId(input.operationId);
    if (!operationId) throw new Error("Invalid Design direct-edit operation identity.");
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project) throw new Error("Design Project was not found.");
    const lineageId = projectId(input.lineageId);
    const mediaId = projectId(input.mediaId);
    const node = project.canvas.nodes.find(
      (candidate) =>
        candidate.kind === "artboard" &&
        candidate.lineageId === lineageId &&
        candidate.artifactMediaIds?.includes(mediaId),
    );
    if (!node) throw new Error("The selected Design revision is stale.");
    const source = await generativeUiArtifactStore.committedRecoverySourceFor(
      project.chatId,
      mediaId,
    );
    if (!source) throw new Error("The selected Design revision is unavailable.");
    if (!isUsablePublishedDesignSource(project, source)) {
      throw new Error("The selected Design revision is damaged. Repair it before editing.");
    }
    const selection = parseDesignElementSelection(input.selection);
    const edit = parseDesignDirectEdit(input.edit);
    if (
      !selection?.elementId ||
      selection.selector !== `[data-aiden-id="${selection.elementId}"]` ||
      !edit
    ) {
      throw new Error("Direct edits require one exact stable element and a literal value.");
    }
    return designProjectLifecycle.runProjectMutation(() =>
      designDirectEditService.applyPrototype({
        gestureId: operationId,
        target: {
          origin: "prototype",
          projectId: project.id,
          lineageId,
          mediaId,
          artifactId: source.artifact.id,
          selection: {
            selector: selection.selector,
            tagName: selection.tagName,
            elementId: selection.elementId,
          },
          proof: {
            selectorMatchCount: 1,
            componentMatchCount: 1,
            literalDefinitionMatchCount: 1,
            computedClass: false,
            dynamicValue: false,
            localizedText: false,
            richText: false,
            semanticColorTokens: edit.kind === "color-token" ? [edit.token] : [],
          },
        },
        edit,
      }),
    );
  });

  ipcMain.handle("designer:undoPrototypeDirectEdit", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set(["projectId", "lineageId", "editedMediaId", "revertMediaId", "undoId"]),
    );
    return designProjectLifecycle.runProjectMutation(() =>
      designDirectEditService.undoPrototype({
        projectId: projectId(input.projectId),
        lineageId: projectId(input.lineageId),
        editedMediaId: projectId(input.editedMediaId),
        revertMediaId: projectId(input.revertMediaId),
        undoId: string(input.undoId, "direct-edit undo", 128),
      }),
    );
  });

  ipcMain.handle("designer:applyConnectedDirectEdit", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set(["operationId", "projectId", "sourceSelectionId", "edit"]),
    );
    const operationId = parseRendererDirectEditGestureId(input.operationId);
    if (!operationId) throw new Error("Invalid Design direct-edit operation identity.");
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project?.workspaceId || project.connectionState !== "connected") {
      throw new Error("This Design Project is not connected to a workspace.");
    }
    const sourceSelectionId = string(input.sourceSelectionId, "source selection", 128);
    const binding = await sourceDesignerActionService.resolve(
      owner,
      project.workspaceId,
      sourceSelectionId,
    );
    const sourceNode = project.canvas.nodes.find(({ kind }) => kind === "source-preview");
    if (!sourceNode) throw new Error("The connected preview is not saved on this canvas.");
    const edit = parseDesignDirectEdit(input.edit);
    if (!edit) throw new Error("The direct edit value is invalid or unsupported.");
    const result = await designDirectEditService.applyConnected({
      owner,
      chatId: project.chatId,
      sourceSelectionId,
      gestureId: operationId,
      target: {
        origin: "connected-app",
        projectId: project.id,
        lineageId: sourceNode.id,
        mediaId: binding.sourceVersion,
        workspaceId: project.workspaceId,
        path: binding.path,
        sourceVersion: binding.sourceVersion,
        start: binding.start,
        end: binding.end,
        preimage: binding.snippet,
        preimageHash: createHash("sha256").update(binding.snippet, "utf8").digest("hex"),
        selection: {
          selector: binding.selection.selector,
          tagName: binding.selection.tagName,
          ...(binding.selection.elementId ? { elementId: binding.selection.elementId } : {}),
        },
        proof: {
          selectorMatchCount: 1,
          componentMatchCount: 1,
          literalDefinitionMatchCount: 1,
          computedClass: false,
          dynamicValue: false,
          localizedText: false,
          richText: false,
          semanticColorTokens: edit.kind === "color-token" ? [edit.token] : [],
        },
      },
      edit,
    });
    const afterSource =
      binding.source.slice(0, binding.start) +
      result.action.after +
      binding.source.slice(binding.end);
    const postProof = await sourceDesignerActionService.connectedComponentPostimageProof(
      binding,
      afterSource,
    );
    if (!postProof) {
      sourceDesignerActionService.discardForDurable(owner, result.action.id);
      throw new Error("The proposed source no longer has one proven component instance.");
    }
    try {
      const record = await designProjectLifecycle.runProjectMutation(async () => {
        const current = await designProjectStore.get(project.id);
        if (
          !current ||
          current.revision !== project.revision ||
          current.chatId !== project.chatId ||
          current.workspaceId !== project.workspaceId ||
          current.connectionState !== "connected" ||
          !current.canvas.nodes.some(
            (node) => node.kind === "source-preview" && node.id === sourceNode.id,
          )
        ) {
          throw new Error("The Design Project changed while this edit was being prepared.");
        }
        return sourceDesignerMultifileCoordinator.prepare({
          actionId: `multifile:${createHash("sha256").update(result.proposalId).digest("hex")}`,
          workspaceId: current.workspaceId!,
          projectId: current.id,
          chatId: current.chatId,
          projectRevision: current.revision,
          sourceNodeId: sourceNode.id,
          sourceSelectionId,
          ...(binding.sourceManifestHash ? { sourceManifestHash: binding.sourceManifestHash } : {}),
          sourcePath: binding.path,
          sourceStart: binding.start,
          sourceEnd: binding.end,
          sourceLineNumber: binding.lineNumber,
          sourceColumnNumber: binding.columnNumber,
          ...(binding.componentName ? { sourceComponentName: binding.componentName } : {}),
          sourceSelector: binding.selection.selector,
          sourceTagName: binding.selection.tagName,
          ...(binding.selection.elementId ? { sourceElementId: binding.selection.elementId } : {}),
          sourceAfterManifestHash: postProof.manifestHash,
          sourceAfterVersion: postProof.sourceVersion,
          sourceAfterStart: postProof.start,
          sourceAfterEnd: postProof.end,
          sourceAfterLineNumber: postProof.lineNumber,
          sourceAfterColumnNumber: postProof.columnNumber,
          label: result.action.label,
          files: [
            {
              path: binding.path,
              expectedBeforeSha256: binding.sourceVersion,
              afterBytes: Buffer.from(afterSource, "utf8"),
            },
          ],
        });
      });
      sourceDesignerActionService.discardForDurable(owner, result.action.id);
      const action = await sourceDesignerMultifileAction(project.id, record.actionId);
      owner.send("designer:multifile-action-changed", { action });
      return {
        kind: "durable-designer-action" as const,
        proposalId: result.proposalId,
        action,
      };
    } catch (error) {
      sourceDesignerActionService.discardForDurable(owner, result.action.id);
      throw error;
    }
  });

  ipcMain.handle("designer:attachDesignSystem", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set(["projectId", "expectedRevision", "name", "sources", "packageRoot", "routeScope"]),
    );
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project) throw new Error("Design Project was not found.");
    if (project.revision !== projectRevision(input.expectedRevision)) {
      throw new DesignProjectRevisionConflictError(project.revision);
    }
    if (project.designSystemBinding) {
      throw new Error("Detach the current design system before attaching another one.");
    }
    const selection = await designSystemExtractionInput(project, {
      name: string(input.name, "design-system name", 160),
      sources: designSystemSources(input.sources),
      packageRoot: string(input.packageRoot, "design-system package root", 256),
      routeScope: string(input.routeScope, "design-system route scope", 160),
    });
    const attachment = await withDesignSystemWorkspace(owner, project, selection, (reviewed) =>
      designSystemAttachmentService.attach(reviewed),
    );
    try {
      const updated = await designProjectLifecycle.runProjectMutation(() =>
        designProjectStore.update({
          id: project.id,
          expectedRevision: project.revision,
          connectionState: project.connectionState,
          workspaceId: project.workspaceId,
          canvas: project.canvas,
          referenceAssetIds: project.referenceAssetIds,
          designSystemBinding: {
            id: attachment.attachmentId,
            revision: attachment.revision,
          },
        }),
      );
      const projection = await withDesignSystemWorkspace(owner, updated, selection, (reviewed) =>
        designSystemAttachmentService.rendererProjection(attachment.attachmentId, reviewed),
      );
      return { project: updated, projection };
    } catch (error) {
      await designSystemAttachmentService
        .detach(attachment.attachmentId, attachment.revision)
        .catch(() => undefined);
      throw error;
    }
  });

  ipcMain.handle("designer:designSystemProjection", async (event, projectIdValue: unknown) => {
    const owner = ownerFor(event);
    const project = await designProjectStore.get(projectId(projectIdValue));
    if (!project?.designSystemBinding) return undefined;
    const selection = await designSystemExtractionInput(project);
    return withDesignSystemWorkspace(owner, project, selection, (reviewed) =>
      designSystemAttachmentService.rendererProjection(project.designSystemBinding!.id, reviewed),
    );
  });

  ipcMain.handle("designer:designSystemModelContext", async (event, projectIdValue: unknown) => {
    const owner = ownerFor(event);
    const project = await designProjectStore.get(projectId(projectIdValue));
    if (!project?.designSystemBinding || !project.workspaceId) return undefined;
    return workspaceEnvironmentApplicationService.run(owner, project.workspaceId, (resolved) =>
      currentDesignSystemModelContext(project, resolved.folderPath),
    );
  });

  ipcMain.handle("designer:refreshDesignSystem", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = exactRecord(inputValue, new Set(["projectId", "expectedRevision"]));
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project?.designSystemBinding)
      throw new Error("This project has no design system attached.");
    if (project.revision !== projectRevision(input.expectedRevision)) {
      throw new DesignProjectRevisionConflictError(project.revision);
    }
    const selection = await designSystemExtractionInput(project);
    const attachment = await withDesignSystemWorkspace(owner, project, selection, (reviewed) =>
      designSystemAttachmentService.refresh(
        project.designSystemBinding!.id,
        project.designSystemBinding!.revision,
        reviewed,
      ),
    );
    const updated = await designProjectLifecycle.runProjectMutation(() =>
      designProjectStore.update({
        id: project.id,
        expectedRevision: project.revision,
        connectionState: project.connectionState,
        workspaceId: project.workspaceId,
        canvas: project.canvas,
        referenceAssetIds: project.referenceAssetIds,
        designSystemBinding: {
          id: attachment.attachmentId,
          revision: attachment.revision,
        },
      }),
    );
    const projection = await withDesignSystemWorkspace(owner, updated, selection, (reviewed) =>
      designSystemAttachmentService.rendererProjection(attachment.attachmentId, reviewed),
    );
    return { project: updated, projection };
  });

  ipcMain.handle("designer:detachDesignSystem", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(inputValue, new Set(["projectId", "expectedRevision"]));
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project?.designSystemBinding)
      throw new Error("This project has no design system attached.");
    if (project.revision !== projectRevision(input.expectedRevision)) {
      throw new DesignProjectRevisionConflictError(project.revision);
    }
    const updated = await designProjectLifecycle.runProjectMutation(() =>
      designProjectStore.update({
        id: project.id,
        expectedRevision: project.revision,
        connectionState: project.connectionState,
        workspaceId: project.workspaceId,
        canvas: project.canvas,
        referenceAssetIds: project.referenceAssetIds,
      }),
    );
    await designSystemAttachmentService.detach(
      project.designSystemBinding.id,
      project.designSystemBinding.revision,
    );
    return updated;
  });

  ipcMain.handle(
    "designer:previewManagedHandoff",
    async (event, projectIdValue: unknown, workspaceIdValue?: unknown) => {
      ownerFor(event);
      const project = await designProjectStore.get(projectId(projectIdValue));
      if (!project) throw new Error("Design Project was not found.");
      const sourceWorkspaceId =
        project.connectionState === "connected" && project.workspaceId
          ? project.workspaceId
          : string(workspaceIdValue, "handoff source workspace", 128);
      return designHandoffApplicationService.previewManagedTarget(sourceWorkspaceId);
    },
  );

  ipcMain.handle(
    "designer:previewExistingHandoff",
    async (event, projectIdValue: unknown, workspaceIdValue?: unknown) => {
      ownerFor(event);
      const project = await designProjectStore.get(projectId(projectIdValue));
      if (!project) throw new Error("Design Project was not found.");
      const sourceWorkspaceId =
        project.connectionState === "connected" && project.workspaceId
          ? project.workspaceId
          : string(workspaceIdValue, "handoff target workspace", 128);
      return designHandoffApplicationService.previewExistingTarget(sourceWorkspaceId);
    },
  );

  ipcMain.handle("designer:beginManagedHandoff", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set([
        "projectId",
        "expectedRevision",
        "lineageId",
        "mediaId",
        "previewDigest",
        "dirtyCheckoutAcknowledged",
        "sourceWorkspaceId",
        "operationId",
      ]),
      new Set([
        "projectId",
        "expectedRevision",
        "lineageId",
        "mediaId",
        "previewDigest",
        "dirtyCheckoutAcknowledged",
        "operationId",
      ]),
    );
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project) throw new Error("Design Project was not found.");
    if (project.revision !== projectRevision(input.expectedRevision)) {
      throw new DesignProjectRevisionConflictError(project.revision);
    }
    const sourceWorkspaceId =
      project.connectionState === "connected" && project.workspaceId
        ? project.workspaceId
        : string(input.sourceWorkspaceId, "handoff source workspace", 128);
    const preview = await designHandoffApplicationService.previewManagedTarget(sourceWorkspaceId);
    if (preview.previewDigest !== string(input.previewDigest, "handoff preview digest", 128)) {
      throw new Error("The handoff target changed. Review it again before continuing.");
    }
    if (typeof input.dirtyCheckoutAcknowledged !== "boolean") {
      throw new Error("Invalid handoff acknowledgement.");
    }
    const packet = await designHandoffPacket(project, input.lineageId, input.mediaId);
    return designHandoffApplicationService.begin({
      operationId: string(input.operationId, "handoff operation", 128),
      packet,
      target: {
        kind: "managed-worktree",
        source: preview.source,
        previewDigest: preview.previewDigest,
        expectedCommittedHead: preview.expectedCommittedHead,
        dirtyCheckout: preview.dirtyCheckout,
        ...(preview.dirtyCheckout && input.dirtyCheckoutAcknowledged
          ? {
              dirtyCheckoutAcknowledgement: preview.requiredDirtyCheckoutAcknowledgement!,
            }
          : {}),
      },
    });
  });

  ipcMain.handle("designer:beginExistingHandoff", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(
      inputValue,
      new Set([
        "projectId",
        "expectedRevision",
        "lineageId",
        "mediaId",
        "previewDigest",
        "sourceWorkspaceId",
        "strongWarningAcknowledged",
        "operationId",
      ]),
      new Set([
        "projectId",
        "expectedRevision",
        "lineageId",
        "mediaId",
        "previewDigest",
        "strongWarningAcknowledged",
        "operationId",
      ]),
    );
    const project = await designProjectStore.get(projectId(input.projectId));
    if (!project) throw new Error("Design Project was not found.");
    if (project.revision !== projectRevision(input.expectedRevision)) {
      throw new DesignProjectRevisionConflictError(project.revision);
    }
    const sourceWorkspaceId =
      project.connectionState === "connected" && project.workspaceId
        ? project.workspaceId
        : string(input.sourceWorkspaceId, "handoff target workspace", 128);
    const preview = await designHandoffApplicationService.previewExistingTarget(sourceWorkspaceId);
    if (preview.previewDigest !== string(input.previewDigest, "handoff preview digest", 128)) {
      throw new Error("The handoff target changed. Review it again before continuing.");
    }
    if (input.strongWarningAcknowledged !== true) {
      throw new Error("Acknowledge the existing-workspace warning before continuing.");
    }
    const packet = await designHandoffPacket(project, input.lineageId, input.mediaId);
    return designHandoffApplicationService.begin({
      operationId: string(input.operationId, "handoff operation", 128),
      packet,
      target: {
        kind: "existing-workspace",
        target: preview.target,
        previewDigest: preview.previewDigest,
        strongWarningAcknowledgement: preview.requiredStrongWarningAcknowledgement,
      },
    });
  });

  ipcMain.handle("designer:cancelHandoff", async (event, operationIdValue: unknown) => {
    ownerFor(event);
    return designHandoffApplicationService.cancel(
      string(operationIdValue, "handoff operation", 128),
    );
  });

  ipcMain.handle("designer:resumeHandoff", async (event, operationIdValue: unknown) => {
    ownerFor(event);
    return designHandoffApplicationService.resume(
      string(operationIdValue, "handoff operation", 128),
    );
  });

  ipcMain.handle("designer:projectHandoffLinks", async (event, projectIdValue: unknown) => {
    ownerFor(event);
    const project = await designProjectStore.get(projectId(projectIdValue));
    if (!project) throw new Error("Design Project was not found.");
    return designHandoffApplicationService.linksForProject(project.id);
  });

  ipcMain.handle("designer:projectHandoffRecoveries", async (event, projectIdValue: unknown) => {
    ownerFor(event);
    const project = await designProjectStore.get(projectId(projectIdValue));
    if (!project) throw new Error("Design Project was not found.");
    return designHandoffApplicationService.recoveriesForProject(project.id);
  });

  ipcMain.handle(
    "designer:readGeneratedSource",
    async (event, projectIdValue: unknown, lineageIdValue: unknown, mediaIdValue: unknown) => {
      ownerFor(event);
      const project = await designProjectStore.get(projectId(projectIdValue));
      if (!project) throw new Error("Design Project was not found.");
      const lineageId = projectId(lineageIdValue);
      const mediaId = projectId(mediaIdValue);
      const node = project.canvas.nodes.find(
        (candidate) => candidate.kind === "artboard" && candidate.lineageId === lineageId,
      );
      if (!node?.artifactMediaIds?.includes(mediaId)) {
        throw new Error("That source revision does not belong to this Design Project.");
      }
      const source = await generativeUiArtifactStore.committedRecoverySourceFor(
        project.chatId,
        mediaId,
      );
      if (!source) throw new Error("That generated source revision is unavailable.");
      if (!isUsablePublishedDesignSource(project, source)) {
        throw new Error(
          "That generated source revision is damaged. Repair it before viewing code.",
        );
      }
      const hash = createHash("sha256").update(source.html, "utf8").digest("hex");
      return {
        filename: "index.html",
        language: "html",
        content: source.html,
        byteSize: Buffer.byteLength(source.html, "utf8"),
        contentHash: hash,
        revisionLabel: source.artifact.title,
        revisionId: source.artifact.mediaId,
        lineageId,
        createdAt: source.createdAt,
        provenance: source.model ? `Generated with ${source.model}` : "Generated by Aiden",
        ...(source.model ? { model: source.model } : {}),
        readOnly: true,
      };
    },
  );

  ipcMain.handle(
    "designer:readConnectedSource",
    async (event, projectIdValue: unknown, selectionIdValue: unknown) => {
      const owner = ownerFor(event);
      const project = await designProjectStore.get(projectId(projectIdValue));
      if (!project?.workspaceId || project.connectionState !== "connected") {
        throw new Error("This Design Project is not connected to a workspace.");
      }
      const source = await sourceDesignerActionService.readBoundSource(
        owner,
        project.workspaceId,
        string(selectionIdValue, "source selection", 128),
      );
      const extension = source.path.split(".").pop()?.toLocaleLowerCase();
      const language =
        extension === "tsx"
          ? "tsx"
          : extension === "jsx"
            ? "jsx"
            : extension === "ts"
              ? "typescript"
              : "javascript";
      return {
        filename: source.path,
        language,
        content: source.content,
        byteSize: Buffer.byteLength(source.content, "utf8"),
        contentHash: source.sourceVersion,
        revisionLabel: "Proven workspace snapshot",
        provenance: "Authorized local workspace read",
        readOnly: true,
      };
    },
  );

  ipcMain.handle(
    "designer:exportProjectBundle",
    async (event, projectIdValue: unknown, lineageIdValue: unknown, mediaIdValue: unknown) => {
      const owner = ownerFor(event);
      const project = await designProjectStore.get(projectId(projectIdValue));
      if (!project) throw new Error("Design Project was not found.");
      const lineageId = projectId(lineageIdValue);
      const mediaId = projectId(mediaIdValue);
      const node = project.canvas.nodes.find(
        (candidate) => candidate.kind === "artboard" && candidate.lineageId === lineageId,
      );
      if (!node?.artifactMediaIds?.includes(mediaId)) {
        throw new Error("That source revision does not belong to this Design Project.");
      }
      const source = await generativeUiArtifactStore.committedRecoverySourceFor(
        project.chatId,
        mediaId,
      );
      if (!source) throw new Error("That generated source revision is unavailable.");
      if (!isUsablePublishedDesignSource(project, source)) {
        throw new Error("That generated source revision is damaged. Repair it before exporting.");
      }
      const references = await Promise.all(
        project.referenceAssetIds.map(async (assetId) => {
          const stored = await designReferenceAssetStore.read(assetId);
          if (!stored) throw new Error("A Design reference image is unavailable.");
          const extensionByMimeType: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
            "image/bmp": "bmp",
            "image/heic": "heic",
            "image/heif": "heif",
          };
          const extension = extensionByMimeType[stored.asset.mimeType];
          if (!extension) throw new Error("A Design reference image type is unsupported.");
          return {
            relativePath: `${stored.asset.id}.${extension}`,
            bytes: stored.bytes,
          };
        }),
      );
      const contentHash = createHash("sha256").update(source.html, "utf8").digest("hex");
      const revision = node.artifactMediaIds.indexOf(mediaId) + 1;
      const bundle = buildDesignProjectExportBundle({
        projectId: project.id,
        projectTitle: project.title,
        lineageId,
        revision,
        contentHash,
        sourceRevisionTimestamp: new Date(source.createdAt).toISOString(),
        indexHtml: source.html,
        referenceAssets: references,
      });
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) throw new Error("The export window is unavailable.");
      const result = await dialog.showSaveDialog(parent, {
        title: "Export Design source bundle",
        defaultPath: bundle.fileName,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (result.canceled || !result.filePath) return { status: "cancelled" as const };
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      await writeDesignProjectExport(result.filePath, bundle.getZipBytes());
      try {
        const history = await designProjectExportHistoryStore.record({
          projectId: project.id,
          lineageId,
          mediaId,
          contentHash,
          filePath: result.filePath,
        });
        return {
          status: "saved" as const,
          exportId: history.id,
          fileName: history.fileName,
        };
      } catch (error) {
        logger.warn(
          "design-project",
          "The source bundle was saved, but its Reveal shortcut could not be recorded.",
          error,
        );
        return { status: "saved" as const };
      }
    },
  );

  ipcMain.handle("designer:latestProjectExport", async (event, projectIdValue: unknown) => {
    ownerFor(event);
    return designProjectExportHistoryStore.latestForProject(projectId(projectIdValue));
  });

  ipcMain.handle(
    "designer:revealProjectExport",
    async (event, projectIdValue: unknown, exportIdValue: unknown) => {
      ownerFor(event);
      const requestedProjectId = projectId(projectIdValue);
      const record = await designProjectExportHistoryStore.get(projectId(exportIdValue));
      if (!record || record.projectId !== requestedProjectId) {
        throw new Error("That Design export is unavailable.");
      }
      shell.showItemInFolder(record.filePath);
      return true;
    },
  );

  ipcMain.handle("designer:putReferenceAsset", async (event, inputValue: unknown) => {
    ownerFor(event);
    if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) {
      throw new Error("Invalid Design reference image.");
    }
    const input = inputValue as Record<string, unknown>;
    if (
      Object.keys(input).length !== 3 ||
      !("name" in input) ||
      !("mimeType" in input) ||
      !("data" in input) ||
      typeof input.data !== "string" ||
      input.data.length === 0 ||
      input.data.length > MAX_DESIGN_REFERENCE_BASE64_CHARS ||
      input.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.data)
    ) {
      throw new Error("Invalid Design reference image.");
    }
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data) {
      throw new Error("Invalid Design reference image.");
    }
    return designReferenceAssetStore.put({
      name: string(input.name, "Design reference image name", 255),
      mimeType: string(input.mimeType, "Design reference image type", 64),
      bytes,
    });
  });

  ipcMain.handle("designer:readReferenceAsset", async (event, assetIdValue: unknown) => {
    ownerFor(event);
    const result = await designReferenceAssetStore.read(
      string(assetIdValue, "Design reference image identity", 64),
    );
    return result ? { asset: result.asset, data: result.bytes.toString("base64") } : undefined;
  });

  ipcMain.handle("designer:removeMissingReferenceAsset", async (event, inputValue: unknown) => {
    ownerFor(event);
    const input = exactRecord(inputValue, new Set(["projectId", "expectedRevision", "assetId"]));
    return designProjectLifecycle.runProjectMutation(() =>
      designReferenceRecoveryService.removeMissing({
        projectId: projectId(input.projectId),
        expectedRevision: projectRevision(input.expectedRevision),
        assetId: string(input.assetId, "Design reference image identity", 64),
      }),
    );
  });

  ipcMain.handle("designer:previewState", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const { projectId: requestedProjectId } = parseDesignProjectPreviewParams(inputValue);
    return designProjectLifecycle.runProjectMutation(async () => {
      const project = await requireConnectedProject(requestedProjectId);
      return workspaceEnvironmentApplicationService.run(
        owner,
        project.workspaceId!,
        async (resolved) => {
        const current = await requireConnectedProject(requestedProjectId);
        assertSameConnectedDesignProjectBinding(current, project);
          return sourceDesignPreviewService.state(owner, project.id, resolved.folderPath);
        },
        );
    });
  });

  ipcMain.handle("designer:stopPreview", async (event, inputValue: unknown) => {
    ownerFor(event);
    const { projectId: requestedProjectId } = parseDesignProjectPreviewParams(inputValue);
    await designProjectLifecycle.runProjectMutation(async () => {
      const project = await requireConnectedProject(requestedProjectId);
      await sourceDesignPreviewService.stopProject(project.id);
    });
  });

  ipcMain.handle("designer:startPreview", async (event, inputValue: unknown) => {
      const owner = ownerFor(event);
      const input = parseDesignProjectStartPreviewParams(inputValue);
      return designProjectLifecycle.runProjectMutation(async () => {
        const project = await requireConnectedProject(input.projectId);
        const workspaceId = project.workspaceId;
        if (workspaceMutationGate.isChanging(workspaceId)) {
          throw new Error("The workspace is changing. Try again in a moment.");
        }
        const admission = admitOwnedWorkspaceOperation(
          workspaceOperationRegistry,
          owner,
          workspaceId,
        );
        try {
          if (
            owner.isDestroyed() ||
            admission.signal.aborted ||
            workspaceMutationGate.isChanging(workspaceId)
          ) {
            throw new Error("The workspace changed before the preview could start.");
          }
          const resolved = await workspaceEnvironmentApplicationService.resolve(workspaceId, true);
          if (!resolved) throw new Error("The workspace folder is unavailable.");
          const current = await requireConnectedProject(input.projectId);
          assertSameConnectedDesignProjectBinding(current, project);
          if (
            owner.isDestroyed() ||
            admission.signal.aborted ||
            workspaceMutationGate.isChanging(workspaceId)
          ) {
            throw new Error("The workspace changed before the preview could start.");
          }
          // The preview service owns and releases this admission for the full
          // lifetime of the child process after a successful start.
          return await sourceDesignPreviewService.start({
            owner,
            admission,
            projectId: project.id,
            workspaceId,
            root: resolved.folderPath,
            scriptId: input.scriptId,
          });
        } catch (error) {
          admission.release();
          throw error;
        }
    });
      });

  ipcMain.handle("designer:bindSelection", async (event, inputValue: unknown) => {
      const owner = ownerFor(event);
      const input = parseDesignProjectBindSelectionParams(inputValue);
      const descriptor = parseSourceElementDescriptor(input.descriptor);
      if (!descriptor) throw new Error("The selected element context is invalid.");
      return designProjectLifecycle.runProjectMutation(async () => {
        const project = await requireConnectedProject(input.projectId);
        return workspaceEnvironmentApplicationService.run(owner, project.workspaceId, async () => {
          const current = await requireConnectedProject(input.projectId);
          assertSameConnectedDesignProjectBinding(current, project);
          return sourceDesignerActionService.bind(
            owner,
            project.id,
            project.workspaceId,
            input.sessionId,
            descriptor,
          );
      });
        });
      });

  ipcMain.handle("designer:listActions", async (event, inputValue: unknown) => {
      const owner = ownerFor(event);
      const { projectId: requestedProjectId } = parseDesignProjectPreviewParams(inputValue);
      return designProjectLifecycle.runProjectMutation(async () => {
        const project = await requireConnectedProject(requestedProjectId);
        return sourceDesignerActionService.list(
          owner,
          project.id,
          project.chatId,
          project.workspaceId,
        );
    });
      });

  ipcMain.handle("designer:listMultifileActions", async (event, projectIdValue: unknown) => {
    ownerFor(event);
    const requestedProjectId = projectId(projectIdValue);
    if (!(await designProjectStore.get(requestedProjectId))) {
      throw new Error("Design Project was not found.");
    }
    return listSourceDesignerMultifileActions(requestedProjectId);
  });

  ipcMain.handle(
    "designer:applyMultifileAction",
    async (event, projectIdValue: unknown, actionIdValue: unknown) => {
      const owner = ownerFor(event);
      const requestedProjectId = projectId(projectIdValue);
      const actionId = string(actionIdValue, "multi-file Designer Action", 128);
      await designProjectLifecycle.runProjectMutation(async () => {
        const project = await designProjectStore.get(requestedProjectId);
        const action = await sourceDesignerMultifileJournal.get(actionId);
        if (
          !project?.workspaceId ||
          project.connectionState !== "connected" ||
          !action ||
          action.projectId !== project.id ||
          action.chatId !== project.chatId ||
          action.workspaceId !== project.workspaceId ||
          action.projectRevision !== project.revision ||
          !action.sourceNodeId ||
          !project.canvas.nodes.some(
            (node) => node.kind === "source-preview" && node.id === action.sourceNodeId,
          )
        ) {
          throw new Error(
            "This Designer Action's saved project authority changed. Review a new proposal.",
          );
        }
        await workspaceEnvironmentApplicationService.run(
          owner,
          project.workspaceId,
          async (resolved) => {
            const sourceFile = action.files.find(({ path }) => path === action.sourcePath);
            if (
              !sourceFile ||
              !action.sourceSelectionId ||
              !action.sourceManifestHash ||
              action.sourceStart === undefined ||
              action.sourceEnd === undefined ||
              action.sourceLineNumber === undefined ||
              action.sourceColumnNumber === undefined ||
              !action.sourceComponentName ||
              !action.sourceSelector ||
              !action.sourceTagName ||
              !action.sourceAfterManifestHash ||
              action.sourceAfterVersion !== sourceFile?.after.sha256 ||
              action.sourceAfterStart === undefined ||
              action.sourceAfterEnd === undefined ||
              action.sourceAfterLineNumber === undefined ||
              action.sourceAfterColumnNumber === undefined
            ) {
              throw new Error(
                "This Designer Action predates durable source authority proofs. Review a new proposal.",
              );
            }
            const proveOwnership = (input: {
              source: string;
              sourceVersion: string;
              start: number;
              end: number;
              lineNumber: number;
              columnNumber: number;
              manifestHash: string;
            }) =>
              sourceDesignerActionService.proveDurableConnectedComponentSingleUse({
                selectionId: action.sourceSelectionId!,
                workspaceId: action.workspaceId,
                root: resolved.folderPath,
                path: sourceFile.path,
                ...input,
                componentName: action.sourceComponentName!,
                selector: action.sourceSelector!,
                tagName: action.sourceTagName!,
                ...(action.sourceElementId ? { elementId: action.sourceElementId } : {}),
              });
            await sourceDesignerMultifileCoordinator.apply(actionId, {
              before: () =>
                proveOwnership({
                  source: Buffer.from(sourceFile.before.base64, "base64").toString("utf8"),
                  sourceVersion: sourceFile.before.sha256,
                  start: action.sourceStart!,
                  end: action.sourceEnd!,
                  lineNumber: action.sourceLineNumber!,
                  columnNumber: action.sourceColumnNumber!,
                  manifestHash: action.sourceManifestHash!,
                }),
              after: () =>
                proveOwnership({
                  source: Buffer.from(sourceFile.after.base64, "base64").toString("utf8"),
                  sourceVersion: action.sourceAfterVersion!,
                  start: action.sourceAfterStart!,
                  end: action.sourceAfterEnd!,
                  lineNumber: action.sourceAfterLineNumber!,
                  columnNumber: action.sourceAfterColumnNumber!,
                  manifestHash: action.sourceAfterManifestHash!,
                }),
            });
          },
        );
      });
      const updated = await sourceDesignerMultifileAction(requestedProjectId, actionId);
      owner.send("designer:multifile-action-changed", { action: updated });
      return updated;
    },
  );

  ipcMain.handle(
    "designer:undoMultifileAction",
    async (event, projectIdValue: unknown, actionIdValue: unknown) => {
      const owner = ownerFor(event);
      const requestedProjectId = projectId(projectIdValue);
      const actionId = string(actionIdValue, "multi-file Designer Action", 128);
      await designProjectLifecycle.runProjectMutation(async () => {
        const project = await designProjectStore.get(requestedProjectId);
        const action = await sourceDesignerMultifileJournal.get(actionId);
        if (
          !project?.workspaceId ||
          project.connectionState !== "connected" ||
          !action ||
          action.projectId !== project.id ||
          action.workspaceId !== project.workspaceId
        ) {
          throw new Error("That multi-file Designer Action is outside this Design Project.");
        }
        await workspaceEnvironmentApplicationService.run(owner, project.workspaceId, () =>
          sourceDesignerMultifileCoordinator.undo(actionId),
        );
      });
      const updated = await sourceDesignerMultifileAction(requestedProjectId, actionId);
      owner.send("designer:multifile-action-changed", { action: updated });
      return updated;
    },
  );

  ipcMain.handle("designer:applyAction", async (event, inputValue: unknown) => {
      const owner = ownerFor(event);
      const input = parseDesignProjectActionParams(inputValue);
      return designProjectLifecycle.runProjectMutation(async () => {
        const project = await requireConnectedProject(input.projectId);
        requireProjectAction(owner, project, input.actionId);
        return workspaceEnvironmentApplicationService.run(
          owner,
          project.workspaceId,
          async (resolved, signal) => {
            const current = await requireConnectedProject(input.projectId);
            assertSameConnectedDesignProjectBinding(current, project);
            requireProjectAction(owner, current, input.actionId);
            return sourceDesignerActionService.apply(
              owner,
              input.actionId,
              resolved.folderPath,
              signal,
            );
          },
        );
    });
      });

  ipcMain.handle("designer:rejectAction", async (event, inputValue: unknown) => {
    const owner = ownerFor(event);
    const input = parseDesignProjectActionParams(inputValue);
    return designProjectLifecycle.runProjectMutation(async () => {
      const project = await requireConnectedProject(input.projectId);
      requireProjectAction(owner, project, input.actionId);
      return sourceDesignerActionService.reject(owner, input.actionId);
    });
  });

  ipcMain.handle("designer:undoAction", async (event, inputValue: unknown) => {
      const owner = ownerFor(event);
      const input = parseDesignProjectActionParams(inputValue);
      return designProjectLifecycle.runProjectMutation(async () => {
        const project = await requireConnectedProject(input.projectId);
        requireProjectAction(owner, project, input.actionId);
        return workspaceEnvironmentApplicationService.run(
          owner,
          project.workspaceId,
          async (resolved, signal) => {
            const current = await requireConnectedProject(input.projectId);
            assertSameConnectedDesignProjectBinding(current, project);
            requireProjectAction(owner, current, input.actionId);
            return sourceDesignerActionService.undo(
              owner,
              input.actionId,
              resolved.folderPath,
              signal,
            );
          },
        );
    });
      });
}
