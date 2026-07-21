import * as React from "react";
import { settingsApi } from "./ipc";
import {
  APPEARANCE_CHANGE_EVENT,
  applyAppearanceConfig,
  readCachedAppearance,
  type AppliedAppearance,
} from "./appearance-runtime";
import {
  createDefaultAppearanceConfig,
  normalizeAppearanceConfig,
  type AppearanceConfig,
} from "../shared/appearance";

export function useTheme(): void {
  React.useEffect(() => {
    let active = true;
    let config: AppearanceConfig = readCachedAppearance() ?? createDefaultAppearanceConfig();
    let nativeDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    let nativeHighContrast = window.matchMedia("(prefers-contrast: more)").matches;

    const render = () => applyAppearanceConfig(config, nativeDark, nativeHighContrast);
    const handleRuntimeChange = (event: Event) => {
      const detail = (event as CustomEvent<AppliedAppearance>).detail;
      if (detail?.config) config = detail.config;
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, handleRuntimeChange);

    void Promise.all([
      window.aidenAPI.nativeTheme.getInfo(),
      settingsApi.get(),
    ]).then(async ([themeInfo, settings]) => {
      if (!active) return;
      nativeDark = themeInfo.shouldUseDarkColors;
      nativeHighContrast = themeInfo.shouldUseHighContrastColors === true;
      const persisted = settings.appearance
        ? normalizeAppearanceConfig(settings.appearance)
        : readCachedAppearance();
      config = persisted ?? {
        ...createDefaultAppearanceConfig(),
        mode: themeInfo.themeSource,
      };
      if (themeInfo.themeSource !== config.mode) {
        await window.aidenAPI.nativeTheme.setThemeSource(config.mode);
        const updated = await window.aidenAPI.nativeTheme.getInfo();
        if (!active) return;
        nativeDark = updated.shouldUseDarkColors;
        nativeHighContrast = updated.shouldUseHighContrastColors === true;
      }
      render();
    }).catch(() => {
      if (active) render();
    });

    const unsubscribe = window.aidenAPI.nativeTheme.onChanged((info) => {
      nativeDark = info.shouldUseDarkColors;
      nativeHighContrast = info.shouldUseHighContrastColors === true;
      config = { ...config, mode: info.themeSource };
      render();
    });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const refreshSystemPreferences = () => render();
    reducedMotion.addEventListener("change", refreshSystemPreferences);
    return () => {
      active = false;
      unsubscribe();
      reducedMotion.removeEventListener("change", refreshSystemPreferences);
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, handleRuntimeChange);
    };
  }, []);
}
