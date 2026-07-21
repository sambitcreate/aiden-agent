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

export interface AppliedAppearance {
  config: AppearanceConfig;
  scheme: AppearanceScheme;
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
  const detail: AppliedAppearance = { config, scheme };
  queueMicrotask(() => {
    window.dispatchEvent(new CustomEvent<AppliedAppearance>(APPEARANCE_CHANGE_EVENT, { detail }));
  });
  return { config, scheme };
}

export function applyCachedAppearance(): AppliedAppearance {
  const cached = readCachedAppearance() ?? createDefaultAppearanceConfig();
  return applyAppearanceConfig(cached);
}
