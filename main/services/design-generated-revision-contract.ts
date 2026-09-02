import { createHash } from "node:crypto";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { isDesignProjectOpaqueId } from "./design-project-contract.js";

export const DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION = 1 as const;
export const DESIGN_ARTIFACT_RECOVERY_GENERATION_PREFIX = "journal-recovery:" as const;

const DESIGN_ARTIFACT_RECOVERY_GENERATION_ID = /^journal-recovery:[a-f0-9]{64}$/u;

export function isDesignArtifactRecoveryGenerationId(value: string): boolean {
  return DESIGN_ARTIFACT_RECOVERY_GENERATION_ID.test(value);
}

/**
 * Main-owned durable claim binding one immutable generated blob to one Design
 * Project lineage. The artifact record supplies the revision/media ID, so the
 * canonical identity is exactly projectId + lineageId + artifact.mediaId.
 */
export type DesignGeneratedRevisionOwnershipV1 =
  | {
      version: typeof DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION;
      kind: "new-artboard";
      projectId: string;
      lineageId: string;
    }
  | {
      version: typeof DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION;
      kind: "revision";
      projectId: string;
      lineageId: string;
      baseMediaId: string;
    };

export interface OwnedDesignGeneratedRevisionV1 {
  mediaId: string;
  ownership: DesignGeneratedRevisionOwnershipV1;
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

export function generatedDesignLineageId(projectId: string, mediaId: string): string {
  return `lineage:${digest(["generated-design-lineage", projectId, mediaId])}`;
}

export function generatedDesignNodeId(projectId: string, lineageId: string): string {
  return `node:${digest(["generated-design-node", projectId, lineageId])}`;
}

export function newArtboardOwnership(
  projectId: string,
  mediaId: string,
): DesignGeneratedRevisionOwnershipV1 {
  return {
    version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
    kind: "new-artboard",
    projectId,
    lineageId: generatedDesignLineageId(projectId, mediaId),
  };
}

export function parseDesignGeneratedRevisionOwnershipV1(
  value: unknown,
  artifact: ChatHtmlArtifactV1,
): DesignGeneratedRevisionOwnershipV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.version !== DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION ||
    (record.kind !== "new-artboard" && record.kind !== "revision") ||
    !isDesignProjectOpaqueId(record.projectId) ||
    !isDesignProjectOpaqueId(record.lineageId) ||
    !artifact.mediaId.startsWith("design:")
  ) {
    return undefined;
  }
  if (record.kind === "new-artboard") {
    if (
      keys.length !== 4 ||
      keys.some((key) => !["version", "kind", "projectId", "lineageId"].includes(key)) ||
      artifact.revisionOfMediaId !== undefined ||
      record.lineageId !== generatedDesignLineageId(record.projectId, artifact.mediaId)
    ) {
      return undefined;
    }
    return {
      version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
      kind: "new-artboard",
      projectId: record.projectId,
      lineageId: record.lineageId,
    };
  }
  if (
    keys.length !== 5 ||
    keys.some(
      (key) => !["version", "kind", "projectId", "lineageId", "baseMediaId"].includes(key),
    ) ||
    !isDesignProjectOpaqueId(record.baseMediaId) ||
    !record.baseMediaId.startsWith("design:") ||
    artifact.revisionOfMediaId !== record.baseMediaId
  ) {
    return undefined;
  }
  return {
    version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
    kind: "revision",
    projectId: record.projectId,
    lineageId: record.lineageId,
    baseMediaId: record.baseMediaId,
  };
}
