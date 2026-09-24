import type { Attachment } from "./types.js";
import {
  attachmentInlineBytesRemaining,
  attachmentSlotsRemaining,
} from "../shared/attachment-contract.js";

/** A completion belongs to one mounted composer and one attachment attempt. */
export class ComposerAttachmentOperation {
  private generation = 0;
  private busy = false;

  get isBusy(): boolean {
    return this.busy;
  }

  begin(): number | null {
    if (this.busy) return null;
    this.busy = true;
    return ++this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  finish(token: number): void {
    if (this.isCurrent(token)) this.busy = false;
  }

  cancel(): void {
    this.generation += 1;
    this.busy = false;
  }
}

/** Recheck capacity at commit: annotations or send recovery can change the draft during I/O. */
export function acceptComposerAttachments(
  current: readonly Attachment[],
  added: readonly Attachment[],
  includeImages: boolean,
): Attachment[] {
  let remainingSlots = attachmentSlotsRemaining(current.length);
  let remainingBytes = attachmentInlineBytesRemaining(current);
  const ids = new Set(current.map((attachment) => attachment.id));
  const accepted: Attachment[] = [];
  for (const attachment of added) {
    if (remainingSlots === 0) break;
    if (ids.has(attachment.id) || (!includeImages && attachment.kind === "image")) continue;
    const bytes =
      attachment.kind === "image"
        ? attachment.size
        : new TextEncoder().encode(attachment.text ?? "").byteLength;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remainingBytes) continue;
    accepted.push(attachment);
    ids.add(attachment.id);
    remainingSlots -= 1;
    remainingBytes -= bytes;
  }
  return accepted;
}
