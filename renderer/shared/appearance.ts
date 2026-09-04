export type AppearanceMode = "system" | "light" | "dark";
export type AppearanceScheme = "light" | "dark";
export type ThemePresetId = "aiden" | "slate" | "berry" | "moss";
export type ThemeSelection = ThemePresetId | "custom";
export type UiFontId = "system" | "rounded" | "humanist";
export type CodeFontId = "sf-mono" | "menlo" | "monaco";
export type ReduceMotionPreference = "system" | "on" | "off";
export type DiffMarkerPreference = "color" | "symbols";
export type DockIconPreference = "aiden" | "monochrome";

export interface ThemeVariantConfig {
  preset: ThemeSelection;
  accent: string;
  background: string;
  foreground: string;
  uiFont: UiFontId;
  codeFont: CodeFontId;
  translucentSidebar: boolean;
  contrast: number;
}

export interface AppearanceConfig {
  version: 1;
  mode: AppearanceMode;
  light: ThemeVariantConfig;
  dark: ThemeVariantConfig;
  pointerCursors: boolean;
  dockIcon: DockIconPreference;
  reduceMotion: ReduceMotionPreference;
  uiFontSize: number;
  codeFontSize: number;
  diffMarkers: DiffMarkerPreference;
  fontSmoothing: boolean;
}

export interface AppearancePreviewSnapshot {
  appearance: AppearanceConfig;
  pending: boolean;
}

interface ThemePalette {
  canvas: string;
  sidebar: string;
  raised: string;
  foreground: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

interface ThemePreset {
  id: ThemePresetId;
  label: string;
  light: ThemePalette;
  dark: ThemePalette;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const APPEARANCE_VERSION = 1 as const;

export const UI_FONT_OPTIONS: ReadonlyArray<{ id: UiFontId; label: string; preview: string }> = [
  { id: "system", label: "System", preview: "-apple-system, BlinkMacSystemFont" },
  { id: "rounded", label: "Rounded", preview: "SF Pro Rounded" },
  { id: "humanist", label: "Humanist", preview: "Avenir Next" },
];

export const CODE_FONT_OPTIONS: ReadonlyArray<{ id: CodeFontId; label: string; preview: string }> = [
  { id: "sf-mono", label: "SF Mono", preview: "ui-monospace, SFMono-Regular" },
  { id: "menlo", label: "Menlo", preview: "Menlo, Monaco" },
  { id: "monaco", label: "Monaco", preview: "Monaco, Menlo" },
];

export const THEME_PRESETS: ReadonlyArray<ThemePreset> = [
  {
    id: "aiden",
    label: "Aiden",
    light: {
      canvas: "#F6F7F9",
      sidebar: "#EEF0F3",
      raised: "#FFFFFF",
      foreground: "#3D3F41",
      secondary: "#6B7280",
      accent: "#006AD6",
      success: "#30D158",
      warning: "#FF9F0A",
      danger: "#FF453A",
    },
    dark: {
      canvas: "#181B21",
      sidebar: "#20242C",
      raised: "#292E37",
      foreground: "#D1D4DA",
      secondary: "#9AA3AE",
      accent: "#3E97F6",
      success: "#32D17A",
      warning: "#FFB020",
      danger: "#FF5E57",
    },
  },
  {
    id: "slate",
    label: "Slate",
    light: {
      canvas: "#F2F5F9",
      sidebar: "#E6EBF2",
      raised: "#FFFFFF",
      foreground: "#3A434E",
      secondary: "#637083",
      accent: "#087581",
      success: "#2DB67D",
      warning: "#E0A72E",
      danger: "#E24D5B",
    },
    dark: {
      canvas: "#181E26",
      sidebar: "#202833",
      raised: "#29323E",
      foreground: "#D1D6DE",
      secondary: "#94A3BB",
      accent: "#21A9BE",
      success: "#35C08A",
      warning: "#D4A72C",
      danger: "#F87171",
    },
  },
  {
    id: "berry",
    label: "Berry",
    light: {
      canvas: "#FBF4F7",
      sidebar: "#F1E8EE",
      raised: "#FFFFFF",
      foreground: "#443F4A",
      secondary: "#6E6470",
      accent: "#B42C70",
      success: "#22C7A8",
      warning: "#E3A23C",
      danger: "#E24C5A",
    },
    dark: {
      canvas: "#1D1822",
      sidebar: "#251D2B",
      raised: "#2E2435",
      foreground: "#D5CFD6",
      secondary: "#A39AA6",
      accent: "#E8629F",
      success: "#32D1B2",
      warning: "#D9A441",
      danger: "#F0717A",
    },
  },
  {
    id: "moss",
    label: "Moss",
    light: {
      canvas: "#F3F6F4",
      sidebar: "#E7ECE8",
      raised: "#FFFFFF",
      foreground: "#3F4943",
      secondary: "#65736B",
      accent: "#157862",
      success: "#3DBF7D",
      warning: "#D4A22A",
      danger: "#E05353",
    },
    dark: {
      canvas: "#18201C",
      sidebar: "#202A25",
      raised: "#29342E",
      foreground: "#D1D6D3",
      secondary: "#95A39B",
      accent: "#42B596",
      success: "#47D18C",
      warning: "#D9B43A",
      danger: "#EB6B6B",
    },
  },
];

const PRESETS_BY_ID = Object.fromEntries(
  THEME_PRESETS.map((preset) => [preset.id, preset]),
) as Record<ThemePresetId, ThemePreset>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cloneVariant(value: ThemeVariantConfig): ThemeVariantConfig {
  return { ...value };
}

export function getPresetVariant(id: ThemePresetId, scheme: AppearanceScheme): ThemeVariantConfig {
  const palette = PRESETS_BY_ID[id][scheme];
  return {
    preset: id,
    accent: palette.accent,
    background: palette.canvas,
    foreground: palette.foreground,
    uiFont: "system",
    codeFont: "sf-mono",
    translucentSidebar: true,
    contrast: scheme === "light" ? 45 : 60,
  };
}

const DEFAULT_APPEARANCE: AppearanceConfig = {
  version: APPEARANCE_VERSION,
  mode: "system",
  light: getPresetVariant("aiden", "light"),
  dark: getPresetVariant("aiden", "dark"),
  pointerCursors: false,
  dockIcon: "aiden",
  reduceMotion: "system",
  uiFontSize: 14,
  codeFontSize: 12,
  diffMarkers: "symbols",
  fontSmoothing: true,
};

export function createDefaultAppearanceConfig(): AppearanceConfig {
  return {
    ...DEFAULT_APPEARANCE,
    light: cloneVariant(DEFAULT_APPEARANCE.light),
    dark: cloneVariant(DEFAULT_APPEARANCE.dark),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemePresetId(value: unknown): value is ThemePresetId {
  return value === "aiden" || value === "slate" || value === "berry" || value === "moss";
}

function isUiFontId(value: unknown): value is UiFontId {
  return value === "system" || value === "rounded" || value === "humanist";
}

function isCodeFontId(value: unknown): value is CodeFontId {
  return value === "sf-mono" || value === "menlo" || value === "monaco";
}

function normalizeVariant(value: unknown, fallback: ThemeVariantConfig): ThemeVariantConfig {
  if (!isRecord(value)) return cloneVariant(fallback);
  const preset = value.preset === "custom" || isThemePresetId(value.preset)
    ? value.preset
    : fallback.preset;
  return {
    preset,
    accent: typeof value.accent === "string" && HEX_COLOR.test(value.accent)
      ? value.accent.toUpperCase()
      : fallback.accent,
    background: typeof value.background === "string" && HEX_COLOR.test(value.background)
      ? value.background.toUpperCase()
      : fallback.background,
    foreground: typeof value.foreground === "string" && HEX_COLOR.test(value.foreground)
      ? value.foreground.toUpperCase()
      : fallback.foreground,
    uiFont: isUiFontId(value.uiFont) ? value.uiFont : fallback.uiFont,
    codeFont: isCodeFontId(value.codeFont) ? value.codeFont : fallback.codeFont,
    translucentSidebar: typeof value.translucentSidebar === "boolean"
      ? value.translucentSidebar
      : fallback.translucentSidebar,
    contrast: typeof value.contrast === "number" && Number.isFinite(value.contrast)
      ? clamp(Math.round(value.contrast), 0, 100)
      : fallback.contrast,
  };
}

function normalizeStoredVariant(
  value: unknown,
  fallback: ThemeVariantConfig,
  scheme: AppearanceScheme,
): ThemeVariantConfig {
  if (isRecord(value) && isThemePresetId(value.preset)) {
    return getPresetVariant(value.preset, scheme);
  }
  return normalizeVariant(value, fallback);
}

export function normalizeAppearanceConfig(value: unknown): AppearanceConfig {
  const fallback = createDefaultAppearanceConfig();
  if (!isRecord(value)) return fallback;
  return {
    version: APPEARANCE_VERSION,
    mode: value.mode === "light" || value.mode === "dark" || value.mode === "system"
      ? value.mode
      : fallback.mode,
    light: normalizeStoredVariant(value.light, fallback.light, "light"),
    dark: normalizeStoredVariant(value.dark, fallback.dark, "dark"),
    pointerCursors: typeof value.pointerCursors === "boolean"
      ? value.pointerCursors
      : fallback.pointerCursors,
    dockIcon: value.dockIcon === "monochrome" || value.dockIcon === "aiden"
      ? value.dockIcon
      : fallback.dockIcon,
    reduceMotion: value.reduceMotion === "on" || value.reduceMotion === "off" || value.reduceMotion === "system"
      ? value.reduceMotion
      : fallback.reduceMotion,
    uiFontSize: typeof value.uiFontSize === "number" && Number.isFinite(value.uiFontSize)
      ? clamp(Math.round(value.uiFontSize), 12, 18)
      : fallback.uiFontSize,
    codeFontSize: typeof value.codeFontSize === "number" && Number.isFinite(value.codeFontSize)
      ? clamp(Math.round(value.codeFontSize), 10, 18)
      : fallback.codeFontSize,
    diffMarkers: value.diffMarkers === "symbols" || value.diffMarkers === "color"
      ? value.diffMarkers
      : fallback.diffMarkers,
    fontSmoothing: typeof value.fontSmoothing === "boolean"
      ? value.fontSmoothing
      : fallback.fontSmoothing,
  };
}

export function parseAppearanceConfig(value: unknown): AppearanceConfig {
  if (!isRecord(value)) throw new Error("Appearance settings must be an object.");
  if (value.version !== undefined && value.version !== APPEARANCE_VERSION) {
    throw new Error("Appearance settings use an unsupported version.");
  }
  const required = [
    "mode",
    "light",
    "dark",
    "pointerCursors",
    "dockIcon",
    "reduceMotion",
    "uiFontSize",
    "codeFontSize",
    "diffMarkers",
    "fontSmoothing",
  ];
  if (required.some((key) => !(key in value))) {
    throw new Error("Appearance settings are incomplete.");
  }
  const normalized = normalizeAppearanceConfig(value);
  const verifyVariant = (variant: unknown, label: string) => {
    if (!isRecord(variant)) throw new Error(`${label} theme must be an object.`);
    for (const key of ["accent", "background", "foreground"]) {
      if (typeof variant[key] !== "string" || !HEX_COLOR.test(variant[key] as string)) {
        throw new Error(`${label} theme has an invalid ${key} color.`);
      }
    }
    if (variant.preset !== "custom" && !isThemePresetId(variant.preset)) {
      throw new Error(`${label} theme has an unsupported preset.`);
    }
    if (!isUiFontId(variant.uiFont) || !isCodeFontId(variant.codeFont)) {
      throw new Error(`${label} theme has an unsupported font selection.`);
    }
    if (typeof variant.translucentSidebar !== "boolean") {
      throw new Error(`${label} theme has an invalid sidebar preference.`);
    }
    if (typeof variant.contrast !== "number" || !Number.isFinite(variant.contrast) || variant.contrast < 0 || variant.contrast > 100) {
      throw new Error(`${label} theme contrast must be between 0 and 100.`);
    }
  };
  verifyVariant(value.light, "Light");
  verifyVariant(value.dark, "Dark");
  const lightSafetyIssues = themeVariantSafetyIssues(normalized.light, "light");
  const darkSafetyIssues = themeVariantSafetyIssues(normalized.dark, "dark");
  if (lightSafetyIssues.length > 0 || darkSafetyIssues.length > 0) {
    throw new Error([...lightSafetyIssues, ...darkSafetyIssues].join(" "));
  }
  if (typeof value.pointerCursors !== "boolean" || typeof value.fontSmoothing !== "boolean") {
    throw new Error("Appearance toggle preferences must be boolean values.");
  }
  if (normalized.mode !== value.mode || normalized.dockIcon !== value.dockIcon || normalized.reduceMotion !== value.reduceMotion || normalized.diffMarkers !== value.diffMarkers) {
    throw new Error("Appearance settings contain an unsupported option.");
  }
  if (normalized.uiFontSize !== value.uiFontSize || normalized.codeFontSize !== value.codeFontSize) {
    throw new Error("Appearance font sizes are outside the supported range.");
  }
  return normalized;
}

export function parseThemeVariantJson(text: string, scheme: AppearanceScheme): ThemeVariantConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("The theme file must contain an object.");
  if (value.version !== undefined && value.version !== APPEARANCE_VERSION) {
    throw new Error("The theme file uses an unsupported version.");
  }
  if (value.scheme !== undefined && value.scheme !== scheme) {
    throw new Error(`This is a ${String(value.scheme)} theme, not a ${scheme} theme.`);
  }
  const candidate = isRecord(value.theme) ? value.theme : value;
  for (const key of ["accent", "background", "foreground"]) {
    if (typeof candidate[key] !== "string" || !HEX_COLOR.test(candidate[key] as string)) {
      throw new Error(`The theme has an invalid ${key} color.`);
    }
  }
  if (!isUiFontId(candidate.uiFont) || !isCodeFontId(candidate.codeFont)) {
    throw new Error("The theme has an unsupported font selection.");
  }
  if (typeof candidate.translucentSidebar !== "boolean") {
    throw new Error("The theme has an invalid sidebar preference.");
  }
  if (
    typeof candidate.contrast !== "number"
    || !Number.isFinite(candidate.contrast)
    || candidate.contrast < 0
    || candidate.contrast > 100
  ) {
    throw new Error("Theme contrast must be between 0 and 100.");
  }
  if (candidate.preset !== undefined && candidate.preset !== "custom" && !isThemePresetId(candidate.preset)) {
    throw new Error("The theme has an unsupported preset.");
  }
  const normalized = normalizeVariant(candidate, getPresetVariant("aiden", scheme));
  const claimedPreset = isThemePresetId(candidate.preset) ? candidate.preset : null;
  const claimedPresetValues = claimedPreset ? getPresetVariant(claimedPreset, scheme) : null;
  const matchesClaimedPreset = claimedPresetValues !== null
    && ([
      "accent",
      "background",
      "foreground",
      "uiFont",
      "codeFont",
      "translucentSidebar",
      "contrast",
    ] as const).every((key) => normalized[key] === claimedPresetValues[key]);
  const result: ThemeVariantConfig = {
    ...normalized,
    preset: matchesClaimedPreset && claimedPreset ? claimedPreset : "custom",
  };
  const safetyIssues = themeVariantSafetyIssues(result, scheme);
  if (safetyIssues.length > 0) throw new Error(safetyIssues.join(" "));
  return result;
}

export function serializeThemeVariant(variant: ThemeVariantConfig, scheme: AppearanceScheme): string {
  return JSON.stringify(
    {
      version: APPEARANCE_VERSION,
      scheme,
      theme: variant,
    },
    null,
    2,
  );
}

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

function hexToRgb(hex: string): Rgb {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function channelHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function rgbToHex(value: Rgb): string {
  return `#${channelHex(value.red)}${channelHex(value.green)}${channelHex(value.blue)}`.toUpperCase();
}

function mixHex(from: string, to: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const weight = clamp(amount, 0, 1);
  return rgbToHex({
    red: a.red + (b.red - a.red) * weight,
    green: a.green + (b.green - a.green) * weight,
    blue: a.blue + (b.blue - a.blue) * weight,
  });
}

function alphaHex(hex: string, alpha: number): string {
  const { red, green, blue } = hexToRgb(hex);
  return `rgb(${red} ${green} ${blue} / ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function minimumContrastRatio(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => colorContrastRatio(color, surface)));
}

/**
 * Preserve the requested hue when possible, then move it only as far toward
 * black or white as needed to remain readable on every application surface.
 * Valid custom themes always provide at least one readable accent fallback,
 * so semantic roles can recover from a palette collision without rejecting
 * otherwise-safe user-selected primitives.
 */
function contrastCorrectColor(
  preferred: string,
  surfaces: readonly string[],
  minimum: number,
  fallbacks: readonly string[] = [],
): string {
  const normalized = mixHex(preferred, preferred, 0);
  if (minimumContrastRatio(normalized, surfaces) >= minimum) return normalized;

  const steps = 256;
  for (let index = 1; index <= steps; index += 1) {
    const amount = index / steps;
    const candidates = [
      mixHex(normalized, "#000000", amount),
      mixHex(normalized, "#FFFFFF", amount),
    ].filter((candidate) => minimumContrastRatio(candidate, surfaces) >= minimum);
    if (candidates.length > 0) {
      return candidates.sort(
        (left, right) =>
          minimumContrastRatio(right, surfaces) - minimumContrastRatio(left, surfaces),
      )[0];
    }
  }

  const fallbackCandidates = [
    ...fallbacks.map((candidate) => mixHex(candidate, candidate, 0)),
    "#000000",
    "#FFFFFF",
  ];
  const readableFallback = fallbackCandidates.find(
    (candidate) => minimumContrastRatio(candidate, surfaces) >= minimum,
  );
  if (readableFallback) return readableFallback;
  return fallbackCandidates.sort(
    (left, right) =>
      minimumContrastRatio(right, surfaces) - minimumContrastRatio(left, surfaces),
  )[0];
}

function foregroundForFill(
  fill: string,
  scheme: AppearanceScheme,
): string {
  const preferred = scheme === "light" ? "#FFFFFF" : "#000000";
  const alternate = preferred === "#FFFFFF" ? "#000000" : "#FFFFFF";
  return colorContrastRatio(fill, preferred) >= 4.5 ? preferred : alternate;
}

function selectedPalette(variant: ThemeVariantConfig, scheme: AppearanceScheme): ThemePalette {
  return variant.preset === "custom"
    ? PRESETS_BY_ID.aiden[scheme]
    : PRESETS_BY_ID[variant.preset][scheme];
}

export function uiFontStack(id: UiFontId): string {
  if (id === "rounded") return '"SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
  if (id === "humanist") return '"Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, sans-serif';
  return '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
}

export function codeFontStack(id: CodeFontId): string {
  if (id === "menlo") return 'Menlo, Monaco, "Courier New", monospace';
  if (id === "monaco") return 'Monaco, Menlo, "Courier New", monospace';
  return 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
}

export function resolveThemeTokens(
  variant: ThemeVariantConfig,
  scheme: AppearanceScheme,
  systemHighContrast = false,
): Record<string, string> {
  const palette = selectedPalette(variant, scheme);
  const contrast = clamp((variant.contrast + (systemHighContrast ? 20 : 0)) / 100, 0, 1);
  const foreground = variant.foreground;
  const background = variant.background;
  const light = scheme === "light";
  const raised = variant.preset === "custom"
    ? mixHex(background, light ? "#FFFFFF" : foreground, light ? 0.72 : 0.08 + contrast * 0.04)
    : palette.raised;
  const sidebar = variant.preset === "custom"
    ? mixHex(background, foreground, 0.025 + contrast * (light ? 0.025 : 0.045))
    : palette.sidebar;
  // Use the same rounded alphas for contrast correction and emitted CSS,
  // including the system Increase Contrast increment.
  const controlAlpha = Number((0.055 + contrast * 0.065).toFixed(3));
  const inputAlpha = Number((0.035 + contrast * 0.035).toFixed(3));
  const wellAlpha = Number((0.018 + contrast * 0.024).toFixed(3));
  const controlTint = mixHex(background, foreground, controlAlpha);
  const selectionTint = mixHex(background, variant.accent, light ? 0.12 : 0.18);
  const wellTint = mixHex(raised, foreground, wellAlpha);
  const textSurfaces = [
    background,
    sidebar,
    raised,
    controlTint,
    selectionTint,
    wellTint,
  ] as const;
  const toolbarIcon = contrastCorrectColor(
    mixHex(foreground, "#FFFFFF", light ? 0.3 : 0.08),
    textSurfaces,
    3,
    [foreground, variant.accent],
  );
  const secondaryBase = contrastCorrectColor(
    variant.preset === "custom"
      ? mixHex(background, foreground, light ? 0.64 : 0.7)
      : palette.secondary,
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const textSecondary = contrastCorrectColor(
    mixHex(secondaryBase, foreground, 0.28),
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const textTertiary = contrastCorrectColor(
    mixHex(secondaryBase, foreground, 0.14),
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const textQuaternary = contrastCorrectColor(
    secondaryBase,
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const borderAlpha = 0.09 + contrast * 0.12;
  const accentForeground = colorContrastRatio(variant.accent, "#FFFFFF")
    >= colorContrastRatio(variant.accent, "#000000")
    ? "#FFFFFF"
    : "#000000";
  const accentContrastTarget = accentForeground === "#FFFFFF" ? "#000000" : "#FFFFFF";
  const accentHover = mixHex(
    variant.accent,
    accentContrastTarget,
    light ? 0.07 : 0.14,
  );
  const accentActive = mixHex(
    variant.accent,
    accentContrastTarget,
    light ? 0.14 : 0.22,
  );
  const supportRed = contrastCorrectColor(
    palette.danger,
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const supportGreen = contrastCorrectColor(
    palette.success,
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const supportWarning = contrastCorrectColor(
    palette.warning,
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const syntaxKeyword = contrastCorrectColor(
    light ? "#C83349" : "#FF7F8D",
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const syntaxString = contrastCorrectColor(
    light
      ? mixHex("#176B58", variant.accent, 0.12)
      : mixHex("#8CE0C6", variant.accent, 0.12),
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const syntaxNumber = contrastCorrectColor(
    light
      ? mixHex("#2D5BA7", variant.accent, 0.22)
      : mixHex("#92BFFF", variant.accent, 0.24),
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const syntaxTitle = contrastCorrectColor(
    light
      ? mixHex("#7546A8", variant.accent, 0.12)
      : mixHex("#D4A8FF", variant.accent, 0.12),
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );
  const syntaxVariable = contrastCorrectColor(
    light ? "#C45C19" : "#FFB06B",
    textSurfaces,
    4.75,
    [foreground, variant.accent],
  );

  // Colored status text is corrected against its own translucent fill, not
  // just the canvas. Keep hue where possible without relying on an outline.
  const statusTokens: Record<string, string> = {};
  for (const [tone, color] of Object.entries({
    accent: variant.accent, red: supportRed, green: supportGreen, warning: supportWarning,
  })) {
    statusTokens[`--status-${tone}-surface`] = alphaHex(color, 0.08);
    statusTokens[`--status-${tone}`] = contrastCorrectColor(
      mixHex(color, foreground, 0.35),
      textSurfaces.map((surface) => mixHex(surface, color, 0.08)),
      4.75,
      [foreground],
    );
  }

  return {
    ...statusTokens,
    "--text-primary": foreground,
    "--toolbar-icon": toolbarIcon,
    "--text-secondary": textSecondary,
    "--text-tertiary": textTertiary,
    "--text-quaternary": textQuaternary,
    "--surface-background": alphaHex(background, 0.94),
    "--surface-sidebar": alphaHex(sidebar, variant.translucentSidebar ? 0.78 : 1),
    "--surface-popover": raised,
    "--surface-context-bar": alphaHex(sidebar, 0.8),
    "--surface-control": alphaHex(foreground, controlAlpha),
    "--surface-control-hover": alphaHex(foreground, controlAlpha + 0.045),
    "--surface-control-active": alphaHex(foreground, controlAlpha + 0.1),
    "--surface-input": alphaHex(foreground, inputAlpha),
    "--surface-well": alphaHex(foreground, wellAlpha),
    "--surface-list-hover": alphaHex(foreground, 0.035 + contrast * 0.04),
    "--surface-list-selection": alphaHex(variant.accent, light ? 0.12 : 0.18),
    "--border-field": alphaHex(foreground, borderAlpha),
    "--border-separator": alphaHex(foreground, 0.055 + contrast * 0.07),
    "--accent": variant.accent,
    "--accent-foreground": accentForeground,
    "--accent-hover": accentHover,
    "--accent-active": accentActive,
    "--focus-ring": contrastCorrectColor(
      foreground,
      textSurfaces,
      3,
      [foreground],
    ),
    "--support-red": supportRed,
    "--support-red-foreground": foregroundForFill(supportRed, scheme),
    "--support-green": supportGreen,
    "--support-green-foreground": foregroundForFill(supportGreen, scheme),
    "--support-warning": supportWarning,
    "--support-warning-foreground": foregroundForFill(supportWarning, scheme),
    "--window-gradient-start": alphaHex(background, 0.98),
    "--window-gradient-end": alphaHex(mixHex(background, sidebar, 0.55), 0.94),
    "--glass-fill": alphaHex(sidebar, variant.translucentSidebar ? 0.68 : 0.96),
    "--syntax-comment": textTertiary,
    "--syntax-keyword": syntaxKeyword,
    "--syntax-string": syntaxString,
    "--syntax-number": syntaxNumber,
    "--syntax-title": syntaxTitle,
    "--syntax-variable": syntaxVariable,
    "--terminal-background": raised,
    "--terminal-foreground": foreground,
    "--terminal-cursor": variant.accent,
    "--terminal-selection": alphaHex(variant.accent, light ? 0.2 : 0.3),
    "--terminal-black": contrastCorrectColor(
      mixHex(background, foreground, light ? 0.18 : 0.1),
      textSurfaces,
      4.75,
      [foreground, variant.accent],
    ),
    "--terminal-red": supportRed,
    "--terminal-green": supportGreen,
    "--terminal-yellow": supportWarning,
    "--terminal-blue": contrastCorrectColor(
      mixHex(variant.accent, light ? "#233C75" : "#D8E7FF", 0.22),
      textSurfaces,
      4.75,
      [foreground, variant.accent],
    ),
    "--terminal-magenta": contrastCorrectColor(
      light ? "#895A9D" : "#DCBAFF",
      textSurfaces,
      4.75,
      [foreground, variant.accent],
    ),
    "--terminal-cyan": contrastCorrectColor(
      light ? "#367D8C" : "#91E9EE",
      textSurfaces,
      4.75,
      [foreground, variant.accent],
    ),
    "--terminal-white": contrastCorrectColor(
      light ? "#DDE2E8" : foreground,
      textSurfaces,
      4.75,
      [foreground, variant.accent],
    ),
    "--theme-canvas": background,
    "--theme-sidebar": sidebar,
    "--theme-raised": raised,
  };
}

function relativeLuminanceChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function colorContrastRatio(first: string, second: string): number {
  if (!HEX_COLOR.test(first) || !HEX_COLOR.test(second)) return 0;
  const luminance = (hex: string) => {
    const rgb = hexToRgb(hex);
    return 0.2126 * relativeLuminanceChannel(rgb.red)
      + 0.7152 * relativeLuminanceChannel(rgb.green)
      + 0.0722 * relativeLuminanceChannel(rgb.blue);
  };
  const a = luminance(first);
  const b = luminance(second);
  const lightest = Math.max(a, b);
  const darkest = Math.min(a, b);
  return (lightest + 0.05) / (darkest + 0.05);
}

export function themeVariantSafetyIssues(
  variant: ThemeVariantConfig,
  scheme: AppearanceScheme,
): string[] {
  const label = scheme === "light" ? "Light theme" : "Dark theme";
  const issues: string[] = [];
  const palette = selectedPalette(variant, scheme);
  const raised = variant.preset === "custom"
    ? mixHex(
        variant.background,
        scheme === "light" ? "#FFFFFF" : variant.foreground,
        scheme === "light" ? 0.72 : 0.12,
      )
    : palette.raised;
  const sidebar = variant.preset === "custom"
    ? mixHex(
        variant.background,
        variant.foreground,
        scheme === "light" ? 0.05 : 0.07,
      )
    : palette.sidebar;
  const textRatio = Math.min(
    colorContrastRatio(variant.foreground, variant.background),
    colorContrastRatio(variant.foreground, sidebar),
    colorContrastRatio(variant.foreground, raised),
  );
  if (textRatio < 4.5) {
    issues.push(`${label} foreground needs at least 4.5:1 contrast against its surfaces (currently ${textRatio.toFixed(2)}:1).`);
  }

  const weakestSurfaceRatio = Math.min(
    colorContrastRatio(variant.accent, variant.background),
    colorContrastRatio(variant.accent, sidebar),
    colorContrastRatio(variant.accent, raised),
  );
  if (weakestSurfaceRatio < 4.5) {
    issues.push(`${label} accent needs at least 4.5:1 contrast against its surfaces (currently ${weakestSurfaceRatio.toFixed(2)}:1).`);
  }

  const onAccentRatio = Math.max(
    colorContrastRatio(variant.accent, "#FFFFFF"),
    colorContrastRatio(variant.accent, "#000000"),
  );
  if (onAccentRatio < 4.5) {
    issues.push(`${label} accent cannot provide readable control text.`);
  }
  return issues;
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}
