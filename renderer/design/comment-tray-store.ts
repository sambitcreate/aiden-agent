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
  /**
   * The `<attached-design-comments>` block for these comments, naming the
   * attached picture of each comment that has one, by comment id.
   */
  block(pictures?: Readonly<Record<string, string>>): string;
  remove(id: string): void;
  /**
   * Marks these comments sent and saves the canvas, before the message that
   * carries them goes, so Aiden's turn finds them sent rather than still
   * drafts. Never rejects. `done` is for a send that went (it drops the
   * comments' pictures); `undo` for one that failed or was cancelled (it puts
   * them back in the tray, keeping edits made meanwhile).
   */
  markSent(ids: readonly string[]): Promise<DesignCommentSend>;
  /** Brings a comment on screen and opens it. */
  open(id: string): void;
};

export type DesignCommentSend = { done(): void; undo(): void };

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

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * What a message carries for the tray: the comments block as a text file and,
 * when the model takes images and room is left, a picture of each spot. The
 * block always goes first and names the picture each comment has, so Aiden
 * knows which image shows which comment; pictures that do not fit are left
 * out, and so is their name.
 */
export function designCommentAttachments(input: {
  block: (pictures: Readonly<Record<string, string>>) => string;
  /** The tray's comments in order, each with the picture of its spot when one was taken. */
  comments: readonly { id: string; picture?: DesignCommentCrop | undefined }[];
  existing: readonly Attachment[];
  supportsImages: boolean;
  id: string;
}): Attachment[] | null {
  const slots = attachmentSlotsRemaining(input.existing.length);
  const remaining = attachmentInlineBytesRemaining(input.existing);
  const offered = input.supportsImages
    ? input.comments.flatMap((comment, index) =>
        comment.picture
          ? [{
              commentId: comment.id,
              index,
              crop: comment.picture,
              name: `Design comment ${index + 1}.${comment.picture.mimeType === "image/png" ? "png" : "jpg"}`,
            }]
          : [],
      )
    : [];
  // Naming a picture only lengthens the block, so the block naming every
  // offered picture bounds the one that goes: pictures are fitted in the room
  // that leaves, then the block names the ones that fit.
  const widest = byteLength(input.block(Object.fromEntries(offered.map((picture) => [picture.commentId, picture.name]))));
  let pictureSlots = slots - 1;
  let pictureBytes = remaining - widest;
  const chosen: typeof offered = [];
  for (const picture of offered) {
    const bytes = base64Bytes(picture.crop.data);
    if (pictureSlots < 1 || bytes > pictureBytes || bytes > MAX_INLINE_IMAGE_BYTES) continue;
    chosen.push(picture);
    pictureSlots -= 1;
    pictureBytes -= bytes;
  }
  const block = input.block(Object.fromEntries(chosen.map((picture) => [picture.commentId, picture.name])));
  const size = byteLength(block);
  if (slots < 1 || size > remaining) return null;
  return [
    { id: `${input.id}-comments`, name: "Design comments.txt", kind: "text", mimeType: "text/plain", text: block, size },
    ...chosen.map((picture): Attachment => ({
      id: `${input.id}-picture-${picture.index + 1}`,
      name: picture.name,
      kind: "image",
      mimeType: picture.crop.mimeType,
      data: picture.crop.data,
      size: base64Bytes(picture.crop.data),
    })),
  ];
}
