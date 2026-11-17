// The theme an artifact frame is drawn with. With its Dark switch off it
// follows Aiden's appearance, as artifacts do everywhere; on, it gets the
// dark variant of the person's theme even while Aiden itself is light.

import { getPresetVariant, resolveThemeTokens, themeVariantSafetyIssues } from "../shared/appearance";
import { GENERATIVE_UI_THEME_VARIABLES, sanitizeGenerativeUiThemeVars } from "../shared/generative-ui-theme";
import { readCurrentAppearance } from "../lib/appearance-runtime";
import { readGenerativeUiTheme, type GenerativeUiThemeSnapshot } from "../lib/generative-ui-theme-snapshot";

export function readDesignArtifactTheme(dark: boolean): GenerativeUiThemeSnapshot {
  const current = readGenerativeUiTheme();
  if (!dark || current.colorScheme === "dark") return current;
  const config = readCurrentAppearance();
  const variant =
    config && themeVariantSafetyIssues(config.dark, "dark").length === 0 ? config.dark : getPresetVariant("aiden", "dark");
  const tokens = resolveThemeTokens(variant, "dark");
  const raw: Record<string, string> = { ...current.vars };
  for (const name of GENERATIVE_UI_THEME_VARIABLES) {
    if (tokens[name]) raw[name] = tokens[name];
  }
  const vars = sanitizeGenerativeUiThemeVars(raw);
  const hex = (name: string, fallback: string) => {
    const value = vars[name];
    return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
  };
  return {
    colorScheme: "dark",
    canvas: hex("--surface-popover", "#1e1f22"),
    foreground: hex("--text-primary", "#ececec"),
    secondary: hex("--text-secondary", "#a3a3a3"),
    accent: hex("--accent", "#4c9bff"),
    vars,
  };
}
