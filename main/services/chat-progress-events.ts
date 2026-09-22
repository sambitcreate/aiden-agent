import type { TodoSnapshotViewV1 } from "../../renderer/shared/todo.js";

/** Process-local invalidations, not another persistence authority. */
export class ChatProgressEvents {
  private readonly active = new Map<
    string,
    { generationId: string; todo?: TodoSnapshotViewV1 }
  >();
  private readonly listeners = new Map<string, Set<() => void>>();
  private serial = 0;
  private readonly revisions = new Map<string, number>();

  revision(chatId: string): number {
    return this.revisions.get(chatId) ?? 0;
  }

  begin(chatId: string, generationId: string): void {
    this.active.set(chatId, { generationId });
    this.changed(chatId);
  }

  current(
    chatId: string,
  ): { generationId: string; todo?: TodoSnapshotViewV1 } | undefined {
    const value = this.active.get(chatId);
    return value && structuredClone(value);
  }

  durableTodo(
    chatId: string,
    generationId: string,
    todo: TodoSnapshotViewV1,
  ): void {
    const current = this.active.get(chatId);
    if (
      !current ||
      current.generationId !== generationId ||
      todo.chatId !== chatId
    )
      return;
    current.todo = structuredClone(todo);
    this.changed(chatId);
  }

  settle(chatId: string, generationId: string): void {
    if (this.active.get(chatId)?.generationId !== generationId) return;
    this.active.delete(chatId);
    this.changed(chatId);
  }

  changed(chatId: string): void {
    this.serial += 1;
    this.revisions.delete(chatId);
    if (this.revisions.size >= 512)
      this.revisions.delete(this.revisions.keys().next().value!);
    this.revisions.set(chatId, this.serial);
    for (const listener of this.listeners.get(chatId) ?? []) {
      // An optional observer must never fail the owning generation.
      try {
        listener();
      } catch {
        /* Subscriber closes its own failed transport. */
      }
    }
  }

  subscribe(chatId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(chatId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(chatId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(chatId);
    };
  }
}

export const chatProgressEvents = new ChatProgressEvents();
