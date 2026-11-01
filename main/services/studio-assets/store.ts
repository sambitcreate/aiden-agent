import { initializeSqliteReclamation, reclaimSqlitePages } from "../sqlite-reclamation.js";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncDirectory, writeFileAtomic } from "../durable-fs.js";
import {
  STUDIO_ASSET_LIMITS,
  StudioAssetError,
  holderKey,
  isStudioAssetId,
  parseHolderKey,
  type StudioAssetHolder,
  type StudioAssetHolderKind,
  type StudioAssetLimits,
  type StudioAssetMediaType,
  type StudioAssetRecord,
  type StudioAssetThumbnailEdge,
} from "./contract.js";
import { validateStudioImage } from "./image-validation-core.js";

export interface StudioAssetThumbnailer {
  render(input: {
    bytes: Uint8Array;
    mediaType: StudioAssetMediaType;
    edge: StudioAssetThumbnailEdge;
  }): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}

/** Timer seam for the periodic collection. Production uses unref'd Node intervals. */
export interface StudioAssetStoreTimers {
  setInterval(callback: () => unknown, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StudioAssetStoreOptions {
  /** Resolved lazily so a disabled feature never touches userData. */
  root: () => string;
  thumbnailer: StudioAssetThumbnailer;
  now?: () => number;
  limits?: Partial<StudioAssetLimits>;
  /** Receives non-fatal housekeeping failures (startup sweep or collection); the store stays usable. */
  onError?: (error: unknown) => void;
  /**
   * Receives recoveries worth a log line: a quarantined database, or asset rows
   * rebuilt from stored images. The store is usable when this is called.
   */
  onWarning?: (message: string, error?: unknown) => void;
  /** How often an open store collects unheld assets past their grace period. */
  gcIntervalMs?: number;
  timers?: StudioAssetStoreTimers;
}

/** Periodic collection while the store is open; startup and quota pressure also collect. */
export const STUDIO_ASSET_GC_INTERVAL_MS = 20 * 60 * 1000;
/** Decode failures remembered per process so a failing image is not re-decoded per request. */
const MAX_REMEMBERED_THUMBNAIL_FAILURES = 512;
const DATABASE_FILE = "assets-v1.sqlite";
const DATABASE_SIDECARS = ["", "-wal", "-shm"] as const;
// Primary SQLite result codes that mean the file itself is unusable.
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const NODE_TIMERS: StudioAssetStoreTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** The database opened but carries a schema this build cannot read. */
class UnsupportedSchemaError extends StudioAssetError {
  constructor() {
    super("unavailable", "The studio asset database uses an unsupported schema.");
  }
}

/**
 * The database was written by a newer build. It is valid there, so it is never quarantined:
 * the store stays unavailable and the file is left untouched for that build to open again.
 */
class NewerSchemaError extends StudioAssetError {
  constructor() {
    super("unavailable", "The studio asset database was created by a newer version of Aiden.");
  }
}

/**
 * True for a database file that is damaged or unreadable as this schema, which
 * quarantine can fix. Permission, missing-directory and other I/O failures are
 * not: moving the file aside would not help and could hide the real problem.
 */
function isUnusableDatabase(error: unknown): boolean {
  if (error instanceof UnsupportedSchemaError) return true;
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode !== "number") return false;
  const primary = errcode & 0xff;
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
}

function describeDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1 && Number.isInteger(hours)) return hours === 1 ? "an hour" : `${hours} hours`;
  const minutes = Math.max(1, Math.ceil(ms / (60 * 1000)));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

function describeBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

async function syncDirectories(directories: Iterable<string>): Promise<void> {
  for (const directory of directories) {
    // Best effort: the unlinks already happened; a lost directory flush only
    // risks a deleted file reappearing after power loss, which the next sweep handles.
    await syncDirectory(directory).catch(() => undefined);
  }
}

/**
 * Availability of the store. "closed" means never opened or shut down, "open"
 * means usable, and "failed" means the last initialize() could not open the
 * database; initialize() may be called again to retry.
 *
 * Design Studio and Create Images report a storage error when status() is not
 * "open": a "failed" store is a startup failure worth surfacing, while any
 * operation on a store that is not open rejects with StudioAssetError
 * ("unavailable"), which the aiden-asset: handler maps to HTTP 503.
 */
export type StudioAssetStoreStatus = "closed" | "open" | "failed";

interface AssetRow {
  id: string;
  media_type: StudioAssetMediaType;
  bytes: number;
  width: number;
  height: number;
  created_at: number;
}

const SCHEMA = `
  CREATE TABLE assets (id TEXT PRIMARY KEY, media_type TEXT NOT NULL, bytes INTEGER NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
  CREATE TABLE holds (holder TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
    PRIMARY KEY (holder, asset_id));
  CREATE INDEX holds_by_asset ON holds(asset_id);
  PRAGMA user_version=1;
`;
// `recovered`: assets re-indexed from blobs after the index was lost. Their holds
// could not be recovered, and one feature holding an asset again says nothing about
// its other owners, so GC never collects them. `recovery_pending`: one row while a
// rebuild has not finished re-indexing, written with a fresh schema and cleared in
// the transaction that inserts the recovered rows, so a rebuild interrupted by an
// error or exit resumes on the next open instead of deleting the blobs as orphans.
// Additive, so they are created on every open of a version-1 database.
const RECOVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS recovered (asset_id TEXT PRIMARY KEY REFERENCES assets(id));
  CREATE TABLE IF NOT EXISTS recovery_pending (id INTEGER PRIMARY KEY CHECK (id = 1));
`;
const THUMBNAIL_EDGES: readonly StudioAssetThumbnailEdge[] = [256, 512];

function toRecord(row: AssetRow): StudioAssetRecord {
  return {
    assetId: row.id,
    mediaType: row.media_type,
    bytes: Number(row.bytes),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: Number(row.created_at),
  };
}

/**
 * Content-addressed image store shared by Design Studio and Create Images.
 * Bytes are immutable files named by sha256; SQLite holds metadata and which
 * holders (projects, workflows, runs) keep each asset alive. An asset with no
 * holder is collected after a grace period measured from its last put or release.
 */
export class StudioAssetStore {
  private db: DatabaseSync | null = null;
  private root = "";
  private readonly now: () => number;
  private readonly limits: StudioAssetLimits;
  /**
   * Tail of the queue that serializes every operation which creates or unlinks
   * blobs (put, collectGarbage, the startup sweep). Without it a put of an
   * unheld digest could dedupe against a row GC has just dropped and then lose
   * its blob to GC's unlink.
   */
  private blobWrites: Promise<unknown> = Promise.resolve();
  /** In-flight open, shared so concurrent initialize() calls never leak a second handle. */
  private opening: Promise<void> | null = null;
  private failed = false;
  private readonly timers: StudioAssetStoreTimers;
  private gcTimer: unknown = null;
  /** One in-flight cache read or render per `${id}:${edge}`, shared by concurrent callers. */
  private readonly thumbnailLoads = new Map<
    string,
    Promise<{ bytes: Uint8Array; mediaType: StudioAssetMediaType }>
  >();
  /** `${id}:${edge}` keys whose decode failed; insertion-ordered so the oldest is evicted first. */
  private readonly thumbnailFailures = new Set<string>();

  constructor(private readonly options: StudioAssetStoreOptions) {
    this.now = options.now ?? Date.now;
    this.limits = { ...STUDIO_ASSET_LIMITS, ...options.limits };
    this.timers = options.timers ?? NODE_TIMERS;
  }

  status(): StudioAssetStoreStatus {
    if (this.db) return "open";
    return this.failed ? "failed" : "closed";
  }

  initialize(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= this.open().then(
      () => {
        this.failed = false;
        this.opening = null;
      },
      (error: unknown) => {
        this.failed = true;
        this.opening = null;
        throw error;
      },
    );
    return this.opening;
  }

  private async open(): Promise<void> {
    const root = this.options.root();
    await fs.mkdir(path.join(root, "blobs"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(root, "thumbs"), { recursive: true, mode: 0o700 });
    const file = path.join(root, DATABASE_FILE);
    let db: DatabaseSync;
    // True while a rebuild is unfinished: the file was missing or was just
    // quarantined (now or on an earlier open whose re-index never completed), so
    // every blob on disk may have lost its row and may be re-indexed.
    let recovering: boolean;
    try {
      ({ db, recovering } = openDatabase(file));
    } catch (error) {
      if (!isUnusableDatabase(error)) throw error;
      // The database only indexes content-addressed blobs, so a fresh one can
      // be rebuilt from them by the sweep below. Keep the old file for diagnosis.
      const quarantined = await quarantineDatabase(file, this.now());
      ({ db, recovering } = openDatabase(file));
      this.options.onWarning?.(
        `The studio asset database could not be read and was moved aside as ${path.basename(quarantined)}; rebuilding it from stored images.`,
        error,
      );
    }
    try {
      await restrictDatabaseFiles(file);
    } catch (error) {
      db.close();
      throw error;
    }
    reclaimSqlitePages(db);
    this.db = db;
    this.root = root;
    // Housekeeping is best effort: a failed pass must not disable a store whose
    // database opened, and the next start (or an explicit collection) retries it.
    try {
      await this.exclusive(() => this.sweepOrphanFiles(recovering));
      await this.collectGarbage();
    } catch (error) {
      this.options.onError?.(error);
    }
    this.gcTimer = this.timers.setInterval(
      () => this.collectPeriodically(),
      this.options.gcIntervalMs ?? STUDIO_ASSET_GC_INTERVAL_MS,
    );
  }

  /** Timer callback; resolves (never rejects) once the pass is done, for tests. */
  private collectPeriodically(): Promise<void> {
    if (!this.db) return Promise.resolve();
    return this.collectGarbage().then(
      () => undefined,
      (error: unknown) => {
        // A close between the tick and the queued pass is expected, not a failure.
        if (error instanceof StudioAssetError && error.code === "unavailable" && !this.db) return;
        this.options.onError?.(error);
      },
    );
  }

  /**
   * New operations fail with "unavailable" immediately. The handle itself is
   * closed once queued blob work has drained, so an in-flight put or collection
   * never hits node:sqlite's native "database is not open" error. A close during
   * initialize() waits for the open to finish first.
   */
  close(): Promise<void> {
    if (this.opening) {
      return this.opening
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => this.close());
    }
    const db = this.db;
    this.failed = false;
    if (!db) return Promise.resolve();
    this.db = null;
    if (this.gcTimer !== null) {
      this.timers.clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.thumbnailFailures.clear();
    return this.blobWrites.then(() => {
      reclaimSqlitePages(db);
      db.close();
    });
  }

  get(assetId: string): StudioAssetRecord | undefined {
    const row = this.row(assetId);
    return row ? toRecord(row) : undefined;
  }

  usage(): { assets: number; bytes: number } {
    const row = this.requireDb()
      .prepare("SELECT COUNT(*) AS assets, COALESCE(SUM(bytes), 0) AS bytes FROM assets")
      .get() as { assets: number; bytes: number };
    return { assets: Number(row.assets), bytes: Number(row.bytes) };
  }

  put(input: { bytes: Uint8Array; declaredMimeType?: string }): Promise<StudioAssetRecord> {
    return this.exclusive(() => this.putNow(input));
  }

  private async putNow(input: {
    bytes: Uint8Array;
    declaredMimeType?: string;
  }): Promise<StudioAssetRecord> {
    const db = this.requireDb();
    if (input.bytes.byteLength > this.limits.maxAssetBytes) {
      throw new StudioAssetError(
        "too_large",
        `The image is larger than the ${Math.floor(this.limits.maxAssetBytes / (1024 * 1024))} MiB asset limit.`,
      );
    }
    const image = validateStudioImage(input.bytes, input.declaredMimeType, this.limits);
    const id = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.row(id);
    if (existing) {
      // A dedup hit restarts the grace period so the next GC leaves it alone.
      db.prepare("UPDATE assets SET touched_at = ? WHERE id = ?").run(this.now(), id);
      return toRecord(existing);
    }
    if (this.exceedsQuota(input.bytes.byteLength)) {
      // Unheld assets past their grace count toward usage until collected, so
      // collect now (already on the exclusive queue) before refusing. This put's
      // digest has no row, so the pass cannot touch it.
      try {
        await this.collectGarbageNow();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (this.exceedsQuota(input.bytes.byteLength)) {
        throw new StudioAssetError("quota", this.quotaMessage());
      }
    }
    const target = this.blobPath(id);
    try {
      await writeFileAtomic(target, input.bytes, {
        exclusive: true,
        mode: 0o600,
        mkdirMode: 0o700,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Same name means same content unless the file was damaged.
      if ((await fs.stat(target)).size !== input.bytes.byteLength) {
        throw new StudioAssetError("unavailable", "A stored studio asset is damaged.");
      }
    }
    const now = this.now();
    db.prepare(
      "INSERT OR IGNORE INTO assets (id, media_type, bytes, width, height, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, image.mediaType, input.bytes.byteLength, image.width, image.height, now, now);
    return toRecord(this.requireRow(id));
  }

  private quotaMessage(): string {
    const message = `Studio asset storage is full. Space from deleted projects and workflows is freed up to ${describeDuration(this.limits.gcGraceMs)} after you delete them, so try again later or delete more unused items.`;
    const recovered = this.requireDb()
      .prepare(
        "SELECT COUNT(*) AS assets, COALESCE(SUM(bytes), 0) AS bytes FROM assets JOIN recovered ON recovered.asset_id = assets.id",
      )
      .get() as { assets: number; bytes: number };
    const count = Number(recovered.assets);
    if (count === 0) return message;
    // Recovered images are never collected (their owners are unknown), so the
    // grace-period promise does not cover them; say how much they hold instead.
    const images = count === 1 ? "1 image" : `${count} images`;
    return `${message} Aiden also keeps ${images} (${describeBytes(Number(recovered.bytes))}) recovered when its image index was rebuilt, because it cannot tell which projects still use them; deleting items does not free that space.`;
  }

  private exceedsQuota(incomingBytes: number): boolean {
    const usage = this.usage();
    return (
      usage.assets + 1 > this.limits.maxAssets ||
      usage.bytes + incomingBytes > this.limits.maxTotalBytes
    );
  }

  async read(assetId: string): Promise<{ record: StudioAssetRecord; bytes: Uint8Array }> {
    const row = this.requireRow(assetId);
    return { record: toRecord(row), bytes: await this.readBlob(row.id) };
  }

  async thumbnail(
    assetId: string,
    edge: StudioAssetThumbnailEdge,
  ): Promise<{ bytes: Uint8Array; mediaType: StudioAssetMediaType }> {
    const row = this.requireRow(assetId);
    if (Math.max(Number(row.width), Number(row.height)) <= edge) {
      return { bytes: await this.readBlob(row.id), mediaType: row.media_type };
    }
    const key = `${row.id}:${edge}`;
    if (this.thumbnailFailures.has(key)) {
      return { bytes: await this.readBlob(row.id), mediaType: row.media_type };
    }
    // Rendering is a synchronous main-thread decode of up to 20 MP, so concurrent
    // requests for the same rendition share one cache read or render.
    let load = this.thumbnailLoads.get(key);
    if (!load) {
      load = this.loadThumbnail(row, edge, key).finally(() => this.thumbnailLoads.delete(key));
      this.thumbnailLoads.set(key, load);
    }
    return load;
  }

  private async loadThumbnail(
    row: AssetRow,
    edge: StudioAssetThumbnailEdge,
    key: string,
  ): Promise<{ bytes: Uint8Array; mediaType: StudioAssetMediaType }> {
    const cached = this.thumbPath(row.id, edge);
    try {
      return { bytes: await fs.readFile(cached), mediaType: "image/png" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const original = await this.readBlob(row.id);
    let rendered: { bytes: Uint8Array };
    try {
      rendered = await this.options.thumbnailer.render({
        bytes: original,
        mediaType: row.media_type,
        edge,
      });
    } catch {
      // nativeImage cannot decode every accepted format (for example WebP on
      // Linux). The original is within the validated pixel limit. Remember the
      // failure so later requests skip straight to the original.
      this.rememberThumbnailFailure(key);
      return { bytes: original, mediaType: row.media_type };
    }
    // The cache is regenerable; a failed write only costs a re-render. If GC removed
    // the asset mid-render this can leave an orphan thumbnail; it is harmless
    // (content-addressed) and initialize() sweeps it on the next start.
    await writeFileAtomic(cached, rendered.bytes, { fsync: false, mode: 0o600 }).catch(
      () => undefined,
    );
    return { bytes: rendered.bytes, mediaType: "image/png" };
  }

  private rememberThumbnailFailure(key: string): void {
    this.thumbnailFailures.add(key);
    if (this.thumbnailFailures.size > MAX_REMEMBERED_THUMBNAIL_FAILURES) {
      const oldest = this.thumbnailFailures.values().next().value;
      if (oldest !== undefined) this.thumbnailFailures.delete(oldest);
    }
  }

  retain(holder: StudioAssetHolder, assetIds: readonly string[]): void {
    const key = holderKey(holder);
    this.transaction((db) => {
      const insert = db.prepare("INSERT OR IGNORE INTO holds (holder, asset_id) VALUES (?, ?)");
      for (const assetId of new Set(assetIds)) {
        this.requireRow(assetId);
        insert.run(key, assetId);
      }
    });
  }

  release(holder: StudioAssetHolder, assetIds: readonly string[]): void {
    const key = holderKey(holder);
    this.transaction((db) => {
      const remove = db.prepare("DELETE FROM holds WHERE holder = ? AND asset_id = ?");
      const touch = db.prepare("UPDATE assets SET touched_at = ? WHERE id = ?");
      const now = this.now();
      for (const assetId of new Set(assetIds)) {
        if (Number(remove.run(key, assetId).changes) > 0) touch.run(now, assetId);
      }
    });
  }

  releaseAllForHolder(holder: StudioAssetHolder): number {
    const key = holderKey(holder);
    return this.transaction((db) => {
      db.prepare(
        "UPDATE assets SET touched_at = ? WHERE id IN (SELECT asset_id FROM holds WHERE holder = ?)",
      ).run(this.now(), key);
      return Number(db.prepare("DELETE FROM holds WHERE holder = ?").run(key).changes);
    });
  }

  /** Set exact membership, for example from a workflow document's autosave. */
  replaceHolder(holder: StudioAssetHolder, assetIds: readonly string[]): void {
    const key = holderKey(holder);
    const next = new Set(assetIds);
    this.transaction((db) => {
      for (const assetId of next) this.requireRow(assetId);
      const current = (
        db.prepare("SELECT asset_id FROM holds WHERE holder = ?").all(key) as { asset_id: string }[]
      ).map(({ asset_id }) => asset_id);
      const remove = db.prepare("DELETE FROM holds WHERE holder = ? AND asset_id = ?");
      const touch = db.prepare("UPDATE assets SET touched_at = ? WHERE id = ?");
      const now = this.now();
      for (const assetId of current) {
        if (next.has(assetId)) continue;
        remove.run(key, assetId);
        touch.run(now, assetId);
      }
      const insert = db.prepare("INSERT OR IGNORE INTO holds (holder, asset_id) VALUES (?, ?)");
      for (const assetId of next) insert.run(key, assetId);
    });
  }

  holders(assetId: string): StudioAssetHolder[] {
    this.requireRow(assetId);
    return (
      this.requireDb()
        .prepare("SELECT holder FROM holds WHERE asset_id = ? ORDER BY holder")
        .all(assetId) as { holder: string }[]
    ).map(({ holder }) => parseHolderKey(holder));
  }

  /** Ids of every holder of one kind that holds at least one asset, so features can find holders whose owner is gone. */
  holderIds(kind: StudioAssetHolderKind): string[] {
    const prefix = `${kind}:`;
    return (
      this.requireDb()
        .prepare("SELECT DISTINCT holder FROM holds WHERE substr(holder, 1, ?) = ? ORDER BY holder")
        .all(prefix.length, prefix) as { holder: string }[]
    ).map(({ holder }) => holder.slice(prefix.length));
  }

  collectGarbage(): Promise<{ deletedAssets: number; freedBytes: number }> {
    return this.exclusive(() => this.collectGarbageNow());
  }

  private async collectGarbageNow(): Promise<{ deletedAssets: number; freedBytes: number }> {
    const cutoff = this.now() - this.limits.gcGraceMs;
    // Synchronous transaction: no retain can interleave between select and delete,
    // and the queue keeps any put from running until the files are gone too.
    const doomed = this.transaction((db) => {
      const rows = db
        .prepare(
          "SELECT id, bytes FROM assets WHERE touched_at < ? AND NOT EXISTS (SELECT 1 FROM holds WHERE holds.asset_id = assets.id) AND NOT EXISTS (SELECT 1 FROM recovered WHERE recovered.asset_id = assets.id)",
        )
        .all(cutoff) as { id: string; bytes: number }[];
      const remove = db.prepare("DELETE FROM assets WHERE id = ?");
      for (const row of rows) remove.run(row.id);
      return rows;
    });
    const touched = new Set<string>();
    for (const row of doomed) {
      await this.removeFiles(row.id);
      touched.add(path.dirname(this.blobPath(row.id)));
    }
    if (doomed.length > 0) {
      touched.add(path.join(this.root, "thumbs"));
      await syncDirectories(touched);
    }
    return {
      deletedAssets: doomed.length,
      freedBytes: doomed.reduce((total, row) => total + Number(row.bytes), 0),
    };
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.blobWrites.then(work);
    this.blobWrites = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new StudioAssetError("unavailable", "Studio asset storage is not open.");
    return this.db;
  }

  private row(assetId: string): AssetRow | undefined {
    if (!isStudioAssetId(assetId)) return undefined;
    return this.requireDb()
      .prepare("SELECT id, media_type, bytes, width, height, created_at FROM assets WHERE id = ?")
      .get(assetId) as AssetRow | undefined;
  }

  private requireRow(assetId: string): AssetRow {
    const row = this.row(assetId);
    if (!row) throw new StudioAssetError("not_found", "This studio asset is no longer available.");
    return row;
  }

  private transaction<T>(work: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back (for example on a constraint abort);
        // a failing ROLLBACK must not mask the original error.
      }
      throw error;
    }
  }

  /** A blob GC unlinked after the row lookup reads as a missing asset, not a raw fs error. */
  private async readBlob(id: string): Promise<Uint8Array> {
    try {
      return await fs.readFile(this.blobPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StudioAssetError("not_found", "This studio asset is no longer available.");
      }
      throw error;
    }
  }

  private blobPath(id: string): string {
    return path.join(this.root, "blobs", id.slice(0, 2), id);
  }

  private thumbPath(id: string, edge: StudioAssetThumbnailEdge): string {
    return path.join(this.root, "thumbs", `${id}-${edge}.png`);
  }

  private async removeFiles(id: string): Promise<void> {
    await fs.rm(this.blobPath(id), { force: true });
    for (const edge of THUMBNAIL_EDGES) await fs.rm(this.thumbPath(id, edge), { force: true });
  }

  /**
   * Reconcile files with rows after a crash or a lost database. Only while a
   * rebuild is pending is a blob without a row re-indexed (its bytes must
   * still hash to its name and pass image validation) and marked recovered. On an
   * ordinary open a blob without a row is a put that crashed before its insert or
   * a GC that deleted the row before the file, so it is removed, as are staging
   * files and thumbnails without a row.
   */
  private async sweepOrphanFiles(recovering: boolean): Promise<void> {
    const blobs = path.join(this.root, "blobs");
    const touched = new Set<string>();
    const recovered: Array<{
      id: string;
      mediaType: StudioAssetMediaType;
      bytes: number;
      width: number;
      height: number;
      createdAt: number;
    }> = [];
    for (const shard of await fs.readdir(blobs, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const directory = path.join(blobs, shard.name);
      for (const entry of await fs.readdir(directory)) {
        const staged = entry.startsWith(".") && entry.endsWith(".tmp");
        if (!staged && (!isStudioAssetId(entry) || this.row(entry))) continue;
        const file = path.join(directory, entry);
        if (recovering && !staged && shard.name === entry.slice(0, 2)) {
          const record = await this.revalidateBlob(file, entry);
          if (record) {
            recovered.push(record);
            continue;
          }
        }
        await fs.rm(file, { force: true });
        touched.add(directory);
      }
    }
    if (recovering) {
      const now = this.now();
      this.transaction((db) => {
        db.prepare("DELETE FROM recovery_pending").run();
        const insert = db.prepare(
          "INSERT OR IGNORE INTO assets (id, media_type, bytes, width, height, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        const mark = db.prepare("INSERT OR IGNORE INTO recovered (asset_id) VALUES (?)");
        for (const asset of recovered) {
          insert.run(asset.id, asset.mediaType, asset.bytes, asset.width, asset.height, asset.createdAt, now);
          mark.run(asset.id);
        }
      });
    }
    if (recovered.length > 0) {
      this.options.onWarning?.(
        `Re-indexed ${recovered.length} stored studio ${recovered.length === 1 ? "image" : "images"} that had no database entry.`,
      );
    }
    const thumbs = path.join(this.root, "thumbs");
    for (const entry of await fs.readdir(thumbs)) {
      const id = entry.slice(0, 64);
      if (!isStudioAssetId(id) || !this.row(id)) {
        await fs.rm(path.join(thumbs, entry), { force: true });
        touched.add(thumbs);
      }
    }
    await syncDirectories(touched);
  }

  /** Metadata for an unindexed blob, or undefined when it is damaged or not an accepted image. */
  private async revalidateBlob(
    file: string,
    id: string,
  ): Promise<
    | {
        id: string;
        mediaType: StudioAssetMediaType;
        bytes: number;
        width: number;
        height: number;
        createdAt: number;
      }
    | undefined
  > {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > this.limits.maxAssetBytes) return undefined;
    const bytes = await fs.readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== id) return undefined;
    let image: ReturnType<typeof validateStudioImage>;
    try {
      image = validateStudioImage(bytes, undefined, this.limits);
    } catch {
      return undefined;
    }
    return {
      id,
      mediaType: image.mediaType,
      bytes: bytes.byteLength,
      width: image.width,
      height: image.height,
      // Blobs are written once, so the file time is the best surviving creation time.
      createdAt: Math.floor(stat.mtimeMs),
    };
  }
}

/**
 * Open (creating as 0600 if missing) and check the schema; closes the handle on failure.
 * `recovering` is true when a rebuild is pending: this call created the schema, or an
 * earlier open did and its re-index never finished.
 */
function openDatabase(file: string): { db: DatabaseSync; recovering: boolean } {
  // Create the file private before SQLite does, so it never exists with the
  // default 0644 mode. SQLite gives -wal and -shm the main file's mode.
  closeSync(openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=100;");
    initializeSqliteReclamation(db);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (Number(version) === 0) {
      db.exec(`BEGIN IMMEDIATE; ${SCHEMA} ${RECOVERY_SCHEMA} INSERT INTO recovery_pending (id) VALUES (1); COMMIT;`);
    } else if (Number(version) > 1) {
      throw new NewerSchemaError();
    } else if (Number(version) !== 1) {
      throw new UnsupportedSchemaError();
    }
    db.exec(RECOVERY_SCHEMA);
    const recovering = db.prepare("SELECT 1 FROM recovery_pending").get() !== undefined;
    return { db, recovering };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Pin 0600 on the database and its sidecars, whatever mode an older build created them with. */
async function restrictDatabaseFiles(file: string): Promise<void> {
  for (const suffix of DATABASE_SIDECARS) {
    try {
      await fs.chmod(`${file}${suffix}`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Rename the database and its sidecars to `<file>.corrupt-<timestamp>[-wal|-shm]`; returns the new main path. */
async function quarantineDatabase(file: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, "-");
  let target = `${file}.corrupt-${stamp}`;
  for (let attempt = 1; await pathExists(target); attempt += 1) {
    target = `${file}.corrupt-${stamp}-${attempt}`;
  }
  for (const suffix of DATABASE_SIDECARS) {
    try {
      await fs.rename(`${file}${suffix}`, `${target}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    // rename keeps the mode, and an older build may have created the file 0644; the kept copy
    // holds the same data as the live database, so it is private too. Best effort.
    await fs.chmod(`${target}${suffix}`, 0o600).catch(() => undefined);
  }
  await syncDirectory(path.dirname(file)).catch(() => undefined);
  return target;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
