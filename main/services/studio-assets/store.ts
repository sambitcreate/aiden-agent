import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../durable-fs.js";
import {
  STUDIO_ASSET_LIMITS,
  StudioAssetError,
  holderKey,
  isStudioAssetId,
  parseHolderKey,
  type StudioAssetHolder,
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

export interface StudioAssetStoreOptions {
  /** Resolved lazily so a disabled feature never touches userData. */
  root: () => string;
  thumbnailer: StudioAssetThumbnailer;
  now?: () => number;
  limits?: Partial<StudioAssetLimits>;
}

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

  constructor(private readonly options: StudioAssetStoreOptions) {
    this.now = options.now ?? Date.now;
    this.limits = { ...STUDIO_ASSET_LIMITS, ...options.limits };
  }

  initialize(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    const root = this.options.root();
    await fs.mkdir(path.join(root, "blobs"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(root, "thumbs"), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(root, "assets-v1.sqlite"));
    try {
      db.exec(
        "PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (Number(version) === 0) {
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
      } else if (Number(version) !== 1) {
        throw new StudioAssetError(
          "unavailable",
          "The studio asset database uses an unsupported schema.",
        );
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    this.root = root;
    await this.exclusive(() => this.sweepOrphanFiles());
    await this.collectGarbage();
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
    if (!db) return Promise.resolve();
    this.db = null;
    return this.blobWrites.then(() => db.close());
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
    const usage = this.usage();
    if (
      usage.assets + 1 > this.limits.maxAssets ||
      usage.bytes + input.bytes.byteLength > this.limits.maxTotalBytes
    ) {
      throw new StudioAssetError(
        "quota",
        "Studio asset storage is full. Delete unused projects or workflows to free space.",
      );
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
      // Linux). The original is within the validated pixel limit.
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
          "SELECT id, bytes FROM assets WHERE touched_at < ? AND NOT EXISTS (SELECT 1 FROM holds WHERE holds.asset_id = assets.id)",
        )
        .all(cutoff) as { id: string; bytes: number }[];
      const remove = db.prepare("DELETE FROM assets WHERE id = ?");
      for (const row of rows) remove.run(row.id);
      return rows;
    });
    for (const row of doomed) await this.removeFiles(row.id);
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

  /** Remove crash leftovers: staging files, blobs whose row never committed, orphan thumbnails. */
  private async sweepOrphanFiles(): Promise<void> {
    const blobs = path.join(this.root, "blobs");
    for (const shard of await fs.readdir(blobs, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const directory = path.join(blobs, shard.name);
      for (const entry of await fs.readdir(directory)) {
        const staged = entry.startsWith(".") && entry.endsWith(".tmp");
        if (staged || (isStudioAssetId(entry) && !this.row(entry))) {
          await fs.rm(path.join(directory, entry), { force: true });
        }
      }
    }
    const thumbs = path.join(this.root, "thumbs");
    for (const entry of await fs.readdir(thumbs)) {
      const id = entry.slice(0, 64);
      if (!isStudioAssetId(id) || !this.row(id))
        await fs.rm(path.join(thumbs, entry), { force: true });
    }
  }
}
