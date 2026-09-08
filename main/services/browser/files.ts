import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

const CAPABILITY_QUERY = "__aiden_preview";
export const BROWSER_PREVIEW_AUTH_HEADER = "X-Aiden-Preview-Authorization";
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_WORKSPACES = 24;
const MAX_CONCURRENT_READS = 8;
const ENTRY_EXTENSIONS = new Set([".htm", ".html", ".pdf"]);
// Mirrors t3code's workspace browser asset types. Unknown files are never a
// download fallback: a local page cannot turn this into a general file reader.
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const SECRET_NAME =
  /(?:^|[._-])(?:secrets?|credentials|private[-_]?key|id_rsa|id_ed25519)(?:[._-]|$)/i;

export interface BrowserFileWorkspace {
  id: string;
  folderPath?: string;
  permission: "none" | "ask" | "full";
}
export interface BrowserFileServiceOptions {
  getWorkspace(workspaceId: string): Promise<BrowserFileWorkspace | undefined>;
  /** Deterministic filesystem-race seam; production leaves this unset. */
  beforeRead?(): Promise<void>;
  onLifecycle?(event: {
    leaseId: string;
    event: "created" | "attached" | "released" | "closed";
    reason: string;
  }): void;
}
/** Main-only preparation. Serialized lookalikes never create file authority. */
export interface PreparedBrowserFile {
  readonly workspaceId: string;
  readonly path: string;
  readonly assetPaths: readonly string[];
  readonly displayPaths: readonly string[];
  readonly requiresApproval: boolean;
}
export interface BrowserFileReservation {
  readonly url: string;
  release(): void;
}
interface ExactFileIdentity {
  canonical: string;
  configured: string;
  device: number;
  inode: number;
}
interface PreparedDetails {
  epoch: number;
  workspaceRoot: RootIdentity;
  root: RootIdentity;
  relative: string;
  key: string;
  files: Map<string, ExactFileIdentity>;
  approved: boolean;
}
interface RootIdentity {
  configuredPath: string;
  canonicalPath: string;
  device: number;
  inode: number;
}
interface Lease {
  id: string;
  key: string;
  workspaceId: string;
  workspaceRoot: RootIdentity;
  root: RootIdentity;
  files: Map<string, ExactFileIdentity>;
  server: Server;
  origin: string;
  host: string;
  token: string;
  revoked: boolean;
  retiring: boolean;
  reads: number;
  reservations: Set<object>;
  consumers: Set<string>;
  closing?: Promise<void>;
}
class FilePreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function equalSecret(left: string | undefined, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function safeSegments(segments: string[]): string[] {
  if (
    !segments.length ||
    segments.some(
      (segment) =>
        !segment ||
        segment.startsWith(".") ||
        segment.includes("\\") ||
        segment.includes("/") ||
        [...segment].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        SECRET_NAME.test(segment),
    )
  ) {
    throw new FilePreviewError(404, "This file is not available for browser preview.");
  }
  return segments;
}
function confinedRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new FilePreviewError(404, "Choose a file inside the current workspace.");
  }
  safeSegments(relative.split(path.sep));
  return relative;
}
function identityMatches(identity: RootIdentity, stat: { dev: number; ino: number }): boolean {
  return identity.device === stat.dev && identity.inode === stat.ino;
}
/** Never forward an internal bearer header, including across redirects. */
export function browserPreviewRequestHeaders(
  headers: Record<string, string>,
  authorization?: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === BROWSER_PREVIEW_AUTH_HEADER.toLowerCase()) continue;
    if (key.toLowerCase() === "cookie") {
      // Earlier previews used host-wide cookies. Do not send those historical
      // bearer values to another loopback port after this policy changes.
      const retained = value.split(";").map((part) => part.trim())
        .filter((part) => !part.startsWith("aiden_preview_"));
      if (retained.length) result[key] = retained.join("; ");
    } else result[key] = value;
  }
  if (authorization) result[BROWSER_PREVIEW_AUTH_HEADER] = authorization;
  return result;
}
function requestSegments(request: Pick<IncomingMessage, "url">): string[] {
  const rawPath = (request.url ?? "").split("?", 1)[0]!;
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.length > 8192)
    throw new FilePreviewError(404, "Invalid preview path.");
  try {
    return safeSegments(
      rawPath
        .slice(1)
        .split("/")
        .map((segment) => decodeURIComponent(segment)),
    );
  } catch {
    throw new FilePreviewError(404, "Invalid preview path.");
  }
}

function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0)
    throw new FilePreviewError(416, "Invalid byte range.");
  const suffix = match[1] === "";
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix ? size - 1 : match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new FilePreviewError(416, "Invalid byte range.");
  return { start, end, partial: true };
}

/** Owns private loopback origins for workspace HTML/PDF previews and their assets. */
export class BrowserFileService {
  private readonly leases = new Map<string, Lease>();
  private readonly retiredOrigins = new Set<string>();
  private readonly retiredTokens = new Map<string, number>();
  private readonly opening = new Map<string, Promise<unknown>>();
  private readonly epochs = new Map<string, number>();
  private readonly preparations = new WeakMap<PreparedBrowserFile, PreparedDetails>();
  private readonly consumers = new Map<string, Lease>();
  private readonly closing = new Set<Promise<void>>();
  private stopped = false;
  private starting = 0;
  private activeReads = 0;

  constructor(private readonly options: BrowserFileServiceOptions) {}

  /** Preview URLs stay ephemeral after navigation removes the bootstrap token. */
  isPreviewUrl(value: string): boolean {
    try {
      const origin = new URL(value).origin;
      return (
        this.retiredOrigins.has(origin) ||
        [...this.leases.values()].some((lease) => lease.origin === origin)
      );
    } catch {
      return false;
    }
  }
  /** Called only by the native guest request interceptor, never by page JavaScript. */
  authorizationForRequest(
    workspaceId: string,
    value: string,
    requestingOrigin: string,
  ): string | undefined {
    if (this.stopped) return undefined;
    try {
      const url = new URL(value);
      if (url.origin !== requestingOrigin || url.username || url.password) return undefined;
      const relative = requestSegments({ url: url.pathname }).join(path.sep);
      const lease = [...this.leases.values()].find((candidate) =>
        candidate.workspaceId === workspaceId && candidate.origin === url.origin &&
        !candidate.revoked && !candidate.retiring && candidate.files.has(relative),
      );
      return lease?.token;
    } catch {
      return undefined;
    }
  }
  /** Never persist raw capabilities echoed by an untrusted page into text results. */
  redactText(value: string): string {
    if (value.length < 32) return value;
    const now = Date.now();
    for (const [token, expires] of this.retiredTokens)
      if (expires <= now) this.retiredTokens.delete(token);
    const tokens = new Set([
      ...this.retiredTokens.keys(),
      ...[...this.leases.values()].map((lease) => lease.token),
    ]);
    if (!tokens.size) return value;
    return value.replace(new RegExp([...tokens].join("|"), "g"), "[private-preview]");
  }

  async prepare(
    workspaceId: string,
    suppliedPath: string,
    options: { assetPaths?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<PreparedBrowserFile> {
    if (
      !workspaceId ||
      workspaceId.length > 200 ||
      typeof suppliedPath !== "string" ||
      !suppliedPath ||
      suppliedPath.length > 8192
    )
      throw new Error("Choose an HTML or PDF document for browser preview.");
    if (
      options.assetPaths !== undefined &&
      (!Array.isArray(options.assetPaths) ||
        options.assetPaths.length > 64 ||
        options.assetPaths.some(
          (asset) => typeof asset !== "string" || !asset || asset.length > 8192,
        ))
    )
      throw new Error("Declare at most 64 exact browser asset paths.");
    const epoch = this.epochs.get(workspaceId) ?? 0;
    const check = () => {
      this.assertOpening(workspaceId, epoch);
      options.signal?.throwIfAborted();
    };
    check();
    const workspaceRoot = await this.resolveRoot(workspaceId);
    check();
    const candidate = path.resolve(workspaceRoot.configuredPath, suppliedPath);
    if (!ENTRY_EXTENSIONS.has(path.extname(candidate).toLowerCase()))
      throw new Error("Browser file preview supports HTML and PDF documents.");
    const assets = [...new Set(options.assetPaths ?? [])].map((asset) =>
      path.resolve(path.dirname(candidate), asset),
    );
    let relative: string | undefined;
    try {
      relative = confinedRelative(workspaceRoot.configuredPath, candidate);
    } catch {
      /* An exact external grant may authorize this document. */
    }
    let root = workspaceRoot;
    let files: Map<string, ExactFileIdentity>;
    let displayPaths = [candidate, ...assets];
    let workspaceOnly = Boolean(relative);
    if (workspaceOnly) {
      for (const asset of assets) {
        try {
          confinedRelative(root.configuredPath, asset);
        } catch {
          workspaceOnly = false;
          break;
        }
      }
    }
    if (workspaceOnly) {
      files = new Map();
      for (const configured of displayPaths) {
        check();
        const route = confinedRelative(root.configuredPath, configured);
        const inspected = await this.inspectFile(root, route);
        files.set(route, {
          configured,
          canonical: inspected.canonical,
          device: inspected.stat.dev,
          inode: inspected.stat.ino,
        });
      }
    } else {
      const identities: ExactFileIdentity[] = [];
      for (const configured of displayPaths) {
        check();
        const canonical = await fs.realpath(configured);
        safeSegments([path.basename(configured), path.basename(canonical)]);
        if (!MIME_TYPES[path.extname(canonical).toLowerCase()])
          throw new Error("This file type cannot be previewed in the browser.");
        const stat = await fs.stat(canonical);
        if (!stat.isFile() || stat.size > MAX_ASSET_BYTES)
          throw new Error("Browser preview grants require regular files no larger than 32 MB.");
        identities.push({ configured, canonical, device: stat.dev, inode: stat.ino });
      }
      let common = path.dirname(identities[0]!.canonical);
      for (const file of identities)
        while (
          path.relative(common, file.canonical).startsWith(`..${path.sep}`) ||
          path.relative(common, file.canonical) === ".."
        )
          common = path.dirname(common);
      const stat = await fs.stat(common);
      root = { configuredPath: common, canonicalPath: common, device: stat.dev, inode: stat.ino };
      files = new Map(identities.map((file) => [confinedRelative(common, file.canonical), file]));
      relative = confinedRelative(common, identities[0]!.canonical);
      displayPaths = identities.map((file) => file.canonical);
    }
    check();
    const prepared: PreparedBrowserFile = Object.freeze({
      workspaceId,
      path: suppliedPath,
      assetPaths: Object.freeze([...(options.assetPaths ?? [])]),
      displayPaths: Object.freeze(displayPaths),
      requiresApproval: !workspaceOnly,
    });
    this.preparations.set(prepared, {
      epoch,
      workspaceRoot,
      root,
      relative: relative!,
      files,
      approved: workspaceOnly,
      // Each origin owns an immutable route/file grant. Opening another document
      // cannot give a previously loaded page access to that document or its assets.
      key: `exact:${workspaceId}:${JSON.stringify([root.canonicalPath, [...files.entries()].map(([route, file]) => [route, file.canonical, file.device, file.inode]).sort()])}`,
    });
    return prepared;
  }

  /** Called only by the main approval coordinator after this exact descriptor was allowed. */
  approve(prepared: PreparedBrowserFile): void {
    const details = this.preparations.get(prepared);
    if (!details) throw new Error("This browser file preparation is not authentic.");
    this.assertOpening(prepared.workspaceId, details.epoch);
    details.approved = true;
  }

  async open(
    workspaceId: string,
    suppliedPath: string,
    options: {
      preparedFile?: PreparedBrowserFile;
      assetPaths?: readonly string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<BrowserFileReservation> {
    const prepared =
      options.preparedFile ?? (await this.prepare(workspaceId, suppliedPath, options));
    const details = this.preparations.get(prepared);
    if (
      !details ||
      prepared.workspaceId !== workspaceId ||
      prepared.path !== suppliedPath ||
      JSON.stringify(prepared.assetPaths) !== JSON.stringify(options.assetPaths ?? [])
    )
      throw new Error("The browser file grant does not match this exact request.");
    if (!details.approved)
      throw new Error(
        "A file outside the workspace needs approval for that exact document and its declared assets.",
      );
    const check = () => {
      this.assertOpening(workspaceId, details.epoch);
      options.signal?.throwIfAborted();
    };
    const operation = (this.opening.get(workspaceId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        check();
        let lease = this.leases.get(details.key);
        let acquisition: BrowserFileReservation | undefined;
        if (lease) {
          try {
            acquisition = this.reserve(lease, lease.origin, options.signal);
            await this.validateLease(lease);
          } catch {
            acquisition?.release();
            acquisition = undefined;
            await this.closeLease(lease, "authority_revoked", false);
            lease = undefined;
          }
        }
        try {
          check();
        } catch (error) {
          acquisition?.release();
          throw error;
        }
        if (!lease) {
          if (this.leases.size + this.starting >= MAX_WORKSPACES)
            throw new Error("Close a browser preview before opening another local document.");
          this.starting += 1;
          try {
            lease = await this.createLease(workspaceId, details);
          } finally {
            this.starting -= 1;
          }
          this.leases.set(details.key, lease);
          try {
            check();
            acquisition = this.reserve(lease, lease.origin, options.signal);
          } catch (error) {
            await this.closeLease(lease, "open_cancelled", false);
            throw error;
          }
        }
        try {
          check();
          await this.validateLease(lease);
          await this.inspectLeaseFile(lease, details.relative);
          check();
          const encoded = details.relative.split(path.sep).map(encodeURIComponent).join("/");
          return this.reserve(lease, `${lease.origin}/${encoded}`, options.signal);
        } catch (error) {
          this.maybeClose(lease, "open_failed");
          throw error;
        } finally {
          acquisition?.release();
        }
      });
    this.opening.set(workspaceId, operation);
    try {
      return await operation;
    } finally {
      if (this.opening.get(workspaceId) === operation) this.opening.delete(workspaceId);
    }
  }

  /** Keep an existing authorized origin alive during a new tab or navigation. */
  reserveUrl(
    workspaceId: string,
    value: string,
    signal?: AbortSignal,
  ): BrowserFileReservation | undefined {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    const lease = [...this.leases.values()].find(
      (candidate) =>
        candidate.origin === parsed.origin &&
        candidate.workspaceId === workspaceId &&
        !candidate.revoked &&
        !candidate.retiring,
    );
    if (!lease) {
      if (this.isPreviewUrl(value))
        throw new Error("This local browser preview expired. Open its file again.");
      return undefined;
    }
    return this.reserve(lease, value, signal);
  }
  private reserve(lease: Lease, value: string, signal?: AbortSignal): BrowserFileReservation {
    signal?.throwIfAborted();
    if (lease.revoked || lease.retiring) throw new Error("This browser preview was closed.");
    const reservation = {};
    lease.reservations.add(reservation);
    const url = new URL(value);
    url.searchParams.set(CAPABILITY_QUERY, lease.token);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      lease.reservations.delete(reservation);
      this.event(lease, "released", "reservation_released");
      this.maybeClose(lease, "last_consumer");
    };
    signal?.addEventListener("abort", release, { once: true });
    return { url: url.href, release };
  }
  commitConsumer(workspaceId: string, consumerId: string, value: string): void {
    let origin: string | undefined;
    try {
      origin = new URL(value).origin;
    } catch {
      /* Navigating away releases its old preview. */
    }
    const next = [...this.leases.values()].find(
      (lease) =>
        lease.workspaceId === workspaceId &&
        lease.origin === origin &&
        !lease.revoked &&
        !lease.retiring,
    );
    const previous = this.consumers.get(consumerId);
    if (previous === next) return;
    if (next) {
      next.consumers.add(consumerId);
      this.consumers.set(consumerId, next);
      this.event(next, "attached", "navigation_committed");
    } else this.consumers.delete(consumerId);
    if (previous) {
      previous.consumers.delete(consumerId);
      this.event(previous, "released", "navigation_away");
      this.maybeClose(previous, "last_consumer");
    }
  }
  releaseConsumer(consumerId: string): void {
    const lease = this.consumers.get(consumerId);
    this.consumers.delete(consumerId);
    if (!lease) return;
    lease.consumers.delete(consumerId);
    this.event(lease, "released", "consumer_closed");
    this.maybeClose(lease, "last_consumer");
  }
  private maybeClose(lease: Lease, reason: string): void {
    if (!lease.reservations.size && !lease.consumers.size)
      void this.closeLease(lease, reason, true);
  }
  private event(
    lease: Lease,
    event: "created" | "attached" | "released" | "closed",
    reason: string,
  ): void {
    try {
      this.options.onLifecycle?.({ leaseId: lease.id, event, reason });
    } catch {
      /* Diagnostics never change preview authority. */
    }
  }
  async closeForWorkspace(workspaceId: string): Promise<void> {
    this.epochs.set(workspaceId, (this.epochs.get(workspaceId) ?? 0) + 1);
    await Promise.all(
      [...this.leases.values()]
        .filter((lease) => lease.workspaceId === workspaceId)
        .map((lease) => this.closeLease(lease, "workspace_closed", false)),
    );
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.leases.values()].map((lease) => this.closeLease(lease, "shutdown", false)),
    );
    await Promise.allSettled([...this.opening.values(), ...this.closing]);
  }

  private assertOpening(workspaceId: string, epoch: number): void {
    if (this.stopped || epoch !== (this.epochs.get(workspaceId) ?? 0))
      throw new Error("The workspace browser preview was closed.");
  }
  private async resolveRoot(workspaceId: string): Promise<RootIdentity> {
    const workspace = await this.options.getWorkspace(workspaceId);
    if (
      !workspace ||
      workspace.id !== workspaceId ||
      !workspace.folderPath ||
      workspace.permission === "none"
    )
      throw new FilePreviewError(403, "Workspace file access is no longer available.");
    const configuredPath = path.resolve(workspace.folderPath);
    const canonicalPath = await fs.realpath(configuredPath);
    const stat = await fs.stat(canonicalPath);
    if (!stat.isDirectory())
      throw new FilePreviewError(403, "The workspace folder is unavailable.");
    return { configuredPath, canonicalPath, device: stat.dev, inode: stat.ino };
  }
  private async validateLease(lease: Lease): Promise<void> {
    if (lease.revoked || this.stopped)
      throw new FilePreviewError(403, "This browser preview was closed.");
    let current: RootIdentity;
    try {
      current = await this.resolveRoot(lease.workspaceId);
    } catch (error) {
      lease.revoked = true;
      throw error;
    }
    if (
      current.configuredPath !== lease.workspaceRoot.configuredPath ||
      current.canonicalPath !== lease.workspaceRoot.canonicalPath ||
      !identityMatches(lease.workspaceRoot, { dev: current.device, ino: current.inode })
    ) {
      lease.revoked = true;
      throw new FilePreviewError(403, "The workspace folder changed. Open the file again.");
    }
    if (lease.revoked || this.stopped)
      throw new FilePreviewError(403, "This browser preview was closed.");
  }
  private async inspectFile(root: RootIdentity, relative: string) {
    safeSegments(relative.split(path.sep));
    const mime = MIME_TYPES[path.extname(relative).toLowerCase()];
    if (!mime)
      throw new FilePreviewError(404, "This asset type is not available for browser preview.");
    const canonical = await fs.realpath(path.join(root.canonicalPath, relative));
    confinedRelative(root.canonicalPath, canonical);
    // Do not let a safe public extension disguise a symlink to a secret or
    // unsupported file, even when the canonical target remains in the root.
    if (!MIME_TYPES[path.extname(canonical).toLowerCase()])
      throw new FilePreviewError(404, "This asset type is not available for browser preview.");
    const stat = await fs.stat(canonical);
    if (!stat.isFile())
      throw new FilePreviewError(404, "Choose a regular file for browser preview.");
    if (stat.size > MAX_ASSET_BYTES)
      throw new FilePreviewError(413, "This browser preview asset exceeds 32 MB.");
    return { canonical, stat, mime };
  }
  private async inspectLeaseFile(lease: Lease, relative: string) {
    const grant = lease.files.get(relative);
    if (!grant)
      throw new FilePreviewError(404, "This asset was not included in the approved file grant.");
    const expected = await this.inspectFile(lease.root, relative);
    if (
      expected.canonical !== grant.canonical ||
      expected.stat.dev !== grant.device ||
      expected.stat.ino !== grant.inode ||
      (await fs.realpath(grant.configured)) !== grant.canonical
    )
      throw new FilePreviewError(409, "The approved file identity changed. Open the file again.");
    return expected;
  }
  private async createLease(workspaceId: string, details: PreparedDetails): Promise<Lease> {
    const lease = {
      id: randomBytes(12).toString("hex"),
      key: details.key,
      workspaceId,
      root: details.root,
      workspaceRoot: details.workspaceRoot,
      files: details.files,
      origin: "",
      host: "",
      token: randomBytes(32).toString("base64url"),
      revoked: false,
      retiring: false,
      reads: 0,
      reservations: new Set<object>(),
      consumers: new Set<string>(),
    } as Lease;
    lease.server = createServer((request, response) => {
      void this.serve(lease, request, response);
    });
    lease.server.requestTimeout = 15_000;
    lease.server.headersTimeout = 10_000;
    lease.server.keepAliveTimeout = 1000;
    lease.server.maxRequestsPerSocket = 100;
    await new Promise<void>((resolve, reject) => {
      lease.server.once("error", reject);
      lease.server.listen(0, "127.0.0.1", () => {
        lease.server.off("error", reject);
        resolve();
      });
    });
    const address = lease.server.address() as AddressInfo;
    lease.host = `127.0.0.1:${address.port}`;
    lease.origin = `http://${lease.host}`;
    this.event(lease, "created", "exact_grant");
    return lease;
  }
  private closeLease(lease: Lease, reason: string, drain: boolean): Promise<void> {
    if (!drain) lease.revoked = true;
    if (lease.closing) {
      if (!drain) lease.server.closeAllConnections();
      return lease.closing;
    }
    lease.retiring = true;
    if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
    for (const id of lease.consumers)
      if (this.consumers.get(id) === lease) this.consumers.delete(id);
    lease.consumers.clear();
    this.retiredOrigins.add(lease.origin);
    this.retiredTokens.set(lease.token, Date.now() + 10 * 60_000);
    if (this.retiredTokens.size > 64)
      this.retiredTokens.delete(this.retiredTokens.keys().next().value!);
    if (this.retiredOrigins.size > 256)
      this.retiredOrigins.delete(this.retiredOrigins.values().next().value!);
    const operation = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lease.revoked = true;
        this.event(lease, "closed", reason);
        resolve();
      };
      const timer = setTimeout(
        () => {
          lease.server.closeAllConnections();
          finish();
        },
        drain ? 5000 : 100,
      );
      if (!lease.server.listening) {
        finish();
        return;
      }
      lease.server.close(finish);
      if (!drain) lease.server.closeAllConnections();
    });
    lease.closing = operation;
    this.closing.add(operation);
    void operation.finally(() => this.closing.delete(operation));
    return operation;
  }
  private async serve(
    lease: Lease,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let reading = false;
    try {
      if (lease.retiring) throw new FilePreviewError(403, "This browser preview was closed.");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        throw new FilePreviewError(405, "Only read requests are available.");
      }
      const hosts = request.rawHeaders.filter(
        (_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === "host",
      );
      if (
        hosts.length !== 1 ||
        request.headers.host !== lease.host ||
        request.socket.remoteAddress !== "127.0.0.1"
      )
        throw new FilePreviewError(403, "Invalid preview host.");
      const parsed = new URL(request.url ?? "", lease.origin);
      const tokens = parsed.searchParams.getAll(CAPABILITY_QUERY);
      const tokenAccess = tokens.length === 1 && equalSecret(tokens[0], lease.token);
      const authorization = request.headers[BROWSER_PREVIEW_AUTH_HEADER.toLowerCase()];
      const headerAccess = typeof authorization === "string" && equalSecret(authorization, lease.token);
      if (
        (tokens.length > 0 && !tokenAccess) ||
        (!tokenAccess && !headerAccess)
      )
        throw new FilePreviewError(403, "This browser preview requires its private access URL.");
      if (request.headers.origin && request.headers.origin !== lease.origin)
        throw new FilePreviewError(403, "Cross-origin preview requests are unavailable.");
      const fetchSite = request.headers["sec-fetch-site"];
      if (!tokenAccess && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
        throw new FilePreviewError(403, "Cross-origin preview requests are unavailable.");
      const relative = requestSegments(request).join(path.sep);
      if (this.activeReads >= MAX_CONCURRENT_READS)
        throw new FilePreviewError(503, "This browser preview is busy. Try again.");
      lease.reads += 1;
      this.activeReads += 1;
      reading = true;
      await this.validateLease(lease);
      const expected = await this.inspectLeaseFile(lease, relative);
      const file = await fs.open(expected.canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.dev !== expected.stat.dev ||
          before.ino !== expected.stat.ino ||
          before.size !== expected.stat.size ||
          before.mtimeMs !== expected.stat.mtimeMs
        )
          throw new FilePreviewError(409, "The preview file changed. Reload it.");
        await this.options.beforeRead?.();
        await this.validateLease(lease);
        const current = await this.inspectLeaseFile(lease, relative);
        if (
          current.canonical !== expected.canonical ||
          current.stat.dev !== before.dev ||
          current.stat.ino !== before.ino
        )
          throw new FilePreviewError(409, "The preview file changed. Reload it.");
        let range: ReturnType<typeof byteRange>;
        try {
          range = byteRange(request.headers.range, before.size);
        } catch (error) {
          response.setHeader("Content-Range", `bytes */${before.size}`);
          throw error;
        }
        const length = Math.max(0, range.end - range.start + 1);
        const content = request.method === "HEAD" ? undefined : Buffer.alloc(length);
        if (content) {
          let offset = 0;
          while (offset < content.length) {
            if (request.destroyed || lease.revoked || this.stopped)
              throw new FilePreviewError(403, "This browser preview was closed.");
            const { bytesRead } = await file.read(
              content,
              offset,
              content.length - offset,
              range.start + offset,
            );
            if (!bytesRead) throw new FilePreviewError(409, "The preview file changed. Reload it.");
            offset += bytesRead;
          }
        }
        const after = await file.stat();
        await this.validateLease(lease);
        const final = await this.inspectLeaseFile(lease, relative);
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          final.canonical !== expected.canonical ||
          final.stat.dev !== before.dev ||
          final.stat.ino !== before.ino
        )
          throw new FilePreviewError(409, "The preview file changed. Reload it.");
        response.setHeader("Content-Type", expected.mime);
        response.setHeader("Content-Length", length);
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        if (range.partial)
          response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${before.size}`);
        response.writeHead(range.partial ? 206 : 200);
        response.end(content);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (response.destroyed) return;
      const status = error instanceof FilePreviewError ? error.status : 404;
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(
        request.method === "HEAD"
          ? undefined
          : error instanceof FilePreviewError
            ? error.message
            : "This preview file is unavailable.",
      );
    } finally {
      if (reading) {
        lease.reads -= 1;
        this.activeReads -= 1;
      }
      if (lease.revoked && !lease.closing) void this.closeLease(lease, "authority_revoked", true);
    }
  }
}

export const browserFileService = new BrowserFileService({
  getWorkspace: async (workspaceId) =>
    (await import("../config-store.js")).configStore.getWorkspace(workspaceId),
  onLifecycle: (event) => {
    void import("../dev-log.js")
      .then(({ writeDevLog }) => writeDevLog("info", "browser-preview", [event]))
      .catch(() => {});
  },
});
