/**
 * Snapshot images of inline visuals. Each is stored as an ordinary PNG/JPEG
 * attachment on its assistant message, so the Aiden Remote attachment route
 * and the phones' image views work unchanged, but under a reserved id prefix
 * so the desktop never shows it twice, never counts it against image limits,
 * and never feeds it back to the model.
 */

export const VISUAL_SNAPSHOT_ID_PREFIX = "visual-snapshot_";
const SNAPSHOT_ID = /^visual-snapshot_[0-9a-f]{64}$/u;
const VISUAL_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_SNAPSHOTS = 40;

export interface VisualSnapshotRefV1 {
  /** The HTML artifact's mediaId or the native visual's id. */
  visualId: string;
  attachmentId: string;
}

export function isVisualSnapshotAttachmentId(id: unknown): boolean {
  return typeof id === "string" && SNAPSHOT_ID.test(id);
}

/** Lenient: bad entries are dropped individually; unknown keys are ignored. */
export function parseVisualSnapshots(value: unknown): VisualSnapshotRefV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const refs: VisualSnapshotRefV1[] = [];
  for (const entry of value.slice(0, MAX_SNAPSHOTS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.visualId !== "string" || !VISUAL_ID.test(record.visualId)) continue;
    if (!isVisualSnapshotAttachmentId(record.attachmentId)) continue;
    if (seen.has(record.visualId)) continue;
    seen.add(record.visualId);
    refs.push({ visualId: record.visualId, attachmentId: record.attachmentId as string });
  }
  return refs.length ? refs : undefined;
}

/**
 * The attachments the desktop shows beside a message. A snapshot is hidden
 * only when this message draws the visual it pictures; a paired Mac's chat
 * carries nothing this desktop can draw, so there the snapshot is the visual.
 */
export function attachmentsShownWithVisuals<T extends { id: string }>(message: {
  attachments?: readonly T[];
  visualSnapshots?: unknown;
  uiVisuals?: readonly { id: string }[];
  htmlArtifacts?: readonly { mediaId: string }[];
}): readonly T[] {
  const attachments = message.attachments ?? [];
  const refs = parseVisualSnapshots(message.visualSnapshots);
  if (!refs || attachments.length === 0) return attachments;
  const drawn = new Set([
    ...(message.uiVisuals ?? []).map((visual) => visual.id),
    ...(message.htmlArtifacts ?? []).map((artifact) => artifact.mediaId),
  ]);
  const hidden = new Set(refs.filter((ref) => drawn.has(ref.visualId)).map((ref) => ref.attachmentId));
  return hidden.size > 0 ? attachments.filter((attachment) => !hidden.has(attachment.id)) : attachments;
}

/** Drops snapshot attachments; returns the same array when there were none. */
export function withoutVisualSnapshots<T extends { id: string }>(attachments: readonly T[]): readonly T[] {
  return attachments.some((attachment) => isVisualSnapshotAttachmentId(attachment.id))
    ? attachments.filter((attachment) => !isVisualSnapshotAttachmentId(attachment.id))
    : attachments;
}
