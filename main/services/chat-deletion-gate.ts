/**
 * Closes chat-generation admission while chat and private inspector history
 * are deleted together. Callers must begin before their first awaited delete
 * operation and release only after both stores have settled.
 */
export class ChatDeletionGate {
  private readonly deleting = new Set<string>();

  isDeleting(chatId: string): boolean {
    return this.deleting.has(chatId);
  }

  begin(chatId: string): () => void {
    if (this.deleting.has(chatId)) {
      throw new Error("This chat is already being deleted.");
    }
    this.deleting.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.deleting.delete(chatId);
    };
  }
}
