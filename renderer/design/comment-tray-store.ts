// The tray of design comments waiting to go to Aiden, shared between the
// canvas that owns them and the chat's composer that sends them. The canvas
// publishes its tray while it is mounted; the composer reads it. Pictures of
// each commented spot are taken when the comment is saved and kept here, in
// memory only, until the comment is sent or the app closes.

import * as React from "react";
import {
  attachmentInlineBytesRemaining,
  attachmentSlotsRemaining,
  MAX_INLINE_IMAGE_BYTES,
} from "../shared/attachment-contract";
import type { Attachment } from "../lib/types";

export type DesignTrayComment = { id: string; label: string; note: string };

export type DesignCommentTray = {
  comments: readonly DesignTrayComment[];
  /** The `<attached-design-comments>` block for these comments. */
  block: string;
  remove(id: string): void;
  markSent(ids: readonly string[]): void;
  /** Brings a comment on screen and opens it. */
  open(id: string): void;
};

export type DesignCommentCrop = { mimeType: "image/png" | "image/jpeg"; data: string };

const trays = new Map<string, DesignCommentTray>();
const crops = new Map<string, DesignCommentCrop>();
const listeners = new Set<() => void>();

const cropKey = (chatId: string, commentId: string) => `${chatId}\n${commentId}`;

export function publishDesignCommentTray(chatId: string, tray: DesignCommentTray | null): void {
  if (tray && tray.comments.length > 0) trays.set(chatId, tray);
  else if (!trays.delete(chatId)) return;
  for (const listener of listeners) listener();
}

export function designCommentTray(chatId: string): DesignCommentTray | null {
  return trays.get(chatId) ?? null;
}

export function useDesignCommentTray(chatId: string): DesignCommentTray | null {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => trays.get(chatId) ?? null,
    () => null,
  );
}

/** Keeps the picture of a commented spot, from a PNG or JPEG data URL. */
export function rememberCommentCrop(chatId: string, commentId: string, dataUrl: string): void {
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
  if (!match) return;
  crops.set(cropKey(chatId, commentId), { mimeType: match[1] as DesignCommentCrop["mimeType"], data: match[2]! });
}

export function forgetCommentCrops(chatId: string, commentIds: readonly string[]): void {
  for (const id of commentIds) crops.delete(cropKey(chatId, id));
}

export function commentCrop(chatId: string, commentId: string): DesignCommentCrop | undefined {
  return crops.get(cropKey(chatId, commentId));
}

function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/**
 * What a message carries for the tray: the comments block as a text file and,
 * when the model takes images and room is left, a picture of each spot. The
 * block always goes first; pictures that do not fit are left out.
 */
export function designCommentAttachments(input: {
  block: string;
  pictures: readonly (DesignCommentCrop | undefined)[];
  existing: readonly Attachment[];
  supportsImages: boolean;
  id: string;
}): Attachment[] | null {
  let slots = attachmentSlotsRemaining(input.existing.length);
  let remaining = attachmentInlineBytesRemaining(input.existing);
  const size = new TextEncoder().encode(input.block).byteLength;
  if (slots < 1 || size > remaining) return null;
  const attachments: Attachment[] = [
    { id: `${input.id}-comments`, name: "Design comments.txt", kind: "text", mimeType: "text/plain", text: input.block, size },
  ];
  slots -= 1;
  remaining -= size;
  if (!input.supportsImages) return attachments;
  input.pictures.forEach((picture, index) => {
    if (!picture || slots < 1) return;
    const bytes = base64Bytes(picture.data);
    if (bytes > remaining || bytes > MAX_INLINE_IMAGE_BYTES) return;
    attachments.push({
      id: `${input.id}-picture-${index + 1}`,
      name: `Design comment ${index + 1}.${picture.mimeType === "image/png" ? "png" : "jpg"}`,
      kind: "image",
      mimeType: picture.mimeType,
      data: picture.data,
      size: bytes,
    });
    slots -= 1;
    remaining -= bytes;
  });
  return attachments;
}
