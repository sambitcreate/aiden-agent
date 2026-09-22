export interface DesignPreviewDocument {
  title: string;
  src: string;
  contentHash: string;
  designCapability: string;
}

/** URL-only reuse after source authorization; never a source/authority cache. */
export class DesignPreviewCache {
  private readonly entries = new Map<string, { document: DesignPreviewDocument; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  get(documentId: string, chatId: string, contentHash: string): DesignPreviewDocument | undefined {
    this.prune();
    return this.entries.get(JSON.stringify([documentId, chatId, contentHash]))?.document;
  }

  set(documentId: string, chatId: string, document: DesignPreviewDocument): void {
    this.prune();
    const key = JSON.stringify([documentId, chatId, document.contentHash]);
    this.entries.delete(key);
    // The protocol token lasts 30 minutes. Never reuse it close to expiration.
    this.entries.set(key, { document, expiresAt: this.now() + 5 * 60_000 });
    while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    }
  }
}
