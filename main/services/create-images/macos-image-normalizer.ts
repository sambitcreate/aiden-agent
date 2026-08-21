import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readRegularFile } from "../regular-file-read.js";
import { validateImageBytes } from "./asset-image-validation-core.js";

const IMAGE_IO_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;

export interface MacosImageNormalizerLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

async function runSips(inputPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/sips", ["-s", "format", "png", inputPath, "--out", outputPath], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let diagnostic = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (diagnostic.length < MAX_DIAGNOSTIC_BYTES) {
        diagnostic += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) finish();
      else {
        finish(
          new Error(
            diagnostic.trim() ||
              `The macOS image converter stopped with ${signal ?? `exit code ${String(code)}`}.`,
          ),
        );
      }
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("The macOS image converter exceeded its time limit."));
    }, IMAGE_IO_TIMEOUT_MS);
  });
}

/**
 * Convert a static raster with macOS ImageIO after Chromium declines it.
 * The selected file is copied into a private directory first, the converter
 * receives fixed arguments without a shell, and its PNG is fully revalidated.
 */
export async function normalizeImageWithMacosImageIo(
  selectedPath: string,
  limits: MacosImageNormalizerLimits,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (process.platform !== "darwin") {
    throw new Error("The macOS image converter is unavailable on this platform.");
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-normalize-"));
  const inputPath = path.join(temporary, "source.raster");
  const outputPath = path.join(temporary, "normalized.png");
  try {
    const input = await readRegularFile(selectedPath, limits.maxInputBytes);
    await fs.writeFile(inputPath, input, { flag: "wx", mode: 0o600 });
    await runSips(inputPath, outputPath);
    const bytes = await readRegularFile(outputPath, limits.maxOutputBytes);
    const descriptor = validateImageBytes(bytes, "image/png", "normalized.png", limits);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return { bytes: copy, width: descriptor.width, height: descriptor.height };
  } finally {
    await fs.rm(temporary, { force: true, recursive: true }).catch(() => undefined);
  }
}
