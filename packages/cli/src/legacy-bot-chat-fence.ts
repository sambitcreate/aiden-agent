/**
 * Orders legacy Bot-chat writes against the switch to durable Bot sessions.
 *
 * A paired device's write to a Bot's workspace chat (a turn's opening append,
 * a rename, …) runs `shared`, admission check included. `bots enable-durable`
 * writes its marker `exclusive`: it waits for writes already admitted to
 * finish, and writes that arrive meanwhile wait behind it, then see the marker
 * and are refused. So every legacy write either commits before the marker,
 * and so before the backup is read, or is refused.
 *
 * A turn holds the fence only for its admission and opening append, never
 * while its reply streams: migration already stops and drains every running
 * Bot-chat turn before it reads the backup.
 */
export class LegacyBotChatFence {
  private active = 0;
  private writer: Promise<void> | undefined;
  private onDrained: (() => void) | undefined;

  async shared<T>(operation: () => Promise<T>): Promise<T> {
    while (this.writer) await this.writer;
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) this.onDrained?.();
    }
  }

  /** Runs once admitted writes finish; refuses, changing nothing, if they outlast `drainMs`. */
  async exclusive<T>(operation: () => Promise<T>, drainMs: number): Promise<T> {
    while (this.writer) await this.writer;
    let release!: () => void;
    this.writer = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (this.active > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.onDrained = undefined;
            reject(new Error("A paired device is still saving a change to a Bot chat. Nothing was changed; run `aiden bots enable-durable` again in a moment."));
          }, drainMs);
          this.onDrained = () => { clearTimeout(timer); this.onDrained = undefined; resolve(); };
        });
      }
      return await operation();
    } finally {
      this.writer = undefined;
      release();
    }
  }
}
