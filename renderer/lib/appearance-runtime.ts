import {
  codeFontStack,
  createDefaultAppearanceConfig,
  getPresetVariant,
  normalizeAppearanceConfig,
  resolveThemeTokens,
  themeVariantSafetyIssues,
  uiFontStack,
  type AppearanceConfig,
  type AppearanceScheme,
} from "../shared/appearance";

export const APPEARANCE_STORAGE_KEY = "aiden-agent.appearance-v1";
export const APPEARANCE_CHANGE_EVENT = "aiden:appearance-changed";
export const APPEARANCE_INTENT_FAILED_EVENT = "aiden:appearance-intent-failed";

export interface AppliedAppearance {
  config: AppearanceConfig;
  scheme: AppearanceScheme;
  systemHighContrast: boolean;
}

export interface NativeAppearanceSignal {
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors?: boolean;
  themeSource?: AppearanceConfig["mode"];
}

export interface ReconciledNativeAppearance {
  config: AppearanceConfig;
  nativeUsesDarkColors: boolean;
  systemHighContrast: boolean;
}

export interface NativeAppearanceRevisionTracker {
  markChanged(): void;
  readStable<Info>(read: () => Promise<Info>): Promise<Info>;
}

export interface ReconciledRuntimeAppearance {
  config: AppearanceConfig;
  supersedesPending: boolean;
}

let appearanceIntentRevision = 0;
let appearanceIntentTail = Promise.resolve();

/** Claim ownership for a user-authored appearance change. */
export function beginAppearanceIntent(): number {
  appearanceIntentRevision += 1;
  return appearanceIntentRevision;
}

export function readAppearanceIntentRevision(): number {
  return appearanceIntentRevision;
}

export function isAppearanceIntentCurrent(revision: number): boolean {
  return revision === appearanceIntentRevision;
}

/**
 * Serialize persistence/native mutations across Command-K and full Settings.
 * A newer optimistic intent invalidates queued older work; work already inside
 * an await receives a guard so it cannot roll back over its successor.
 */
export function runAppearanceIntent<Result>(
  revision: number,
  operation: (isCurrent: () => boolean) => Promise<Result>,
): Promise<Result | undefined> {
  const run = async (): Promise<Result | undefined> => {
    if (!isAppearanceIntentCurrent(revision)) return undefined;
    return operation(() => isAppearanceIntentCurrent(revision));
  };
  const task = appearanceIntentTail.then(run, run);
  appearanceIntentTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function createNativeAppearanceRevisionTracker(): NativeAppearanceRevisionTracker {
  let revision = 0;
  return {
    markChanged() {
      revision += 1;
    },
    async readStable<Info>(read: () => Promise<Info>): Promise<Info> {
      while (true) {
        const startedAt = revision;
        const info = await read();
        if (startedAt === revision) return info;
      }
    },
  };
}

export function reconcileRuntimeAppearanceEvent(
  config: AppearanceConfig,
  pendingRevision: number | null,
  currentRevision: number,
): ReconciledRuntimeAppearance {
  return {
    config: normalizeAppearanceConfig(config),
    supersedesPending:
      pendingRevision !== null && pendingRevision !== currentRevision,
  };
}

export function rebaseAppearanceIntentAfterFailure(
  pendingRevision: number | null,
  failedRevision: number,
  currentRevision: number,
): number | null {
  if (
    pendingRevision === null ||
    pendingRevision === failedRevision ||
    failedRevision !== currentRevision
  ) {
    return null;
  }
  return beginAppearanceIntent();
}

export function announceAppearanceIntentFailure(revision: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ revision: number }>(
      APPEARANCE_INTENT_FAILED_EVENT,
      { detail: { revision } },
    ),
  );
}

/**
 * Native theme notifications also fire for programmatic setThemeSource calls.
 * Treat them as environment signals only: the intent-owned appearance config
 * remains authoritative, so a delayed notification cannot restore an old mode.
 */
export function reconcileNativeThemeChange(
  config: AppearanceConfig,
  signal: NativeAppearanceSignal,
): ReconciledNativeAppearance | null {
  const normalized = normalizeAppearanceConfig(config);
  if (
    signal.themeSource !== undefined &&
    signal.themeSource !== normalized.mode
  ) {
    return null;
  }
  return {
    config: normalized,
    nativeUsesDarkColors: signal.shouldUseDarkColors,
    systemHighContrast: signal.shouldUseHighContrastColors === true,
  };
}

function systemUsesDarkColors(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

function systemUsesReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function effectiveAppearanceScheme(
  config: AppearanceConfig,
  nativeUsesDarkColors = systemUsesDarkColors(),
): AppearanceScheme {
  if (config.mode === "light") return "light";
  if (config.mode === "dark") return "dark";
  return nativeUsesDarkColors ? "dark" : "light";
}

export function readCachedAppearance(): AppearanceConfig | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return value ? normalizeAppearanceConfig(JSON.parse(value) as unknown) : null;
  } catch {
    return null;
  }
}

export function cacheAppearance(config: AppearanceConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Appearance still works for the current window when storage is unavailable.
  }
}

export function applyAppearanceConfig(
  value: AppearanceConfig,
  nativeUsesDarkColors = systemUsesDarkColors(),
  systemHighContrast = false,
): AppliedAppearance {
  const config = normalizeAppearanceConfig(value);
  const scheme = effectiveAppearanceScheme(config, nativeUsesDarkColors);
  const requestedVariant = config[scheme];
  const variant = themeVariantSafetyIssues(requestedVariant, scheme).length === 0
    ? requestedVariant
    : getPresetVariant("aiden", scheme);
  const root = document.documentElement;
  const tokens = resolveThemeTokens(variant, scheme, systemHighContrast);

  root.classList.toggle("dark", scheme === "dark");
  root.style.colorScheme = scheme;
  root.dataset.appearanceMode = config.mode;
  root.dataset.appearanceScheme = scheme;
  root.dataset.theme = variant.preset;
  root.dataset.pointerCursors = String(config.pointerCursors);
  root.dataset.diffMarkers = config.diffMarkers;
  root.dataset.fontSmoothing = String(config.fontSmoothing);
  root.dataset.sidebarTranslucent = String(variant.translucentSidebar);
  root.dataset.reduceMotionPreference = config.reduceMotion;
  const reduceMotion = config.reduceMotion === "on"
    || (config.reduceMotion === "system" && systemUsesReducedMotion());
  root.dataset.reduceMotion = String(reduceMotion);
  root.style.setProperty("--font-ui-family", uiFontStack(variant.uiFont));
  root.style.setProperty("--font-code-family", codeFontStack(variant.codeFont));
  root.style.setProperty("--ui-font-size", `${config.uiFontSize}px`);
  root.style.setProperty("--code-font-size", `${config.codeFontSize}px`);
  for (const [name, token] of Object.entries(tokens)) root.style.setProperty(name, token);

  const themeColor = tokens["--theme-canvas"];
  let metaThemeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement("meta");
    metaThemeColor.name = "theme-color";
    document.head.appendChild(metaThemeColor);
  }
  metaThemeColor.content = themeColor;

  cacheAppearance(config);
  const detail: AppliedAppearance = { config, scheme, systemHighContrast };
  queueMicrotask(() => {
    window.dispatchEvent(new CustomEvent<AppliedAppearance>(APPEARANCE_CHANGE_EVENT, { detail }));
  });
  return detail;
}

export function applyCachedAppearance(): AppliedAppearance {
  const cached = readCachedAppearance() ?? createDefaultAppearanceConfig();
  return applyAppearanceConfig(cached);
}
