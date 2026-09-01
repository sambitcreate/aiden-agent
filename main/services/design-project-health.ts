import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";

export interface DesignProjectHealthV1 {
  health: "ready" | "needs-repair";
  recoveryMessage?: string;
}

export interface DesignProjectHealthSources {
  hasArtifact(chatId: string, mediaId: string): Promise<boolean>;
  hasReferenceAsset(assetId: string): Promise<boolean>;
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
          "A saved reference image is missing. Open the project to remove or replace it.",
      };
    }
  }
  for (const mediaId of project.canvas.nodes.flatMap((node) =>
    node.kind === "artboard" ? (node.artifactMediaIds ?? []) : [],
  )) {
    if (!(await sources.hasArtifact(project.chatId, mediaId))) {
      return {
        health: "needs-repair",
        recoveryMessage:
          "A saved artboard revision is missing. Earlier project data was preserved for repair.",
      };
    }
  }
  return { health: "ready" };
}
