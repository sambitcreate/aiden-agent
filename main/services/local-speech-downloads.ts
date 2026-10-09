// On-device speech model storage and a verified, resumable downloader.
//
// Layout under the injected root:
//   .partial/<id>.tar.bz2.part   bytes received so far (kept across cancel/relaunch)
//   <id>.extracting/             staging directory for extraction
//   <id>/                        the installed model (only the files the spec names)
//
// Every archive is pinned by exact byte size and SHA-256 in the catalog. Nothing
// here touches the network except an explicit downloadModel() call.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import {
  SPEECH_MODELS,
  formatSizeLabel,
  languagesLabel,
  type SpeechModelSpec,
} from "./local-speech-catalog.js";

const execFileAsync = promisify(execFile);

export interface LocalModel {
  id: string;
  name: string;
  description: string;
  sizeLabel: string;
  quant: string;
  languagesLabel: string;
  accuracy: number;
  speed: number;
  recommended: boolean;
  installed: boolean;
  languages: string[];
  capabilities: SpeechModelSpec["capabilities"];
  license: SpeechModelSpec["license"];
}

export interface LocalModelDownloadState {
  id: string;
  percentage: number;
  phase: "download" | "verify" | "extract";
  status: "downloading" | "failed";
  error?: string;
}

export interface SpeechModelManagerDependencies {
  root(): string;
  /** Tests inject tiny fixtures; defaults to the pinned catalog. */
  catalog?: readonly SpeechModelSpec[];
  fetchImpl?: typeof fetch;
  /** Abort when no bytes arrive for this long. Default 60 s. */
  stallMs?: number;
  /** Abort when response headers do not arrive within this long. Default 15 s. */
  connectMs?: number;
  progress?(value: {
    id: string;
    downloaded: number;
    total: number;
    percentage: number;
    phase: LocalModelDownloadState["phase"];
  }): void;
  info?(message: string): void;
}

const PARTIAL_DIR = ".partial";
const PARTIAL_SUFFIX = ".tar.bz2.part";
const EXTRACTING_SUFFIX = ".extracting";
const LEGACY_STAGING = /^\..+\.staging-\d+$/;

const CANCELLED = "Download cancelled.";
const STALLED = "The download stalled. Press Download to resume.";
const CONNECT_TIMEOUT = "Could not reach the download server. Press Download to try again.";
const WRONG_RANGE = "The download server returned an unexpected range. Press Download to restart.";
const OVERSIZE = "The download is larger than expected and was corrupted. Try again.";
const CORRUPTED = "The download was corrupted. Try again.";
const INTERRUPTED = "The download was interrupted. Press Download to resume.";
/** User-facing copy for a local write failure; only a full disk or quota asks for space. */
export function diskFailureMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
  const advice =
    code === "ENOSPC" || code === "EDQUOT"
      ? "Free up space and try again."
      : "Check that Aiden can write to its data folder and try again.";
  return `Aiden couldn't write the voice model to disk: ${code}. ${advice}`;
}

/** Tags an error raised by the network (fetch or body reader) rather than by Aiden. */
class NetworkFailure extends Error {
  constructor(readonly original: unknown) {
    super(String(original));
  }
}
/** Tags an error raised by the partial file's write stream. */
class DiskFailure extends Error {
  constructor(readonly original: unknown) {
    super(diskFailureMessage(original));
  }
}

function tarBinary(): string {
  return fs.existsSync("/usr/bin/tar") ? "/usr/bin/tar" : "tar";
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Bytes already in a partial download. A non-regular entry at the partial path
 * (a directory, say) is a local write problem, not download bytes. It is
 * reported as a disk failure before any size is read, and it is never removed
 * here, so a resume cannot try to delete it non-recursively.
 */
export async function partialDownloadBytes(file: string): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(file);
  } catch {
    return 0;
  }
  if (!stat.isFile()) {
    const code = stat.isDirectory() ? "EISDIR" : "EEXIST";
    throw new DiskFailure(Object.assign(new Error(`${file} is not a regular file`), { code }));
  }
  return stat.size;
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Remove every file not named by the spec, then any directories left empty. */
async function pruneToSpec(dir: string, keep: ReadonlySet<string>): Promise<void> {
  async function walk(current: string): Promise<boolean> {
    let empty = true;
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (await walk(full)) await fs.promises.rmdir(full);
        else empty = false;
      } else if (entry.isFile() && keep.has(relative)) {
        empty = false;
      } else {
        await fs.promises.rm(full, { force: true });
      }
    }
    return empty;
  }
  await walk(dir);
}

async function hasRegularFiles(dir: string, files: Iterable<string>): Promise<boolean> {
  for (const file of files) {
    try {
      if (!(await fs.promises.lstat(path.join(dir, file))).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function createSpeechModelManager(deps: SpeechModelManagerDependencies) {
  const catalog = deps.catalog ?? SPEECH_MODELS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stallMs = deps.stallMs ?? 60_000;
  const connectMs = deps.connectMs ?? 15_000;

  const downloads = new Map<string, AbortController>();
  const downloadStates = new Map<string, LocalModelDownloadState>();
  const pendingDownloads = new Set<Promise<void>>();

  function specFor(id: string): SpeechModelSpec | undefined {
    return catalog.find((model) => model.id === id);
  }

  function modelsRoot(): string {
    const dir = deps.root();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  const partialPath = (id: string) => path.join(modelsRoot(), PARTIAL_DIR, `${id}${PARTIAL_SUFFIX}`);
  const stagingPath = (id: string) => path.join(modelsRoot(), `${id}${EXTRACTING_SUFFIX}`);

  /** Absolute directory for a model's installed files, or null for an unknown id. */
  function modelDir(id: string): string | null {
    return specFor(id) ? path.join(modelsRoot(), id) : null;
  }

  function isModelInstalled(id: string): boolean {
    const spec = specFor(id);
    const dir = modelDir(id);
    return Boolean(spec && dir && Object.values(spec.files).every((file) => fs.existsSync(path.join(dir, file))));
  }

  function listModels(): LocalModel[] {
    return catalog.map((spec) => ({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      sizeLabel: formatSizeLabel(spec.archive.bytes),
      quant: "int8",
      languagesLabel: languagesLabel(spec),
      accuracy: spec.accuracy,
      speed: spec.speed,
      recommended: spec.recommended,
      installed: isModelInstalled(spec.id),
      languages: [...spec.languages],
      capabilities: { ...spec.capabilities },
      license: { ...spec.license },
    }));
  }

  function localModelDownloadStates(): LocalModelDownloadState[] {
    return [...downloadStates.values()].map((state) => ({ ...state }));
  }

  async function performDownload(id: string): Promise<void> {
    const spec = specFor(id);
    if (!spec) throw new Error(`Unknown model "${id}".`);
    if (downloads.has(id)) throw new Error("This model is already downloading.");

    const controller = new AbortController();
    downloads.set(id, controller);
    downloadStates.set(id, { id, percentage: 0, phase: "download", status: "downloading" });

    const total = spec.archive.bytes;
    const part = partialPath(id);
    const staging = stagingPath(id);

    const emit = (phase: LocalModelDownloadState["phase"], downloaded: number, of: number) => {
      const percentage =
        phase === "download"
          ? Math.min(90, Math.round((downloaded / Math.max(of, 1)) * 90))
          : phase === "verify"
            ? 90
            : 90 + Math.round((downloaded / Math.max(of, 1)) * 10);
      downloadStates.set(id, { id, percentage, phase, status: "downloading" });
      deps.progress?.({ id, downloaded, total: of, percentage, phase });
    };

    try {
      await fs.promises.mkdir(path.dirname(part), { recursive: true, mode: 0o700 });
      let have = await partialDownloadBytes(part);
      if (have > total) {
        await fs.promises.rm(part, { force: true });
        have = 0;
      }
      if (have < total) await fetchInto(spec, part, have, controller, emit);

      // Verify the whole partial in one pass, which covers resumed bytes too.
      emit("verify", total, total);
      const digest = await sha256File(part, controller.signal);
      if (digest !== spec.archive.sha256) {
        await fs.promises.rm(part, { force: true });
        throw new Error(CORRUPTED);
      }

      emit("extract", 0, 1);
      await fs.promises.rm(staging, { recursive: true, force: true });
      await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
      await execFileAsync(tarBinary(), ["-xjf", part, "-C", staging, "--strip-components=1"], {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300_000,
        signal: controller.signal,
      });
      const required = Object.values(spec.files);
      await pruneToSpec(staging, new Set(required));
      if (!(await hasRegularFiles(staging, required))) {
        throw new Error("The downloaded model is missing expected files.");
      }
      const dir = path.join(modelsRoot(), id);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.rename(staging, dir);
      await fs.promises.rm(part, { force: true });
      emit("extract", 1, 1);
      downloadStates.delete(id);
      deps.info?.(`Installed speech model "${id}"`);
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (controller.signal.reason === CANCELLED) {
        downloadStates.delete(id);
        throw new Error(CANCELLED);
      }
      const resolved = error instanceof Error ? error : new Error(String(error));
      const previous = downloadStates.get(id);
      downloadStates.set(id, {
        id,
        percentage: previous?.percentage ?? 0,
        phase: previous?.phase ?? "download",
        status: "failed",
        error: resolved.message,
      });
      throw resolved;
    } finally {
      downloads.delete(id);
    }
  }

  /** Append the archive's remaining bytes to `part`, resuming from `have`. */
  async function fetchInto(
    spec: SpeechModelSpec,
    part: string,
    have: number,
    controller: AbortController,
    emit: (phase: "download", downloaded: number, of: number) => void,
  ): Promise<void> {
    const total = spec.archive.bytes;
    let reason: "connect" | "stall" | "oversize" | undefined;
    const abortFor = (why: "connect" | "stall" | "oversize") => {
      reason ??= why;
      controller.abort(why);
    };
    const failure = (error: unknown): Error => {
      if (controller.signal.reason === CANCELLED) return new Error(CANCELLED);
      if (reason === "connect") return new Error(CONNECT_TIMEOUT);
      if (reason === "stall") return new Error(STALLED);
      if (reason === "oversize") return new Error(OVERSIZE);
      if (error instanceof DiskFailure) {
        deps.info?.(`Speech model download for "${spec.id}" could not write: ${String(error.original)}`);
        return new Error(error.message);
      }
      if (error instanceof NetworkFailure) {
        // Network-level failures (reset, DNS, "terminated") keep the partial for resume.
        deps.info?.(`Speech model download for "${spec.id}" interrupted: ${error.message}`);
        return new Error(INTERRUPTED);
      }
      return error instanceof Error ? error : new Error(String(error));
    };

    const connectTimer = setTimeout(() => abortFor("connect"), connectMs);
    let res: Response;
    try {
      res = await fetchImpl(spec.archive.url, {
        signal: controller.signal,
        redirect: "follow",
        headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
      });
    } catch (error) {
      throw failure(new NetworkFailure(error));
    } finally {
      clearTimeout(connectTimer);
    }

    let start = 0;
    if (res.status === 206) {
      const match = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
      if (!match || Number(match[1]) !== have) {
        await res.body?.cancel().catch(() => {});
        await fs.promises.rm(part, { force: true });
        throw new Error(WRONG_RANGE);
      }
      start = have;
    } else if (res.status === 416) {
      await res.body?.cancel().catch(() => {});
      return; // Verification decides whether the partial is complete and valid.
    } else if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Download failed: ${res.status}`);
    }
    // A 200 to a Range request restarts from zero.
    if (!res.body) throw new Error(`Download failed: ${res.status}`);

    const file = fs.createWriteStream(part, { flags: start > 0 ? "a" : "w", mode: 0o600 });
    const fileError = new Promise<never>((_, reject) => file.once("error", (error) => reject(new DiskFailure(error))));
    fileError.catch(() => {});
    const reader = res.body.getReader();
    let downloaded = start;
    let lastEmit = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abortFor("stall"), stallMs);
    };
    emit("download", downloaded, total);
    try {
      armStall();
      for (;;) {
        const read = reader.read().catch((error: unknown) => {
          throw new NetworkFailure(error);
        });
        const { done, value } = await Promise.race([read, fileError]);
        if (done) break;
        armStall();
        const chunk = Buffer.from(value);
        if (downloaded + chunk.length > total) {
          abortFor("oversize");
          throw new Error(OVERSIZE);
        }
        if (!file.write(chunk)) {
          await Promise.race([new Promise<void>((resolve) => file.once("drain", resolve)), fileError]);
        }
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          emit("download", downloaded, total);
        }
      }
      clearTimeout(stallTimer);
      file.end();
      await Promise.race([finished(file), fileError]);
      emit("download", downloaded, total);
      if (downloaded < total) {
        // The server ended cleanly but early. Keep the partial so the next run resumes.
        deps.info?.(`Speech model download for "${spec.id}" ended early at ${downloaded} of ${total} bytes`);
        throw new Error(INTERRUPTED);
      }
    } catch (error) {
      throw failure(error);
    } finally {
      clearTimeout(stallTimer);
      await reader.cancel().catch(() => {});
      if (!file.closed) {
        file.end();
        await finished(file).catch(() => {});
      }
      if (reason === "oversize") await fs.promises.rm(part, { force: true });
    }
  }

  function downloadModel(id: string): Promise<void> {
    const operation = performDownload(id);
    pendingDownloads.add(operation);
    void operation.then(
      () => pendingDownloads.delete(operation),
      () => pendingDownloads.delete(operation),
    );
    return operation;
  }

  /** Abort an active download. The partial file is kept so the next Download resumes. */
  function cancelDownload(id: string): boolean {
    const controller = downloads.get(id);
    if (!controller) return false;
    controller.abort(CANCELLED);
    downloadStates.delete(id);
    return true;
  }

  async function stopDownloads(): Promise<void> {
    for (const id of downloads.keys()) cancelDownload(id);
    await Promise.allSettled(pendingDownloads);
  }

  async function deleteModel(id: string): Promise<void> {
    const dir = modelDir(id);
    if (!dir) throw new Error(`Unknown model "${id}".`);
    if (downloads.has(id)) throw new Error("Cancel the model download before deleting it.");
    downloadStates.delete(id);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rm(partialPath(id), { force: true });
  }

  /**
   * Remove staging leftovers and partials that can no longer resume: every
   * `<id>.extracting/` without an active download, legacy `.<id>.staging-*`
   * directories, and `.partial/*.part` files for unknown ids or that exceed the
   * pinned size. Partials for catalog models are kept so a relaunch resumes.
   */
  async function cleanupLeftovers(): Promise<void> {
    const root = modelsRoot();
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const extractingId = entry.name.endsWith(EXTRACTING_SUFFIX) ? entry.name.slice(0, -EXTRACTING_SUFFIX.length) : null;
      if ((extractingId !== null && !downloads.has(extractingId)) || LEGACY_STAGING.test(entry.name)) {
        await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
    const partialDir = path.join(root, PARTIAL_DIR);
    let partials: fs.Dirent[] = [];
    try {
      partials = await fs.promises.readdir(partialDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of partials) {
      const id = entry.name.endsWith(PARTIAL_SUFFIX) ? entry.name.slice(0, -PARTIAL_SUFFIX.length) : null;
      if (id !== null && downloads.has(id)) continue;
      const spec = id === null ? undefined : specFor(id);
      const full = path.join(partialDir, entry.name);
      const stale = !spec || !entry.isFile() || (await fileSize(full)) > spec.archive.bytes;
      if (stale) await fs.promises.rm(full, { recursive: true, force: true });
    }
  }

  return {
    modelDir,
    isModelInstalled,
    listModels,
    localModelDownloadStates,
    downloadModel,
    cancelDownload,
    deleteModel,
    stopDownloads,
    cleanupLeftovers,
    specFor,
  };
}
