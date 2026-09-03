import { createHash } from "node:crypto";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { DesignProjectSnapshot as DesignProjectSnapshotV1 } from "./design-project-contract.js";
import { validateGenerativeUiHtml } from "./generative-ui-html.js";
import type {
  CommittedGenerativeUiRecoverySource,
  StagedHtmlArtifact,
} from "./generative-ui-artifact-store.js";

export function isValidDesignArtifactSource(
  source: { artifact: ChatHtmlArtifactV1; html: string } | undefined,
): source is { artifact: ChatHtmlArtifactV1; html: string } {
  if (!source) return false;
  if (
    Buffer.byteLength(source.html, "utf8") !== source.artifact.size ||
    createHash("sha256").update(source.html).digest("hex") !== source.artifact.id
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

/**
 * Authorize a revision published into the exact durable project lineage.
 * Fully unannotated legacy rows may fall back to exact project membership;
 * partially annotated modern rows fail closed.
 */
export function projectOwnsPublishedDesignSource(
  project: DesignProjectSnapshotV1 | undefined,
  source: CommittedGenerativeUiRecoverySource,
): boolean {
  if (!project || project.chatId !== source.chatId) return false;
  const owners = project.canvas.nodes.filter(
    (node) =>
      node.kind === "artboard" &&
      node.lineageId !== undefined &&
      node.artifactMediaIds?.includes(source.artifact.mediaId) === true,
  );
  if (owners.length !== 1) return false;
  const [owner] = owners;
  if (!source.designOwnership && !source.designPublication) return true;
  return (
    source.designPublication === "published" &&
    source.designOwnership?.projectId === project.id &&
    source.designOwnership.lineageId === owner?.lineageId
  );
}

export function isUsablePublishedDesignSource(
  project: DesignProjectSnapshotV1 | undefined,
  source: CommittedGenerativeUiRecoverySource | undefined,
): source is CommittedGenerativeUiRecoverySource {
  return isValidDesignArtifactSource(source) && projectOwnsPublishedDesignSource(project, source);
}

/**
 * Narrow authority for one staged candidate while its owning generation is
 * live. This does not make the source durable or eligible for context/export.
 */
export function projectOwnsLiveDesignCandidateSource(
  project: DesignProjectSnapshotV1 | undefined,
  source: StagedHtmlArtifact,
): boolean {
  if (
    !project ||
    source.chatId !== project.chatId ||
    source.committed ||
    source.designPublication !== "candidate" ||
    source.designOwnership?.projectId !== project.id
  ) {
    return false;
  }
  const ownership = source.designOwnership;
  if (ownership.kind === "new-artboard") {
    return !project.canvas.nodes.some(
      (node) =>
        node.lineageId === ownership.lineageId ||
        node.artifactMediaIds?.includes(source.artifact.mediaId) === true,
    );
  }
  const owners = project.canvas.nodes.filter(
    (node) =>
      node.kind === "artboard" &&
      node.lineageId === ownership.lineageId &&
      node.activeMediaId === ownership.baseMediaId &&
      node.artifactMediaIds?.includes(ownership.baseMediaId) === true,
  );
  return owners.length === 1;
}

export function isUsableLiveDesignCandidateSource(
  project: DesignProjectSnapshotV1 | undefined,
  source: StagedHtmlArtifact | undefined,
): source is StagedHtmlArtifact {
  return (
    isValidDesignArtifactSource(source) && projectOwnsLiveDesignCandidateSource(project, source)
  );
}
