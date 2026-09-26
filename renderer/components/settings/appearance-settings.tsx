import * as React from "react";
import {
  Check,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import {
  Button,
  toast,
} from "../ui";
import { settingsApi } from "../../lib/ipc";
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_INTENT_FAILED_EVENT,
  announceAppearanceIntentFailure,
  applyAppearanceConfig,
  beginAppearanceIntent,
  createNativeAppearanceRevisionTracker,
  readCachedAppearance,
  readAppearanceIntentRevision,
  reconcileNativeThemeChange,
  reconcileRuntimeAppearanceEvent,
  rebaseAppearanceIntentAfterFailure,
  runAppearanceIntent,
  type AppliedAppearance,
} from "../../lib/appearance-runtime";
import {
  THEME_PRESETS,
  createDefaultAppearanceConfig,
  getPresetVariant,
  normalizeAppearanceConfig,
  resolveThemeTokens,
  themeVariantSafetyIssues,
  type AppearanceConfig,
  type AppearanceMode,
  type AppearanceScheme,
  type ThemePresetId,
  type ThemeVariantConfig,
} from "../../shared/appearance";
import type { NativeThemeInfo } from "../../preload";

type CssProperties = React.CSSProperties & Record<`--${string}`, string>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function handleRadioNavigation<Value extends string>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  index: number,
  options: ReadonlyArray<{ value: Value }>,
  onChange: (value: Value) => void,
): void {
  let nextIndex: number | null = null;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + options.length) % options.length;
  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % options.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = options.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const group = event.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
  group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  onChange(options[nextIndex].value);
}

function appearanceSafetyIssues(config: AppearanceConfig): string[] {
  return [
    ...themeVariantSafetyIssues(config.light, "light"),
    ...themeVariantSafetyIssues(config.dark, "dark"),
  ];
}

function ThemeModePreview({ mode, config }: { mode: AppearanceMode; config: AppearanceConfig }) {
  const schemes: AppearanceScheme[] = mode === "system" ? ["light", "dark"] : [mode];
  return (
    <span className={`appearance-mode-preview appearance-mode-preview-${mode}`} aria-hidden="true">
      {schemes.map((scheme) => (
        <span key={scheme} className="appearance-mode-scene" data-preview-scheme={scheme} style={previewStyle(config[scheme], scheme)}>
          <span className="appearance-mode-preview-toolbar" />
          <span className="appearance-mode-preview-sidebar" />
          <span className="appearance-mode-preview-content"><i /><i /><i /></span>
        </span>
      ))}
    </span>
  );
}

function ThemeModePicker({ value, config, disabled, onChange }: { value: AppearanceMode; config: AppearanceConfig; disabled?: boolean; onChange: (mode: AppearanceMode) => void }) {
  const options: Array<{ value: AppearanceMode; label: string; icon: React.ReactNode }> = [
    { value: "system", label: "System", icon: <Monitor /> },
    { value: "light", label: "Light", icon: <Sun /> },
    { value: "dark", label: "Dark", icon: <Moon /> },
  ];
  return (
    <div className="appearance-mode-picker" role="radiogroup" aria-label="Theme mode">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          tabIndex={value === option.value ? 0 : -1}
          className="appearance-mode-option"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleRadioNavigation(event, index, options, onChange)}
        >
          <ThemeModePreview mode={option.value} config={config} />
          <span className="appearance-mode-option-label">
            {option.icon}
            {option.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function previewStyle(variant: ThemeVariantConfig, scheme: AppearanceScheme): CssProperties {
  const tokens = resolveThemeTokens(variant, scheme);
  return {
    "--preview-bg": tokens["--surface-popover"],
    "--preview-sidebar": tokens["--theme-sidebar"],
    "--preview-fg": tokens["--text-primary"],
    "--preview-muted": tokens["--text-tertiary"],
    "--preview-accent": tokens["--accent"],
    "--preview-border": tokens["--border-separator"],
  };
}

type ThemePreset = (typeof THEME_PRESETS)[number];

/** The scheme that visually defines each preset on its tile. */
const TILE_SIGNATURE_SCHEME: Record<ThemePresetId, AppearanceScheme> = {
  aiden: "light",
  slate: "light",
  berry: "light",
  moss: "light",
  paper: "light",
  calm: "light",
  graphite: "dark",
  dusk: "dark",
  midnight: "dark",
};

function ThemeTile({
  preset,
  index,
  selected,
  tabbable,
  onChange,
}: {
  preset: ThemePreset;
  index: number;
  selected: boolean;
  tabbable: boolean;
  onChange: (preset: ThemePresetId) => void;
}) {
  const palette = preset[TILE_SIGNATURE_SCHEME[preset.id]];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      className="appearance-tile"
      onClick={() => onChange(preset.id)}
      onKeyDown={(event) =>
        handleRadioNavigation(
          event,
          index,
          THEME_PRESETS.map((entry) => ({ value: entry.id })),
          onChange,
        )
      }
    >
      <span
        className="appearance-tile-swatch"
        aria-hidden="true"
        style={{ backgroundColor: palette.canvas, color: palette.foreground }}
      >
        Aa
        <span className="appearance-tile-accent" style={{ backgroundColor: palette.accent }} />
        {selected ? (
          <span className="appearance-tile-check"><Check strokeWidth={3} /></span>
        ) : null}
      </span>
      <span className="appearance-tile-label">{preset.label}</span>
    </button>
  );
}

function ThemeTileGrid({
  value,
  onChange,
}: {
  value: ThemePresetId | null;
  onChange: (preset: ThemePresetId) => void;
}) {
  const selectedIndex = THEME_PRESETS.findIndex((preset) => preset.id === value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;
  return (
    <div className="appearance-theme-grid" role="radiogroup" aria-label="Themes">
      {THEME_PRESETS.map((preset, index) => (
        <ThemeTile
          key={preset.id}
          preset={preset}
          index={index}
          selected={preset.id === value}
          tabbable={index === focusIndex}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

export function AppearanceSettings() {
  const [config, setConfig] = React.useState<AppearanceConfig>(() => readCachedAppearance() ?? createDefaultAppearanceConfig());
  const [hydrated, setHydrated] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [modePending, setModePending] = React.useState(false);
  const configRef = React.useRef(config);
  const nativeInfoRef = React.useRef<NativeThemeInfo | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = React.useRef<{
    config: AppearanceConfig;
    revision: number;
  } | null>(null);
  const dirtyRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const hasSafetyIssues = React.useMemo(() => appearanceSafetyIssues(config).length > 0, [config]);
  configRef.current = config;

  const queueSave = React.useCallback((next: AppearanceConfig, revision: number) => {
    void runAppearanceIntent(revision, async (isCurrent) => {
      if (!isCurrent()) return;
      try {
        await settingsApi.set({ appearance: next });
        if (
          isCurrent() &&
          pendingSaveRef.current?.revision === revision
        ) {
          pendingSaveRef.current = null;
          dirtyRef.current = false;
          if (mountedRef.current) setSaveError(null);
        }
      } catch (error) {
        if (
          isCurrent() &&
          pendingSaveRef.current?.revision === revision
        ) {
          dirtyRef.current = true;
          if (mountedRef.current) {
            setSaveError(errorMessage(error, "Aiden could not save appearance settings."));
          }
        }
      }
    });
  }, []);

  const scheduleSave = React.useCallback((next: AppearanceConfig, revision: number) => {
    pendingSaveRef.current = { config: next, revision };
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      queueSave(next, revision);
    }, 220);
  }, [queueSave]);

  const apply = React.useCallback((next: AppearanceConfig) => {
    const nativeInfo = nativeInfoRef.current;
    applyAppearanceConfig(
      next,
      nativeInfo?.shouldUseDarkColors,
      nativeInfo?.shouldUseHighContrastColors === true,
    );
  }, []);

  const update = React.useCallback((
    updater: (current: AppearanceConfig) => AppearanceConfig,
    revision = beginAppearanceIntent(),
  ) => {
    const next = normalizeAppearanceConfig(updater(configRef.current));
    configRef.current = next;
    setConfig(next);
    apply(next);
    if (appearanceSafetyIssues(next).length === 0) {
      // Keep hidden/reused auxiliary windows on the live preview while the
      // durable settings write remains intentionally debounced.
      void settingsApi.previewAppearance(next).catch(() => {});
      scheduleSave(next, revision);
    } else if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, [apply, scheduleSave]);

  React.useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const nativeRevision = createNativeAppearanceRevisionTracker();
    const hydrationRevision = readAppearanceIntentRevision();
    void (async () => {
      const appearanceState = await settingsApi.getAppearanceState();
      const nativeInfo = await nativeRevision.readStable(
        () => window.aidenAPI.nativeTheme.getInfo(),
      );
      if (cancelled) return;
      nativeInfoRef.current = nativeInfo;
      if (hydrationRevision !== readAppearanceIntentRevision()) {
        setHydrated(true);
        return;
      }
      const next = normalizeAppearanceConfig(appearanceState.appearance);
      configRef.current = next;
      setConfig(next);
      if (appearanceState.pending) {
        scheduleSave(next, beginAppearanceIntent());
      } else {
        pendingSaveRef.current = null;
        dirtyRef.current = false;
      }
      applyAppearanceConfig(next, nativeInfo.shouldUseDarkColors, nativeInfo.shouldUseHighContrastColors === true);
      setHydrated(true);
    })().catch((error: unknown) => {
      if (!cancelled) {
        setHydrated(true);
        toast.error(errorMessage(error, "Aiden could not load appearance settings."));
      }
    });
    const unsubscribe = window.aidenAPI.nativeTheme.onChanged((nativeInfo) => {
      nativeRevision.markChanged();
      const reconciled = reconcileNativeThemeChange(configRef.current, nativeInfo);
      if (!reconciled) return;
      nativeInfoRef.current = nativeInfo;
      configRef.current = reconciled.config;
      applyAppearanceConfig(
        reconciled.config,
        reconciled.nativeUsesDarkColors,
        reconciled.systemHighContrast,
      );
    });
    const handleRuntimeChange = (event: Event) => {
      const detail = (event as CustomEvent<AppliedAppearance>).detail;
      if (!detail?.config) return;
      const reconciled = reconcileRuntimeAppearanceEvent(
        detail.config,
        pendingSaveRef.current?.revision ?? null,
        readAppearanceIntentRevision(),
      );
      if (reconciled.supersedesPending) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        pendingSaveRef.current = null;
        dirtyRef.current = false;
        setSaveError(null);
      }
      configRef.current = reconciled.config;
      setConfig(reconciled.config);
      nativeInfoRef.current = {
        ...nativeInfoRef.current,
        themeSource: reconciled.config.mode,
        shouldUseDarkColors: detail.scheme === "dark",
        shouldUseHighContrastColors: detail.systemHighContrast,
      };
    };
    const handleIntentFailure = (event: Event) => {
      const failedRevision = (
        event as CustomEvent<{ revision?: unknown }>
      ).detail?.revision;
      if (typeof failedRevision !== "number") return;
      const pending = pendingSaveRef.current;
      const rebasedRevision = rebaseAppearanceIntentAfterFailure(
        pending?.revision ?? null,
        failedRevision,
        readAppearanceIntentRevision(),
      );
      if (!pending || rebasedRevision === null) return;
      scheduleSave(pending.config, rebasedRevision);
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, handleRuntimeChange);
    window.addEventListener(APPEARANCE_INTENT_FAILED_EVENT, handleIntentFailure);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, handleRuntimeChange);
      window.removeEventListener(APPEARANCE_INTENT_FAILED_EVENT, handleIntentFailure);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const pending = pendingSaveRef.current;
      if (dirtyRef.current && pending) queueSave(pending.config, pending.revision);
    };
  }, [queueSave, scheduleSave]);

  const changeMode = (mode: AppearanceMode) => {
    if (modePending || mode === configRef.current.mode || appearanceSafetyIssues(configRef.current).length > 0) return;
    const revision = beginAppearanceIntent();
    setModePending(true);
    void runAppearanceIntent(revision, async (isCurrent) => {
      try {
        await window.aidenAPI.nativeTheme.setThemeSource(mode);
        if (!isCurrent()) {
          await window.aidenAPI.nativeTheme.setThemeSource(configRef.current.mode);
          return;
        }
      } catch (error) {
        if (isCurrent()) {
          toast.error(errorMessage(error, "Aiden could not change the theme mode."));
          announceAppearanceIntentFailure(revision);
        }
        return;
      }
      update((current) => ({ ...current, mode }), revision);
      try {
        nativeInfoRef.current = await window.aidenAPI.nativeTheme.getInfo();
        if (!isCurrent()) return;
        apply(configRef.current);
      } catch (error) {
        if (isCurrent()) {
          toast.error(errorMessage(error, "The theme changed, but Aiden could not refresh the system appearance state."));
        }
      }
    }).finally(() => {
      if (mountedRef.current) setModePending(false);
    });
  };

  const changeTheme = (preset: ThemePresetId) => {
    update((current) => ({
      ...current,
      light: getPresetVariant(preset, "light"),
      dark: getPresetVariant(preset, "dark"),
    }));
  };

  const selectedPreset =
    config.light.preset !== "custom" && config.light.preset === config.dark.preset
      ? config.light.preset
      : null;
  const currentThemeLabel = selectedPreset
    ? (THEME_PRESETS.find((preset) => preset.id === selectedPreset)?.label ?? "Custom")
    : "Custom";

  return (
    <div className="appearance-page" aria-busy={!hydrated} inert={!hydrated ? true : undefined}>
      <div className="settings-page-heading appearance-heading">
        <h1>Appearance</h1>
        <p>Pick a theme and choose when Aiden uses its light or dark look.</p>
      </div>

      {saveError ? (
        <div className="appearance-page-status" data-kind="error" role="alert">
          <div><strong>Appearance changes are not saved.</strong><div>{saveError}</div></div>
          <Button
            variant="transparent"
            size="small"
            onClick={() => {
              const pending = pendingSaveRef.current;
              if (!pending) return;
              setSaveError(null);
              queueSave(pending.config, pending.revision);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <section className="appearance-theme-section" aria-labelledby="appearance-theme-title">
        <h2 id="appearance-theme-title">Theme</h2>
        <ThemeModePicker config={config} value={config.mode} disabled={hasSafetyIssues || modePending} onChange={changeMode} />
        <ThemeTileGrid value={selectedPreset} onChange={changeTheme} />
        <p className="appearance-current-theme">Current theme: {currentThemeLabel}</p>
      </section>
    </div>
  );
}
