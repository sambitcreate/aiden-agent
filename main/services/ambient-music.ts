import path from "node:path";

import rawAssetManifest from "../../resources/ambient-music/asset-manifest.json";
import { app, logger } from "../platform.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import { parseAmbientMusicAssetManifest } from "./ambient-music-download-core.js";
import { AmbientMusicModelStore } from "./ambient-music-download.js";
import { AmbientMusicManager } from "./ambient-music-manager.js";
import { AmbientMusicService } from "./ambient-music-service.js";
import { ambientMusicEnabled } from "./ambient-music-feature-flag.js";

const HELPER_APP_NAME = "Aiden Ambient Music Helper.app";
const HELPER_EXECUTABLE = "aiden-ambient-music-helper";

function helperExecutablePath(): string {
  const helperApp = isPackagedRuntime()
    ? path.resolve(process.resourcesPath, "..", "Helpers", HELPER_APP_NAME)
    : path.join(app.getAppPath(), "build", "native", HELPER_APP_NAME);
  return path.join(helperApp, "Contents", "MacOS", HELPER_EXECUTABLE);
}

let manager: AmbientMusicManager | undefined;

export function getAmbientMusicManager(): AmbientMusicManager {
  if (!ambientMusicEnabled()) {
    throw new Error("Ambient Music is disabled by the local rollout policy.");
  }
  if (manager) return manager;
  const service = new AmbientMusicService({
    helperExecutablePath,
    warn: (message, error) => logger.warn("ambient-music", message, error),
  });
  const store = new AmbientMusicModelStore({
    root: path.join(app.getPath("userData"), "Ambient Music"),
    manifest: parseAmbientMusicAssetManifest(rawAssetManifest),
  });
  manager = new AmbientMusicManager({ service, store });
  return manager;
}

export function existingAmbientMusicManager(): AmbientMusicManager | undefined {
  return manager;
}
