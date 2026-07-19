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

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

// The file every extracted model must contain to count as installed.
const REQUIRED_FILE = "encoder.int8.onnx";

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
  return Boolean(dir && fs.existsSync(path.join(dir, REQUIRED_FILE)));
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

  const dir = path.join(modelsRoot(), id);
  const tmpTar = path.join(os.tmpdir(), `nh-parakeet-${id}-${Date.now()}.tar.bz2`);

  const emit = (downloaded: number, total: number, phase: "download" | "extract") =>
    ipcMain.broadcast("localModels:progress", {
      id,
      downloaded,
      total,
      // Reserve the last 10% for extraction so the bar keeps moving.
      percentage:
        phase === "extract" ? 90 + Math.round((downloaded / Math.max(total, 1)) * 10) : total ? Math.round((downloaded / total) * 90) : 0,
      phase,
    });

  try {
    const res = await fetch(entry.url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length") ?? 0);

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
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          emit(downloaded, total, "download");
        }
      }
    } finally {
      await new Promise<void>((resolve) => fileStream.end(resolve));
    }

    // Fresh extract dir.
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
    emit(0, 1, "extract");
    // macOS tar (libarchive) handles bz2; --strip-components=1 drops the archive's top folder.
    await execFileAsync("/usr/bin/tar", ["-xjf", tmpTar, "-C", dir, "--strip-components=1"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60_000,
    });
    if (!isModelInstalled(id)) {
      throw new Error("Extracted model is missing expected files.");
    }
    emit(1, 1, "extract");
    logger.info("local-models", `Installed Parakeet model "${id}"`);
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (controller.signal.aborted) throw new Error("Download cancelled.");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await fs.promises.rm(tmpTar, { force: true }).catch(() => {});
    downloads.delete(id);
  }
}

export function cancelDownload(id: string): boolean {
  const controller = downloads.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function deleteModel(id: string): Promise<void> {
  const dir = modelDir(id);
  if (!dir) throw new Error(`Unknown model "${id}".`);
  await fs.promises.rm(dir, { recursive: true, force: true });
}
