export class MemoryPersistence<T> {
  constructor(protected data: T) {}

  beforeCommit?: (draft: T) => Promise<void>;

  async load(): Promise<T> {
    return structuredClone(this.data);
  }

  async update<R>(
    mutation: (draft: T) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    await this.beforeCommit?.(draft);
    if (!isCurrent()) throw new Error("Stale persistence operation.");
    this.data = draft;
    return result;
  }

  snapshot(): T {
    return structuredClone(this.data);
  }

  restore(data: T): void {
    this.data = structuredClone(data);
  }
}
