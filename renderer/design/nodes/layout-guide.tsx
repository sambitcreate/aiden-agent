// A layout guide drawn over a page, artifact or artboard: equal columns with
// 16 px gutters and margins, or an 8 px grid, in the frame's design pixels.
// It is only drawn on the canvas and never part of an export.

import type { DesignGuide } from "../../shared/design-canvas/schema";

const GUTTER = 16;

/** A guide's columns, or null for a grid. */
export function guideColumns(guide: DesignGuide): number | null {
  return guide.startsWith("columns-") ? Number(guide.slice("columns-".length)) : null;
}

export function LayoutGuide({ guide, scale }: { guide: DesignGuide; /** Canvas units per design pixel. */ scale: number }) {
  const columns = guideColumns(guide);
  if (columns !== null) {
    return (
      <div
        aria-hidden
        data-design-guide={guide}
        className="pointer-events-none absolute inset-0 flex"
        style={{ gap: GUTTER * scale, paddingInline: GUTTER * scale }}
      >
        {Array.from({ length: columns }, (_, index) => (
          <div key={index} className="h-full min-w-0 flex-1" style={{ background: "color-mix(in srgb, var(--chart-4) 12%, transparent)" }} />
        ))}
      </div>
    );
  }
  const step = 8 * scale;
  const line = "color-mix(in srgb, var(--chart-1) 22%, transparent)";
  return (
    <div
      aria-hidden
      data-design-guide={guide}
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
        backgroundSize: `${step}px ${step}px`,
      }}
    />
  );
}
