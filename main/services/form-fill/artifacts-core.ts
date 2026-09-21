import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  FORM_FILL_ARTIFACT_FILES,
  FORM_FILL_MAX_FILE_BYTES,
  FORM_FILL_MAX_FILE_COUNT,
  FORM_FILL_MAX_TOTAL_BYTES,
  FORM_FILL_MODEL_PACKAGE_DIR,
  formFillArtifactUrl,
  isAllowedArtifactPath,
  type FormFillArtifactFile,
} from "./manifest.js";

export type FormFillArtifactState =
  | "not-downloaded"
  | "downloading"
  | "preparing"
  | "ready"
  | "update-required"
  | "error"
  | "unsupported";

export interface FormFillArtifactStatus {
  state: FormFillArtifactState;
  /** 0–1 download progress while downloading. */
  progress: number;
  /** Downloaded bytes while downloading (0 elsewhere). */
  downloadedBytes: number;
  /** Expected total bytes for the pinned manifest. */
  totalBytes: number;
  /** Detail for state === "error". Never contains document or model content. */
  error?: string;
}

const TOTAL_BYTES = FORM_FILL_ARTIFACT_FILES.reduce((sum, file) => sum + file.bytes, 0);

export function isFormFillSupported(
  options: {
    platform?: string;
    arch?: string;
    osRelease?: string;
  } = {},
): { supported: boolean; reason?: string } {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    return { supported: false, reason: "Form fill needs a Mac with Apple silicon." };
  }
  // macOS 14.4 is Darwin 23.4.0.
  const release = options.osRelease ?? process.getSystemVersion?.() ?? "";
  const match = release.match(/^(\d+)\.(\d+)/u);
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 23 || (major === 23 && minor < 4)) {
      return { supported: false, reason: "Form fill needs macOS 14.4 or later." };
    }
  }
  return { supported: true };
}

/** Absolute path the helper loads: the published .mlpackage inside root. */
export function formFillPackagePath(root: string): string {
  return path.join(root, FORM_FILL_MODEL_PACKAGE_DIR);
}

/**
 * Verify a staged package against the pinned manifest. Returns a failure
 * reason, or null when every expected file exists, is a regular file, and
 * hashes to its pinned SHA-256. `files` is injectable for tests.
 */
export async function verifyFormFillPackage(
  root: string,
  files: readonly FormFillArtifactFile[] = FORM_FILL_ARTIFACT_FILES,
): Promise<string | null> {
  const rootResolved = path.resolve(root);
  const relativePaths: string[] = [];
  let entryCount = 0;
  try {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        entryCount += 1;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          relativePaths.push(`symlink:${path.relative(rootResolved, full)}`);
        } else if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          relativePaths.push(path.relative(rootResolved, full));
        } else {
          relativePaths.push(`special:${path.relative(rootResolved, full)}`);
        }
      }
    };
    walk(rootResolved);
  } catch {
    return "The model directory is unreadable.";
  }
  if (entryCount > FORM_FILL_MAX_FILE_COUNT) {
    return "The model contains too many files.";
  }
  for (const relative of relativePaths) {
    if (relative.startsWith("symlink:")) {
      return "The model package must not contain links.";
    }
    if (relative.startsWith("special:")) {
      return "The model package contains an unexpected entry.";
    }
    if (!isAllowedArtifactPath(relative, files)) {
      return "The model package contains an unexpected file.";
    }
  }
  for (const file of files) {
    const full = path.join(rootResolved, file.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return `The model file ${file.path} is missing.`;
    }
    if (!stat.isFile()) return `The model file ${file.path} is not a regular file.`;
    if (stat.size !== file.bytes) {
      return `The model file ${file.path} has an unexpected size.`;
    }
    const hash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    if (hash !== file.sha256) {
      return `The model file ${file.path} failed its checksum.`;
    }
  }
  return null;
}

interface DownloadProgressSink {
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}

async function downloadToFile(
  url: string,
  destination: string,
  maxBytes: number,
  sink: DownloadProgressSink,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { "User-Agent": "aiden-form-fill/1" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status}).`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const writer = fs.createWriteStream(destination, { flags: "wx" });
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new Error("The download exceeded its size limit.");
      }
      if (!writer.write(value)) {
        await new Promise<void>((resolve, reject) => {
          writer.once("drain", resolve);
          writer.once("error", reject);
        });
      }
      sink.onProgress?.(received, TOTAL_BYTES);
    }
  } finally {
    writer.destroy();
  }
  await fsp.stat(destination);
}

export class FormFillArtifactStore {
  private statusValue: FormFillArtifactStatus = {
    state: "not-downloaded",
    progress: 0,
    downloadedBytes: 0,
    totalBytes: TOTAL_BYTES,
  };
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      /** Directory that holds published + staging trees. Required. */
      rootDir: string;
      onStatusChanged?: (status: FormFillArtifactStatus) => void;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  get rootDir(): string {
    return this.deps.rootDir;
  }

  status(): FormFillArtifactStatus {
    return { ...this.statusValue };
  }

  private setStatus(status: FormFillArtifactStatus): void {
    this.statusValue = status;
    this.deps.onStatusChanged?.({ ...status });
  }

  /** Refresh status without touching the network. */
  async refresh(): Promise<FormFillArtifactStatus> {
    const support = isFormFillSupported();
    if (!support.supported) {
      this.setStatus({
        state: "unsupported",
        progress: 0,
        downloadedBytes: 0,
        totalBytes: TOTAL_BYTES,
        error: support.reason,
      });
      return this.status();
    }
    if (this.inFlight) return this.status();
    const root = this.rootDir;
    const failure = await verifyFormFillPackage(root);
    this.setStatus({
      state: failure ? "not-downloaded" : "ready",
      progress: failure ? 0 : 1,
      downloadedBytes: failure ? 0 : TOTAL_BYTES,
      totalBytes: TOTAL_BYTES,
      error: undefined,
    });
    return this.status();
  }

  /**
   * Download the pinned package into a staging tree, verify every file's size
   * and SHA-256, then atomically swap it into place. Never mutates a working
   * install when any part fails.
   */
  async download(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const support = isFormFillSupported();
    if (!support.supported) {
      this.setStatus({ ...this.statusValue, state: "unsupported", error: support.reason });
      throw new Error(support.reason);
    }
    this.abort = new AbortController();
    const now = this.deps.now ?? Date.now;
    const staging = `${this.rootDir}.staging-${now()}`;
    this.setStatus({
      state: "downloading",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: TOTAL_BYTES,
    });
    this.inFlight = this.doDownload(staging, now)
      .catch((error: unknown) => {
        const message =
          this.abort?.signal.aborted || (error as Error)?.name === "AbortError"
            ? "Download cancelled."
            : `Model download failed: ${(error as Error)?.message ?? "unknown error"}`;
        const cancelled = message === "Download cancelled.";
        this.setStatus({
          state: cancelled ? "not-downloaded" : "error",
          progress: 0,
          downloadedBytes: 0,
          totalBytes: TOTAL_BYTES,
          error: cancelled ? undefined : message,
        });
        if (cancelled) return;
        throw error;
      })
      .finally(async () => {
        await fsp.rm(staging, { recursive: true, force: true });
        this.abort = null;
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async doDownload(staging: string, now: () => number): Promise<void> {
    if (TOTAL_BYTES > FORM_FILL_MAX_TOTAL_BYTES) {
      throw new Error("The pinned model manifest exceeds the download byte limit.");
    }
    let downloaded = 0;
    for (const file of FORM_FILL_ARTIFACT_FILES) {
      const destination = path.join(staging, file.path);
      await downloadToFile(
        formFillArtifactUrl(file.path),
        destination,
        Math.min(file.bytes, FORM_FILL_MAX_FILE_BYTES) + 1,
        {
          onProgress: (fileBytes) => {
            this.setStatus({
              state: "downloading",
              progress: Math.min(1, (downloaded + fileBytes) / TOTAL_BYTES),
              downloadedBytes: downloaded + fileBytes,
              totalBytes: TOTAL_BYTES,
            });
          },
        },
        this.abort!.signal,
      );
      downloaded += file.bytes;
      if (downloaded > FORM_FILL_MAX_TOTAL_BYTES) {
        throw new Error("The model download exceeded the byte limit.");
      }
    }
    this.setStatus({ ...this.statusValue, state: "preparing", progress: 1 });
    const failure = await verifyFormFillPackage(staging);
    if (failure) {
      throw new Error(`Downloaded model is invalid: ${failure}`);
    }
    // Atomic publish: remove the old tree only after staging verifies.
    const backup = `${this.rootDir}.previous-${now()}`;
    let movedOld = false;
    if (fs.existsSync(this.rootDir)) {
      await fsp.rename(this.rootDir, backup);
      movedOld = true;
    }
    try {
      await fsp.rename(staging, this.rootDir);
    } catch (error) {
      if (movedOld) await fsp.rename(backup, this.rootDir).catch(() => {});
      throw error;
    }
    if (movedOld) await fsp.rm(backup, { recursive: true, force: true });
    this.setStatus({
      state: "ready",
      progress: 1,
      downloadedBytes: TOTAL_BYTES,
      totalBytes: TOTAL_BYTES,
    });
  }

  cancel(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  async remove(): Promise<void> {
    this.cancel();
    await fsp.rm(this.rootDir, { recursive: true, force: true });
    this.setStatus({
      state: "not-downloaded",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: TOTAL_BYTES,
    });
  }
}
