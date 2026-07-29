// Generic JSON file store rooted in a caller-chosen directory.
// Machine-local app data belongs in the operating system's user-data directory,
// which is the default root. Stores whose file is the user's to hand-edit pass
// their own root (see aiden-config-dir.ts) and set `preserveCorruptFile`.

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "node:crypto";

export interface DataStoreOptions {
  /**
   * Copy an unparseable file aside before a write replaces it. Set this for any
   * file the user maintains by hand: a JSON typo must cost them a restart, not
   * the file. Left off for regenerable caches, which would only litter.
   */
  preserveCorruptFile?: boolean;
}

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;
  private loadPromise: Promise<T> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  /** True when load() fell back to defaults because the file would not parse. */
  private corrupt = false;

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
    private readonly rootResolver?: () => string,
    private readonly options: DataStoreOptions = {},
  ) {}

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const root = this.rootResolver
        ? this.rootResolver()
        : (await import("../platform.js")).app.getPath("userData");
      await fs.mkdir(root, { recursive: true });
      this.filePath = path.join(root, this.filename);
    }
    return this.filePath;
  }

  /** Absolute path of the backing file — for error messages and seeded docs. */
  async path(): Promise<string> {
    return this.getFilePath();
  }

  async load(): Promise<T> {
    if (this.cache !== null) return this.cache;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        let corrupt = false;
        try {
          const filePath = await this.getFilePath();
          const data = await fs.readFile(filePath, "utf-8");
          this.cache = JSON.parse(data) as T;
        } catch (error) {
          // A missing file is the ordinary first-run path. A file that exists
          // but will not parse is the user's data, and a later write must not
          // be allowed to quietly destroy it.
          corrupt = (error as NodeJS.ErrnoException).code !== "ENOENT";
          this.cache = structuredClone(this.defaultValue);
        }
        this.corrupt = corrupt;
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

  /**
   * Park an unparseable file beside itself so replacing it is never destructive.
   * Best effort by design: if the copy fails there is nothing worth preserving,
   * and it must not block the write the user actually asked for.
   */
  private async preserveCorrupt(destination: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      await fs.copyFile(destination, `${destination}.invalid-${stamp}`);
    } catch {
      // Unreadable or already gone — fall through to the write.
    }
  }

  /**
   * Replace the file atomically: stage a sibling temp file, then rename over the
   * destination. An in-place write can leave the file truncated if the process
   * dies or the disk fills mid-write, which would destroy a config the user
   * maintains by hand rather than merely losing a regenerable cache.
   */
  private async writeNow(data: T, isCurrent: () => boolean): Promise<void> {
    const destination = await this.getFilePath();
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    if (this.options.preserveCorruptFile) {
      // `corrupt` is only assessed by load(). update() always loads first, but a
      // bare save() need not have, and overwriting an unread file is precisely
      // when the user's data is at risk. Assess it before replacing it.
      if (this.cache === null) await this.load();
      if (this.corrupt) await this.preserveCorrupt(destination);
    }
    const staged = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(staged, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      await fs.rename(staged, destination);
    } finally {
      await fs.rm(staged, { force: true }).catch(() => undefined);
    }
    this.cache = data;
    this.corrupt = false;
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

  /**
   * Re-read the file from disk, picking up edits made outside the app. Resolves
   * true when the parsed contents actually changed.
   *
   * `load()` deliberately never re-reads, so this is the only way a hand-edit
   * becomes visible. It runs inside the mutation queue: an unqueued reload can
   * land between the `load()` and the `writeNow()` of an in-flight `update()`,
   * and that write would then silently clobber the very edit the reload just
   * observed.
   *
   * The change signal is a content comparison rather than an mtime/size stat.
   * Two different hand-edits can share a size, and coarse mtime resolution on
   * network and older filesystems can put both inside one tick — a stat gate
   * would silently drop the second edit, which is precisely the case this
   * method exists to catch. Re-reading a small config file is not worth that.
   */
  async reload(): Promise<boolean> {
    return this.serialized(async () => {
      const before = this.cache === null ? undefined : JSON.stringify(this.cache);
      this.cache = null;
      this.loadPromise = null;
      const next = await this.load();
      return before !== JSON.stringify(next);
    });
  }
}

/** Returns the userData subdirectory (created if missing) — used by the chat store. */
export async function ensureUserDataDir(...segments: string[]): Promise<string> {
  const dir = path.join((await import("../platform.js")).app.getPath("userData"), ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
