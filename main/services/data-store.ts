// Generic JSON file store rooted in a caller-chosen directory.
// Machine-local app data belongs in the operating system's user-data directory,
// which is the default root. Stores whose file is the user's to hand-edit pass
// their own root (see aiden-config-dir.ts) and set `preserveCorruptFile`.

import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "node:crypto";
import { decodeUtf8, readRegularFile } from "./regular-file-read.js";

export interface DataStoreOptions<T> {
  /** Refuse descriptor reads larger than this byte ceiling, including files that grow mid-read. */
  maxBytes?: number;
  /** POSIX mode applied to every atomically staged replacement. */
  fileMode?: number;
  /**
   * Copy an unparseable file aside before a write replaces it. Set this for any
   * file the user maintains by hand: a JSON typo must cost them a restart, not
   * the file. Left off for regenerable caches, which would only litter.
   */
  preserveCorruptFile?: boolean;
  /** Normalize valid JSON whose runtime shape does not match the typed store. */
  normalize?: (value: unknown) => T;
  /** Report whether valid JSON is safe to persist after normalization. */
  isSafe?: (value: unknown) => boolean;
  /**
   * Re-read the backing file at the start of every mutation. Use this for files
   * that people edit outside Aiden so a cached healthy value cannot overwrite a
   * newer hand edit.
   */
  reloadBeforeWrite?: boolean;
  /** Refuse to replace unparseable JSON even when a rescue copy could be made. */
  rejectCorruptWrite?: boolean;
  /** Refuse to replace valid JSON that the tolerant reader could not safely normalize. */
  rejectUnsafeWrite?: boolean;
  /** Abort a save based on a stale snapshot when the backing file changed. */
  rejectExternalChanges?: boolean;
  /** Test seam for racing a protected publication after the destination is held. */
  beforeProtectedPublish?: () => Promise<void>;
  /** Test seam for replacing the destination immediately before it is held. */
  beforeProtectedHold?: () => Promise<void>;
  /** Test seam for an old descriptor writing after the final held-byte check. */
  afterProtectedPublish?: () => Promise<void>;
  /** Test seam for holding a disk read before it becomes the active snapshot. */
  beforeLoadCommit?: () => Promise<void>;
  /**
   * Synchronous authority fence immediately before an externally reloaded
   * value replaces the in-memory cache. It is never called for app writes.
   */
  beforeExternalCacheCommit?: (previous: T | null, next: T) => void;
  /** Synchronous authority fence immediately before an app write is published. */
  beforeWritePublish?: (previous: T | null, next: T) => void;
}

export class DataStoreExternalChangeError extends Error {
  constructor() {
    super("Cannot overwrite a JSON file that changed outside the app.");
    this.name = "DataStoreExternalChangeError";
  }
}

export class DataStoreCorruptWriteError extends Error {
  constructor() {
    super("Cannot overwrite a JSON file that does not parse.");
    this.name = "DataStoreCorruptWriteError";
  }
}

export class DataStoreUnsafeWriteError extends Error {
  constructor() {
    super("Cannot overwrite a JSON file whose schema is not safe for this app version.");
    this.name = "DataStoreUnsafeWriteError";
  }
}

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;
  private loadPromise: Promise<T> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  /** Predecessor names created by this process remain live until next startup. */
  private readonly liveHeldFiles = new Set<string>();
  /** Exact bytes observed by the last load; null means the file was absent. */
  private diskSnapshot: Buffer | null | undefined;
  /** True when load() fell back to defaults because the file would not parse. */
  private corrupt = false;
  /** True when valid JSON was normalized for reads but must not be overwritten. */
  private unsafe = false;
  private externalReloadPrevious: T | null | undefined;

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
    private readonly rootResolver?: () => string,
    private readonly options: DataStoreOptions<T> = {},
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
        let data: string | undefined;
        let bytes: Buffer | undefined;
        let filePath: string | undefined;
        try {
          filePath = await this.getFilePath();
          await this.recoverHeldFiles(filePath);
          bytes = await readRegularFile(filePath, this.options.maxBytes);
          data = decodeUtf8(bytes);
          this.diskSnapshot = Buffer.from(bytes);
          const parsed = JSON.parse(data) as unknown;
          await this.options.beforeLoadCommit?.();
          this.unsafe = this.options.isSafe ? !this.options.isSafe(parsed) : false;
          const next = this.options.normalize
            ? this.options.normalize(parsed)
            : (parsed as T);
          if (this.externalReloadPrevious !== undefined) {
            this.options.beforeExternalCacheCommit?.(
              this.externalReloadPrevious,
              next,
            );
          }
          this.cache = next;
        } catch (error) {
          // A missing file is the ordinary first-run path. A file that exists
          // but will not parse is the user's data, and a later write must not
          // be allowed to quietly destroy it.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" && filePath) {
            // readFile also reports ENOENT for a dangling symlink. That is an
            // existing user-owned filesystem object, not the ordinary
            // first-run "missing file" state, and must stay write-protected.
            try {
              await fs.lstat(filePath);
              corrupt = true;
            } catch (lstatError) {
              corrupt = (lstatError as NodeJS.ErrnoException).code !== "ENOENT";
            }
          } else {
            corrupt = true;
          }
          this.diskSnapshot = corrupt ? bytes : null;
          this.unsafe = false;
          const next = structuredClone(this.defaultValue);
          if (this.externalReloadPrevious !== undefined) {
            this.options.beforeExternalCacheCommit?.(
              this.externalReloadPrevious,
              next,
            );
          }
          this.cache = next;
        }
        this.corrupt = corrupt;
        return this.cache;
      })();
    }
    return this.loadPromise;
  }

  /** Whether the current cached value came from an unparseable on-disk file. */
  async loadedFromCorruptFile(): Promise<boolean> {
    await this.load();
    return this.corrupt;
  }

  /** Whether valid on-disk JSON was unsafe and only normalized for in-memory reads. */
  async loadedFromUnsafeFile(): Promise<boolean> {
    await this.load();
    return this.unsafe;
  }

  /** Exact bytes observed by the successful cached load, or null when absent. */
  async loadedDiskContents(): Promise<Buffer | null> {
    await this.load();
    return this.diskSnapshot ? Buffer.from(this.diskSnapshot) : null;
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
      const contents = await readRegularFile(destination, this.options.maxBytes);
      await fs.writeFile(`${destination}.invalid-${stamp}`, contents, {
        flag: "wx",
      });
    } catch {
      // Unreadable or already gone — fall through to the write.
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async restoreHeldFile(
    held: string,
    destination: string,
    preserveConflict: boolean,
  ): Promise<void> {
    try {
      const info = await fs.lstat(held);
      if (info.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(held), destination);
      } else if (info.isDirectory()) {
        await fs.cp(held, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
          preserveTimestamps: true,
        });
      } else {
        await fs.link(held, destination);
      }
      await fs.rm(held, { recursive: info.isDirectory(), force: true });
    } catch (error) {
      try {
        await fs.lstat(destination);
      } catch {
        throw error;
      }
      if (preserveConflict) {
        await fs.rename(held, `${destination}.conflict-${randomUUID()}`);
      } else {
        await fs.rm(held, { recursive: true, force: true });
      }
    }
  }

  private contentHash(contents: string | Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
  }

  private async recoverHeldFiles(destination: string): Promise<void> {
    const directory = path.dirname(destination);
    const prefix = `.${path.basename(destination)}.`;
    let names: string[];
    try {
      names = (await fs.readdir(directory)).filter(
        (name) => name.startsWith(prefix) && (name.endsWith(".held") || name.endsWith(".previous")),
      );
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const held = path.join(directory, name);
      if (this.liveHeldFiles.has(held)) continue;
      const predecessor = name.endsWith(".previous");
      let info;
      try {
        info = await fs.lstat(held);
      } catch {
        continue;
      }
      if (!predecessor) {
        let destinationExists = true;
        try {
          await fs.lstat(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          destinationExists = false;
        }
        if (!destinationExists) {
          // Any failure propagates into load(), keeping protected stores
          // read-only instead of seeding defaults over the parked source.
          await this.restoreHeldFile(held, destination, true);
          await this.syncDirectory(directory);
          continue;
        }
        if (!info.isFile() || info.isSymbolicLink()) {
          await this.restoreHeldFile(held, destination, true);
          await this.syncDirectory(directory);
          continue;
        }
      }
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const suffix = predecessor ? ".previous" : ".held";
      const encodedHash = name.slice(prefix.length, -suffix.length).split(".", 1)[0];
      try {
        const contents = await readRegularFile(held, this.options.maxBytes);
        if (/^[a-f0-9]{64}$/u.test(encodedHash) && this.contentHash(contents) === encodedHash) {
          await fs.rm(held, { force: true });
        } else {
          await fs.rename(held, `${destination}.conflict-${randomUUID()}`);
        }
        await this.syncDirectory(directory);
      } catch {
        // Leave an unreadable recovery candidate untouched for manual review.
      }
    }
  }

  private async publishProtected(
    staged: string,
    destination: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.diskSnapshot === undefined) {
      throw new Error("Cannot overwrite a JSON file before loading its current contents.");
    }
    const expectedHash =
      this.diskSnapshot === null ? "absent" : this.contentHash(this.diskSnapshot);
    const held = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${expectedHash}.${randomUUID()}.held`,
    );
    this.liveHeldFiles.add(held);
    let heldMatches = false;
    let destinationPublished = false;
    let destinationHeld = false;
    if (this.diskSnapshot !== null) {
      try {
        await this.options.beforeProtectedHold?.();
        await fs.rename(destination, held);
        destinationHeld = true;
      } catch (error) {
        this.liveHeldFiles.delete(held);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new DataStoreExternalChangeError();
        }
        throw error;
      }
    }

    try {
      if (this.diskSnapshot !== null) {
        try {
          heldMatches = (await readRegularFile(held, this.options.maxBytes)).equals(
            this.diskSnapshot,
          );
        } catch {
          throw new DataStoreExternalChangeError();
        }
        if (!heldMatches) throw new DataStoreExternalChangeError();
      }
      await this.options.beforeProtectedPublish?.();
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      if (
        this.diskSnapshot !== null &&
        !(await readRegularFile(held, this.options.maxBytes)).equals(this.diskSnapshot)
      ) {
        heldMatches = false;
        await this.restoreHeldFile(held, destination, true);
        throw new DataStoreExternalChangeError();
      }
      // The destination is absent only inside this protected publication. A
      // concurrent editor that creates it wins: hard-link publication is the
      // no-overwrite primitive that rename lacks.
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      await fs.link(staged, destination);
      destinationPublished = true;
      await this.syncDirectory(path.dirname(destination));
      // A writer that already held the old inode can still modify it after the
      // pre-publication comparison. Publication is already committed at this
      // point, so preserve that late edit as a conflict instead of reporting a
      // rejected save while leaving the app's new document canonical.
      await this.options.afterProtectedPublish?.();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DataStoreExternalChangeError();
      }
      throw error;
    } finally {
      if (this.diskSnapshot !== null) {
        if (destinationHeld && !destinationPublished) {
          try {
            this.liveHeldFiles.delete(held);
            await this.restoreHeldFile(held, destination, true);
            await this.syncDirectory(path.dirname(destination));
          } catch {
            // Keep an unreadable held file for startup recovery rather than
            // risking deletion of the only copy of a late external edit.
          }
        } else if (heldMatches && destinationPublished) {
          const previous = `${held.slice(0, -".held".length)}.previous`;
          try {
            await fs.rename(held, previous);
            this.liveHeldFiles.delete(held);
            this.liveHeldFiles.add(previous);
            await this.syncDirectory(path.dirname(destination));
          } catch {
            // A still-named held file is also safe; next startup reconciles it.
          }
        }
        // Once publication is visible, retain every old inode under a
        // predecessor for this process lifetime. An editor may write through
        // any descriptor it opened before any later app publication; next
        // startup compares all predecessor bytes with their encoded hashes and
        // removes unchanged files or preserves edited ones as conflicts.
      }
    }
  }

  /**
   * Replace the file atomically: stage a sibling temp file, then rename over the
   * destination. An in-place write can leave the file truncated if the process
   * dies or the disk fills mid-write, which would destroy a config the user
   * maintains by hand rather than merely losing a regenerable cache.
   */
  private async writeNow(data: T, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    if (this.options.isSafe && !this.options.isSafe(data)) {
      throw new DataStoreUnsafeWriteError();
    }
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (
      this.options.maxBytes !== undefined &&
      Buffer.byteLength(serialized, "utf8") > this.options.maxBytes
    ) {
      throw new DataStoreUnsafeWriteError();
    }
    const destination = await this.getFilePath();
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
      await fs.writeFile(staged, serialized, {
        encoding: "utf-8",
        ...(this.options.fileMode === undefined ? {} : { mode: this.options.fileMode }),
      });
      const stagedHandle = await fs.open(staged, "r");
      try {
        await stagedHandle.sync();
      } finally {
        await stagedHandle.close();
      }
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      this.options.beforeWritePublish?.(
        this.cache === null ? null : structuredClone(this.cache),
        data,
      );
      if (this.options.rejectExternalChanges) {
        await this.publishProtected(staged, destination, isCurrent);
      } else {
        if (!isCurrent()) throw new Error("The renderer document is no longer active.");
        await fs.rename(staged, destination);
        await this.syncDirectory(path.dirname(destination));
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => undefined);
    }
    this.cache = data;
    this.diskSnapshot = Buffer.from(serialized, "utf-8");
    this.corrupt = false;
    this.unsafe = false;
  }

  async save(data: T, isCurrent: () => boolean = () => true): Promise<void> {
    const snapshot = structuredClone(data);
    return this.serialized(async () => {
      const hadCache = this.cache !== null;
      const changed = this.options.reloadBeforeWrite ? await this.reloadNow() : false;
      if (this.options.rejectCorruptWrite && this.corrupt) {
        throw new DataStoreCorruptWriteError();
      }
      if (this.options.rejectUnsafeWrite && this.unsafe) {
        throw new DataStoreUnsafeWriteError();
      }
      if (
        this.options.rejectExternalChanges &&
        ((hadCache && changed) || (!hadCache && this.diskSnapshot !== null))
      ) {
        throw new DataStoreExternalChangeError();
      }
      await this.writeNow(snapshot, isCurrent);
    });
  }

  /** Serialize a fresh read-modify-write transaction with every other writer. */
  async update<R>(
    mutation: (draft: T) => R | Promise<R>,
    isCurrent: () => boolean = () => true,
  ): Promise<R> {
    return this.serialized(async () => {
      if (!isCurrent()) throw new Error("The renderer document is no longer active.");
      if (this.options.reloadBeforeWrite) await this.reloadNow();
      if (this.options.rejectCorruptWrite && this.corrupt) {
        throw new DataStoreCorruptWriteError();
      }
      if (this.options.rejectUnsafeWrite && this.unsafe) {
        throw new DataStoreUnsafeWriteError();
      }
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
    return this.serialized(() => this.reloadNow());
  }

  private async reloadNow(): Promise<boolean> {
    // Reads do not join the mutation queue. Let an initial in-flight load finish
    // before invalidating its promise so it cannot commit stale state after this
    // reload has read newer bytes.
    if (this.loadPromise) await this.loadPromise;
    const previous = this.cache === null ? null : structuredClone(this.cache);
    const before = previous === null ? undefined : JSON.stringify(previous);
    this.cache = null;
    this.loadPromise = null;
    this.externalReloadPrevious = previous;
    try {
      const next = await this.load();
      return before !== JSON.stringify(next);
    } finally {
      this.externalReloadPrevious = undefined;
    }
  }
}

/** Returns the userData subdirectory (created if missing) — used by the chat store. */
export async function ensureUserDataDir(...segments: string[]): Promise<string> {
  const dir = path.join((await import("../platform.js")).app.getPath("userData"), ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
