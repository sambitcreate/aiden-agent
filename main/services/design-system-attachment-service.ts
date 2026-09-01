import {
  DesignSystemSnapshotStore,
  type DesignSystemRendererProjectionV1,
} from "./design-system-snapshot-store.js";
import type { DesignSystemAttachmentRecordV1 } from "./design-system-snapshot-core.js";
import {
  extractReviewedDesignSystemIndex,
  inspectReviewedDesignSystemSources,
  type DesignSystemWorkspaceExtractorOptions,
} from "./design-system-workspace-extractor.js";

/**
 * Main-process orchestration boundary for explicit attach, refresh, freshness,
 * and detach actions. Callers must provide the currently user-reviewed source
 * selection for every filesystem operation; attachment identity alone grants
 * no workspace read authority.
 */
export class DesignSystemAttachmentService {
  constructor(private readonly store: DesignSystemSnapshotStore) {}

  async attach(
    reviewedExtractionInput: unknown,
    options: DesignSystemWorkspaceExtractorOptions = {},
  ): Promise<DesignSystemAttachmentRecordV1> {
    const index = await extractReviewedDesignSystemIndex(reviewedExtractionInput, options);
    return this.store.create(index);
  }

  async refresh(
    attachmentId: string,
    expectedRevision: number,
    reviewedExtractionInput: unknown,
    options: DesignSystemWorkspaceExtractorOptions = {},
  ): Promise<DesignSystemAttachmentRecordV1> {
    const index = await extractReviewedDesignSystemIndex(reviewedExtractionInput, options);
    return this.store.refresh(attachmentId, expectedRevision, index);
  }

  async rendererProjection(
    attachmentId: string,
    reviewedExtractionInput: unknown,
    options: DesignSystemWorkspaceExtractorOptions = {},
  ): Promise<DesignSystemRendererProjectionV1> {
    const record = await this.store.getRecord(attachmentId);
    if (record?.state === "detached") {
      return this.store.rendererProjection(attachmentId, []);
    }
    const currentSources = await inspectReviewedDesignSystemSources(
      reviewedExtractionInput,
      options,
    );
    return this.store.rendererProjection(attachmentId, currentSources);
  }

  detach(attachmentId: string, expectedRevision: number): Promise<DesignSystemAttachmentRecordV1> {
    return this.store.detach(attachmentId, expectedRevision);
  }
}
