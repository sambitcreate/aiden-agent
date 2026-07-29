/**
 * Serializes an empty chat's one-time workspace move against generation
 * admission. Both sides enter synchronously before their first await.
 */
export class ChatWorkspaceMutationGate {
  private readonly changing = new Set<string>();

  tryBegin(chatId: string, busy: boolean): (() => void) | null {
    if (busy || this.changing.has(chatId)) return null;
    this.changing.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.changing.delete(chatId);
    };
  }

  isChanging(chatId: string): boolean {
    return this.changing.has(chatId);
  }
}
