// The animated "ribbon" inside Aiden Live's floating pill: a few soft strands
// that swell with the voice that is speaking. Drawn on a canvas so it can
// follow the audio level every frame without re-rendering React.

import * as React from "react";
import { prefersReducedMotion } from "../../lib/appearance-runtime";
import type { AidenLiveRibbonColors } from "../../shared/aiden-live-settings";

export type LiveRibbonMotion = "listening" | "thinking" | "speaking" | "waiting";

/**
 * The Spectrum gradient: the ribbon's only colours outside the theme tokens
 * (owner decision 6a). "Theme accent" draws with `--accent` instead.
 */
export const LIVE_RIBBON_SPECTRUM = ["#FF5A5F", "#FFB020", "#FFF6D6", "#3E97F6", "#8B5CF6"] as const;

interface Strand {
  /** Index into the palette, or -1 for the gradient core. */
  color: number;
  width: number;
  blur: number;
  alpha: number;
  /** Hump height as a share of the half-height. */
  lift: number;
  /** Ripple cycles across the width and how fast they travel. */
  cycles: number;
  speed: number;
  phase: number;
}

const STRANDS: readonly Strand[] = [
  { color: 0, width: 9, blur: 5, alpha: 0.8, lift: 0.62, cycles: 1.1, speed: 0.9, phase: 0 },
  { color: 3, width: 11, blur: 5, alpha: 0.85, lift: 0.5, cycles: 0.9, speed: -0.7, phase: 1.7 },
  { color: 1, width: 7, blur: 5, alpha: 0.7, lift: 0.7, cycles: 1.4, speed: 1.2, phase: 3.1 },
  { color: -1, width: 3, blur: 1, alpha: 1, lift: 0.6, cycles: 1, speed: 0.8, phase: 0.6 },
  { color: 2, width: 2, blur: 0, alpha: 0.9, lift: 0.55, cycles: 1.2, speed: -1, phase: 2.4 },
];

/** How tall the ribbon stands for a state and a 0–1 audio level. */
export function liveRibbonAmplitude(motion: LiveRibbonMotion, level: number): number {
  const bounded = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  switch (motion) {
    case "listening":
      return 0.35 + bounded * 0.65;
    case "speaking":
      return 0.45 + bounded * 0.55;
    case "thinking":
      return 0.28;
    case "waiting":
      return 0.22;
  }
}

function strandY(strand: Strand, x: number, width: number, mid: number, amplitude: number, time: number): number {
  const u = x / width;
  // A hump in the middle that fades to a flat line at both ends.
  const envelope = Math.sin(Math.PI * u) ** 2;
  const ripple = Math.sin(2 * Math.PI * strand.cycles * u + strand.phase + time * strand.speed);
  return mid - envelope * mid * strand.lift * amplitude * (0.55 + 0.45 * ripple);
}

function drawRibbon(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  amplitude: number,
  time: number,
  palette: readonly string[],
  dim: boolean,
): void {
  context.clearRect(0, 0, width, height);
  const mid = height * 0.62;
  const core = context.createLinearGradient(0, 0, width, 0);
  palette.forEach((color, index) => core.addColorStop(index / Math.max(1, palette.length - 1), color));
  for (const strand of STRANDS) {
    context.save();
    context.globalAlpha = strand.alpha * (dim ? 0.5 : 1);
    context.filter = strand.blur > 0 ? `blur(${strand.blur}px)` : "none";
    context.strokeStyle = strand.color < 0 ? core : (palette[strand.color % palette.length] ?? palette[0]!);
    context.lineWidth = strand.width;
    context.lineCap = "round";
    context.beginPath();
    for (let x = 0; x <= width; x += 4) {
      const y = strandY(strand, x, width, mid, amplitude, time);
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    context.restore();
  }
  // Fade both ends into the pill.
  context.save();
  context.globalCompositeOperation = "destination-in";
  const fade = context.createLinearGradient(0, 0, width, 0);
  fade.addColorStop(0, "rgb(0 0 0 / 0)");
  fade.addColorStop(0.22, "rgb(0 0 0 / 1)");
  fade.addColorStop(0.78, "rgb(0 0 0 / 1)");
  fade.addColorStop(1, "rgb(0 0 0 / 0)");
  context.fillStyle = fade;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function ribbonPalette(element: Element, colors: AidenLiveRibbonColors): readonly string[] {
  if (colors === "spectrum") return LIVE_RIBBON_SPECTRUM;
  const accent = getComputedStyle(element).getPropertyValue("--accent").trim() || LIVE_RIBBON_SPECTRUM[3];
  const ink = getComputedStyle(element).getPropertyValue("--live-glass-ink").trim() || "#F2F4F7";
  return [accent, accent, ink, accent, accent];
}

export function LiveRibbonWave({
  motion,
  level,
  colors,
  width,
  height = 48,
}: {
  motion: LiveRibbonMotion;
  /** Read once per frame; 0 to 1. */
  level(): number;
  colors: AidenLiveRibbonColors;
  width: number;
  height?: number;
}): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const levelRef = React.useRef(level);
  levelRef.current = level;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const palette = ribbonPalette(canvas, colors);
    const dim = motion === "thinking" || motion === "waiting";
    const still = () =>
      // One complete still pose; only the words around it change.
      drawRibbon(context, width, height, liveRibbonAmplitude(motion, 0.4), 0, palette, dim);
    let frame = 0;
    let recheck: ReturnType<typeof setTimeout> | null = null;
    let smoothed = 0;
    const started = performance.now();
    // Thinking drifts slowly; voices move at full pace.
    const pace = motion === "thinking" || motion === "waiting" ? 0.35 : 1.6;
    const draw = (now: number) => {
      frame = 0;
      if (prefersReducedMotion()) {
        still();
        // Reduce Motion can be switched off mid-session; look again later.
        recheck = setTimeout(() => {
          recheck = null;
          frame = window.requestAnimationFrame(draw);
        }, 1_000);
        return;
      }
      if (document.visibilityState !== "hidden") {
        const target = levelRef.current();
        smoothed += (target - smoothed) * (target > smoothed ? 0.35 : 0.12);
        drawRibbon(context, width, height, liveRibbonAmplitude(motion, smoothed), ((now - started) / 1_000) * pace, palette, dim);
      }
      frame = window.requestAnimationFrame(draw);
    };
    if (prefersReducedMotion()) still();
    frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
      if (recheck) clearTimeout(recheck);
    };
  }, [colors, height, motion, width]);

  return (
    <canvas
      ref={canvasRef}
      className="live-ribbon-wave"
      data-motion={motion}
      data-colors={colors}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
