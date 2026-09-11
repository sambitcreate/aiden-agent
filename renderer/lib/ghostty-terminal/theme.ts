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
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}): GhosttyTheme {
  const base = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ].map((value) => ghosttyColorFromCss(value, 0));
  const cube = [0, 95, 135, 175, 215, 255];
  const extended: GhosttyColor[] = [];
  for (const r of cube) {
    for (const g of cube) {
      for (const b of cube) extended.push({ r, g, b });
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    extended.push({ r: value, g: value, b: value });
  }
  return {
    foreground: ghosttyColorFromCss(theme.foreground, 0xe6e9ee),
    background: ghosttyColorFromCss(theme.background, 0x1d232d),
    cursor: ghosttyColorFromCss(theme.cursor, 0x0a84ff),
    palette: [...base, ...extended],
    selectionBackground: theme.selectionBackground,
  };
}
