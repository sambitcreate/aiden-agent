import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../shared/path-containment.js";

export type AidenOpaqueHandleKind = "loc" | "cur" | "sel" | "file";

export interface AidenOpaqueHandleClaims {
  instanceId: string;
  deviceId: string;
  workspaceId?: string;
  rootId: string;
  policyRevision: string;
  canonicalRootPath: string;
  canonicalPath: string;
  filesystemDevice: string;
  filesystemInode: string;
  confinedRootDevice?: string;
  confinedRootInode?: string;
  expiresAt: number;
  depth?: number;
  snapshotId?: string;
  cursorOffset?: number;
  parentHandleDigest?: string;
  displayPath?: string;
  kind?: "directory" | "file";
}

export type AidenOpaqueHandleErrorCode =
  | "handle_invalid"
  | "handle_expired"
  | "handle_wrong_device"
  | "root_policy_changed"
  | "filesystem_identity_changed"
  | "path_outside_root"
  | "handle_capacity";

export class AidenOpaqueHandleError extends Error {
  constructor(readonly code: AidenOpaqueHandleErrorCode) {
    super(code);
  }
}

export interface AidenOpaqueHandleIssueOptions {
  /** Scope of the listing that issued this handle, e.g. one device's view of one workspace or directory. */
  listing?: string;
  /** Generation identifier for a multi-page lazy directory listing (`snapshotId`). */
  generation?: string;
  /** Marks lazy `children()` file and continuation-cursor handles eligible for per-device LRU reclamation. */
  lazyPage?: boolean;
  /** Marks reserved/save-result document handles protected from pressure reclamation until expiry. */
  protectedDocument?: boolean;
}

export interface AidenOpaqueHandleResolveOptions {
  consume?: boolean;
  now?: number;
  /** Validates directory/cursor navigation without promoting the handle to an immortal opened document. */
  navigation?: boolean;
}

export interface AidenOpaqueHandleBatch {
  issue(kind: AidenOpaqueHandleKind, claims: AidenOpaqueHandleClaims, options?: AidenOpaqueHandleIssueOptions): string;
  commit(): void;
  dispose(): void;
}

interface StoredHandle {
  kind: AidenOpaqueHandleKind;
  claims: AidenOpaqueHandleClaims;
  /** Scope of the listing that issued this handle, e.g. one device's view of one workspace or directory. */
  listing?: string;
  /** Generation of a multi-page lazy directory listing (`snapshotId`). */
  generation?: string;
  /** True only for lazy `children()` file and continuation-cursor handles. */
  lazyPage?: boolean;
  superseded?: boolean;
  protectedDocument?: boolean;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function isOpaqueTokenSyntax(token: string): boolean {
  return /^(?:loc|cur|sel|file)_[A-Za-z0-9_-]{43}$/u.test(token);
}

const DEFAULT_MAX_ENTRIES = 10_000;
// One listing issues up to 4,000 file handles, so a device keeps room for a
// fresh listing while other paired devices always keep the other half.
const DEFAULT_MAX_ENTRIES_PER_DEVICE = 5_000;
const SWEEP_INTERVAL_MS = 60_000;

export class AidenOpaqueHandleStore {
  private readonly handles = new Map<string, StoredHandle>();
  private readonly deviceCounts = new Map<string, number>();
  /** Handles issued by the newest listing of each scope, by digest. */
  private readonly listings = new Map<string, Set<string>>();
  /** Handles issued by each active lazy directory generation (`snapshotId`), by digest. */
  private readonly generations = new Map<string, Set<string>>();
  /** Per-device superseded eligible handles, ordered oldest-superseded first. */
  private readonly deviceReclaimable = new Map<string, Set<string>>();
  /** Per-device live eligible lazy-page handles, ordered least-recently-used first. */
  private readonly deviceLazyLru = new Map<string, Set<string>>();
  /** Active in-flight operation and page-assembly pin counts by handle digest. */
  private readonly inFlightCounts = new Map<string, number>();
  private nextSweepAt = Number.NEGATIVE_INFINITY;
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly options: { maxEntries?: number; maxEntriesPerDevice?: number; now?: () => number } = {},
  ) {}

  private get maxEntries(): number {
    return Math.max(1, this.options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  private get maxEntriesPerDevice(): number {
    return Math.min(this.maxEntries, Math.max(1, this.options.maxEntriesPerDevice ?? DEFAULT_MAX_ENTRIES_PER_DEVICE));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isProtected(key: string, stored: StoredHandle): boolean {
    return Boolean(stored.protectedDocument) || (this.inFlightCounts.get(key) ?? 0) > 0;
  }

  private deleteFromDeviceSet(index: Map<string, Set<string>>, deviceId: string, key: string): void {
    const set = index.get(deviceId);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) index.delete(deviceId);
  }

  private remove(key: string): void {
    const stored = this.handles.get(key);
    if (!stored) return;
    this.handles.delete(key);
    const deviceId = stored.claims.deviceId;
    this.deleteFromDeviceSet(this.deviceReclaimable, deviceId, key);
    this.deleteFromDeviceSet(this.deviceLazyLru, deviceId, key);
    const count = (this.deviceCounts.get(deviceId) ?? 1) - 1;
    if (count > 0) this.deviceCounts.set(deviceId, count);
    else this.deviceCounts.delete(deviceId);
    if (stored.listing) {
      const issued = this.listings.get(stored.listing);
      issued?.delete(key);
      if (issued?.size === 0) this.listings.delete(stored.listing);
    }
    if (stored.generation) {
      const gen = this.generations.get(stored.generation);
      gen?.delete(key);
      if (gen?.size === 0) this.generations.delete(stored.generation);
    }
  }

  /**
   * Expired handles are dropped when they are next used, by a sweep at most
   * once a minute, and when the store is full and time has moved on since the
   * last sweep, so issuing stays amortized O(1) instead of scanning every
   * outstanding handle per call.
   */
  private sweep(now: number): void {
    let skippedInFlight = false;
    for (const [key, stored] of this.handles) {
      if (stored.claims.expiresAt <= now) {
        if ((this.inFlightCounts.get(key) ?? 0) > 0) {
          skippedInFlight = true;
          continue;
        }
        this.remove(key);
      }
    }
    if (!skippedInFlight) {
      this.lastSweepAt = now;
      this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    }
  }

  private makeRoom(now: number, deviceId: string): void {
    const full = () =>
      this.handles.size >= this.maxEntries ||
      (this.deviceCounts.get(deviceId) ?? 0) >= this.maxEntriesPerDevice;
    if (!full()) return;
    // 1. Prune expired entries first (consumed entries are removed immediately on use).
    if (now > this.lastSweepAt) this.sweep(now);
    if (!full()) return;
    // 2. Reclaim superseded eligible entries belonging to the requesting device.
    const superseded = this.deviceReclaimable.get(deviceId);
    if (superseded) {
      for (const key of [...superseded]) {
        const stored = this.handles.get(key);
        if (!stored) {
          this.deleteFromDeviceSet(this.deviceReclaimable, deviceId, key);
          continue;
        }
        if (this.isProtected(key, stored)) continue;
        this.remove(key);
        if (!full()) return;
      }
    }
    // 3. Reclaim least-recently-used eligible lazy-page handles belonging to the requesting device.
    const lazyLru = this.deviceLazyLru.get(deviceId);
    if (lazyLru) {
      for (const key of [...lazyLru]) {
        const stored = this.handles.get(key);
        if (!stored) {
          this.deleteFromDeviceSet(this.deviceLazyLru, deviceId, key);
          continue;
        }
        if (this.isProtected(key, stored)) continue;
        this.remove(key);
        if (!full()) return;
      }
    }
    if (full()) throw new AidenOpaqueHandleError("handle_capacity");
  }

  /**
   * Protects an existing handle from pressure reclamation while an asynchronous
   * file or directory operation is in flight.
   */
  pin(token: string | undefined): () => void {
    if (!token || !isOpaqueTokenSyntax(token)) return () => undefined;
    const key = digest(token);
    this.inFlightCounts.set(key, (this.inFlightCounts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inFlightCounts.get(key) ?? 1) - 1;
      if (next > 0) this.inFlightCounts.set(key, next);
      else this.inFlightCounts.delete(key);
    };
  }

  /**
   * Assembles a page of handles atomically with respect to pressure reclamation:
   * incoming navigation tokens and every newly issued handle (including the
   * outgoing cursor) stay pinned until `commit()`, and `dispose()` rolls back
   * newly issued handles if assembly fails or cancels before `commit()`.
   */
  beginBatch(pinnedTokens: ReadonlyArray<string | undefined> = []): AidenOpaqueHandleBatch {
    const pinnedReleases = pinnedTokens.map((token) => this.pin(token));
    const issued: Array<{ token: string; release: () => void }> = [];
    let committed = false;
    let disposed = false;
    const releaseAll = () => {
      for (const release of pinnedReleases) release();
      for (const entry of issued) entry.release();
    };
    return {
      issue: (kind, claims, options = {}) => {
        if (disposed || committed) throw new AidenOpaqueHandleError("handle_invalid");
        const token = this.issue(kind, claims, options);
        issued.push({ token, release: this.pin(token) });
        return token;
      },
      commit: () => {
        if (disposed) return;
        committed = true;
        releaseAll();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        releaseAll();
        if (!committed) {
          for (const entry of issued) this.discard(entry.token);
        }
      },
    };
  }

  issue(kind: AidenOpaqueHandleKind, claims: AidenOpaqueHandleClaims, options: AidenOpaqueHandleIssueOptions = {}): string {
    const now = this.now();
    if (claims.expiresAt <= now) throw new AidenOpaqueHandleError("handle_expired");
    if (kind === "file" && !claims.workspaceId) throw new AidenOpaqueHandleError("handle_invalid");
    if (now >= this.nextSweepAt) this.sweep(now);
    this.makeRoom(now, claims.deviceId);
    const token = `${kind}_${randomBytes(32).toString("base64url")}`;
    const key = digest(token);
    this.handles.set(key, {
      kind,
      claims: { ...claims },
      ...(options.listing ? { listing: options.listing } : {}),
      ...(options.generation ? { generation: options.generation } : {}),
      ...(options.lazyPage ? { lazyPage: true } : {}),
      ...(options.protectedDocument ? { protectedDocument: true } : {}),
    });
    this.deviceCounts.set(claims.deviceId, (this.deviceCounts.get(claims.deviceId) ?? 0) + 1);
    if (options.listing) {
      let issued = this.listings.get(options.listing);
      if (!issued) this.listings.set(options.listing, (issued = new Set()));
      issued.add(key);
    }
    if (options.generation) {
      let gen = this.generations.get(options.generation);
      if (!gen) this.generations.set(options.generation, (gen = new Set()));
      gen.add(key);
    }
    if (options.lazyPage && !options.protectedDocument) {
      let lru = this.deviceLazyLru.get(claims.deviceId);
      if (!lru) this.deviceLazyLru.set(claims.deviceId, (lru = new Set()));
      lru.add(key);
    }
    return token;
  }

  private markSuperseded(key: string): void {
    const stored = this.handles.get(key);
    if (!stored) return;
    stored.superseded = true;
    const deviceId = stored.claims.deviceId;
    this.deleteFromDeviceSet(this.deviceLazyLru, deviceId, key);
    if (!stored.protectedDocument) {
      let reclaimable = this.deviceReclaimable.get(deviceId);
      if (!reclaimable) this.deviceReclaimable.set(deviceId, (reclaimable = new Set()));
      reclaimable.add(key);
    }
  }

  /**
   * A new listing for `listing` supersedes the handles earlier listings of it
   * issued. They keep working, but once the store (or the device's share of
   * it) is full those never opened as documents are reclaimed first, so
   * re-listing cannot lock the device out until the old handles expire.
   */
  supersedeListing(listing: string): void {
    const issued = this.listings.get(listing);
    if (!issued) return;
    this.listings.delete(listing);
    for (const key of issued) {
      const stored = this.handles.get(key);
      if (!stored) continue;
      if (stored.generation) {
        const gen = this.generations.get(stored.generation);
        gen?.delete(key);
        if (gen?.size === 0) this.generations.delete(stored.generation);
      }
      this.markSuperseded(key);
    }
  }

  /**
   * Retires one lazy directory generation (for example when its unfinished
   * server-cached inventory expires or is evicted) without disturbing newer
   * generations of the same directory or opened-document handles.
   */
  retireGeneration(generation: string): void {
    const gen = this.generations.get(generation);
    if (!gen) return;
    this.generations.delete(generation);
    for (const key of gen) {
      const stored = this.handles.get(key);
      if (!stored) continue;
      if (stored.listing) {
        const issued = this.listings.get(stored.listing);
        issued?.delete(key);
        if (issued?.size === 0) this.listings.delete(stored.listing);
      }
      this.markSuperseded(key);
    }
  }

  /** Reserve before a save, then bind the same slot to its installed inode. */
  updateReservedFileIdentity(token: string, device: string, inode: string): void {
    const key = digest(token);
    const stored = this.handles.get(key);
    if (!stored || stored.kind !== "file") throw new AidenOpaqueHandleError("handle_invalid");
    stored.claims.filesystemDevice = device;
    stored.claims.filesystemInode = inode;
    stored.protectedDocument = true;
    this.deleteFromDeviceSet(this.deviceReclaimable, stored.claims.deviceId, key);
    this.deleteFromDeviceSet(this.deviceLazyLru, stored.claims.deviceId, key);
  }

  discard(token: string): void {
    this.remove(digest(token));
  }

  claimsFor(
    token: string,
    expectedKind: AidenOpaqueHandleKind,
  ): AidenOpaqueHandleClaims {
    if (!new RegExp(`^${expectedKind}_[A-Za-z0-9_-]{43}$`, "u").test(token)) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    const stored = this.handles.get(digest(token));
    if (!stored || stored.kind !== expectedKind) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    if (stored.claims.expiresAt <= this.now()) {
      this.remove(digest(token));
      throw new AidenOpaqueHandleError("handle_expired");
    }
    return { ...stored.claims };
  }

  resolve(
    token: string,
    expectedKind: AidenOpaqueHandleKind,
    current: AidenOpaqueHandleClaims,
    options: AidenOpaqueHandleResolveOptions = {},
  ): AidenOpaqueHandleClaims {
    if (!new RegExp(`^${expectedKind}_[A-Za-z0-9_-]{43}$`).test(token)) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    const tokenDigest = digest(token);
    const stored = this.handles.get(tokenDigest);
    if (!stored || stored.kind !== expectedKind) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    const claims = stored.claims;
    const now = options.now ?? this.now();
    if (now >= claims.expiresAt) {
      this.remove(tokenDigest);
      throw new AidenOpaqueHandleError("handle_expired");
    }
    if (claims.instanceId !== current.instanceId || claims.deviceId !== current.deviceId) {
      throw new AidenOpaqueHandleError("handle_wrong_device");
    }
    if (expectedKind === "file" && (!claims.workspaceId || !current.workspaceId || claims.workspaceId !== current.workspaceId)) {
      throw new AidenOpaqueHandleError("root_policy_changed");
    }
    if (claims.rootId !== current.rootId || claims.policyRevision !== current.policyRevision) {
      throw new AidenOpaqueHandleError("root_policy_changed");
    }
    if (!isPathInside(current.canonicalRootPath, current.canonicalPath)) {
      throw new AidenOpaqueHandleError("path_outside_root");
    }
    if (
      claims.canonicalRootPath !== current.canonicalRootPath ||
      claims.canonicalPath !== current.canonicalPath ||
      claims.filesystemDevice !== current.filesystemDevice ||
      claims.filesystemInode !== current.filesystemInode ||
      claims.confinedRootDevice !== current.confinedRootDevice ||
      claims.confinedRootInode !== current.confinedRootInode ||
      claims.kind !== current.kind ||
      claims.depth !== current.depth ||
      claims.snapshotId !== current.snapshotId ||
      claims.cursorOffset !== current.cursorOffset ||
      claims.parentHandleDigest !== current.parentHandleDigest ||
      claims.displayPath !== current.displayPath
    ) {
      throw new AidenOpaqueHandleError("filesystem_identity_changed");
    }
    // A consumed handle is gone: any later use is simply an unknown handle.
    if (options.consume) {
      this.remove(tokenDigest);
      return { ...claims };
    }
    if (options.navigation) {
      if (stored.lazyPage && !stored.protectedDocument && !stored.superseded) {
        let lru = this.deviceLazyLru.get(claims.deviceId);
        if (!lru) this.deviceLazyLru.set(claims.deviceId, (lru = new Set()));
        lru.delete(tokenDigest);
        lru.add(tokenDigest);
      }
    } else {
      stored.protectedDocument = true;
      this.deleteFromDeviceSet(this.deviceReclaimable, claims.deviceId, tokenDigest);
      this.deleteFromDeviceSet(this.deviceLazyLru, claims.deviceId, tokenDigest);
    }
    return { ...claims };
  }

  consumeSelection<T>(
    token: string,
    current: AidenOpaqueHandleClaims,
    createWorkspaceSynchronously: (claims: AidenOpaqueHandleClaims) => T extends PromiseLike<unknown> ? never : T,
    now = Date.now(),
  ): T {
    if (current.kind !== "directory") throw new AidenOpaqueHandleError("handle_invalid");
    if (createWorkspaceSynchronously.constructor.name === "AsyncFunction") {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    const claims = this.resolve(token, "sel", current, { now, consume: true });
    const result = createWorkspaceSynchronously(claims);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    return result;
  }

  storedTokenMaterialForTesting(): string[] {
    return [...this.handles.keys()];
  }
}

export async function inspectAidenFilesystemIdentity(rootPath: string, candidatePath: string): Promise<Pick<AidenOpaqueHandleClaims, "canonicalRootPath" | "canonicalPath" | "filesystemDevice" | "filesystemInode" | "kind">> {
  // Drain both path lookups even when one fails so shared metadata admission
  // does not release its budget while a sibling lookup is still running.
  const [root, candidate] = await Promise.allSettled([realpath(rootPath), realpath(candidatePath)]);
  if (root.status === "rejected") throw root.reason;
  if (candidate.status === "rejected") throw candidate.reason;
  const canonicalRootPath = root.value;
  const canonicalPath = candidate.value;
  if (!isPathInside(canonicalRootPath, canonicalPath)) throw new AidenOpaqueHandleError("path_outside_root");
  const identity = await stat(canonicalPath);
  // Another name for a multiply-linked regular file can live outside the root,
  // so the in-root name would expose or mutate that outside file.
  if (identity.isFile() && identity.nlink !== 1) throw new AidenOpaqueHandleError("path_outside_root");
  return {
    canonicalRootPath,
    canonicalPath,
    filesystemDevice: String(identity.dev),
    filesystemInode: String(identity.ino),
    kind: identity.isDirectory() ? "directory" : "file",
  };
}

/**
 * A snapshot-handle save installs a new inode at the same name. Rebind the
 * handle in place (clients validate that a save answers with the id they sent)
 * after the same containment and single-link checks a fresh listing performs.
 * If the installed file cannot be admitted, the handle is discarded so it
 * authorizes nothing, and the phone re-lists.
 */
export async function rebindAidenFileHandleToSavedFile(
  handles: AidenOpaqueHandleStore,
  token: string,
  rootPath: string,
  displayPath: string,
  saved: { device: string; inode: string },
): Promise<void> {
  let rebound = false;
  try {
    const stored = handles.claimsFor(token, "file");
    const installed = await inspectAidenFilesystemIdentity(rootPath, path.join(rootPath, displayPath));
    // Only the inode this save installed is adopted, never a file another app put there afterwards.
    if (
      installed.kind === "file" &&
      installed.canonicalRootPath === stored.canonicalRootPath &&
      installed.canonicalPath === stored.canonicalPath &&
      installed.filesystemDevice === saved.device &&
      installed.filesystemInode === saved.inode
    ) {
      handles.updateReservedFileIdentity(token, installed.filesystemDevice, installed.filesystemInode);
      rebound = true;
    }
  } catch {
    // The save already landed; only the follow-up handle use is refused.
  }
  // The pre-save inode may be freed and reused by a replacement, so a handle that could not be
  // rebound must authorize nothing: the phone gets a conflict and lists the folder again.
  if (!rebound) handles.discard(token);
}
