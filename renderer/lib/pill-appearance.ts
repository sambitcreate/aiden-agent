import { onNotification, settingsApi } from "./ipc";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceConfig,
} from "./appearance-runtime";
import {
  parseAppearanceConfig,
  type AppearanceConfig,
} from "../shared/appearance";

interface AppearanceMediaQuery {
  readonly matches: boolean;
  addEventListener(
    type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void;
  removeEventListener(
    type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void;
}

interface PillAppearanceStorageChange {
  key: string | null;
  newValue: string | null;
}

export interface PillAppearanceSyncEnvironment {
  readCachedAppearance(): AppearanceConfig | null;
  readAuthoritativeAppearance(): Promise<unknown>;
  applyAppearance(
    config: AppearanceConfig,
    nativeUsesDarkColors: boolean,
    systemHighContrast: boolean,
  ): void;
  darkScheme: AppearanceMediaQuery;
  highContrast: AppearanceMediaQuery;
  reducedMotion: AppearanceMediaQuery;
  subscribeStorage(
    listener: (event: PillAppearanceStorageChange) => void,
  ): () => void;
  subscribeAppearance(listener: (value: unknown) => void): () => void;
  subscribeVisibility(listener: () => void): () => void;
}

export interface PillAppearanceSyncHandle {
  ready: Promise<void>;
  stop(): void;
}

/**
 * Parse the renderer-authored cache strictly so damage or manual edits fall
 * back to the persisted main-process settings instead of silently becoming
 * default appearance values.
 */
export function parsePillAppearanceStorageValue(
  value: string | null,
): AppearanceConfig | null {
  if (!value) return null;
  try {
    return parseAppearanceConfig(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function browserEnvironment(): PillAppearanceSyncEnvironment {
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const highContrast = window.matchMedia("(prefers-contrast: more)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  return {
    readCachedAppearance: () =>
      parsePillAppearanceStorageValue(
        localStorage.getItem(APPEARANCE_STORAGE_KEY),
      ),
    readAuthoritativeAppearance: () => settingsApi.getAppearance(),
    applyAppearance: (config, nativeUsesDarkColors, systemHighContrast) => {
      applyAppearanceConfig(
        config,
        nativeUsesDarkColors,
        systemHighContrast,
      );
    },
    darkScheme,
    highContrast,
    reducedMotion,
    subscribeStorage: (listener) => {
      const handleStorage = (event: StorageEvent) =>
        listener({ key: event.key, newValue: event.newValue });
      window.addEventListener("storage", handleStorage);
      return () => window.removeEventListener("storage", handleStorage);
    },
    subscribeAppearance: (listener) =>
      onNotification("settings:appearance-changed", listener),
    subscribeVisibility: (listener) => {
      window.addEventListener("visibilitychange", listener);
      return () => window.removeEventListener("visibilitychange", listener);
    },
  };
}

/**
 * Keep the hidden-and-reused pill synchronized without giving its restricted
 * preload access to Electron's native-theme setter.
 */
export function startPillAppearanceSync(
  environment: PillAppearanceSyncEnvironment = browserEnvironment(),
): PillAppearanceSyncHandle {
  let active = true;
  let revision = 0;
  let config = environment.readCachedAppearance();

  const applyCurrent = () => {
    if (!active || !config) return;
    environment.applyAppearance(
      config,
      environment.darkScheme.matches,
      environment.highContrast.matches,
    );
  };

  const adopt = (next: AppearanceConfig) => {
    revision += 1;
    config = next;
    applyCurrent();
  };

  const hydrateAuthoritative = async (): Promise<void> => {
    const hydrationRevision = revision;
    try {
      const value = await environment.readAuthoritativeAppearance();
      if (!active || hydrationRevision !== revision) return;
      let persisted: AppearanceConfig;
      try {
        persisted = parseAppearanceConfig(value);
      } catch {
        return;
      }
      adopt(persisted);
    } catch {
      // The synchronous cached/default paint remains usable if IPC is unavailable.
    }
  };

  const refreshAuthoritative = () => {
    // Never repaint from the origin-local cache on reuse: packaged renderer
    // entry points have distinct file: URLs, so that valid cache can lag. The
    // main-process effective appearance includes an in-flight safe preview.
    void hydrateAuthoritative();
  };

  const handleStorage = (event: PillAppearanceStorageChange) => {
    if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
    const cached = parsePillAppearanceStorageValue(event.newValue);
    if (cached) adopt(cached);
    else {
      revision += 1;
      void hydrateAuthoritative();
    }
  };
  const handleAppearance = (value: unknown) => {
    let next: AppearanceConfig;
    try {
      next = parseAppearanceConfig(value);
    } catch {
      return;
    }
    adopt(next);
  };
  const handleMediaChange = () => applyCurrent();

  const removeStorage = environment.subscribeStorage(handleStorage);
  const removeAppearance = environment.subscribeAppearance(handleAppearance);
  const removeVisibility = environment.subscribeVisibility(refreshAuthoritative);
  for (const media of [
    environment.darkScheme,
    environment.highContrast,
    environment.reducedMotion,
  ]) {
    media.addEventListener("change", handleMediaChange);
  }

  // The pill entrypoint already paints and rewrites the cache synchronously.
  // Reapply for current media state, then reconcile the main-process effective
  // appearance so a missing/corrupt cache or pending preview cannot be missed.
  if (config) applyCurrent();
  const ready = hydrateAuthoritative();

  const stop = () => {
    if (!active) return;
    active = false;
    removeStorage();
    removeAppearance();
    removeVisibility();
    for (const media of [
      environment.darkScheme,
      environment.highContrast,
      environment.reducedMotion,
    ]) {
      media.removeEventListener("change", handleMediaChange);
    }
  };
  return { ready, stop };
}
