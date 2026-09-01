import { DesignSystemAttachmentService } from "./design-system-attachment-service.js";
import { DesignSystemSnapshotStore } from "./design-system-snapshot-store.js";
import * as fs from "node:fs/promises";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";

export const designSystemSnapshotStore = new DesignSystemSnapshotStore();
export const designSystemAttachmentService = new DesignSystemAttachmentService(
  designSystemSnapshotStore,
);

function reviewedSources(
  record: NonNullable<Awaited<ReturnType<DesignSystemSnapshotStore["getRecord"]>>>,
) {
  if (record.state !== "attached") throw new Error("The attached design system was detached.");
  return record.provenance.map(({ sourceId, workspaceRelativePath }) => {
    const kind = sourceId.startsWith("tokens-v1:")
      ? ("tokens-v1" as const)
      : sourceId.startsWith("catalog-v1:")
        ? ("catalog-v1" as const)
        : undefined;
    if (!kind) throw new Error("Reattach this design system to verify its source schema.");
    return { sourceId, workspaceRelativePath, kind, reviewed: true as const };
  });
}

/** Prove freshness and project only the normalized data that a Design turn may send. */
export async function currentDesignSystemModelContext(
  project: DesignProjectSnapshotV1,
  workspaceRoot: string,
) {
  if (!project.designSystemBinding) return undefined;
  const record = await designSystemSnapshotStore.getRecord(project.designSystemBinding.id);
  if (!record || record.revision !== project.designSystemBinding.revision) {
    throw new Error("Refresh the attached design system before starting this Design turn.");
  }
  if (record.state !== "attached") throw new Error("The attached design system is unavailable.");
  const rootPath = await fs.realpath(workspaceRoot);
  const identity = await fs.stat(rootPath, { bigint: true });
  const projection = await designSystemAttachmentService.rendererProjection(record.attachmentId, {
    name: record.snapshot.name,
    authority: {
      rootPath,
      device: identity.dev.toString(),
      inode: identity.ino.toString(),
    },
    sources: reviewedSources(record),
  });
  if (projection.freshness !== "current" || !projection.snapshot) {
    throw new Error("Refresh the attached design system before starting this Design turn.");
  }
  const snapshot = projection.snapshot;
  const values = (items: readonly { name: string; value: string }[]) =>
    items.map(({ name, value }) => ({ name, value }));
  return {
    name: snapshot.name,
    tokens: {
      colors: values(snapshot.tokens.colors),
      spacing: values(snapshot.tokens.spacing),
      typography: snapshot.tokens.typography.map(
        ({ name, families, size, lineHeight, weight, letterSpacing }) => ({
          name,
          families,
          size,
          lineHeight,
          weight,
          ...(letterSpacing ? { letterSpacing } : {}),
        }),
      ),
      radii: values(snapshot.tokens.radii),
      shadows: values(snapshot.tokens.shadows),
    },
    components: snapshot.components.map(({ name, description, variants, states }) => ({
      name,
      ...(description ? { description } : {}),
      variants,
      states,
    })),
    icons: snapshot.icons.map(({ name, label, style, tags }) => ({
      name,
      ...(label ? { label } : {}),
      ...(style ? { style } : {}),
      tags,
    })),
  };
}
