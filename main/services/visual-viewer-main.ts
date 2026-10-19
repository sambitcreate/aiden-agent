import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getRendererBuildPath } from "../windows/window-paths.js";
import { loadGenerativeUiHostLibraries } from "./generative-ui-host-libraries.js";
import type { VisualViewerBundle } from "./visual-viewer-document.js";

/**
 * Loads the phone visual viewer's built page and the host libraries its HTML
 * guests inline. Both are immutable for a running app, so each is read once.
 * A failed read is not cached, so a later request can retry.
 */

const SCRIPT = ["visual-viewer", "viewer.js"] as const;
const STYLE = ["visual-viewer", "viewer.css"] as const;

/** True when this build ships the viewer (`npm run build:visual-viewer`). */
export function visualViewerInstalled(): boolean {
  return existsSync(getRendererBuildPath(...SCRIPT)) && existsSync(getRendererBuildPath(...STYLE));
}

let bundle: Promise<VisualViewerBundle> | undefined;
let libraries: Promise<Record<string, string>> | undefined;

function once<T>(load: () => Promise<T>, read: () => Promise<T> | undefined, store: (value: Promise<T> | undefined) => void): Promise<T> {
  const cached = read();
  if (cached) return cached;
  const pending = load();
  store(pending);
  pending.catch(() => store(undefined));
  return pending;
}

export function loadVisualViewerBundle(): Promise<VisualViewerBundle> {
  return once(
    async () => ({
      script: await readFile(getRendererBuildPath(...SCRIPT), "utf8"),
      style: await readFile(getRendererBuildPath(...STYLE), "utf8"),
    }),
    () => bundle,
    (value) => { bundle = value; },
  );
}

export function loadVisualViewerLibraries(): Promise<Record<string, string>> {
  return once(loadGenerativeUiHostLibraries, () => libraries, (value) => { libraries = value; });
}
