import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import {
  isValidDesignArtifactSource,
  projectOwnsPublishedDesignSource,
} from "./design-artifact-source-authority.js";
import type {
  DesignArtifactPublicationState,
  CommittedGenerativeUiRecoverySource,
} from "./generative-ui-artifact-store.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { DesignGeneratedRevisionOwnershipV1 } from "./design-generated-revision-contract.js";

export { isValidDesignArtifactSource } from "./design-artifact-source-authority.js";

export interface DesignProjectHealthV1 {
  health: "ready" | "needs-repair";
  recoveryMessage?: string;
  recoveryAction?: "recover-artifact" | "open-project";
}

export interface DesignProjectHealthSources {
  artifactSource(
    chatId: string,
    mediaId: string,
  ): Promise<DesignProjectHealthArtifactSource | undefined>;
  hasReferenceAsset(assetId: string): Promise<boolean>;
}

export interface DesignProjectHealthArtifactSource {
  artifact: ChatHtmlArtifactV1;
  html: string;
  chatId?: string;
  generationId?: string;
  createdAt?: number;
  designOwnership?: DesignGeneratedRevisionOwnershipV1;
  designPublication?: DesignArtifactPublicationState;
}

function projectOwnsHealthSource(
  project: DesignProjectSnapshotV1,
  source: DesignProjectHealthArtifactSource,
): boolean {
  if (!source.designOwnership && !source.designPublication) {
    return projectOwnsPublishedDesignSource(project, {
      ...source,
      chatId: source.chatId ?? project.chatId,
      generationId: source.generationId ?? "legacy-health-check",
      createdAt: source.createdAt ?? 0,
    });
  }
  if (!source.chatId || !source.generationId || source.createdAt === undefined) return false;
  return projectOwnsPublishedDesignSource(project, source as CommittedGenerativeUiRecoverySource);
}

/**
 * Inspect only durable project references. Store availability and repair remain
 * owned by their respective main-process stores; this projection never reads
 * renderer state or treats a preview session as durable project health.
 */
export async function inspectDesignProjectHealth(
  project: DesignProjectSnapshotV1,
  sources: DesignProjectHealthSources,
): Promise<DesignProjectHealthV1> {
  for (const assetId of project.referenceAssetIds) {
    if (!(await sources.hasReferenceAsset(assetId))) {
      return {
        health: "needs-repair",
        recoveryMessage:
          "A saved reference image is missing. Open the project to remove it safely.",
        recoveryAction: "open-project",
      };
    }
  }
  for (const node of project.canvas.nodes) {
    if (node.kind !== "artboard") continue;
    const mediaIds = node.artifactMediaIds ?? [];
    const records = await Promise.all(
      mediaIds.map(async (mediaId) => ({
        mediaId,
        source: await sources.artifactSource(project.chatId, mediaId),
      })),
    );
    const valid = new Set(
      records
        .filter(
          ({ source }) =>
            isValidDesignArtifactSource(source) && projectOwnsHealthSource(project, source),
        )
        .map(({ mediaId }) => mediaId),
    );
    // A repaired revision preserves the damaged ancestor in History. Follow
    // immutable revision links so historical damage does not keep a project
    // unhealthy once a valid descendant has explicitly replaced it.
    const repaired = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const { mediaId, source } of records) {
        if (!valid.has(mediaId)) continue;
        const parent = source?.artifact.revisionOfMediaId;
        if (parent && !repaired.has(parent)) {
          repaired.add(parent);
          changed = true;
        }
      }
      for (const { mediaId, source } of records) {
        const parent = source?.artifact.revisionOfMediaId;
        if (parent && repaired.has(mediaId) && !repaired.has(parent)) {
          repaired.add(parent);
          changed = true;
        }
      }
    }
    const broken = records.find(({ mediaId }) => !valid.has(mediaId) && !repaired.has(mediaId));
    if (broken) {
      return {
        health: "needs-repair",
        recoveryMessage:
          broken.source === undefined
            ? "A saved artboard revision is missing. Earlier project data was preserved for repair."
            : "A saved artboard revision is incomplete. Its history was preserved for repair.",
        recoveryAction: "recover-artifact",
      };
    }
    if (node.activeMediaId && !valid.has(node.activeMediaId)) {
      return {
        health: "needs-repair",
        recoveryMessage:
          "The active artboard revision is unavailable. Its history was preserved for repair.",
        recoveryAction: "recover-artifact",
      };
    }
  }
  return { health: "ready" };
}
