export class FakeTimers {
  now: number;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  constructor(now = 0) {
    this.now = now;
  }

  set = (callback: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  get size(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now || !this.pending.has(id)) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}
