import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// Use unique names to avoid conflicts with esbuild's CommonJS shims
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

// Backend is at build/main/index.js, HTML is at build/index.html
// So we go up one level from build/main/ to build/
const BUILD_ROOT = path.resolve(currentDirPath, "..");

/**
 * Absolute path to the build directory that contains HTML entry points.
 */
export function getBuildRoot(): string {
  return BUILD_ROOT;
}

/**
 * Resolve the on-disk HTML file for a given window.
 */
export function resolveWindowHtml(htmlFileName: string): string {
  return path.join(BUILD_ROOT, htmlFileName);
}

/**
 * Return a file:// URL for a locally built HTML file.
 */
export function getWindowFileUrl(htmlFileName: string): string {
  return pathToFileURL(resolveWindowHtml(htmlFileName)).toString();
}

/**
 * Absolute path to the built preload script.
 *
 * The Vite build outputs the preload entry to `build/assets/preload.js` with a
 * stable (non-hashed) filename.  The native layer reads this path from
 * `webPreferences.preload` and injects the script into an isolated
 * WKContentWorld before page scripts run.
 *
 * In dev mode the backend runs via `tsx watch` (source directory), but the
 * preload must still be a built JS file because the native Swift host cannot
 * execute TypeScript.  A prior `npm run build` (or the Xcode build phase) is
 * expected to have produced the file.
 */
export function getPreloadPath(): string {
  return path.join(BUILD_ROOT, "assets", "preload.js");
}

/**
 * Resolve the correct URL for a window, preferring the dev server when available.
 */
export async function getWindowUrl(htmlFileName: string): Promise<string> {
  // .devserverhost is written to the project root by dev-server.js
  // BUILD_ROOT is build/, so we go one level up to reach the project root
  const devServerHostFile = path.join(BUILD_ROOT, "..", ".devserverhost");

  if (fs.existsSync(devServerHostFile)) {
    try {
      const devServerHost = (await fs.promises.readFile(devServerHostFile, "utf-8")).trim();
      if (devServerHost) {
        return `${devServerHost}/${htmlFileName}`;
      }
    } catch {
      // Fall back to the built file
    }
  }

  return getWindowFileUrl(htmlFileName);
}
