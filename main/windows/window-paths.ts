import { app } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function getBuildRoot(): string {
  return path.join(app.getAppPath(), "build");
}

export function getPreloadPath(): string {
  return path.join(getBuildRoot(), "preload", "preload.cjs");
}

export function getPillPreloadPath(): string {
  return path.join(getBuildRoot(), "preload", "preload-pill.cjs");
}

export function getWindowUrl(htmlFileName: string): string {
  const devServer = process.env.AIDEN_RENDERER_URL;
  if (devServer) return `${devServer.replace(/\/$/, "")}/${htmlFileName}`;
  return pathToFileURL(path.join(getBuildRoot(), "renderer", htmlFileName)).toString();
}
