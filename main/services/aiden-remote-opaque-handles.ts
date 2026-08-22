import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

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
  consumed: boolean;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export class AidenOpaqueHandleStore {
  private readonly handles = new Map<string, StoredHandle>();

  constructor(private readonly options: { maxEntries?: number; now?: () => number } = {}) {}

  private get maxEntries(): number {
    return Math.max(1, this.options.maxEntries ?? 10_000);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(now: number, exceptDigest?: string): void {
    for (const [key, stored] of this.handles) {
      if (key !== exceptDigest && (stored.consumed || stored.claims.expiresAt <= now)) {
        this.handles.delete(key);
      }
    }
  }

  issue(kind: AidenOpaqueHandleKind, claims: AidenOpaqueHandleClaims): string {
    const now = this.now();
    this.prune(now);
    if (claims.expiresAt <= now) throw new AidenOpaqueHandleError("handle_expired");
    if (kind === "file" && !claims.workspaceId) throw new AidenOpaqueHandleError("handle_invalid");
    if (this.handles.size >= this.maxEntries) throw new AidenOpaqueHandleError("handle_capacity");
    const token = `${kind}_${randomBytes(32).toString("base64url")}`;
    this.handles.set(digest(token), { kind, claims: { ...claims }, consumed: false });
    return token;
  }

  claimsFor(
    token: string,
    expectedKind: AidenOpaqueHandleKind,
  ): AidenOpaqueHandleClaims {
    if (!new RegExp(`^${expectedKind}_[A-Za-z0-9_-]{43}$`, "u").test(token)) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    const stored = this.handles.get(digest(token));
    if (!stored || stored.kind !== expectedKind || stored.consumed) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    if (stored.claims.expiresAt <= this.now()) {
      this.handles.delete(digest(token));
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
    if (!stored || stored.kind !== expectedKind || stored.consumed) {
      throw new AidenOpaqueHandleError("handle_invalid");
    }
    const claims = stored.claims;
    const now = options.now ?? this.now();
    if (now >= claims.expiresAt) {
      this.handles.delete(tokenDigest);
      throw new AidenOpaqueHandleError("handle_expired");
    }
    this.prune(now, tokenDigest);
    if (claims.instanceId !== current.instanceId || claims.deviceId !== current.deviceId) {
      throw new AidenOpaqueHandleError("handle_wrong_device");
    }
    if (expectedKind === "file" && (!claims.workspaceId || !current.workspaceId || claims.workspaceId !== current.workspaceId)) {
      throw new AidenOpaqueHandleError("root_policy_changed");
    }
    if (claims.rootId !== current.rootId || claims.policyRevision !== current.policyRevision) {
      throw new AidenOpaqueHandleError("root_policy_changed");
    }
    const relative = path.relative(current.canonicalRootPath, current.canonicalPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new AidenOpaqueHandleError("path_outside_root");
    }
    if (
      claims.canonicalRootPath !== current.canonicalRootPath ||
      claims.canonicalPath !== current.canonicalPath ||
      claims.filesystemDevice !== current.filesystemDevice ||
      claims.filesystemInode !== current.filesystemInode ||
      claims.kind !== current.kind ||
      claims.depth !== current.depth ||
      claims.snapshotId !== current.snapshotId ||
      claims.cursorOffset !== current.cursorOffset ||
      claims.parentHandleDigest !== current.parentHandleDigest ||
      claims.displayPath !== current.displayPath
    ) {
      throw new AidenOpaqueHandleError("filesystem_identity_changed");
    }
    if (options.consume) stored.consumed = true;
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
  const [canonicalRootPath, canonicalPath] = await Promise.all([realpath(rootPath), realpath(candidatePath)]);
  const relative = path.relative(canonicalRootPath, canonicalPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new AidenOpaqueHandleError("path_outside_root");
  const identity = await stat(canonicalPath);
  return {
    canonicalRootPath,
    canonicalPath,
    filesystemDevice: String(identity.dev),
    filesystemInode: String(identity.ino),
    kind: identity.isDirectory() ? "directory" : "file",
  };
}
