import * as fs from "node:fs/promises";
import { writeJsonAtomic } from "../durable-fs.js";

/**
 * A small profile-owned JSON document, read once and rewritten atomically.
 * Writes are serialized so a later state never loses to an earlier one.
 *
 * A missing file reads as empty. A file that exists but can't be read or
 * isn't JSON is an error, not an empty file: it may hold approvals or
 * fail-closed guards, so treating it as empty would quietly drop them. It is
 * left where it is for the owner to fix, and no write replaces it until a
 * later read succeeds.
 */
export class HookJsonFile<T> {
  private writes: Promise<void> = Promise.resolve();
  private readFailed = false;

  constructor(
    private readonly filePath: () => string,
    private readonly sanitize: (raw: unknown) => T,
    private readonly empty: () => T,
  ) {}

  async read(): Promise<T> {
    const file = this.filePath();
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.readFailed = false;
        return this.empty();
      }
      this.readFailed = true;
      throw new Error(`${file} could not be read (${(error as Error).message})`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this.readFailed = true;
      throw new Error(`${file} is not valid JSON (${(error as Error).message}); fix or remove it`);
    }
    this.readFailed = false;
    return this.sanitize(raw);
  }

  write(value: T): Promise<void> {
    if (this.readFailed) return Promise.reject(new Error(`${this.filePath()} could not be loaded, so it was not changed.`));
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
