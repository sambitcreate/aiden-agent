/**
 * Consent-gated installer for a pinned ACP agent release.
 *
 * Install properties follow T3 Code
 * apps/server/src/provider/AntigravityInstallation.ts @ f870c419fc (MIT):
 * a free-space check, a streaming download capped at the pinned size with an
 * incremental SHA-256, extraction of exactly the pinned members at their exact
 * sizes, a live identity check of the extracted binary, and an atomic switch
 * of the active pointer. Running processes hold leases, so the active runtime
 * is never removed under them. Nothing here runs unless the user starts it.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

import { AcpHarnessError, abortError, errorMessage } from "./errors.js";
import type { AcpPlatformAsset, AcpPlatformKey, AcpRelease } from "./harness.js";

const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const COMPLETE_MARKER = ".install-complete.json";

export type AcpInstallPhase = "downloading" | "verifying" | "extracting" | "validating" | "activating";

export interface AcpInstallProgress {
  phase: AcpInstallPhase;
  receivedBytes?: number;
  totalBytes?: number;
}

export type AcpRuntimeState =
  | { status: "unsupported"; reason: string }
  | { status: "not_installed"; version: string; downloadBytes: number; requiredBytes: number }
  | { status: "installing"; version: string; progress: AcpInstallProgress }
  | { status: "installed"; version: string; runtimeDir: string }
  | { status: "update_available"; installedVersion: string; version: string; downloadBytes: number; requiredBytes: number }
  | { status: "failed"; version: string; message: string; downloadBytes: number; requiredBytes: number };

export interface AcpRuntimeLease {
  runtimeDir: string;
  asset: AcpPlatformAsset;
  version: string;
  release(): void;
}

export interface AcpInstallerDependencies {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  freeBytes(directory: string): Promise<number>;
  /** Start the extracted binary and confirm its identity; throw to refuse activation. */
  validate(runtimeDir: string, asset: AcpPlatformAsset, signal: AbortSignal): Promise<void>;
  /** Best-effort platform cleanup after extraction (for example, quarantine attributes). */
  afterExtract?(runtimeDir: string): Promise<void>;
}

interface ActivePointer {
  version: string;
  sha256: string;
}

export function requiredInstallBytes(asset: AcpPlatformAsset): number {
  return asset.archiveBytes + asset.members.reduce((total, member) => total + member.bytes, 0) + FREE_SPACE_MARGIN;
}

export class AcpRuntimeInstaller {
  private readonly asset: AcpPlatformAsset | undefined;
  private installing: { controller: AbortController; promise: Promise<void>; progress: AcpInstallProgress } | undefined;
  private failure: string | undefined;
  private active: ActivePointer | undefined;
  private leases = 0;
  private removing = false;
  private readonly listeners = new Set<(state: AcpRuntimeState) => void>();

  constructor(
    private readonly release: AcpRelease,
    private readonly platform: AcpPlatformKey | undefined,
    private readonly baseDir: string,
    private readonly dependencies: AcpInstallerDependencies,
  ) {
    this.asset = platform ? release.platforms[platform] : undefined;
  }

  /** Host the pinned archive downloads from, disclosed before Install. */
  get downloadHost(): string | undefined {
    if (!this.asset) return undefined;
    try {
      return new URL(this.asset.url).host;
    } catch {
      return undefined;
    }
  }

  get platformDir(): string {
    return path.join(this.baseDir, this.platform ?? "unsupported");
  }

  private versionDir(sha256: string): string {
    return path.join(this.platformDir, "versions", sha256);
  }

  private pointerFile(): string {
    return path.join(this.platformDir, "active.json");
  }

  /** Load the active pointer from disk. Safe to call repeatedly. */
  async load(): Promise<AcpRuntimeState> {
    this.active = await this.readPointer();
    // Interrupted installs (a crash or quit mid-download) leave staging trees.
    if (!this.installing) {
      try {
        const entries = await readdir(this.platformDir);
        for (const entry of entries) {
          // An install may start while this sweep runs; never touch its tree.
          if (this.installing || !entry.startsWith("staging-")) continue;
          await rm(path.join(this.platformDir, entry), { recursive: true, force: true });
        }
      } catch {
        // Nothing installed yet.
      }
    }
    return this.state();
  }

  onChange(listener: (state: AcpRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): AcpRuntimeState {
    const asset = this.asset;
    if (!asset) {
      return {
        status: "unsupported",
        reason: "Google does not publish this runtime for this computer.",
      };
    }
    const sizes = { downloadBytes: asset.archiveBytes, requiredBytes: requiredInstallBytes(asset) };
    if (this.installing) {
      return { status: "installing", version: this.release.version, progress: { ...this.installing.progress } };
    }
    if (this.active?.sha256 === asset.sha256) {
      return { status: "installed", version: this.release.version, runtimeDir: this.versionDir(asset.sha256) };
    }
    if (this.failure) return { status: "failed", version: this.release.version, message: this.failure, ...sizes };
    if (this.active) {
      return { status: "update_available", installedVersion: this.active.version, version: this.release.version, ...sizes };
    }
    return { status: "not_installed", version: this.release.version, ...sizes };
  }

  get inUse(): boolean {
    return this.leases > 0;
  }

  /** Hold the pinned runtime for one process. Throws when it is not installed. */
  acquire(): AcpRuntimeLease {
    const asset = this.asset;
    if (!asset || this.removing || this.active?.sha256 !== asset.sha256) {
      throw new AcpHarnessError(
        "install",
        this.active && !this.removing
          ? "This version of Aiden needs a newer runtime. Update it in Settings → Providers."
          : "The runtime is not installed. Install it in Settings → Providers.",
      );
    }
    this.leases += 1;
    let released = false;
    return {
      runtimeDir: this.versionDir(asset.sha256),
      asset,
      version: this.release.version,
      release: () => {
        if (released) return;
        released = true;
        this.leases -= 1;
      },
    };
  }

  /** Single-flight install of the pinned release. */
  install(): Promise<void> {
    const asset = this.asset;
    if (!asset) return Promise.reject(new AcpHarnessError("install", "This computer is not supported."));
    if (this.removing) return Promise.reject(new AcpHarnessError("install", "Wait for the removal to finish first."));
    if (this.installing) return this.installing.promise;
    if (this.active?.sha256 === asset.sha256) return Promise.resolve();
    const controller = new AbortController();
    const progress: AcpInstallProgress = { phase: "downloading", receivedBytes: 0, totalBytes: asset.archiveBytes };
    this.failure = undefined;
    const promise = this.installOnce(asset, controller.signal, progress)
      .then(() => {
        this.failure = undefined;
      })
      .catch((error: unknown) => {
        this.failure = controller.signal.aborted
          ? "Installation cancelled. Nothing was changed."
          : errorMessage(error);
        throw error;
      })
      .finally(() => {
        this.installing = undefined;
        this.emit();
      });
    this.installing = { controller, promise, progress };
    this.emit();
    return promise;
  }

  cancel(): void {
    this.installing?.controller.abort();
  }

  /** Delete every installed version. Refused while a process or install is running. */
  async remove(): Promise<void> {
    if (this.installing) throw new AcpHarnessError("install", "Wait for the installation to finish first.");
    if (this.leases > 0) {
      throw new AcpHarnessError("install", "Stop running chats that use this runtime before removing it.");
    }
    // Stop new leases before the files go away.
    this.removing = true;
    this.active = undefined;
    try {
      await rm(this.platformDir, { recursive: true, force: true });
    } finally {
      this.removing = false;
      this.failure = undefined;
      this.emit();
    }
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Listeners are UI notifications.
      }
    }
  }

  private setProgress(progress: AcpInstallProgress, patch: Partial<AcpInstallProgress>): void {
    Object.assign(progress, patch);
    this.emit();
  }

  private async installOnce(asset: AcpPlatformAsset, signal: AbortSignal, progress: AcpInstallProgress): Promise<void> {
    await mkdir(this.platformDir, { recursive: true, mode: 0o700 });
    const required = requiredInstallBytes(asset);
    const free = await this.dependencies.freeBytes(this.platformDir);
    if (free < required) {
      throw new AcpHarnessError(
        "install",
        `Installing needs about ${Math.ceil(required / 1_000_000)} MB free, but only ${Math.floor(free / 1_000_000)} MB is available.`,
      );
    }
    const staging = path.join(this.platformDir, `staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const archive = path.join(staging, "runtime.zip");
      await this.download(asset, archive, signal, progress);
      this.setProgress(progress, { phase: "extracting" });
      const extracted = path.join(staging, "extracted");
      await extractExactMembers(archive, extracted, asset, signal);
      await rm(archive, { force: true });
      for (const member of asset.members) await chmod(path.join(extracted, member.name), 0o755);
      await this.dependencies.afterExtract?.(extracted).catch(() => undefined);
      this.setProgress(progress, { phase: "validating" });
      await this.dependencies.validate(extracted, asset, signal);
      if (signal.aborted) throw abortError();
      this.setProgress(progress, { phase: "activating" });
      await writeFile(
        path.join(extracted, COMPLETE_MARKER),
        `${JSON.stringify({ version: this.release.version, sha256: asset.sha256, installedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      const destination = this.versionDir(asset.sha256);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await rm(destination, { recursive: true, force: true });
      await rename(extracted, destination);
      await this.writePointer({ version: this.release.version, sha256: asset.sha256 });
      this.active = { version: this.release.version, sha256: asset.sha256 };
      await this.pruneOtherVersions(asset.sha256);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async download(
    asset: AcpPlatformAsset,
    destination: string,
    signal: AbortSignal,
    progress: AcpInstallProgress,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.dependencies.fetch(asset.url, { signal });
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw new AcpHarnessError("install", "Could not reach Google's download server. Check your connection and try again.", {
        cause: error,
      });
    }
    if (!response.ok || !response.body) {
      throw new AcpHarnessError("install", `The download failed (HTTP ${response.status}). Try again later.`);
    }
    const hash = createHash("sha256");
    let received = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > asset.archiveBytes) {
          callback(new AcpHarnessError("install", "The download was larger than expected. Nothing was installed."));
          return;
        }
        hash.update(chunk);
        if (received - lastReport > 1_000_000 || received === asset.archiveBytes) {
          lastReport = received;
          this.setProgress(progress, { receivedBytes: received });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
        meter,
        createWriteStream(destination, { mode: 0o600 }),
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof AcpHarnessError) throw error;
      throw new AcpHarnessError("install", "The download was interrupted. Try again.", { cause: error });
    }
    this.setProgress(progress, { phase: "verifying", receivedBytes: received });
    if (received !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) {
      throw new AcpHarnessError("install", "The download failed its size or SHA-256 check. Nothing was installed.");
    }
    const info = await stat(destination);
    if (info.size !== asset.archiveBytes) {
      throw new AcpHarnessError("install", "The download failed its size check. Nothing was installed.");
    }
  }

  private async readPointer(): Promise<ActivePointer | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.pointerFile(), "utf8")) as Partial<ActivePointer>;
      if (typeof parsed.version !== "string" || typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.sha256)) {
        return undefined;
      }
      const marker = JSON.parse(await readFile(path.join(this.versionDir(parsed.sha256), COMPLETE_MARKER), "utf8")) as Partial<ActivePointer>;
      if (marker.sha256 !== parsed.sha256) return undefined;
      // An incomplete tree (deleted member) is not a usable runtime.
      const asset = Object.values(this.release.platforms).find((candidate) => candidate?.sha256 === parsed.sha256);
      if (asset) {
        for (const member of asset.members) {
          const info = await stat(path.join(this.versionDir(parsed.sha256), member.name));
          if (!info.isFile() || info.size !== member.bytes) return undefined;
        }
      }
      return { version: parsed.version, sha256: parsed.sha256 };
    } catch {
      return undefined;
    }
  }

  private async writePointer(pointer: ActivePointer): Promise<void> {
    const file = this.pointerFile();
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  private async pruneOtherVersions(keep: string): Promise<void> {
    const versions = path.join(this.platformDir, "versions");
    let entries: string[] = [];
    try {
      entries = await readdir(versions);
    } catch {
      return;
    }
    // Older versions may still back a running process only if leased; the
    // pinned version just replaced them for new launches.
    if (this.leases > 0) return;
    await Promise.all(
      entries.filter((entry) => entry !== keep).map((entry) => rm(path.join(versions, entry), { recursive: true, force: true })),
    );
  }
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open the archive."));
      else resolve(zip);
    });
  });
}

/** Extract exactly the pinned members; anything else in the archive is a refusal. */
export async function extractExactMembers(
  archive: string,
  destination: string,
  asset: AcpPlatformAsset,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const zip = await openZip(archive);
  const expected = new Map(asset.members.map((member) => [member.name, member.bytes]));
  if (zip.entryCount !== expected.size) {
    zip.close();
    throw new AcpHarnessError("install", "The archive does not contain the expected files. Nothing was installed.");
  }
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zip.close();
      reject(error instanceof AcpHarnessError ? error : new AcpHarnessError("install", "The archive could not be extracted. Nothing was installed.", { cause: error }));
    };
    const onAbort = () => fail(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    zip.on("error", fail);
    zip.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      if (seen.size !== expected.size) fail(new AcpHarnessError("install", "The archive is missing files."));
      else resolve();
    });
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const size = expected.get(name);
      const unsafe =
        name.includes("/") ||
        name.includes("\\") ||
        name.startsWith(".") ||
        size === undefined ||
        seen.has(name) ||
        entry.uncompressedSize !== size ||
        entry.isEncrypted() ||
        (entry.compressionMethod !== 0 && entry.compressionMethod !== 8);
      if (unsafe) {
        fail(new AcpHarnessError("install", "The archive contains unexpected files. Nothing was installed."));
        return;
      }
      seen.add(name);
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error);
          return;
        }
        pipeline(stream, createWriteStream(path.join(destination, name), { mode: 0o700 }), { signal })
          .then(async () => {
            const info = await stat(path.join(destination, name));
            if (info.size !== size) throw new AcpHarnessError("install", "An extracted file has the wrong size.");
            zip.readEntry();
          })
          .catch(fail);
      });
    });
    zip.readEntry();
  });
}
