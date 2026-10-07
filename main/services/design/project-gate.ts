/**
 * Per-project serial gate (the BotMutationGate pattern). Settled tails are
 * dropped, so idle projects hold no state.
 */
export class DesignProjectGate {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  pending(): number {
    return this.tails.size;
  }
}
