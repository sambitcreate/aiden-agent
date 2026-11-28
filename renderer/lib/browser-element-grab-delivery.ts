import {
  attachmentInlineBytesRemaining,
  attachmentSlotsRemaining,
  MAX_INLINE_IMAGE_BYTES,
} from "../shared/attachment-contract";
import {
  grabbedElementDedupKey,
  grabbedElementsRepresentationBytes,
  grabbedElementThumbnailId,
  MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES,
  MAX_GRABBED_ELEMENTS_PER_MESSAGE,
  MAX_GRABBED_ELEMENTS_TOTAL_BYTES,
  type GrabbedElementCapture,
  type GrabbedElementContextV1,
  type GrabbedElementThumbnail,
} from "../shared/browser-element-grab";
import { ComposerDeliveryRegistry } from "./composer-delivery";
import type { Attachment } from "./types";

/** Main validates and masks the grabbed element; this registry acknowledges the draft write. */
export class BrowserElementGrabDeliveryRegistry extends ComposerDeliveryRegistry<GrabbedElementCapture> {}

export const browserElementGrabDelivery = new BrowserElementGrabDeliveryRegistry();

export const BROWSER_ELEMENT_GRAB_UNAVAILABLE =
  "The chat composer is not available. Finish the current question or return to a chat, then grab an element again.";

function decodedBase64Bytes(data: string): number | null {
  if (data.length === 0 || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function isValidThumbnailImage(
  thumbnail: GrabbedElementThumbnail | undefined,
): { bytes: number; ext: "png" | "jpg" } | null {
  if (!thumbnail) return null;
  const bytes = decodedBase64Bytes(thumbnail.data);
  if (bytes === null || bytes <= 0) return null;
  if (bytes > MAX_GRABBED_ELEMENT_THUMBNAIL_BYTES || bytes > MAX_INLINE_IMAGE_BYTES) return null;
  if (thumbnail.mimeType === "image/png" && thumbnail.data.startsWith("iVBORw0KGgo")) {
    return { bytes, ext: "png" };
  }
  if (thumbnail.mimeType === "image/jpeg" && thumbnail.data.startsWith("/9j/")) {
    return { bytes, ext: "jpg" };
  }
  return null;
}

function thumbnailFileName(element: GrabbedElementContextV1, ext: "png" | "jpg"): string {
  const raw = (element.componentName ?? element.label ?? element.tagName)
    .replace(/[<>/\\:\s]+/gu, "")
    .replace(/[^A-Za-z0-9._-]/gu, "");
  const base = raw.slice(0, 48) || "element";
  return `${base}.${ext}`;
}

/**
 * Builds the optional linked `grab-thumb_<id>` image attachment for a grabbed element capture,
 * respecting message attachment slot and byte budgets.
 */
export function grabbedElementThumbnailAttachments(
  capture: GrabbedElementCapture,
  existing: readonly Attachment[],
): { attachments: Attachment[]; imageSkipped: boolean } {
  const validated = isValidThumbnailImage(capture.thumbnail);
  if (!validated || !capture.thumbnail) {
    return { attachments: [], imageSkipped: Boolean(capture.thumbnail) };
  }
  const slots = attachmentSlotsRemaining(existing.length);
  const remainingBytes = attachmentInlineBytesRemaining(existing);
  if (slots <= 0 || validated.bytes > remainingBytes) {
    return { attachments: [], imageSkipped: true };
  }
  const attachment: Attachment = {
    id: grabbedElementThumbnailId(capture.element.id),
    name: thumbnailFileName(capture.element, validated.ext),
    kind: "image",
    mimeType: capture.thumbnail.mimeType,
    data: capture.thumbnail.data,
    size: validated.bytes,
  };
  return { attachments: [attachment], imageSkipped: false };
}

export interface MaterializedGrabbedElementDraft {
  accepted: boolean;
  reason?: "limit" | "size";
  replaced: boolean;
  element: GrabbedElementContextV1;
  elements: GrabbedElementContextV1[];
  attachments: Attachment[];
  thumbnailAttachment?: Attachment;
  thumbnailSkipped: boolean;
}

/**
 * Merges a newly grabbed browser element into the current composer draft state:
 * - Deduplicates by `grabbedElementDedupKey`, refreshing the existing entry and its thumbnail in place.
 * - Enforces `MAX_GRABBED_ELEMENTS_PER_MESSAGE` and `MAX_GRABBED_ELEMENTS_TOTAL_BYTES`.
 * - Degrades gracefully to text-only metadata if attachment slot/byte budgets cannot fit the thumbnail.
 */
export function materializeGrabbedElementDraft(
  capture: GrabbedElementCapture,
  existingElements: readonly GrabbedElementContextV1[],
  existingAttachments: readonly Attachment[],
): MaterializedGrabbedElementDraft {
  const dedupKey = grabbedElementDedupKey(capture.element);
  const matchIndex = existingElements.findIndex(
    (entry) => grabbedElementDedupKey(entry) === dedupKey,
  );
  const replaced = matchIndex >= 0;

  if (!replaced && existingElements.length >= MAX_GRABBED_ELEMENTS_PER_MESSAGE) {
    return {
      accepted: false,
      reason: "limit",
      replaced: false,
      element: capture.element,
      elements: [...existingElements],
      attachments: [...existingAttachments],
      thumbnailSkipped: false,
    };
  }

  const staleThumbnailId = replaced
    ? (existingElements[matchIndex].thumbnailAttachmentId ??
      grabbedElementThumbnailId(existingElements[matchIndex].id))
    : null;
  const newThumbnailId = grabbedElementThumbnailId(capture.element.id);
  const baseAttachments = existingAttachments.filter(
    (attachment) => attachment.id !== staleThumbnailId && attachment.id !== newThumbnailId,
  );

  const { attachments: addedThumbnails, imageSkipped } = grabbedElementThumbnailAttachments(
    capture,
    baseAttachments,
  );
  const thumbnailAttachment = addedThumbnails[0];

  const nextElement: GrabbedElementContextV1 = { ...capture.element };
  if (thumbnailAttachment) {
    nextElement.thumbnailAttachmentId = thumbnailAttachment.id;
  } else {
    delete nextElement.thumbnailAttachmentId;
  }

  const nextElements = [...existingElements];
  if (replaced) {
    nextElements[matchIndex] = nextElement;
  } else {
    nextElements.push(nextElement);
  }

  if (grabbedElementsRepresentationBytes(nextElements) > MAX_GRABBED_ELEMENTS_TOTAL_BYTES) {
    return {
      accepted: false,
      reason: "size",
      replaced: false,
      element: capture.element,
      elements: [...existingElements],
      attachments: [...existingAttachments],
      thumbnailSkipped: false,
    };
  }

  const nextAttachments = thumbnailAttachment
    ? [...baseAttachments, thumbnailAttachment]
    : baseAttachments;

  return {
    accepted: true,
    replaced,
    element: nextElement,
    elements: nextElements,
    attachments: nextAttachments,
    ...(thumbnailAttachment ? { thumbnailAttachment } : {}),
    thumbnailSkipped: imageSkipped,
  };
}
