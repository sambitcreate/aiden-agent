// Dark-mode background override.
//
// The default dark seeds are pure black (`--bg`/`--bg-secondary` = #000), which
// paints opaque black surfaces (composer footer, etc.) over the window's graphite
// vibrancy material. We soften them to a neutral graphite so every bg-*/text-*/
// border ramp recomputes from the new seeds.
//
// This is injected as a raw <style> at runtime rather than written in styles.css
// because Tailwind v4's compiler consolidates/strips redefinitions of its managed
// seed variables (`--bg`, `--bg-secondary`) — a runtime <style> bypasses it and,
// appended after the bundled stylesheet, wins the cascade.

const STYLE_ID = "app-dark-theme-overrides";

const CSS = `
html.dark {
  --bg: #2a2a2c;
  --bg-secondary: #1d1d1f;
}
`;

export function applyDarkThemeOverrides(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
