import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const buildRoot = path.resolve(currentDir, "..");

export function getPreloadPath(): string {
  return path.join(buildRoot, "preload", "preload.cjs");
}

export function getPillPreloadPath(): string {
  return path.join(buildRoot, "preload", "preload-pill.cjs");
}

export function getQuickChatPreloadPath(): string {
  return path.join(buildRoot, "preload", "preload-quick-chat.cjs");
}

export function getBotBubblesPreloadPath(): string {
  return path.join(buildRoot, "preload", "preload-bot-bubbles.cjs");
}

export function getWindowUrl(htmlFileName: string): string {
  const devServer = process.env.AIDEN_RENDERER_URL;
  if (devServer) return `${devServer.replace(/\/$/, "")}/${htmlFileName}`;
  return pathToFileURL(path.join(buildRoot, "renderer", htmlFileName)).toString();
}

/**
 * The renderer's own origin as Chromium reports it in request initiators:
 * `file://` for packaged builds, or the dev server's origin.
 */
export function rendererOrigin(): string {
  const devServer = process.env.AIDEN_RENDERER_URL;
  if (devServer) {
    try {
      return new URL(devServer).origin;
    } catch {
      return "file://";
    }
  }
  return "file://";
}

/** A file the renderer build ships beside its pages (for example the phone visual viewer). */
export function getRendererBuildPath(...segments: string[]): string {
  return path.join(buildRoot, "renderer", ...segments);
}
