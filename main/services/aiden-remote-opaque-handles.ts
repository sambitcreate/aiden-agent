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

interface StoredHandle {
  kind: AidenOpaqueHandleKind;
  claims: AidenOpaqueHandleClaims;
  /** Scope of the listing that issued this handle, e.g. one device's view of one workspace. */
  listing?: string;
  superseded?: boolean;
  resolved?: boolean;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
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
  /** Superseded handles never resolved: the first reclaimed when full. */
  private readonly reclaimable = new Set<string>();
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

  private remove(key: string): void {
    const stored = this.handles.get(key);
    if (!stored) return;
    this.handles.delete(key);
    this.reclaimable.delete(key);
    const deviceId = stored.claims.deviceId;
    const count = (this.deviceCounts.get(deviceId) ?? 1) - 1;
    if (count > 0) this.deviceCounts.set(deviceId, count);
    else this.deviceCounts.delete(deviceId);
    if (stored.listing) {
      const issued = this.listings.get(stored.listing);
      issued?.delete(key);
      if (issued?.size === 0) this.listings.delete(stored.listing);
    }
  }

  /**
   * Expired handles are dropped when they are next used, by a sweep at most
   * once a minute, and when the store is full and time has moved on since the
   * last sweep, so issuing stays amortized O(1) instead of scanning every
   * outstanding handle per call.
   */
  private sweep(now: number): void {
    this.lastSweepAt = now;
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    for (const [key, stored] of this.handles) {
      if (stored.claims.expiresAt <= now) this.remove(key);
    }
  }

  private makeRoom(now: number, deviceId: string): void {
    const full = () =>
      this.handles.size >= this.maxEntries ||
      (this.deviceCounts.get(deviceId) ?? 0) >= this.maxEntriesPerDevice;
    if (!full()) return;
    // A device that reaches its own quota gives back only its own handles.
    const deviceFull = (this.deviceCounts.get(deviceId) ?? 0) >= this.maxEntriesPerDevice;
    for (const key of [...this.reclaimable]) {
      if (!deviceFull || this.handles.get(key)?.claims.deviceId === deviceId) this.remove(key);
    }
    if (full() && now > this.lastSweepAt) this.sweep(now);
    if (full()) throw new AidenOpaqueHandleError("handle_capacity");
  }

  issue(kind: AidenOpaqueHandleKind, claims: AidenOpaqueHandleClaims, options: { listing?: string } = {}): string {
    const now = this.now();
    if (claims.expiresAt <= now) throw new AidenOpaqueHandleError("handle_expired");
    if (kind === "file" && !claims.workspaceId) throw new AidenOpaqueHandleError("handle_invalid");
    if (now >= this.nextSweepAt) this.sweep(now);
    this.makeRoom(now, claims.deviceId);
    const token = `${kind}_${randomBytes(32).toString("base64url")}`;
    const key = digest(token);
    this.handles.set(key, {
      kind, claims: { ...claims }, ...(options.listing ? { listing: options.listing } : {}),
    });
    this.deviceCounts.set(claims.deviceId, (this.deviceCounts.get(claims.deviceId) ?? 0) + 1);
    if (options.listing) {
      let issued = this.listings.get(options.listing);
      if (!issued) this.listings.set(options.listing, (issued = new Set()));
      issued.add(key);
    }
    return token;
  }

  /**
   * A new listing for `listing` supersedes the handles earlier listings of it
   * issued. They keep working, but once the store (or the device's share of
   * it) is full those never resolved are reclaimed first (a document the
   * client opened has been resolved), so re-listing cannot lock the device out
   * until the old handles expire.
   */
  supersedeListing(listing: string): void {
    const issued = this.listings.get(listing);
    if (!issued) return;
    this.listings.delete(listing);
    for (const key of issued) {
      const stored = this.handles.get(key);
      if (!stored) continue;
      stored.superseded = true;
      if (!stored.resolved) this.reclaimable.add(key);
    }
  }

  /** Reserve before a save, then bind the same slot to its installed inode. */
  updateReservedFileIdentity(token: string, device: string, inode: string): void {
    const stored = this.handles.get(digest(token));
    if (!stored || stored.kind !== "file") throw new AidenOpaqueHandleError("handle_invalid");
    stored.claims.filesystemDevice = device;
    stored.claims.filesystemInode = inode;
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
    options: { consume?: boolean; now?: number } = {},
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
    stored.resolved = true;
    this.reclaimable.delete(tokenDigest);
    // A consumed handle is gone: any later use is simply an unknown handle.
    if (options.consume) this.remove(tokenDigest);
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
