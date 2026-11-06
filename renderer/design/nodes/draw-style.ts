// How drawn items look: the fixed palette as theme colours, and type sizes.
// The palette uses the chart series tokens (which follow light, dark and
// every theme preset) plus the text colours for ink and gray.

import type { DesignColor, DesignTextSize } from "../../shared/design-canvas/schema";

const COLOR_VARS: Record<DesignColor, string> = {
  ink: "var(--text-primary)",
  gray: "var(--text-secondary)",
  blue: "var(--chart-1)",
  green: "var(--chart-2)",
  yellow: "var(--chart-3)",
  red: "var(--chart-4)",
  purple: "var(--chart-5)",
  teal: "var(--chart-6)",
  pink: "var(--chart-7)",
};

/** A palette colour as a CSS colour. */
export function designColorVar(color: DesignColor): string {
  return COLOR_VARS[color];
}

/** A shape's fill: the colour softened over the canvas, so a label on it stays readable. */
export function designFillVar(color: DesignColor): string {
  return `color-mix(in srgb, ${COLOR_VARS[color]} 18%, var(--surface-background))`;
}

/** Type sizes for canvas text, in canvas units. */
export const DESIGN_TEXT_PX: Record<DesignTextSize, number> = { small: 14, medium: 18, large: 32 };

/** What a new item looks like when the person draws it. */
export const DESIGN_DRAW_DEFAULTS = {
  shape: { fill: "blue", color: "blue", strokeWidth: 2 },
  connector: { color: "gray", strokeWidth: 2 },
  stroke: { color: "ink", strokeWidth: 3 },
  text: { size: "medium" },
} as const satisfies {
  shape: { fill: DesignColor; color: DesignColor; strokeWidth: number };
  connector: { color: DesignColor; strokeWidth: number };
  stroke: { color: DesignColor; strokeWidth: number };
  text: { size: DesignTextSize };
};
