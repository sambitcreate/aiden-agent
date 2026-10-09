/** Semantic tokens a sandboxed guest may read. Values are validated, never trusted. */
export const GENERATIVE_UI_THEME_VARIABLES = [
  "--text-primary", "--text-secondary", "--text-tertiary", "--text-quaternary",
  "--surface-background", "--surface-popover", "--surface-control", "--surface-control-hover",
  "--surface-well", "--surface-input", "--surface-list-hover", "--surface-list-selection",
  "--border-separator", "--border-field",
  "--accent", "--accent-foreground", "--accent-hover", "--focus-ring",
  "--status-accent", "--status-red", "--status-green", "--status-warning",
  "--status-accent-surface", "--status-red-surface", "--status-green-surface", "--status-warning-surface",
  "--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8",
  // Radii live in Tailwind's `@theme inline`, so they are usually absent at
  // runtime; the guest kit falls back to the same constants.
  "--radius-control", "--radius-button", "--radius-card", "--radius-pill",
  "--ui-font-size", "--font-ui-family", "--font-code-family",
  "--motion-duration", "--motion-easing",
] as const;

export type GenerativeUiThemeVariable = (typeof GENERATIVE_UI_THEME_VARIABLES)[number];

/**
 * Aiden's light defaults (renderer/styles.css :root), used when no renderer
 * theme is available — standalone export and older callers — so the kit's
 * status colors and the chart series never come out empty.
 */
export const GENERATIVE_UI_DEFAULT_THEME_VARS: Readonly<Record<string, string>> = {
  "--text-primary": "#3d3f41",
  "--text-secondary": "#545963",
  "--text-tertiary": "#595e69",
  "--text-quaternary": "#5d6370",
  "--surface-popover": "#ffffff",
  "--surface-control": "rgb(61 63 65 / 0.084)",
  "--surface-control-hover": "rgb(61 63 65 / 0.129)",
  "--surface-well": "rgb(61 63 65 / 0.029)",
  "--surface-input": "rgb(61 63 65 / 0.051)",
  "--surface-list-hover": "rgb(61 63 65 / 0.053)",
  "--surface-list-selection": "rgb(0 106 214 / 0.12)",
  "--border-separator": "rgb(61 63 65 / 0.087)",
  "--border-field": "rgb(61 63 65 / 0.144)",
  "--accent": "#006ad6",
  "--accent-foreground": "#ffffff",
  "--accent-hover": "#0063c7",
  "--focus-ring": "#3d3f41",
  "--status-accent": "#155ba2",
  "--status-red": "#8c3631",
  "--status-green": "#266036",
  "--status-warning": "#704f1a",
  "--status-accent-surface": "rgb(0 106 214 / 0.080)",
  "--status-red-surface": "rgb(182 49 41 / 0.080)",
  "--status-green-surface": "rgb(26 113 48 / 0.080)",
  "--status-warning-surface": "rgb(139 87 5 / 0.080)",
  "--chart-1": "#1e88c7",
  "--chart-2": "#1f9d63",
  "--chart-3": "#b98200",
  "--chart-4": "#e0544e",
  "--chart-5": "#8a5cf0",
  "--chart-6": "#138f88",
  "--chart-7": "#d64d86",
  "--chart-8": "#6f9a17",
};

const ALLOWED = new Set<string>(GENERATIVE_UI_THEME_VARIABLES);
const COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([#0-9a-z.,%/\s-]+\)|transparent)$/iu;
const LENGTH = /^-?\d+(\.\d+)?(px|rem|em|ms|s|%)?$/iu;
const EASING =
  /^(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\))$/iu;
const FONT_STACK = /^[a-z0-9 ,"'_-]+$/iu;

function safeValue(name: string, raw: string): string | undefined {
  // Authored stacks wrap across lines; computed custom properties keep that.
  const value = raw.replace(/\s+/gu, " ").trim();
  if (!value || value.length > 200) return undefined;
  if (name.startsWith("--font-")) return FONT_STACK.test(value) ? value : undefined;
  if (name === "--motion-easing") return EASING.test(value) ? value : undefined;
  if (name.startsWith("--radius-") || name === "--ui-font-size" || name === "--motion-duration") {
    return LENGTH.test(value) ? value : undefined;
  }
  if (!COLOR.test(value)) return undefined;
  return value.startsWith("#") ? value.toLowerCase() : value;
}

export function sanitizeGenerativeUiThemeVars(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED.has(name) || typeof raw !== "string") continue;
    const value = safeValue(name, raw);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
