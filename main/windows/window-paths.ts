import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const buildRoot = path.resolve(currentDir, "..");

export function getPreloadPath(): string {
  return path.join(buildRoot, "preload", "preload.cjs");
}

export function getWindowUrl(htmlFileName: string): string {
  const devServer = process.env.AIDEN_RENDERER_URL;
  if (devServer) return `${devServer.replace(/\/$/, "")}/${htmlFileName}`;
  return pathToFileURL(path.join(buildRoot, "renderer", htmlFileName)).toString();
}
