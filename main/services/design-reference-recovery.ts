import type { DesignProjectMutationResultV1 } from "../../renderer/shared/design-projects.js";
import type { DesignReferenceAssetStore } from "./design-reference-asset-store.js";
import {
  DesignProjectRevisionConflictError,
  type DesignProjectStore,
} from "./design-project-store.js";

export interface DesignReferenceRecoveryDependencies {
  projects: Pick<DesignProjectStore, "get" | "removeMissingReferenceAsset">;
  assets: Pick<DesignReferenceAssetStore, "withMissingAssetGuard">;
}

/** Main-owned recovery for a durable project reference whose immutable bytes are gone. */
export class DesignReferenceRecoveryService {
  constructor(private readonly dependencies: DesignReferenceRecoveryDependencies) {}

  async removeMissing(input: {
    projectId: string;
    expectedRevision: number;
    assetId: string;
  }): Promise<DesignProjectMutationResultV1> {
    const current = await this.dependencies.projects.get(input.projectId);
    if (!current) throw new Error("Design Project was not found.");
    if (current.revision !== input.expectedRevision) {
      return { status: "conflict", current };
    }
    const ownsReference =
      current.referenceAssetIds.includes(input.assetId) &&
      current.canvas.nodes.some(
        (node) => node.kind === "reference-image" && node.assetId === input.assetId,
      );
    if (!ownsReference) {
      throw new Error("The missing reference image is no longer part of this project.");
    }
    try {
      const guarded = await this.dependencies.assets.withMissingAssetGuard(input.assetId, () =>
        this.dependencies.projects.removeMissingReferenceAsset(input),
      );
      if (guarded.status === "asset-present") {
        throw new Error(
          "This reference image is available again. Reopen the project to restore it.",
        );
      }
      const project = guarded.value;
      return { status: "updated", project };
    } catch (error) {
      if (!(error instanceof DesignProjectRevisionConflictError)) throw error;
      const latest = await this.dependencies.projects.get(input.projectId);
      if (!latest) throw new Error("Design Project was not found.");
      return { status: "conflict", current: latest };
    }
  }
}
