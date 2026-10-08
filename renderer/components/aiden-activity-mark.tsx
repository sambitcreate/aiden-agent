import * as React from "react";
import type { ActivityMark } from "../shared/activity-marks";
import { cn } from "../lib/ui-utils";

// Per-shape phase offsets (seconds) come from docs/activity-marks.md. They are
// plain inline animation delays, so no custom properties are written per frame
// or per shape; the keyframes themselves live in styles.css.
const delay = (...seconds: number[]): React.CSSProperties => ({
  animationDelay: seconds.map((value) => `${Number(value.toFixed(3))}s`).join(", "),
});

// Tri-step's triangle: radius 6.5 around the 24-unit view box centre.
const TRIANGLE = [
  [12, 5.5],
  [17.63, 15.25],
  [6.37, 15.25],
] as const;

const SHUFFLE_HOMES = [
  [7, 7],
  [17, 7],
  [7, 17],
  [17, 17],
] as const;

const COMPOSE_LINES = [
  { y: 5.5, width: 16 },
  { y: 10.7, width: 12 },
  { y: 15.9, width: 14 },
] as const;

const GRID = [6, 12, 18] as const;
const HELIX_COLUMNS = [4, 8, 12, 16, 20] as const;
const HELIX_TIMING = {
  "helix-calm": { duration: 3.6, step: 0.3 },
  "helix-twist": { duration: 1.5, step: 0.375 },
  "helix-swell": { duration: 1.6, step: 0.2 },
  "helix-duplex": { duration: 2, step: 0.2 },
  "helix-flat": { duration: 1, step: 0 },
} as const;

type HelixMark = keyof typeof HELIX_TIMING;

function Helix({ mark }: { mark: HelixMark }) {
  const { duration, step } = HELIX_TIMING[mark];
  // Strand "b" is drawn first so strand "a" passes over it at equal depth.
  return (
    <g className="aiden-mark-strands">
      {(["b", "a"] as const).map((strand) =>
        HELIX_COLUMNS.map((x, i) => {
          const position = -(i * step) - (strand === "a" ? 0 : 0.5) * duration;
          const depth = position + duration / 4;
          const circle = (
            <circle key={`${strand}${x}`} className={`aiden-mark-strand-${strand}`} cx={x} cy={12} r={1.8} style={delay(position, depth)} />
          );
          // Swell's second wave rides on a wrapper so it adds to the braid's
          // motion instead of being scaled by the circle's depth.
          return mark === "helix-swell" ? (
            <g key={`${strand}${x}`} className="aiden-mark-wave" style={delay(i * -0.45)}>{circle}</g>
          ) : circle;
        }),
      )}
    </g>
  );
}

function MarkShapes({ mark }: { mark: ActivityMark }) {
  switch (mark) {
    case "tri-step":
      return (
        <g className="aiden-mark-turn">
          {TRIANGLE.map(([cx, cy]) => <circle key={`${cx}`} cx={cx} cy={cy} r={2.6} />)}
        </g>
      );
    case "quad-shuffle":
      return <>{SHUFFLE_HOMES.map(([cx, cy]) => <circle key={`${cx}${cy}`} cx={cx} cy={cy} r={2.4} />)}</>;
    case "compose":
      return (
        <>
          {COMPOSE_LINES.map(({ y, width }, i) => (
            <rect key={y} x={4} y={y} width={width} height={2.6} rx={1.3} style={delay(i * 0.16 - 1.1)} />
          ))}
        </>
      );
    case "scan-grid":
      return (
        <>
          {GRID.flatMap((cy) =>
            GRID.map((cx, col) => <circle key={`${cx}${cy}`} cx={cx} cy={cy} r={1.9} opacity={0.2} style={delay(col * 0.18 - 0.45)} />),
          )}
        </>
      );
    case "glance":
      return (
        <g className="aiden-mark-look">
          <rect className="aiden-mark-eye" x={7} y={8.5} width={3.4} height={7} rx={1.7} />
          <rect className="aiden-mark-eye" x={13.6} y={8.5} width={3.4} height={7} rx={1.7} />
        </g>
      );
    case "bounce":
      return <>{[5.5, 12, 18.5].map((cx, i) => <circle key={cx} cx={cx} cy={13} r={2.4} style={delay(i * 0.13)} />)}</>;
    case "helix-calm":
    case "helix-twist":
    case "helix-swell":
    case "helix-duplex":
    case "helix-flat":
      return <Helix mark={mark} />;
  }
}

/**
 * One shared IntersectionObserver pauses every mark that scrolls out of view,
 * so long transcripts never tick animations nobody can see.
 */
let sharedObserver: IntersectionObserver | null = null;
function visibilityObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      (entry.target as SVGElement).toggleAttribute("data-offscreen", !entry.isIntersecting);
    }
  });
  return sharedObserver;
}

export interface AidenActivityMarkProps {
  mark: ActivityMark;
  /** Rendered size in CSS pixels. */
  size?: number;
  /** False freezes the mark on a still pose (terminal subagents, idle Live). */
  active?: boolean;
  /** 0–1 voice level. Only Helix · Swell reads it, to size its second wave (five steps). */
  level?: number;
  className?: string;
  "data-subagent-mark-state"?: "active" | "terminal";
}

/**
 * Aiden's animated activity mark. Inline SVG with CSS transform and opacity
 * keyframes only (see the `.aiden-mark` rules in styles.css). Reduced Motion
 * and inactive consumers freeze the same mark instead of swapping icons.
 */
export function AidenActivityMark({
  mark,
  size = 20,
  active = true,
  level,
  className,
  ...dataAttributes
}: AidenActivityMarkProps) {
  const ref = React.useRef<SVGSVGElement>(null);

  React.useEffect(() => {
    const node = ref.current;
    const observer = visibilityObserver();
    if (!node || !observer) return;
    observer.observe(node);
    return () => observer.unobserve(node);
  }, []);

  // The voice level picks one of five swell sizes in CSS rather than writing a
  // custom property on every microphone update.
  const levelStep = level !== undefined && Number.isFinite(level) ? Math.round(Math.max(0, Math.min(1, level)) * 4) : undefined;

  return (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("aiden-mark", className)}
      data-aiden-mark={mark}
      data-paused={active ? undefined : ""}
      data-level={levelStep}
      style={{ width: size, height: size }}
      {...dataAttributes}
    >
      <MarkShapes mark={mark} />
    </svg>
  );
}
