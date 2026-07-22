// Generic JSON file store rooted in the app's userData directory.
// Persistent app data belongs in the operating system's user-data directory.

import * as fs from "fs/promises";
import * as path from "path";

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;
  private loadPromise: Promise<T> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
    private readonly userDataPathResolver?: () => string,
  ) {}

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = this.userDataPathResolver
        ? this.userDataPathResolver()
        : (await import("../platform.js")).app.getPath("userData");
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, this.filename);
    }
    return this.filePath;
  }

  async load(): Promise<T> {
    if (this.cache !== null) return this.cache;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const filePath = await this.getFilePath();
          const data = await fs.readFile(filePath, "utf-8");
          this.cache = JSON.parse(data) as T;
        } catch {
          this.cache = structuredClone(this.defaultValue);
        }
        return this.cache;
      })();
    }
    return this.loadPromise;
  }

  private serialized<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeNow(data: T, isCurrent: () => boolean): Promise<void> {
    const filePath = await this.getFilePath();
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    this.cache = data;
  }

  async save(data: T, isCurrent: () => boolean = () => true): Promise<void> {
    const snapshot = structuredClone(data);
    return this.serialized(() => this.writeNow(snapshot, isCurrent));
  }

  /** Serialize a fresh read-modify-write transaction with every other writer. */
  async update<R>(
    mutation: (draft: T) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    return this.serialized(async () => {
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      const draft = structuredClone(await this.load());
      const result = await mutation(draft);
      await this.writeNow(draft, isCurrent);
      return result;
    });
  }
}

/** Returns the userData subdirectory (created if missing) — used by the chat store. */
export async function ensureUserDataDir(...segments: string[]): Promise<string> {
  const dir = path.join((await import("../platform.js")).app.getPath("userData"), ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
