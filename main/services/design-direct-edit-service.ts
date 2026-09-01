import { createHash } from "node:crypto";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION } from "../../renderer/shared/chat-artifacts.js";
import { DESIGN_ARTIFACT_MEDIA_ID_PREFIX } from "../../renderer/shared/design-workspace.js";
import { HTML_ARTIFACT_MIME_TYPE } from "../../renderer/shared/generative-ui.js";
import type { DesignerActionV1 } from "../../renderer/shared/source-designer.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import {
  proposeDesignDirectEdit,
  type ConnectedDirectEditDesignerActionRequestV1,
  type DesignDirectEditTargetV1,
  type DesignDirectEditV1,
  type PrototypeDirectEditRevisionRequestV1,
} from "./design-direct-edit-core.js";
import {
  transformConnectedDirectEdit,
  transformPrototypeDirectEdit,
} from "./design-direct-edit-transforms.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import type { DesignProjectStore } from "./design-project-store.js";
import type {
  CommittedGenerativeUiSource,
  GenerativeUiArtifactStore,
} from "./generative-ui-artifact-store.js";
import type {
  ResolvedSourceSelection,
  SourceDesignerActionService,
} from "./source-designer-actions.js";

export interface DesignDirectEditArtifactPort extends Pick<
  GenerativeUiArtifactStore,
  "artifactFor" | "commit" | "committedSourceFor" | "discardPending" | "htmlFor" | "stage"
> {}

export interface DesignDirectEditMessagePort {
  /** Append exactly once by mediaId, or verify an existing exact artifact. */
  ensureArtifactMessage(input: {
    chatId: string;
    artifact: ChatHtmlArtifactV1;
    createdAt: number;
    model?: string;
  }): Promise<void>;
}

export interface DesignDirectEditDependencies {
  projects: Pick<DesignProjectStore, "get" | "update">;
  artifacts: DesignDirectEditArtifactPort;
  messages: DesignDirectEditMessagePort;
  actions: Pick<SourceDesignerActionService, "propose" | "resolve">;
  semanticColorTokens(project: DesignProjectSnapshotV1): Promise<readonly string[]>;
  proveConnectedComponentSingleUse(input: {
    project: DesignProjectSnapshotV1;
    binding: ResolvedSourceSelection;
    proposal: ConnectedDirectEditDesignerActionRequestV1;
  }): Promise<boolean>;
  now?: () => number;
}

export interface PrototypeDirectEditResult {
  kind: "prototype-revision";
  proposalId: string;
  undoId: string;
  artifact: ChatHtmlArtifactV1;
  project: DesignProjectSnapshotV1;
}

export interface ConnectedDirectEditResult {
  kind: "designer-action";
  proposalId: string;
  action: DesignerActionV1;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSelection(
  proposal: ConnectedDirectEditDesignerActionRequestV1,
  binding: ResolvedSourceSelection,
): boolean {
  return (
    proposal.selection.selector === binding.selection.selector &&
    proposal.selection.tagName === binding.selection.tagName &&
    proposal.selection.elementId === binding.selection.elementId
  );
}

function requireProjectLineage(
  project: DesignProjectSnapshotV1,
  lineageId: string,
  mediaId: string,
) {
  const matches = project.canvas.nodes.filter(
    (node) =>
      node.kind === "artboard" &&
      node.lineageId === lineageId &&
      node.artifactMediaIds?.includes(mediaId),
  );
  if (matches.length !== 1) {
    throw new Error("The direct-edit revision is not owned by one exact project lineage.");
  }
  return matches[0]!;
}

function requireConnectedSourceNode(
  project: DesignProjectSnapshotV1,
  nodeId: string,
  sourceVersion: string,
): void {
  const matches = project.canvas.nodes.filter(
    (node) => node.kind === "source-preview" && node.id === nodeId,
  );
  if (matches.length !== 1 || !sourceVersion) {
    throw new Error("The connected direct edit is not owned by one exact source preview.");
  }
}

async function requireSemanticToken(
  dependencies: DesignDirectEditDependencies,
  project: DesignProjectSnapshotV1,
  edit: DesignDirectEditV1,
): Promise<void> {
  if (edit.kind !== "color-token") return;
  const tokens = await dependencies.semanticColorTokens(project);
  if (tokens.filter((token) => token === edit.token).length !== 1) {
    throw new Error(
      "The color token is not proven by the project's current design-system snapshot.",
    );
  }
}

function requireExactArtifact(
  source: CommittedGenerativeUiSource | undefined,
  expectedArtifactId: string,
): CommittedGenerativeUiSource {
  if (
    !source ||
    source.artifact.id !== expectedArtifactId ||
    digest(source.html) !== expectedArtifactId
  ) {
    throw new Error("The immutable artifact source hash changed before the direct edit.");
  }
  return source;
}

export class DesignDirectEditService {
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly connectedResults = new Map<string, ConnectedDirectEditResult>();

  constructor(private readonly dependencies: DesignDirectEditDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  private runSerialized<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(identity);
    if (existing) return existing as Promise<T>;
    const pending = operation().finally(() => {
      if (this.inFlight.get(identity) === pending) this.inFlight.delete(identity);
    });
    this.inFlight.set(identity, pending);
    return pending;
  }

  applyPrototype(input: {
    gestureId: string;
    target: Extract<DesignDirectEditTargetV1, { origin: "prototype" }>;
    edit: DesignDirectEditV1;
  }): Promise<PrototypeDirectEditResult> {
    const proposal = proposeDesignDirectEdit(input);
    if (proposal.kind !== "prototype-revision-request") {
      throw new Error("A prototype direct edit produced the wrong proposal kind.");
    }
    return this.runSerialized(proposal.proposalId, () => this.applyPrototypeProposal(proposal));
  }

  private async applyPrototypeProposal(
    proposal: PrototypeDirectEditRevisionRequestV1,
  ): Promise<PrototypeDirectEditResult> {
    let project = await this.dependencies.projects.get(proposal.projectId);
    if (!project) throw new Error("Design Project was not found.");
    const mediaId = `${DESIGN_ARTIFACT_MEDIA_ID_PREFIX}${digest(`direct-edit\0${proposal.proposalId}`)}`;
    const generationId = `direct-edit:${digest(proposal.proposalId)}`;
    const existingNode = project.canvas.nodes.find(
      (node) => node.kind === "artboard" && node.artifactMediaIds?.includes(mediaId),
    );
    if (existingNode) {
      if (existingNode.lineageId !== proposal.lineageId || existingNode.activeMediaId !== mediaId) {
        throw new Error(
          "The deterministic direct-edit revision identity is already owned elsewhere.",
        );
      }
      const artifact = await this.dependencies.artifacts.artifactFor(project.chatId, mediaId);
      const html = await this.dependencies.artifacts.htmlFor(project.chatId, mediaId);
      if (!artifact || !html || artifact.id !== digest(html)) {
        throw new Error("The prior direct-edit revision is incomplete or has conflicting bytes.");
      }
      await this.dependencies.messages.ensureArtifactMessage({
        chatId: project.chatId,
        artifact,
        createdAt: this.now(),
      });
      await this.dependencies.artifacts.commit(project.chatId, [mediaId]);
      return {
        kind: "prototype-revision",
        proposalId: proposal.proposalId,
        undoId: proposal.undoId,
        artifact,
        project,
      };
    }
    const node = requireProjectLineage(project, proposal.lineageId, proposal.baseMediaId);
    if (node.activeMediaId !== proposal.baseMediaId) {
      throw new Error("The selected prototype revision is stale.");
    }
    await requireSemanticToken(this.dependencies, project, proposal.edit);
    const source = requireExactArtifact(
      await this.dependencies.artifacts.committedSourceFor(project.chatId, proposal.baseMediaId),
      proposal.expectedArtifactId,
    );
    const html = transformPrototypeDirectEdit({
      html: source.html,
      selection: proposal.selection,
      edit: proposal.edit,
    });
    if (html === source.html) throw new Error("The direct edit would not change the artifact.");
    const artifact: ChatHtmlArtifactV1 = {
      version: CHAT_ARTIFACT_VERSION,
      kind: "html",
      id: digest(html),
      title: source.artifact.title,
      mimeType: HTML_ARTIFACT_MIME_TYPE,
      size: Buffer.byteLength(html, "utf8"),
      mediaId,
    };
    await this.dependencies.artifacts.stage({
      chatId: project.chatId,
      generationId,
      ...(source.model ? { model: source.model } : {}),
      artifact,
      html,
    });
    let linked = false;
    try {
      project = await this.dependencies.projects.update({
        id: project.id,
        expectedRevision: project.revision,
        connectionState: project.connectionState,
        ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
        canvas: {
          ...project.canvas,
          nodes: project.canvas.nodes.map((candidate) =>
            candidate.id === node.id
              ? {
                  ...candidate,
                  artifactMediaIds: [...(candidate.artifactMediaIds ?? []), mediaId],
                  activeMediaId: mediaId,
                }
              : candidate,
          ),
        },
        referenceAssetIds: project.referenceAssetIds,
        ...(project.designSystemBinding
          ? { designSystemBinding: project.designSystemBinding }
          : {}),
      });
      linked = true;
      await this.dependencies.messages.ensureArtifactMessage({
        chatId: project.chatId,
        artifact,
        createdAt: this.now(),
        ...(source.model ? { model: source.model } : {}),
      });
      await this.dependencies.artifacts.commit(project.chatId, [mediaId]);
      return {
        kind: "prototype-revision",
        proposalId: proposal.proposalId,
        undoId: proposal.undoId,
        artifact,
        project,
      };
    } catch (error) {
      if (!linked) {
        await this.dependencies.artifacts.discardPending({
          chatId: project.chatId,
          generationId,
          mediaId,
        });
      }
      throw error;
    }
  }

  undoPrototype(input: {
    undoId: string;
    projectId: string;
    lineageId: string;
    editedMediaId: string;
    revertMediaId: string;
  }): Promise<PrototypeDirectEditResult> {
    if (!/^undo:[a-f0-9]{64}$/u.test(input.undoId)) {
      throw new Error("The prototype direct-edit undo identity is invalid.");
    }
    const proposalId = `proposal:${input.undoId.slice("undo:".length)}`;
    const expectedEditedMediaId = `${DESIGN_ARTIFACT_MEDIA_ID_PREFIX}${digest(`direct-edit\0${proposalId}`)}`;
    if (input.editedMediaId !== expectedEditedMediaId) {
      throw new Error("The selected revision is not owned by this direct-edit undo.");
    }
    return this.runSerialized(input.undoId, () => this.undoPrototypeRevision(input, proposalId));
  }

  private async undoPrototypeRevision(
    input: {
      undoId: string;
      projectId: string;
      lineageId: string;
      editedMediaId: string;
      revertMediaId: string;
    },
    proposalId: string,
  ): Promise<PrototypeDirectEditResult> {
    let project = await this.dependencies.projects.get(input.projectId);
    if (!project) throw new Error("Design Project was not found.");
    const mediaId = `${DESIGN_ARTIFACT_MEDIA_ID_PREFIX}${digest(`direct-edit-revert\0${input.undoId}`)}`;
    const generationId = `direct-edit-revert:${digest(input.undoId)}`;
    const priorUndoNode = project.canvas.nodes.find(
      (node) => node.kind === "artboard" && node.artifactMediaIds?.includes(mediaId),
    );
    if (priorUndoNode) {
      if (priorUndoNode.lineageId !== input.lineageId || priorUndoNode.activeMediaId !== mediaId) {
        throw new Error("The deterministic direct-edit undo revision is already owned elsewhere.");
      }
      const artifact = await this.dependencies.artifacts.artifactFor(project.chatId, mediaId);
      const html = await this.dependencies.artifacts.htmlFor(project.chatId, mediaId);
      if (!artifact || !html || artifact.id !== digest(html)) {
        throw new Error("The prior direct-edit undo revision is incomplete or conflicting.");
      }
      await this.dependencies.messages.ensureArtifactMessage({
        chatId: project.chatId,
        artifact,
        createdAt: this.now(),
      });
      await this.dependencies.artifacts.commit(project.chatId, [mediaId]);
      return { kind: "prototype-revision", proposalId, undoId: input.undoId, artifact, project };
    }
    const node = requireProjectLineage(project, input.lineageId, input.editedMediaId);
    if (node.activeMediaId !== input.editedMediaId) {
      throw new Error("The direct-edit revision is no longer active.");
    }
    const ids = node.artifactMediaIds ?? [];
    const editedIndex = ids.indexOf(input.editedMediaId);
    if (editedIndex < 1 || ids[editedIndex - 1] !== input.revertMediaId) {
      throw new Error("The exact pre-edit revision is no longer adjacent to this direct edit.");
    }
    const edited = await this.dependencies.artifacts.committedSourceFor(
      project.chatId,
      input.editedMediaId,
    );
    const revert = await this.dependencies.artifacts.committedSourceFor(
      project.chatId,
      input.revertMediaId,
    );
    if (!edited || !revert || edited.html === revert.html) {
      throw new Error("The exact direct-edit revert bytes are unavailable.");
    }
    const artifact: ChatHtmlArtifactV1 = {
      version: CHAT_ARTIFACT_VERSION,
      kind: "html",
      id: digest(revert.html),
      title: revert.artifact.title,
      mimeType: HTML_ARTIFACT_MIME_TYPE,
      size: Buffer.byteLength(revert.html, "utf8"),
      mediaId,
    };
    await this.dependencies.artifacts.stage({
      chatId: project.chatId,
      generationId,
      ...(revert.model ? { model: revert.model } : {}),
      artifact,
      html: revert.html,
    });
    let linked = false;
    try {
      project = await this.dependencies.projects.update({
        id: project.id,
        expectedRevision: project.revision,
        connectionState: project.connectionState,
        ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
        canvas: {
          ...project.canvas,
          nodes: project.canvas.nodes.map((candidate) =>
            candidate.id === node.id
              ? {
                  ...candidate,
                  artifactMediaIds: [...ids, mediaId],
                  activeMediaId: mediaId,
                }
              : candidate,
          ),
        },
        referenceAssetIds: project.referenceAssetIds,
        ...(project.designSystemBinding
          ? { designSystemBinding: project.designSystemBinding }
          : {}),
      });
      linked = true;
      await this.dependencies.messages.ensureArtifactMessage({
        chatId: project.chatId,
        artifact,
        createdAt: this.now(),
        ...(revert.model ? { model: revert.model } : {}),
      });
      await this.dependencies.artifacts.commit(project.chatId, [mediaId]);
      return { kind: "prototype-revision", proposalId, undoId: input.undoId, artifact, project };
    } catch (error) {
      if (!linked) {
        await this.dependencies.artifacts.discardPending({
          chatId: project.chatId,
          generationId,
          mediaId,
        });
      }
      throw error;
    }
  }

  applyConnected(input: {
    owner: ChatGenerationOwner;
    chatId: string;
    sourceSelectionId: string;
    gestureId: string;
    target: Extract<DesignDirectEditTargetV1, { origin: "connected-app" }>;
    edit: DesignDirectEditV1;
    label?: string;
  }): Promise<ConnectedDirectEditResult> {
    const proposal = proposeDesignDirectEdit(input);
    if (proposal.kind !== "designer-action-request") {
      throw new Error("A connected direct edit produced the wrong proposal kind.");
    }
    return this.runSerialized(proposal.proposalId, async () => {
      const prior = this.connectedResults.get(proposal.proposalId);
      if (prior) return prior;
      const result = await this.applyConnectedProposal(proposal, input);
      this.connectedResults.set(proposal.proposalId, result);
      while (this.connectedResults.size > 80) {
        const oldest = this.connectedResults.keys().next().value as string | undefined;
        if (!oldest) break;
        this.connectedResults.delete(oldest);
      }
      return result;
    });
  }

  private async applyConnectedProposal(
    proposal: ConnectedDirectEditDesignerActionRequestV1,
    input: {
      owner: ChatGenerationOwner;
      chatId: string;
      sourceSelectionId: string;
      label?: string;
    },
  ): Promise<ConnectedDirectEditResult> {
    const project = await this.dependencies.projects.get(proposal.projectId);
    if (
      !project ||
      project.connectionState !== "connected" ||
      project.workspaceId !== proposal.workspaceId
    ) {
      throw new Error("The Design Project no longer has this connected workspace authority.");
    }
    requireConnectedSourceNode(project, proposal.lineageId, proposal.baseMediaId);
    await requireSemanticToken(this.dependencies, project, proposal.edit);
    const binding = await this.dependencies.actions.resolve(
      input.owner,
      proposal.workspaceId,
      input.sourceSelectionId,
    );
    if (
      binding.path !== proposal.path ||
      binding.sourceVersion !== proposal.sourceVersion ||
      binding.start !== proposal.start ||
      binding.end !== proposal.end ||
      binding.snippet !== proposal.preimage ||
      digest(binding.snippet) !== proposal.preimageHash ||
      !exactSelection(proposal, binding)
    ) {
      throw new Error("The live source binding does not match the direct-edit proposal.");
    }
    if (
      !(await this.dependencies.proveConnectedComponentSingleUse({
        project,
        binding,
        proposal,
      }))
    ) {
      throw new Error("The selected JSX element belongs to an ambiguous or shared component.");
    }
    const replacement = transformConnectedDirectEdit({
      source: binding.source,
      start: binding.start,
      end: binding.end,
      selection: proposal.selection,
      edit: proposal.edit,
    });
    if (replacement === binding.snippet) {
      throw new Error("The direct edit would not change the connected source.");
    }
    const action = this.dependencies.actions.propose({
      owner: input.owner,
      chatId: input.chatId,
      binding,
      label: input.label ?? `Direct edit · ${proposal.edit.kind}`,
      replacement,
      preApplyGuard: () =>
        this.dependencies.proveConnectedComponentSingleUse({ project, binding, proposal }),
    });
    return { kind: "designer-action", proposalId: proposal.proposalId, action };
  }
}
