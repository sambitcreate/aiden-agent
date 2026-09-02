import { createHash } from "node:crypto";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION } from "../../renderer/shared/chat-artifacts.js";
import type {
  DesignArtifactRecoveryOperation,
  DesignArtifactRecoveryPlanV1,
  DesignArtifactRecoveryResultV1,
} from "../../renderer/shared/design-projects.js";
import { HTML_ARTIFACT_MIME_TYPE } from "../../renderer/shared/generative-ui.js";
import { DESIGN_ARTIFACT_MEDIA_ID_PREFIX } from "../../renderer/shared/design-workspace.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import {
  DesignProjectRevisionConflictError,
  type DesignProjectStore,
} from "./design-project-store.js";
import {
  DESIGN_ARTIFACT_RECOVERY_GENERATION_PREFIX,
  type DesignGeneratedRevisionOwnershipV1,
} from "./design-generated-revision-contract.js";
import type { DesignDirectEditMessagePort } from "./design-direct-edit-service.js";
import {
  designArtifactRecoveryFingerprint,
  type GenerativeUiArtifactStore,
} from "./generative-ui-artifact-store.js";
import { OMITTED_DESIGN_HTML_SENTINEL, validateGenerativeUiHtml } from "./generative-ui-html.js";
import type { PiSessionEntry, PiSessionPort } from "./pi-session-port.js";
import { projectOwnsPublishedDesignSource } from "./design-artifact-source-authority.js";

const RENDER_ARTIFACT_TOOL = "render_artifact";

export interface DesignArtifactRecoverySource {
  chatId: string;
  generationId: string;
  createdAt: number;
  model?: string;
  artifact: ChatHtmlArtifactV1;
  html: string;
  designOwnership?: DesignGeneratedRevisionOwnershipV1;
  designPublication?: "candidate" | "eligible" | "published" | "suppressed";
}

export interface DesignArtifactRecoveryDependencies {
  projects: Pick<
    DesignProjectStore,
    "get" | "removeMissingGeneratedArtboard" | "removeMissingGeneratedRevision"
  >;
  artifacts: Pick<
    GenerativeUiArtifactStore,
    | "stage"
    | "stageRecoveryReplacement"
    | "commit"
    | "designPublicationRecords"
    | "setDesignPublicationState"
    | "withDamagedArtifactGuard"
    | "withMissingArtifactGuard"
  > & {
    committedRecoverySourceFor(
      chatId: string,
      mediaId: string,
    ): Promise<DesignArtifactRecoverySource | undefined>;
  };
  messages: DesignDirectEditMessagePort;
  revisions: {
    markSuccessfulCandidate(chatId: string, mediaIds: readonly string[]): Promise<void>;
    publishEligible(chatId: string, mediaIds: readonly string[]): Promise<void>;
  };
  openJournal(chatId: string): Promise<Pick<PiSessionPort, "getBranch">>;
  now?: () => number;
}

interface BrokenRevision {
  project: DesignProjectSnapshotV1;
  lineageId: string;
  mediaId: string;
  source?: DesignArtifactRecoverySource;
  reason: "omitted-html" | "corrupt-artifact" | "missing-artifact";
  finalizeEligible?: true;
  metadataOnlyDamage?: true;
}

interface RecoveryInspection {
  plan: DesignArtifactRecoveryPlanV1;
  broken: BrokenRevision;
  candidate?: { html: string; source: DesignArtifactRecoverySource };
  removeMissingArtboard?: true;
  removeMissingRevision?: { activeMediaId: string };
  finalizeEligible?: true;
  removeDamagedArtboard?: { expectedFingerprint: string; allowValidContent?: true };
  removeDamagedRevision?: {
    activeMediaId: string;
    expectedFingerprint: string;
    allowValidContent?: true;
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recoveryOperationToken(
  projectId: string,
  lineageId: string,
  damagedMediaId: string,
  expectedRevision: number,
): string {
  return digest(
    `journal-recovery\0${projectId}\0${lineageId}\0${damagedMediaId}\0${expectedRevision}`,
  );
}

function recoveryGenerationId(operationToken: string): string {
  return `${DESIGN_ARTIFACT_RECOVERY_GENERATION_PREFIX}${operationToken}`;
}

function recoveryMediaId(operationToken: string, html: string): string {
  return `${DESIGN_ARTIFACT_MEDIA_ID_PREFIX}${digest(
    `journal-recovery\0${operationToken}\0${digest(html)}`,
  )}`;
}

function sourceIsValid(
  source: { artifact: ChatHtmlArtifactV1; html: string } | undefined,
): boolean {
  if (!source) return false;
  if (
    source.artifact.size !== Buffer.byteLength(source.html, "utf8") ||
    source.artifact.id !== digest(source.html)
  ) {
    return false;
  }
  try {
    validateGenerativeUiHtml(source.html);
    return true;
  } catch {
    return false;
  }
}

function sourceIsUsable(
  project: DesignProjectSnapshotV1,
  source: DesignArtifactRecoverySource | undefined,
): boolean {
  return sourceIsValid(source) && projectOwnsPublishedDesignSource(project, source!);
}

function sourceIsExactEligibleOwner(
  project: DesignProjectSnapshotV1,
  lineageId: string,
  source: DesignArtifactRecoverySource | undefined,
): boolean {
  return (
    sourceIsValid(source) &&
    source!.designPublication === "eligible" &&
    source!.chatId === project.chatId &&
    source!.designOwnership?.projectId === project.id &&
    source!.designOwnership.lineageId === lineageId
  );
}

function planFor(
  broken: BrokenRevision,
  status: "recoverable" | "regenerate",
  reason: DesignArtifactRecoveryPlanV1["reason"],
  messageOverride?: string,
  operationOverride?: DesignArtifactRecoveryOperation,
): DesignArtifactRecoveryPlanV1 {
  const message =
    messageOverride ??
    (status === "recoverable"
      ? "A valid earlier version is available in this project's private local history. Recovering creates a new revision and keeps the damaged version in History."
      : reason === "journal-unavailable"
        ? "Aiden could not safely read this project's private local history. Open the project and regenerate the affected artboard."
        : "No provably valid earlier version is available in this project's private local history. Open the project and regenerate the affected artboard.");
  return {
    version: 1,
    projectId: broken.project.id,
    expectedRevision: broken.project.revision,
    status,
    operation:
      operationOverride ?? (status === "recoverable" ? "recover-revision" : "open-to-regenerate"),
    reason,
    message,
  };
}

function toolCallParts(entry: PiSessionEntry): Array<{
  id: string;
  title: string;
  html: string;
}> {
  if (entry.type !== "message") return [];
  const message = entry.message as unknown as {
    role?: unknown;
    content?: unknown;
  };
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as Record<string, unknown>;
    if (
      value.type !== "toolCall" ||
      value.name !== RENDER_ARTIFACT_TOOL ||
      typeof value.id !== "string" ||
      !value.arguments ||
      typeof value.arguments !== "object" ||
      Array.isArray(value.arguments)
    ) {
      return [];
    }
    const args = value.arguments as Record<string, unknown>;
    return typeof args.title === "string" && typeof args.html === "string"
      ? [{ id: value.id, title: args.title, html: args.html }]
      : [];
  });
}

function entryRole(entry: PiSessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as { role?: unknown };
  return typeof message.role === "string" ? message.role : undefined;
}

function hasSuccessfulToolResult(
  entries: readonly PiSessionEntry[],
  afterIndex: number,
  toolCallId: string,
): boolean {
  for (let index = afterIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entryRole(entry) === "user") return false;
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
    return message.toolName === RENDER_ARTIFACT_TOOL && message.isError === false;
  }
  return false;
}

/**
 * Find only bytes proven to belong to the exact generation which first owned
 * the broken media ID. This never accepts a same-title design from another
 * turn, branch, or generation.
 */
export function recoverableHtmlFromJournal(
  entries: readonly PiSessionEntry[],
  source: DesignArtifactRecoverySource,
): string | undefined {
  const namespace = `${source.generationId}:html`;
  let anchor:
    | {
        entryIndex: number;
        html: string;
        toolCallId: string;
      }
    | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const owningPart = toolCallParts(entries[index]!).find((part) => {
      const mediaId = `${DESIGN_ARTIFACT_MEDIA_ID_PREFIX}${digest(`${namespace}\0${part.id}`)}`;
      return mediaId === source.artifact.mediaId;
    });
    if (owningPart) {
      anchor = {
        entryIndex: index,
        html: owningPart.html,
        toolCallId: owningPart.id,
      };
      break;
    }
  }
  if (!anchor || !hasSuccessfulToolResult(entries, anchor.entryIndex, anchor.toolCallId)) {
    return undefined;
  }
  if (anchor.html === source.html && sourceIsValid(source)) return undefined;
  try {
    validateGenerativeUiHtml(anchor.html);
    return anchor.html;
  } catch {
    return undefined;
  }
}

export class DesignArtifactRecoveryService {
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<DesignArtifactRecoveryResultV1>>();

  constructor(private readonly dependencies: DesignArtifactRecoveryDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  private async completedRecovery(
    projectId: string,
    expectedRevision: number,
  ): Promise<DesignProjectSnapshotV1 | undefined> {
    const project = await this.dependencies.projects.get(projectId);
    if (!project) throw new Error("Design Project was not found.");
    if (project.revision !== expectedRevision + 1) return undefined;
    const records = await this.dependencies.artifacts.designPublicationRecords(
      ["eligible", "published"],
      { chatId: project.chatId },
    );
    const completed = records.find(
      (record) =>
        record.designOwnership?.projectId === project.id &&
        record.designOwnership.kind === "revision" &&
        record.generationId ===
          recoveryGenerationId(
            recoveryOperationToken(
              project.id,
              record.designOwnership.lineageId,
              record.designOwnership.baseMediaId,
              expectedRevision,
            ),
          ) &&
        record.artifact.mediaId ===
          recoveryMediaId(
            recoveryOperationToken(
              project.id,
              record.designOwnership.lineageId,
              record.designOwnership.baseMediaId,
              expectedRevision,
            ),
            record.html,
          ) &&
        record.artifact.revisionOfMediaId === record.designOwnership.baseMediaId &&
        project.canvas.nodes.some(
          (node) =>
            node.kind === "artboard" &&
            node.lineageId === record.designOwnership?.lineageId &&
            node.activeMediaId === record.artifact.mediaId &&
            node.artifactMediaIds?.includes(record.artifact.mediaId) === true,
        ),
    );
    if (!completed || !sourceIsValid(completed)) return undefined;
    if (completed.designPublication === "eligible") {
      await this.dependencies.revisions.publishEligible(project.chatId, [
        completed.artifact.mediaId,
      ]);
    }
    return project;
  }

  private async brokenRevision(projectId: string): Promise<BrokenRevision | undefined> {
    const project = await this.dependencies.projects.get(projectId);
    if (!project) throw new Error("Design Project was not found.");
    for (const node of project.canvas.nodes) {
      if (node.kind !== "artboard" || !node.lineageId) continue;
      const records = await Promise.all(
        (node.artifactMediaIds ?? []).map(async (mediaId) => ({
          mediaId,
          source: await this.dependencies.artifacts.committedRecoverySourceFor(
            project.chatId,
            mediaId,
          ),
        })),
      );
      const valid = new Set(
        records.filter(({ source }) => sourceIsUsable(project, source)).map(({ mediaId }) => mediaId),
      );
      const repaired = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const { mediaId, source } of records) {
          if (!valid.has(mediaId) && !repaired.has(mediaId)) continue;
          const parent = source?.artifact.revisionOfMediaId;
          if (parent && !repaired.has(parent)) {
            repaired.add(parent);
            changed = true;
          }
        }
      }
      const active = records.find(({ mediaId }) => mediaId === node.activeMediaId);
      const candidates = [
        ...(active && !sourceIsUsable(project, active.source) ? [active] : []),
        ...records.filter(({ mediaId }) => mediaId !== active?.mediaId),
      ];
      for (const { mediaId, source } of candidates) {
        const reason =
          source?.html === OMITTED_DESIGN_HTML_SENTINEL
            ? "omitted-html"
            : source
              ? "corrupt-artifact"
              : "missing-artifact";
        if (sourceIsUsable(project, source) || (repaired.has(mediaId) && mediaId !== active?.mediaId)) {
          continue;
        }
        return {
          project,
          lineageId: node.lineageId,
          mediaId,
          ...(source ? { source } : {}),
          reason,
          ...(sourceIsExactEligibleOwner(project, node.lineageId, source)
            ? { finalizeEligible: true as const }
            : sourceIsValid(source)
              ? { metadataOnlyDamage: true as const }
              : {}),
        };
      }
    }
    return undefined;
  }

  private async inspectInternal(projectId: string): Promise<RecoveryInspection> {
    const broken = await this.brokenRevision(projectId);
    if (!broken) throw new Error("This Design Project does not have a damaged active revision.");
    if (broken.finalizeEligible) {
      return {
        broken,
        finalizeEligible: true,
        plan: planFor(
          broken,
          "recoverable",
          "corrupt-artifact",
          "This revision reached the project but its local publication marker is incomplete. Repair safely finishes that exact pending publication.",
          "recover-revision",
        ),
      };
    }
    if (!broken.source) {
      const operationToken = recoveryOperationToken(
        broken.project.id,
        broken.lineageId,
        broken.mediaId,
        broken.project.revision,
      );
      const stagedRecoveries = (
        await this.dependencies.artifacts.designPublicationRecords(
          ["candidate", "eligible", "published", "suppressed"],
          { chatId: broken.project.chatId },
        )
      ).filter(
        (record) =>
          record.generationId === recoveryGenerationId(operationToken) &&
          record.artifact.revisionOfMediaId === broken.mediaId &&
          record.designOwnership?.kind === "revision" &&
          record.designOwnership.projectId === broken.project.id &&
          record.designOwnership.lineageId === broken.lineageId &&
          record.designOwnership.baseMediaId === broken.mediaId &&
          record.artifact.mediaId === recoveryMediaId(operationToken, record.html) &&
          sourceIsValid(record),
      );
      if (stagedRecoveries.length > 1) {
        throw new Error("The deterministic Design recovery identity is ambiguous.");
      }
      const stagedRecovery = stagedRecoveries.find(
        (record) => record.designPublication !== "suppressed",
      );
      if (stagedRecovery) {
        return {
          broken,
          candidate: {
            html: stagedRecovery.html,
            source: { ...stagedRecovery, createdAt: stagedRecovery.stagedAt },
          },
          plan: planFor(broken, "recoverable", "missing-artifact"),
        };
      }
      const node = broken.project.canvas.nodes.find(
        (candidate) => candidate.kind === "artboard" && candidate.lineageId === broken.lineageId,
      );
      if (node?.activeMediaId && node.activeMediaId !== broken.mediaId) {
        const activeSource = await this.dependencies.artifacts.committedRecoverySourceFor(
          broken.project.chatId,
          node.activeMediaId,
        );
        if (
          sourceIsValid(activeSource) &&
          projectOwnsPublishedDesignSource(broken.project, activeSource!)
        ) {
          return {
            broken,
            removeMissingRevision: { activeMediaId: node.activeMediaId },
            plan: planFor(
              broken,
              "recoverable",
              "missing-artifact",
              "The current artboard is intact, but an older local history entry is missing its bytes. Repair removes only that unavailable history entry and keeps the current design active.",
              "remove-missing-history",
            ),
          };
        }
      }
      const brokenIndex = node?.artifactMediaIds?.indexOf(broken.mediaId) ?? -1;
      const candidateIndexes = [
        ...Array.from(
          { length: Math.max(0, brokenIndex) },
          (_, offset) => brokenIndex - offset - 1,
        ),
        ...Array.from(
          {
            length: Math.max(0, (node?.artifactMediaIds?.length ?? 0) - brokenIndex - 1),
          },
          (_, offset) => brokenIndex + offset + 1,
        ),
      ];
      for (const index of candidateIndexes) {
        const mediaId = node?.artifactMediaIds?.[index];
        if (!mediaId) continue;
        const source = await this.dependencies.artifacts.committedRecoverySourceFor(
          broken.project.chatId,
          mediaId,
        );
        if (
          source &&
          sourceIsValid(source) &&
          projectOwnsPublishedDesignSource(broken.project, source)
        ) {
          return {
            broken,
            candidate: { html: source.html, source },
            plan: planFor(broken, "recoverable", "missing-artifact"),
          };
        }
      }
      return {
        broken,
        removeMissingArtboard: true,
        plan: planFor(
          broken,
          "recoverable",
          "missing-artifact",
          "No valid revision bytes remain for this artboard. Repair removes only this broken artboard from the project; its conversation history remains local so you can open the project and regenerate it.",
          "remove-missing-artboard",
        ),
      };
    }
    let entries: PiSessionEntry[] | undefined;
    try {
      entries = await (await this.dependencies.openJournal(broken.project.chatId)).getBranch();
    } catch {
      entries = undefined;
    }
    const html = entries ? recoverableHtmlFromJournal(entries, broken.source) : undefined;
    const suppressedRecovery = html
      ? (
          await this.dependencies.artifacts.designPublicationRecords(["suppressed"], {
            chatId: broken.project.chatId,
            mediaIds: [
              recoveryMediaId(
                recoveryOperationToken(
                  broken.project.id,
                  broken.lineageId,
                  broken.mediaId,
                  broken.project.revision,
                ),
                html,
              ),
            ],
          })
        )[0]
      : undefined;
    if (html && !suppressedRecovery) {
      return {
        broken,
        candidate: { html, source: broken.source },
        plan: planFor(broken, "recoverable", broken.reason),
      };
    }
    const node = broken.project.canvas.nodes.find(
      (candidate) => candidate.kind === "artboard" && candidate.lineageId === broken.lineageId,
    );
    const brokenIndex = node?.artifactMediaIds?.indexOf(broken.mediaId) ?? -1;
    const fallbackIndexes = [
      ...Array.from({ length: Math.max(0, brokenIndex) }, (_, offset) => brokenIndex - offset - 1),
      ...Array.from(
        {
          length: Math.max(0, (node?.artifactMediaIds?.length ?? 0) - brokenIndex - 1),
        },
        (_, offset) => brokenIndex + offset + 1,
      ),
    ];
    for (const index of fallbackIndexes) {
      const mediaId = node?.artifactMediaIds?.[index];
      if (!mediaId) continue;
      const source = await this.dependencies.artifacts.committedRecoverySourceFor(
        broken.project.chatId,
        mediaId,
      );
      if (
        source &&
        sourceIsValid(source) &&
        projectOwnsPublishedDesignSource(broken.project, source)
      ) {
        return {
          broken,
          candidate: { html: source.html, source },
          plan: planFor(broken, "recoverable", broken.reason),
        };
      }
    }
    const expectedFingerprint = designArtifactRecoveryFingerprint(broken.source);
    if (node?.activeMediaId && node.activeMediaId !== broken.mediaId) {
      const activeSource = await this.dependencies.artifacts.committedRecoverySourceFor(
        broken.project.chatId,
        node.activeMediaId,
      );
      if (
        activeSource &&
        sourceIsValid(activeSource) &&
        projectOwnsPublishedDesignSource(broken.project, activeSource)
      ) {
        return {
          broken,
          removeDamagedRevision: {
            activeMediaId: node.activeMediaId,
            expectedFingerprint,
            ...(broken.metadataOnlyDamage ? { allowValidContent: true as const } : {}),
          },
          plan: planFor(
            broken,
            "recoverable",
            broken.reason,
            "The current artboard is intact, but an older history entry is damaged. Repair removes only that unusable history entry and keeps the current design active.",
            "remove-missing-history",
          ),
        };
      }
    }
    return {
      broken,
      removeDamagedArtboard: {
        expectedFingerprint,
        ...(broken.metadataOnlyDamage ? { allowValidContent: true as const } : {}),
      },
      plan: planFor(
        broken,
        "recoverable",
        entries ? "no-valid-journal-revision" : "journal-unavailable",
        "No valid revision can safely replace this artboard. Repair removes only the broken artboard from the project; its conversation history remains local so you can regenerate it.",
        "remove-missing-artboard",
      ),
    };
  }

  async inspect(projectId: string): Promise<DesignArtifactRecoveryPlanV1> {
    return (await this.inspectInternal(projectId)).plan;
  }

  recover(projectId: string, expectedRevision: number): Promise<DesignArtifactRecoveryResultV1> {
    const existing = this.inFlight.get(projectId);
    if (existing) return existing;
    const operation = this.recoverInternal(projectId, expectedRevision).finally(() => {
      if (this.inFlight.get(projectId) === operation) this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, operation);
    return operation;
  }

  private async recoverInternal(
    projectId: string,
    expectedRevision: number,
  ): Promise<DesignArtifactRecoveryResultV1> {
    const alreadyCompleted = await this.completedRecovery(projectId, expectedRevision);
    if (alreadyCompleted) {
      return {
        status: "recovered",
        operation: "recover-revision",
        project: alreadyCompleted,
      };
    }
    let inspection: RecoveryInspection;
    try {
      inspection = await this.inspectInternal(projectId);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "This Design Project does not have a damaged active revision."
      ) {
        throw error;
      }
      const current = await this.dependencies.projects.get(projectId);
      if (current?.revision === expectedRevision) {
        return { status: "recovered", operation: "recover-revision", project: current };
      }
      throw error;
    }
    if (inspection.plan.expectedRevision !== expectedRevision) {
      return { status: "conflict", current: inspection.broken.project };
    }
    if (inspection.removeDamagedRevision) {
      const guarded = await this.dependencies.artifacts.withDamagedArtifactGuard(
        {
          chatId: inspection.broken.project.chatId,
          mediaId: inspection.broken.mediaId,
          expectedFingerprint: inspection.removeDamagedRevision.expectedFingerprint,
          ...(inspection.removeDamagedRevision.allowValidContent
            ? { allowValidContent: true }
            : {}),
        },
        () =>
          this.dependencies.projects.removeMissingGeneratedRevision({
            projectId,
            expectedRevision,
            lineageId: inspection.broken.lineageId,
            missingMediaId: inspection.broken.mediaId,
            expectedActiveMediaId: inspection.removeDamagedRevision!.activeMediaId,
          }),
      );
      if (guarded.status !== "completed") {
        return {
          status: "conflict",
          current: (await this.dependencies.projects.get(projectId)) ?? inspection.broken.project,
        };
      }
      return {
        status: "recovered",
        operation: "remove-missing-history",
        project: guarded.value,
      };
    }
    if (inspection.removeDamagedArtboard) {
      const guarded = await this.dependencies.artifacts.withDamagedArtifactGuard(
        {
          chatId: inspection.broken.project.chatId,
          mediaId: inspection.broken.mediaId,
          expectedFingerprint: inspection.removeDamagedArtboard.expectedFingerprint,
          ...(inspection.removeDamagedArtboard.allowValidContent
            ? { allowValidContent: true }
            : {}),
        },
        () =>
          this.dependencies.projects.removeMissingGeneratedArtboard({
            projectId,
            expectedRevision,
            lineageId: inspection.broken.lineageId,
            activeMediaId: inspection.broken.mediaId,
          }),
      );
      if (guarded.status !== "completed") {
        return {
          status: "conflict",
          current: (await this.dependencies.projects.get(projectId)) ?? inspection.broken.project,
        };
      }
      const project = guarded.value;
      return {
        status: "regenerate",
        project,
        plan: {
          version: 1,
          projectId,
          expectedRevision: project.revision,
          status: "regenerate",
          operation: "open-to-regenerate",
          reason: inspection.plan.reason,
          message:
            "The broken artboard was removed from this project. Its conversation history remains local. Open the project to regenerate the artboard.",
        },
      };
    }
    if (inspection.removeMissingRevision) {
      const guarded = await this.dependencies.artifacts.withMissingArtifactGuard(
        inspection.broken.project.chatId,
        inspection.broken.mediaId,
        () =>
          this.dependencies.projects.removeMissingGeneratedRevision({
            projectId,
            expectedRevision,
            lineageId: inspection.broken.lineageId,
            missingMediaId: inspection.broken.mediaId,
            expectedActiveMediaId: inspection.removeMissingRevision!.activeMediaId,
          }),
      );
      if (guarded.status === "artifact-present") {
        return { status: "conflict", current: inspection.broken.project };
      }
      return {
        status: "recovered",
        operation: "remove-missing-history",
        project: guarded.value,
      };
    }
    if (inspection.removeMissingArtboard) {
      const guarded = await this.dependencies.artifacts.withMissingArtifactGuard(
        inspection.broken.project.chatId,
        inspection.broken.mediaId,
        () =>
          this.dependencies.projects.removeMissingGeneratedArtboard({
            projectId,
            expectedRevision,
            lineageId: inspection.broken.lineageId,
            activeMediaId: inspection.broken.mediaId,
          }),
      );
      if (guarded.status === "artifact-present") {
        return { status: "conflict", current: inspection.broken.project };
      }
      const project = guarded.value;
      return {
        status: "regenerate",
        project,
        plan: {
          version: 1,
          projectId,
          expectedRevision: project.revision,
          status: "regenerate",
          operation: "open-to-regenerate",
          reason: "missing-artifact",
          message:
            "The broken artboard was removed from this project. Its conversation history remains local. Open the project to regenerate the artboard.",
        },
      };
    }
    if (inspection.finalizeEligible) {
      await this.dependencies.revisions.publishEligible(inspection.broken.project.chatId, [
        inspection.broken.mediaId,
      ]);
      const project = await this.dependencies.projects.get(projectId);
      const source = await this.dependencies.artifacts.committedRecoverySourceFor(
        inspection.broken.project.chatId,
        inspection.broken.mediaId,
      );
      if (!project || !sourceIsUsable(project, source)) {
        throw new Error("The pending Design revision publication could not be finalized.");
      }
      return { status: "recovered", operation: "recover-revision", project };
    }
    if (!inspection.candidate) {
      return { status: "regenerate", plan: inspection.plan };
    }
    const { broken } = inspection;
    const { html: candidate, source } = inspection.candidate;
    const operationToken = recoveryOperationToken(
      broken.project.id,
      broken.lineageId,
      broken.mediaId,
      expectedRevision,
    );
    const mediaId = recoveryMediaId(operationToken, candidate);
    const generationId = recoveryGenerationId(operationToken);
    const artifact: ChatHtmlArtifactV1 = {
      version: CHAT_ARTIFACT_VERSION,
      kind: "html",
      id: digest(candidate),
      title: source.artifact.title,
      mimeType: HTML_ARTIFACT_MIME_TYPE,
      size: Buffer.byteLength(candidate, "utf8"),
      mediaId,
      revisionOfMediaId: broken.mediaId,
    };
    const designOwnership: DesignGeneratedRevisionOwnershipV1 = {
      version: 1,
      kind: "revision",
      projectId: broken.project.id,
      lineageId: broken.lineageId,
      baseMediaId: broken.mediaId,
    };
    const existing = (
      await this.dependencies.artifacts.designPublicationRecords(
        ["candidate", "eligible", "published", "suppressed"],
        { chatId: broken.project.chatId, mediaIds: [mediaId] },
      )
    )[0];
    if (existing) {
      if (
        existing.chatId !== broken.project.chatId ||
        existing.generationId !== generationId ||
        existing.html !== candidate ||
        existing.artifact.id !== artifact.id ||
        existing.artifact.mediaId !== artifact.mediaId ||
        existing.artifact.revisionOfMediaId !== artifact.revisionOfMediaId ||
        existing.designOwnership?.kind !== "revision" ||
        existing.designOwnership.projectId !== designOwnership.projectId ||
        existing.designOwnership.lineageId !== designOwnership.lineageId ||
        existing.designOwnership.baseMediaId !== designOwnership.baseMediaId
      ) {
        throw new Error("The deterministic Design recovery identity is already owned elsewhere.");
      }
    } else {
      await this.dependencies.artifacts.stageRecoveryReplacement({
        chatId: broken.project.chatId,
        generationId,
        ...(source.model ? { model: source.model } : {}),
        artifact,
        html: candidate,
        designOwnership,
        damagedMediaId: broken.mediaId,
      });
    }
    const publication = existing?.designPublication ?? "candidate";
    if (publication === "published") {
      throw new Error("The published Design recovery is not linked to its project.");
    }
    if (publication === "suppressed") {
      throw new Error("A suppressed Design recovery cannot be published.");
    } else if (publication === "candidate") {
      await this.dependencies.revisions.markSuccessfulCandidate(broken.project.chatId, [mediaId]);
    }
    await this.dependencies.messages.ensureArtifactMessage({
      chatId: broken.project.chatId,
      artifact,
      createdAt: this.now(),
      ...(source.model ? { model: source.model } : {}),
    });
    await this.dependencies.artifacts.commit(broken.project.chatId, [mediaId]);
    try {
      await this.dependencies.revisions.publishEligible(broken.project.chatId, [mediaId]);
    } catch (error) {
      if (!(error instanceof DesignProjectRevisionConflictError)) throw error;
      const current = await this.dependencies.projects.get(projectId);
      if (!current) throw error;
      return { status: "conflict", current };
    }
    const project = await this.dependencies.projects.get(projectId);
    if (!project || project.canvas.nodes.every((node) => node.activeMediaId !== mediaId)) {
      throw new Error("The recovered Design revision was not published.");
    }
    return { status: "recovered", operation: "recover-revision", project };
  }
}
