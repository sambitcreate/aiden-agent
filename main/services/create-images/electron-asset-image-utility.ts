import { randomBytes } from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, MessageChannelMain } from "electron";
import { readRegularFile } from "../regular-file-read.js";
import type { CreateImagesAnnotationShape } from "../../../renderer/shared/create-images/schema.js";

const IMAGE_UTILITY_TIMEOUT_MS = 20_000;
const IMAGE_UTILITY_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DECODER_CHANNEL = "create-images:image-decoder-port";

interface ImageUtilityRequest {
  operation: "normalize" | "thumbnail" | "validate" | "annotate";
  filePath: string;
  maxInputBytes?: number;
  maxDimension?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxOutputBytes?: number;
  shapes?: readonly CreateImagesAnnotationShape[];
}

interface ImageUtilitySuccess {
  id: string;
  ok: true;
  width: number;
  height: number;
  bytes?: Uint8Array;
}

function preloadPath(): string {
  const developmentOverride = process.env.AIDEN_CREATE_IMAGES_DECODER_PRELOAD;
  if (!app.isPackaged && developmentOverride) return path.resolve(developmentOverride);
  return path.join(app.getAppPath(), "build", "preload", "create-images-image-decoder.cjs");
}

/**
 * Decode one untrusted image in a disposable, sandboxed Chromium renderer.
 * Codec work and decoded pixels therefore live outside the privileged browser
 * process. The decoder page has default-src 'none', no Node integration, no
 * generic Aiden preload bridge, and receives bounded bytes rather than a path.
 */
export async function runImageUtility(request: ImageUtilityRequest): Promise<ImageUtilitySuccess> {
  const id = randomBytes(18).toString("base64url");
  const maxInputBytes = request.maxInputBytes ?? IMAGE_UTILITY_MAX_INPUT_BYTES;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes < 1 ||
    maxInputBytes > IMAGE_UTILITY_MAX_INPUT_BYTES
  ) {
    throw new Error("The image decoder input limit is invalid.");
  }
  const fileBytes = await readRegularFile(request.filePath, maxInputBytes);
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath(),
      sandbox: true,
      webSecurity: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    await window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob:"><title>Aiden Image Decoder</title>',
        ),
    );
    return await new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannelMain();
      let settled = false;
      const finish = (error?: Error, result?: ImageUtilitySuccess) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        port1.close();
        if (error || !result) reject(error ?? new Error("The image decoder returned no result."));
        else resolve(result);
      };
      const timeout = setTimeout(
        () => finish(new Error("The image decoder exceeded its time limit.")),
        IMAGE_UTILITY_TIMEOUT_MS,
      );
      port1.on("message", (event) => {
        const value = event.data as unknown;
        if (typeof value !== "object" || value === null) return;
        const response = value as Partial<ImageUtilitySuccess> & { ok?: boolean };
        if (response.id !== id) return;
        if (
          response.ok !== true ||
          !Number.isSafeInteger(response.width) ||
          !Number.isSafeInteger(response.height)
        ) {
          finish(new Error("The browser image decoder rejected the image."));
          return;
        }
        finish(undefined, response as ImageUtilitySuccess);
      });
      port1.start();
      window.webContents.postMessage(DECODER_CHANNEL, null, [port2]);
      port1.postMessage({
        id,
        operation: request.operation,
        // MessagePort performs the one required structured-clone copy into the
        // sandboxed renderer. Do not first duplicate the bounded file buffer in
        // the privileged main process.
        bytes: new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength),
        ...(request.maxDimension ? { maxDimension: request.maxDimension } : {}),
        ...(request.maxWidth ? { maxWidth: request.maxWidth } : {}),
        ...(request.maxHeight ? { maxHeight: request.maxHeight } : {}),
        ...(request.maxPixels ? { maxPixels: request.maxPixels } : {}),
        ...(request.maxOutputBytes ? { maxOutputBytes: request.maxOutputBytes } : {}),
        ...(request.shapes ? { shapes: structuredClone(request.shapes) } : {}),
      });
      window.webContents.once("render-process-gone", () =>
        finish(new Error("The sandboxed image decoder crashed.")),
      );
    });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
