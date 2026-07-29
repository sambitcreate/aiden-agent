import * as React from "react";
import {
  Copy,
  FileUp,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from "../ui";
import { appApi, settingsApi } from "../../lib/ipc";
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
  CODE_FONT_OPTIONS,
  THEME_PRESETS,
  UI_FONT_OPTIONS,
  createDefaultAppearanceConfig,
  getPresetVariant,
  isHexColor,
  normalizeAppearanceConfig,
  parseThemeVariantJson,
  resolveThemeTokens,
  serializeThemeVariant,
  themeVariantSafetyIssues,
  type AppearanceConfig,
  type AppearanceMode,
  type AppearanceScheme,
  type CodeFontId,
  type DiffMarkerPreference,
  type DockIconPreference,
  type ReduceMotionPreference,
  type ThemePresetId,
  type ThemeVariantConfig,
  type UiFontId,
} from "../../shared/appearance";
import type { NativeThemeInfo } from "../../preload";

type CssProperties = React.CSSProperties & Record<`--${string}`, string>;
const AIDEN_DOCK_ICON_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;
const MONOCHROME_DOCK_ICON_URL = new URL("../../../resources/app-icon-monochrome.png", import.meta.url).href;

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

function ThemeModePreview({ mode }: { mode: AppearanceMode }) {
  return (
    <span className={`appearance-mode-preview appearance-mode-preview-${mode}`} aria-hidden="true">
      <span className="appearance-mode-preview-toolbar" />
      <span className="appearance-mode-preview-sidebar" />
      <span className="appearance-mode-preview-content">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

function ThemeModePicker({ value, disabled, onChange }: { value: AppearanceMode; disabled?: boolean; onChange: (mode: AppearanceMode) => void }) {
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
          <ThemeModePreview mode={option.value} />
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
    "--preview-fg": tokens["--text-primary"],
    "--preview-muted": tokens["--text-tertiary"],
    "--preview-accent": tokens["--accent"],
    "--preview-border": tokens["--border-separator"],
    "--preview-danger": tokens["--support-red"],
    "--preview-success": tokens["--support-green"],
    "--preview-keyword": tokens["--syntax-keyword"],
    "--preview-string": tokens["--syntax-string"],
    "--preview-number": tokens["--syntax-number"],
  };
}

function CodeLine({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="appearance-code-line">
      <span className="appearance-code-number">{number}</span>
      <code>{children}</code>
    </div>
  );
}

function ThemeCodePreview({ light, dark }: { light: ThemeVariantConfig; dark: ThemeVariantConfig }) {
  return (
    <div className="appearance-code-preview" aria-label="Live light and dark theme diff preview">
      <div className="appearance-code-pane appearance-code-pane-deletion" style={previewStyle(light, "light")}>
        <CodeLine number={1}><b>const</b> themePreview: <em>ThemeConfig</em> = {"{"}</CodeLine>
        <CodeLine number={2}>  surface: <q>sidebar</q>,</CodeLine>
        <CodeLine number={3}>  accent: <q>{light.accent}</q>,</CodeLine>
        <CodeLine number={4}>  contrast: <strong>{light.contrast}</strong>,</CodeLine>
        <CodeLine number={5}>{"};"}</CodeLine>
      </div>
      <div className="appearance-code-pane appearance-code-pane-addition" style={previewStyle(dark, "dark")}>
        <CodeLine number={1}><b>const</b> themePreview: <em>ThemeConfig</em> = {"{"}</CodeLine>
        <CodeLine number={2}>  surface: <q>sidebar-elevated</q>,</CodeLine>
        <CodeLine number={3}>  accent: <q>{dark.accent}</q>,</CodeLine>
        <CodeLine number={4}>  contrast: <strong>{dark.contrast}</strong>,</CodeLine>
        <CodeLine number={5}>{"};"}</CodeLine>
      </div>
    </div>
  );
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  const valid = isHexColor(text);
  const commit = (next: string) => {
    const normalized = next.toUpperCase();
    setText(normalized);
    if (isHexColor(normalized)) onChange(normalized);
  };
  return (
    <div className="appearance-color-control">
      <label className="appearance-color-swatch" style={{ backgroundColor: value }}>
        <span className="sr-only">Choose {label.toLocaleLowerCase()}</span>
        <input
          type="color"
          value={value}
          onChange={(event) => commit(event.target.value)}
        />
      </label>
      <input
        aria-label={`${label} hex color`}
        aria-invalid={!valid}
        value={text}
        spellCheck={false}
        maxLength={7}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => {
          if (!valid) setText(value);
        }}
      />
    </div>
  );
}

function ThemeEditorRow({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="appearance-editor-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function ThemeEditor({
  scheme,
  variant,
  onChange,
}: {
  scheme: AppearanceScheme;
  variant: ThemeVariantConfig;
  onChange: (variant: ThemeVariantConfig) => void;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const update = <Key extends keyof ThemeVariantConfig>(key: Key, value: ThemeVariantConfig[Key]) => {
    onChange({ ...variant, [key]: value, preset: "custom" });
  };
  const importTheme = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 64 * 1024) throw new Error("Theme files must be smaller than 64 KB.");
      onChange(parseThemeVariantJson(await file.text(), scheme));
      toast.success(`${scheme === "light" ? "Light" : "Dark"} theme imported.`);
    } catch (error) {
      toast.error(errorMessage(error, "Aiden could not import that theme."));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const copyTheme = async () => {
    try {
      await navigator.clipboard.writeText(serializeThemeVariant(variant, scheme));
      toast.success(`${scheme === "light" ? "Light" : "Dark"} theme copied as JSON.`);
    } catch (error) {
      toast.error(errorMessage(error, "Aiden could not copy that theme."));
    }
  };
  const activePreset = variant.preset;
  return (
    <section className="appearance-editor-card" aria-labelledby={`appearance-${scheme}-title`}>
      <header className="appearance-editor-header">
        <h3 id={`appearance-${scheme}-title`}>{scheme === "light" ? "Light theme" : "Dark theme"}</h3>
        <div className="appearance-editor-actions">
          <input
            ref={fileRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            tabIndex={-1}
            onChange={(event) => void importTheme(event.target.files?.[0])}
          />
          <Button variant="transparent" size="small" onClick={() => fileRef.current?.click()}>
            <FileUp /> Import
          </Button>
          <Button variant="transparent" size="small" onClick={() => void copyTheme()}>
            <Copy /> Copy theme
          </Button>
          <Select
            value={activePreset}
            onValueChange={(value) => {
              if (value !== "custom") onChange(getPresetVariant(value as ThemePresetId, scheme));
            }}
          >
            <SelectTrigger size="small" className="appearance-preset-trigger" aria-label={`${scheme} theme preset`}>
              <span className="appearance-preset-glyph" style={{ backgroundColor: variant.accent }} />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variant.preset === "custom" ? <SelectItem value="custom" disabled>Custom</SelectItem> : null}
              {THEME_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <div className="appearance-editor-body">
        <ThemeEditorRow label="Accent">
          <ColorControl label="Accent" value={variant.accent} onChange={(value) => update("accent", value)} />
        </ThemeEditorRow>
        <ThemeEditorRow label="Background">
          <ColorControl label="Background" value={variant.background} onChange={(value) => update("background", value)} />
        </ThemeEditorRow>
        <ThemeEditorRow label="Foreground">
          <ColorControl label="Foreground" value={variant.foreground} onChange={(value) => update("foreground", value)} />
        </ThemeEditorRow>
        <ThemeEditorRow label="UI font">
          <Select value={variant.uiFont} onValueChange={(value) => update("uiFont", value as UiFontId)}>
            <SelectTrigger size="small" className="appearance-value-select" aria-label={`${scheme} UI font`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_FONT_OPTIONS.map((font) => <SelectItem key={font.id} value={font.id}>{font.label} · {font.preview}</SelectItem>)}
            </SelectContent>
          </Select>
        </ThemeEditorRow>
        <ThemeEditorRow label="Code font">
          <Select value={variant.codeFont} onValueChange={(value) => update("codeFont", value as CodeFontId)}>
            <SelectTrigger size="small" className="appearance-value-select appearance-code-font" aria-label={`${scheme} code font`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_FONT_OPTIONS.map((font) => <SelectItem key={font.id} value={font.id}>{font.label} · {font.preview}</SelectItem>)}
            </SelectContent>
          </Select>
        </ThemeEditorRow>
        <ThemeEditorRow label="Translucent sidebar">
          <Switch
            checked={variant.translucentSidebar}
            onCheckedChange={(checked) => update("translucentSidebar", checked)}
            aria-label={`${scheme} translucent sidebar`}
          />
        </ThemeEditorRow>
        <ThemeEditorRow label="Contrast">
          <div className="appearance-range-control">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={variant.contrast}
              aria-label={`${scheme} theme contrast`}
              onChange={(event) => update("contrast", Number(event.target.value))}
            />
            <output>{variant.contrast}</output>
          </div>
        </ThemeEditorRow>
      </div>
    </section>
  );
}

function PreferenceRow({
  label,
  description,
  children,
}: React.PropsWithChildren<{ label: string; description?: string }>) {
  return (
    <div className="appearance-preference-row">
      <div>
        <div className="appearance-preference-label">{label}</div>
        {description ? <div className="appearance-preference-description">{description}</div> : null}
      </div>
      <div className="appearance-preference-control">{children}</div>
    </div>
  );
}

function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="appearance-segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleRadioNavigation(event, index, options, onChange)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Preferences({
  config,
  disabled,
  dockPending,
  onChange,
  onDockChange,
}: {
  config: AppearanceConfig;
  disabled: boolean;
  dockPending: boolean;
  onChange: (patch: Partial<AppearanceConfig>) => void;
  onDockChange: (preference: DockIconPreference) => void;
}) {
  return (
    <section
      className="appearance-preferences"
      aria-labelledby="appearance-preferences-title"
      aria-disabled={disabled || undefined}
      inert={disabled ? true : undefined}
    >
      <h2 id="appearance-preferences-title">Preferences</h2>
      <div className="appearance-preferences-card">
        <PreferenceRow label="Use pointer cursors" description="Show a pointer when hovering over interactive elements.">
          <Switch checked={config.pointerCursors} onCheckedChange={(checked) => onChange({ pointerCursors: checked })} aria-label="Use pointer cursors" />
        </PreferenceRow>
        <PreferenceRow label="Dock icon" description="Choose the icon Aiden uses in the macOS Dock.">
          <div className="appearance-dock-options" role="radiogroup" aria-label="Dock icon">
            {([
              { value: "aiden", label: "Color Aiden Dock icon", src: AIDEN_DOCK_ICON_URL },
              { value: "monochrome", label: "Monochrome Aiden Dock icon", src: MONOCHROME_DOCK_ICON_URL },
            ] satisfies ReadonlyArray<{ value: DockIconPreference; label: string; src: string }>).map((option, index, options) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-label={option.label}
                aria-checked={config.dockIcon === option.value}
                disabled={dockPending}
                tabIndex={config.dockIcon === option.value ? 0 : -1}
                onClick={() => onDockChange(option.value)}
                onKeyDown={(event) => handleRadioNavigation(event, index, options, onDockChange)}
              >
                <img src={option.src} alt="" />
              </button>
            ))}
          </div>
        </PreferenceRow>
        <PreferenceRow label="Reduce motion" description="Reduce animations or match the macOS preference.">
          <SegmentedControl<ReduceMotionPreference>
            label="Reduce motion"
            value={config.reduceMotion}
            options={[
              { value: "system", label: "System" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            onChange={(value) => onChange({ reduceMotion: value })}
          />
        </PreferenceRow>
        <PreferenceRow label="UI font size" description="Adjust the base size used throughout Aiden.">
          <label className="appearance-number-control">
            <span className="sr-only">UI font size</span>
            <input type="number" min={12} max={18} value={config.uiFontSize} onChange={(event) => onChange({ uiFontSize: Number(event.target.value) })} />
            <span>px</span>
          </label>
        </PreferenceRow>
        <PreferenceRow label="Code font size" description="Adjust code in chats, diffs, files, and terminals.">
          <label className="appearance-number-control">
            <span className="sr-only">Code font size</span>
            <input type="number" min={10} max={18} value={config.codeFontSize} onChange={(event) => onChange({ codeFontSize: Number(event.target.value) })} />
            <span>px</span>
          </label>
        </PreferenceRow>
        <PreferenceRow label="Diff markers" description="Show changes with color alone or add explicit +/− markers.">
          <SegmentedControl<DiffMarkerPreference>
            label="Diff markers"
            value={config.diffMarkers}
            options={[
              { value: "color", label: "Color" },
              { value: "symbols", label: "+/−" },
            ]}
            onChange={(value) => onChange({ diffMarkers: value })}
          />
        </PreferenceRow>
        <PreferenceRow label="Font smoothing" description="Use native macOS font anti-aliasing.">
          <Switch checked={config.fontSmoothing} onCheckedChange={(checked) => onChange({ fontSmoothing: checked })} aria-label="Font smoothing" />
        </PreferenceRow>
      </div>
    </section>
  );
}

export function AppearanceSettings() {
  const [config, setConfig] = React.useState<AppearanceConfig>(() => readCachedAppearance() ?? createDefaultAppearanceConfig());
  const [hydrated, setHydrated] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [modePending, setModePending] = React.useState(false);
  const [dockPending, setDockPending] = React.useState(false);
  const configRef = React.useRef(config);
  const nativeInfoRef = React.useRef<NativeThemeInfo | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = React.useRef<{
    config: AppearanceConfig;
    revision: number;
  } | null>(null);
  const dirtyRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const safetyIssues = React.useMemo(() => appearanceSafetyIssues(config), [config]);
  const hasSafetyIssues = safetyIssues.length > 0;
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
          toast.error(errorMessage(error, "The theme changed, but Aiden could not refresh the macOS appearance state."));
        }
      }
    }).finally(() => {
      if (mountedRef.current) setModePending(false);
    });
  };

  const changeDock = (dockIcon: DockIconPreference) => {
    if (dockPending || dockIcon === configRef.current.dockIcon || appearanceSafetyIssues(configRef.current).length > 0) return;
    const revision = beginAppearanceIntent();
    setDockPending(true);
    void runAppearanceIntent(revision, async (isCurrent) => {
      try {
        const applied = await appApi.setDockIcon(dockIcon);
        if (!applied) throw new Error("Dock icons are unavailable on this platform.");
        if (!isCurrent()) {
          await appApi.setDockIcon(configRef.current.dockIcon);
          return;
        }
        update((current) => ({ ...current, dockIcon }), revision);
      } catch (error) {
        if (isCurrent()) {
          toast.error(errorMessage(error, "Aiden could not change the Dock preference."));
          announceAppearanceIntentFailure(revision);
        }
      }
    }).finally(() => {
      if (mountedRef.current) setDockPending(false);
    });
  };

  return (
    <div className="appearance-page" aria-busy={!hydrated} inert={!hydrated ? true : undefined}>
      <div className="appearance-heading">
        <h1>Appearance</h1>
        <p>Shape Aiden’s light and dark interfaces independently. Changes apply live.</p>
      </div>

      {safetyIssues.length > 0 ? (
        <div className="appearance-page-status" role="alert">
          <div>
            <strong>These colors are not readable yet.</strong>
            <ul>{safetyIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            <div>Live preview and saving are paused; choose safer colors or restore a preset.</div>
          </div>
        </div>
      ) : null}

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
        <ThemeModePicker value={config.mode} disabled={hasSafetyIssues || modePending} onChange={changeMode} />
        <ThemeCodePreview light={config.light} dark={config.dark} />
        <div className="appearance-theme-editors">
          <ThemeEditor scheme="light" variant={config.light} onChange={(light) => update((current) => ({ ...current, light }))} />
          <ThemeEditor scheme="dark" variant={config.dark} onChange={(dark) => update((current) => ({ ...current, dark }))} />
        </div>
      </section>

      <Preferences
        config={config}
        disabled={hasSafetyIssues}
        dockPending={dockPending}
        onChange={(patch) => update((current) => ({ ...current, ...patch }))}
        onDockChange={changeDock}
      />
    </div>
  );
}
