// On-device Parakeet model catalog + download manager. Models are sherpa-onnx
// NVIDIA Parakeet TDT bundles from k2-fsa's GitHub releases (tar.bz2 archives of
// encoder/decoder/joiner ONNX + tokens.txt). Each model is extracted into its
// own directory under userData so it persists and can be managed/deleted.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, ipcMain, logger } from "../platform.js";

const execFileAsync = promisify(execFile);

interface CatalogModel {
  id: string;
  name: string;
  description: string;
  url: string;
  sizeLabel: string;
  quant: string;
  languagesLabel: string;
  accuracy: number; // 0..1
  speed: number; // 0..1
  recommended: boolean;
}

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
}

export interface LocalModelDownloadState {
  id: string;
  percentage: number;
  phase: "download" | "extract";
  status: "downloading" | "failed";
  error?: string;
}

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

const REQUIRED_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
] as const;
const MAXIMUM_ARCHIVE_BYTES = 800 * 1024 * 1024;

const CATALOG: CatalogModel[] = [
  {
    id: "parakeet-v3",
    name: "Parakeet TDT 0.6B v3",
    description: "Fast and accurate. Supports 25 European languages.",
    url: `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    sizeLabel: "620 MB",
    quant: "int8",
    languagesLabel: "25 languages",
    accuracy: 0.8,
    speed: 0.85,
    recommended: true,
  },
  {
    id: "parakeet-v2",
    name: "Parakeet TDT 0.6B v2",
    description: "English only — the most accurate model for English.",
    url: `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    sizeLabel: "620 MB",
    quant: "int8",
    languagesLabel: "English only",
    accuracy: 0.85,
    speed: 0.85,
    recommended: false,
  },
];

function modelsRoot(): string {
  const dir = path.join(app.getPath("userData"), "parakeet-models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute directory for a model's extracted files, or null for an unknown id. */
export function modelDir(id: string): string | null {
  return CATALOG.some((m) => m.id === id) ? path.join(modelsRoot(), id) : null;
}

export function isModelInstalled(id: string): boolean {
  const dir = modelDir(id);
  return Boolean(dir && REQUIRED_FILES.every((file) => fs.existsSync(path.join(dir, file))));
}

export function listModels(): LocalModel[] {
  return CATALOG.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    sizeLabel: m.sizeLabel,
    quant: m.quant,
    languagesLabel: m.languagesLabel,
    accuracy: m.accuracy,
    speed: m.speed,
    recommended: m.recommended,
    installed: isModelInstalled(m.id),
  }));
}

const downloads = new Map<string, AbortController>();
const downloadStates = new Map<string, LocalModelDownloadState>();

export function localModelDownloadStates(): LocalModelDownloadState[] {
  return [...downloadStates.values()].map((state) => ({ ...state }));
}

/**
 * Download a model's tar.bz2, then extract it into its model directory. Streams
 * download progress via `localModels:progress` (0–90%) and extraction (90–100%).
 */
export async function downloadModel(id: string): Promise<void> {
  const entry = CATALOG.find((m) => m.id === id);
  if (!entry) throw new Error(`Unknown model "${id}".`);
  if (downloads.has(id)) throw new Error("This model is already downloading.");

  const controller = new AbortController();
  downloads.set(id, controller);
  downloadStates.set(id, {
    id,
    percentage: 0,
    phase: "download",
    status: "downloading",
  });

  const dir = path.join(modelsRoot(), id);
  const stagingDir = path.join(modelsRoot(), `.${id}.staging-${Date.now()}`);
  const tmpTar = path.join(os.tmpdir(), `nh-parakeet-${id}-${Date.now()}.tar.bz2`);

  const emit = (downloaded: number, total: number, phase: "download" | "extract") => {
    const progress = {
      id,
      downloaded,
      total,
      // Reserve the last 10% for extraction so the bar keeps moving.
      percentage:
        phase === "extract"
          ? 90 + Math.round((downloaded / Math.max(total, 1)) * 10)
          : total
            ? Math.min(90, Math.round((downloaded / total) * 90))
            : 0,
      phase,
    };
    downloadStates.set(id, {
      id,
      percentage: progress.percentage,
      phase,
      status: "downloading",
    });
    ipcMain.broadcast("localModels:progress", progress);
  };

  try {
    const res = await fetch(entry.url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    if (total > MAXIMUM_ARCHIVE_BYTES) throw new Error("The model archive is larger than the supported limit.");

    const fileStream = fs.createWriteStream(tmpTar);
    const reader = res.body.getReader();
    let downloaded = 0;
    let lastEmit = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (!fileStream.write(chunk)) {
          await new Promise<void>((resolve) => fileStream.once("drain", resolve));
        }
        downloaded += chunk.length;
        if (downloaded > MAXIMUM_ARCHIVE_BYTES) {
          controller.abort();
          throw new Error("The model archive is larger than the supported limit.");
        }
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          emit(downloaded, total, "download");
        }
      }
    } finally {
      await new Promise<void>((resolve) => fileStream.end(resolve));
    }

    // Extract and validate away from the active model. Cancellation or a failed
    // archive therefore cannot turn a working model into a partial install.
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    await fs.promises.mkdir(stagingDir, { recursive: true });
    emit(0, 1, "extract");
    // macOS tar (libarchive) handles bz2; --strip-components=1 drops the archive's top folder.
    await execFileAsync("/usr/bin/tar", ["-xjf", tmpTar, "-C", stagingDir, "--strip-components=1"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60_000,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error("Download cancelled.");
    if (!REQUIRED_FILES.every((file) => fs.existsSync(path.join(stagingDir, file)))) {
      throw new Error("Extracted model is missing expected files.");
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rename(stagingDir, dir);
    emit(1, 1, "extract");
    downloadStates.delete(id);
    logger.info("local-models", `Installed Parakeet model "${id}"`);
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (controller.signal.aborted) {
      downloadStates.delete(id);
      throw new Error("Download cancelled.");
    }
    const resolved = error instanceof Error ? error : new Error(String(error));
    downloadStates.set(id, {
      id,
      percentage: downloadStates.get(id)?.percentage ?? 0,
      phase: downloadStates.get(id)?.phase ?? "download",
      status: "failed",
      error: resolved.message,
    });
    throw resolved;
  } finally {
    await fs.promises.rm(tmpTar, { force: true }).catch(() => {});
    downloads.delete(id);
  }
}

export function cancelDownload(id: string): boolean {
  const controller = downloads.get(id);
  if (!controller) return false;
  controller.abort();
  downloadStates.delete(id);
  return true;
}

export async function deleteModel(id: string): Promise<void> {
  const dir = modelDir(id);
  if (!dir) throw new Error(`Unknown model "${id}".`);
  if (downloads.has(id)) throw new Error("Cancel the model download before deleting it.");
  await fs.promises.rm(dir, { recursive: true, force: true });
}
