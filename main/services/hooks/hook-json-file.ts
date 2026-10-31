import * as fs from "node:fs/promises";
import { writeJsonAtomic } from "../durable-fs.js";

/**
 * A small profile-owned JSON document, read once and rewritten atomically.
 * Writes are serialized so a later state never loses to an earlier one.
 */
export class HookJsonFile<T> {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: () => string,
    private readonly sanitize: (raw: unknown) => T,
    private readonly empty: () => T,
  ) {}

  async read(): Promise<T> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw error;
    }
    try {
      return this.sanitize(JSON.parse(text));
    } catch {
      // A damaged file must not take the app down. It is kept beside the
      // original for recovery and reads as empty, which approves nothing.
      await fs.rename(this.filePath(), `${this.filePath()}.damaged-${Date.now()}`).catch(() => undefined);
      return this.empty();
    }
  }

  write(value: T): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(value)) as T;
    const next = this.writes.then(() =>
      writeJsonAtomic(this.filePath(), snapshot, { space: 2, trailingNewline: true, mode: 0o600, mkdirMode: 0o700 }),
    );
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every queued write has settled. */
  flush(): Promise<void> {
    return this.writes;
  }
}
