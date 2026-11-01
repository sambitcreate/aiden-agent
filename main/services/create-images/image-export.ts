// Aiden's auto-saved copies of Create Images output, in a folder people can see:
// `<Pictures>/Aiden/Create Images/<YYYY-MM-DD>/<HHMMSS> <workflow title> <sha8>.<ext>`.
// Electron-free: the root folder, file system and clock are injected, so tests
// never touch the real Pictures folder. File names never contain prompt text.
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import type { ImageMediaType, OutputRef } from "../../../renderer/shared/images/run-types.js";
import { MAX_FILE_STEM_BYTES, safeFileNameStem, truncateFileNameText } from "../chat-image-actions.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { ImageRunLedgerError, type ImageRunLedger } from "./run-ledger.js";

/** Where auto-saved images go below the platform's Pictures folder. */
export const SAVE_FOLDER_SEGMENTS = ["Aiden", "Create Images"] as const;
/** The folder as people see it; no absolute path ever crosses IPC. */
export const SAVE_FOLDER_LABEL = ["Pictures", ...SAVE_FOLDER_SEGMENTS].join(" › ");

export const IMAGE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});

/** UTF-16 units of the workflow title kept in a file name (the stem is also capped at 180 UTF-8 bytes). */
const MAX_TITLE_UNITS = 80;
const MAX_UNIQUE_ATTEMPTS = 1_000;

/** The slice of `node:fs/promises` the exporter uses; tests inject failures through it. */
export interface ExportFileSystem {
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  open(target: string, flags: "wx" | "w", mode: number): Promise<{ writeFile(data: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
  /** Fails with EEXIST when `newPath` exists, which makes publishing a finished file exclusive. */
  link(existingPath: string, newPath: string): Promise<void>;
  /** Replaces `newPath` in one step, so a reader never sees it half-written. */
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(target: string, options: { force: true }): Promise<void>;
  stat(target: string): Promise<{ isFile(): boolean }>;
}

const two = (value: number) => String(value).padStart(2, "0");

/** The local-time day folder, `YYYY-MM-DD`. */
export function exportDayFolder(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * `<HHMMSS> <title> <sha8>.<ext>` in local time; the title is made safe for any folder, "Image"
 * when empty, and cut between graphemes so the whole name, with a " (n)" suffix, stays well
 * under the 255-byte name limit of Linux file systems.
 */
export function exportFileName(input: { at: number; workflowTitle?: string; assetId: string; mediaType: ImageMediaType }): string {
  const date = new Date(input.at);
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  const title = safeFileNameStem(truncateFileNameText(input.workflowTitle ?? "", MAX_TITLE_UNITS, MAX_FILE_STEM_BYTES));
  return `${time} ${title} ${input.assetId.slice(0, 8)}.${IMAGE_EXTENSIONS[input.mediaType]}`;
}

/**
 * Writes `bytes` to a new file named `fileName` in `directory`, or `name (n).ext` when that is
 * taken; never overwrites. Creates the directory first. Returns the path written.
 *
 * The bytes go to a hidden staging file in the same folder first and are then hard-linked to the
 * visible name (exclusive, like `wx`), so a write cut short by quit or a full disk never leaves a
 * truncated image under the real name. Where hard links are not supported (some external or
 * network volumes), the visible name is created and written directly, and removed on failure.
 */
export async function writeUniqueFile(
  fs: ExportFileSystem,
  directory: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  const candidate = (attempt: number) => path.join(directory, attempt === 0 ? fileName : `${stem} (${attempt})${extension}`);
  const staging = path.join(directory, `.aiden-${randomUUID()}.tmp`);
  await writeNewFile(fs, staging, bytes);
  try {
    for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
      const target = candidate(attempt);
      try {
        await fs.link(staging, target);
        return target;
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        return await writeUniqueDirectly(fs, candidate, attempt, bytes);
      }
    }
  } finally {
    await fs.rm(staging, { force: true }).catch(() => undefined);
  }
  throw new Error("No free file name was found for the image.");
}

/**
 * Writes `bytes` over `target`, which may exist (a Save dialog already confirmed replacing it).
 * The bytes go to a hidden staging file beside it and are renamed into place, so a failed or
 * interrupted write leaves the previous file whole.
 */
export async function replaceFile(fs: ExportFileSystem, target: string, bytes: Uint8Array): Promise<void> {
  const staging = path.join(path.dirname(target), `.aiden-${randomUUID()}.tmp`);
  await writeNewFile(fs, staging, bytes);
  try {
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The fallback without hard links: exclusive create of each candidate name, written in place. */
async function writeUniqueDirectly(
  fs: ExportFileSystem,
  candidate: (attempt: number) => string,
  from: number,
  bytes: Uint8Array,
): Promise<string> {
  for (let attempt = from; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
    const target = candidate(attempt);
    try {
      await writeNewFile(fs, target, bytes);
      return target;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("No free file name was found for the image.");
}

/** Creates `target` exclusively and writes `bytes`; on a failed write the file is removed. */
async function writeNewFile(fs: ExportFileSystem, target: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(target, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * What a log may say about a failed file operation: its error code (`EACCES`, `ENOSPC`) or error
 * name, never the message, which names the path and so the workflow title.
 */
export function fileErrorSummary(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.name : "unknown");
}

export interface CreateImagesExportsOptions {
  /** `<Pictures>/Aiden/Create Images`, or null when this session saves nothing (tests that don't opt in). */
  root: (() => string) | null;
  ledger: Pick<ImageRunLedger, "exportPath" | "exportPaths" | "recordExport">;
  assets: Pick<StudioAssetStore, "read">;
  fs?: ExportFileSystem;
  now?: () => number;
  /** Non-fatal auto-save failures, with only the error code: never prompt text, paths or titles. */
  reportIssue?(message: string, error: unknown): void;
}

export class CreateImagesExportUnavailableError extends Error {
  constructor() {
    super("Saving images to a folder isn't available.");
    this.name = "CreateImagesExportUnavailableError";
  }
}

/** Auto-save and on-demand export of Create Images assets, recorded in the run ledger. */
export class CreateImagesExports {
  readonly folderLabel = SAVE_FOLDER_LABEL;
  private readonly fs: ExportFileSystem;
  private readonly now: () => number;
  private readonly pending = new Set<Promise<unknown>>();
  /** One export at a time per asset, so an auto-save and a Reveal never write two copies. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly options: CreateImagesExportsOptions) {
    this.fs = options.fs ?? (nodeFs as unknown as ExportFileSystem);
    this.now = options.now ?? Date.now;
  }

  available(): boolean {
    return this.options.root !== null;
  }

  /** The auto-save root folder. Throws when this session saves nothing. */
  folder(): string {
    if (!this.options.root) throw new CreateImagesExportUnavailableError();
    return this.options.root();
  }

  fileSystem(): ExportFileSystem {
    return this.fs;
  }

  /** The name and day folder an export made now would use. */
  target(ref: Pick<OutputRef, "assetId" | "mediaType">, workflowTitle?: string): { directory: string; fileName: string } {
    const at = this.now();
    return {
      directory: path.join(this.folder(), exportDayFolder(at)),
      fileName: exportFileName({ at, assetId: ref.assetId, mediaType: ref.mediaType, ...(workflowTitle !== undefined ? { workflowTitle } : {}) }),
    };
  }

  /**
   * Saves each image in the background. Never throws and never delays the caller: a failure is
   * reported and the run's outcome is unaffected. Does nothing when this session saves nothing.
   */
  autoSave(outputs: readonly Pick<OutputRef, "assetId" | "mediaType">[], workflowTitle?: string): void {
    if (!this.available()) return;
    for (const ref of outputs) {
      const task = this.ensureExported(ref, workflowTitle).catch((error: unknown) => {
        if (isClosedLedger(error)) return;
        try {
          this.options.reportIssue?.("Could not auto-save a generated image to the Pictures folder.", fileErrorSummary(error));
        } catch {
          // Reporting is best effort.
        }
      });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    }
  }

  /** Resolves once every background auto-save has settled, or after `timeoutMs` when given. */
  async whenIdle(timeoutMs?: number): Promise<void> {
    const drain = (async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    })();
    if (timeoutMs === undefined) return drain;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([drain, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The auto-saved copy's path when one is recorded and still on disk. */
  async savedPath(assetId: string): Promise<string | undefined> {
    const recorded = this.options.ledger.exportPath(assetId);
    return recorded !== undefined && (await this.isFile(recorded)) ? recorded : undefined;
  }

  /** Which of these assets have an auto-saved copy on disk now. */
  async savedAssetIds(assetIds: Iterable<string>): Promise<Set<string>> {
    const recorded = this.options.ledger.exportPaths();
    const checks = [...new Set(assetIds)].map(async (assetId) => {
      const file = recorded.get(assetId);
      return file !== undefined && (await this.isFile(file)) ? assetId : undefined;
    });
    return new Set((await Promise.all(checks)).filter((assetId): assetId is string => assetId !== undefined));
  }

  /**
   * The auto-saved copy of an asset, writing it first when none is recorded or the recorded file
   * was moved or deleted. Throws on failure.
   */
  ensureExported(ref: Pick<OutputRef, "assetId" | "mediaType">, workflowTitle?: string): Promise<string> {
    const running = this.inFlight.get(ref.assetId);
    if (running) return running;
    const task = this.export(ref, workflowTitle).finally(() => this.inFlight.delete(ref.assetId));
    this.inFlight.set(ref.assetId, task);
    return task;
  }

  private async export(ref: Pick<OutputRef, "assetId" | "mediaType">, workflowTitle?: string): Promise<string> {
    const existing = await this.savedPath(ref.assetId);
    if (existing) return existing;
    const { directory, fileName } = this.target(ref, workflowTitle);
    const { bytes } = await this.options.assets.read(ref.assetId);
    const written = await writeUniqueFile(this.fs, directory, fileName, bytes);
    this.options.ledger.recordExport(ref.assetId, written);
    return written;
  }

  private async isFile(target: string): Promise<boolean> {
    try {
      return (await this.fs.stat(target)).isFile();
    } catch {
      return false;
    }
  }
}

/** After quit closes the ledger a late auto-save cannot be recorded; that is not worth reporting. */
function isClosedLedger(error: unknown): boolean {
  return error instanceof ImageRunLedgerError && error.code === "closed";
}
