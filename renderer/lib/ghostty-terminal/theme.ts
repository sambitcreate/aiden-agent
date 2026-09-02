import type { GhosttyColor, GhosttyTheme } from "./core";

export function parseCssColor(value: string, fallback: number): number {
  const hex = value.trim();
  const match = /^#([\da-f]{6})$/iu.exec(hex);
  if (match?.[1]) return Number.parseInt(match[1], 16);
  const rgb = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/iu.exec(hex);
  if (rgb) {
    return ((Number(rgb[1]) & 255) << 16) | ((Number(rgb[2]) & 255) << 8) | (Number(rgb[3]) & 255);
  }
  return fallback;
}

export function ghosttyColorFromCss(value: string, fallback: number): GhosttyColor {
  const packed = parseCssColor(value, fallback);
  return {
    r: (packed >> 16) & 255,
    g: (packed >> 8) & 255,
    b: packed & 255,
  };
}

export function ghosttyThemeFromCss(theme: {
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
}): GhosttyTheme {
  return {
    foreground: ghosttyColorFromCss(theme.foreground, 0xe6e9ee),
    background: ghosttyColorFromCss(theme.background, 0x1d232d),
    cursor: ghosttyColorFromCss(theme.cursor, 0x0a84ff),
    selectionBackground: theme.selectionBackground,
  };
}
