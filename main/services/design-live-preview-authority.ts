export interface DesignLivePreviewGrant {
  streamId: string;
  documentId: string;
  chatId: string;
  mediaId: string;
}

export type DesignLivePreviewAdmission = Omit<DesignLivePreviewGrant, "mediaId">;

interface DesignLivePreviewRecord {
  ownerDocumentId: string;
  boundDocumentId?: string;
  chatId: string;
  mediaIds: Set<string>;
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value;
}

/**
 * Ephemeral authority for optimistic Design previews. Grants are bound to one
 * active generation, renderer document, chat, and exact staged media identity;
 * they never authorize persisted reads or export.
 */
export class DesignLivePreviewAuthority {
  private readonly records = new Map<string, DesignLivePreviewRecord>();

  /** Establish stream ownership before the model can stage its first artifact. */
  admitStream(input: DesignLivePreviewAdmission): void {
    if (
      !validIdentity(input.streamId) ||
      !validIdentity(input.documentId) ||
      !validIdentity(input.chatId)
    ) {
      throw new Error("Invalid live Design preview authority.");
    }
    const existing = this.records.get(input.streamId);
    if (existing) {
      if (existing.ownerDocumentId !== input.documentId || existing.chatId !== input.chatId) {
        throw new Error("Live Design preview authority changed owners.");
      }
      return;
    }
    this.records.set(input.streamId, {
      ownerDocumentId: input.documentId,
      boundDocumentId: input.documentId,
      chatId: input.chatId,
      mediaIds: new Set(),
    });
  }

  grant(input: DesignLivePreviewGrant): void {
    if (
      !validIdentity(input.streamId) ||
      !validIdentity(input.documentId) ||
      !validIdentity(input.chatId) ||
      !validIdentity(input.mediaId)
    ) {
      throw new Error("Invalid live Design preview authority.");
    }
    const existing = this.records.get(input.streamId);
    if (existing) {
      if (existing.ownerDocumentId !== input.documentId || existing.chatId !== input.chatId) {
        throw new Error("Live Design preview authority changed owners.");
      }
      existing.mediaIds.add(input.mediaId);
      return;
    }
    this.admitStream(input);
    this.records.get(input.streamId)!.mediaIds.add(input.mediaId);
  }

  allows(input: DesignLivePreviewGrant): boolean {
    const record = this.records.get(input.streamId);
    return (
      record?.boundDocumentId === input.documentId &&
      record.chatId === input.chatId &&
      record.mediaIds.has(input.mediaId)
    );
  }

  /** Main-only lifecycle check used to keep reconciliation away from live candidates. */
  hasStream(streamId: string): boolean {
    return this.records.has(streamId);
  }

  /** Includes suspended streams so route re-entry cannot race detached generation ownership. */
  hasChat(chatId: string): boolean {
    for (const record of this.records.values()) {
      if (record.chatId === chatId) return true;
    }
    return false;
  }

  /** Revoke document access without discarding the main-owned staged-media set. */
  suspendStream(streamId: string, documentId: string): boolean {
    const record = this.records.get(streamId);
    if (!record || record.ownerDocumentId !== documentId) return false;
    record.boundDocumentId = undefined;
    return true;
  }

  /**
   * Rebind a suspended stream only to the exact renderer document and chat that
   * originally owned it. Media authority remains the immutable main-owned set.
   */
  resumeStream(input: { streamId: string; documentId: string; chatId: string }): boolean {
    if (
      !validIdentity(input.streamId) ||
      !validIdentity(input.documentId) ||
      !validIdentity(input.chatId)
    ) {
      return false;
    }
    const record = this.records.get(input.streamId);
    if (
      !record ||
      record.boundDocumentId !== undefined ||
      record.ownerDocumentId !== input.documentId ||
      record.chatId !== input.chatId
    ) {
      return false;
    }
    record.boundDocumentId = input.documentId;
    return true;
  }

  revokeStream(streamId: string): void {
    this.records.delete(streamId);
  }
}
