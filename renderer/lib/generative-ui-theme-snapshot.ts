import {
  GENERATIVE_UI_THEME_VARIABLES,
  sanitizeGenerativeUiThemeVars,
} from "../shared/generative-ui-theme";

export interface GenerativeUiThemeSnapshot {
  colorScheme: "light" | "dark";
  canvas: string;
  foreground: string;
  secondary: string;
  accent: string;
  vars: Record<string, string>;
}

/** The app's live semantic tokens, sanitized for a sandboxed guest. */
export function readGenerativeUiTheme(): GenerativeUiThemeSnapshot {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const raw: Record<string, string> = {};
  for (const name of GENERATIVE_UI_THEME_VARIABLES) raw[name] = styles.getPropertyValue(name);
  const vars = sanitizeGenerativeUiThemeVars(raw);
  const hex = (name: string, fallback: string) => {
    const value = vars[name];
    return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
  };
  return {
    colorScheme: root.classList.contains("dark") ? "dark" : "light",
    canvas: hex("--surface-popover", "#f6f7f9"),
    foreground: hex("--text-primary", "#3d3f41"),
    secondary: hex("--text-secondary", "#6b6b68"),
    accent: hex("--accent", "#006ad6"),
    vars,
  };
}

/**
 * Calls `listener` (coalesced to one frame) after the appearance runtime
 * changes `<html>`'s class or inline token styles.
 */
export function subscribeGenerativeUiTheme(listener: () => void): () => void {
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      listener();
    });
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
