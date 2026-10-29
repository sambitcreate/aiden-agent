import * as React from "react";
import { onNotification, settingsApi } from "./ipc";
import {
  APPEARANCE_CHANGE_EVENT,
  applyAppearanceConfig,
  createNativeAppearanceRevisionTracker,
  readAppearanceIntentRevision,
  readCachedAppearance,
  reconcileNativeThemeChange,
  runAppearanceIntent,
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
    const nativeRevision = createNativeAppearanceRevisionTracker();

    const render = () => applyAppearanceConfig(config, nativeDark, nativeHighContrast);
    const handleRuntimeChange = (event: Event) => {
      const detail = (event as CustomEvent<AppliedAppearance>).detail;
      if (!detail?.config) return;
      config = detail.config;
      nativeDark = detail.scheme === "dark";
      nativeHighContrast = detail.systemHighContrast;
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, handleRuntimeChange);

    // Re-read the persisted appearance on mount and whenever main reports a
    // change this window did not author (an agent tool, a chat control panel,
    // a paired phone). Queued behind local intents, and dropped when a newer
    // one starts, so it never rolls back an in-flight Settings or Command-K edit.
    const hydrate = () => {
      const hydrationRevision = readAppearanceIntentRevision();
      return runAppearanceIntent(hydrationRevision, async (isCurrent) => {
        const appearance = await settingsApi.getAppearance();
        if (!active || !isCurrent()) return;
        let themeInfo = await nativeRevision.readStable(
          () => window.aidenAPI.nativeTheme.getInfo(),
        );
        if (!active || !isCurrent()) return;
        nativeDark = themeInfo.shouldUseDarkColors;
        nativeHighContrast = themeInfo.shouldUseHighContrastColors === true;
        config = normalizeAppearanceConfig(appearance);
        if (themeInfo.themeSource !== config.mode) {
          await window.aidenAPI.nativeTheme.setThemeSource(config.mode);
          const updated = await nativeRevision.readStable(
            () => window.aidenAPI.nativeTheme.getInfo(),
          );
          if (!active || !isCurrent()) return;
          themeInfo = updated;
          nativeDark = updated.shouldUseDarkColors;
          nativeHighContrast = updated.shouldUseHighContrastColors === true;
        }
        render();
      }).catch(() => {
        if (
          active &&
          hydrationRevision === readAppearanceIntentRevision()
        )
          render();
      });
    };
    void hydrate();
    const unsubscribePersisted = onNotification("settings:appearance-changed", () => {
      if (active) void hydrate();
    });

    const unsubscribe = window.aidenAPI.nativeTheme.onChanged((info) => {
      nativeRevision.markChanged();
      const reconciled = reconcileNativeThemeChange(config, info);
      if (!reconciled) return;
      config = reconciled.config;
      nativeDark = reconciled.nativeUsesDarkColors;
      nativeHighContrast = reconciled.systemHighContrast;
      render();
    });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const refreshSystemPreferences = () => render();
    reducedMotion.addEventListener("change", refreshSystemPreferences);
    return () => {
      active = false;
      unsubscribe();
      unsubscribePersisted();
      reducedMotion.removeEventListener("change", refreshSystemPreferences);
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, handleRuntimeChange);
    };
  }, []);
}
