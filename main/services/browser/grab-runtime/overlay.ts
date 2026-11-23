import type { ViewportRect } from "./hit-test.js";

export interface OverlayAccent {
  bg: string;
  fg: string;
}

export interface OverlayUpdate {
  rect: ViewportRect;
  label: string;
  dimensions: string;
  stepDepth: number;
  frozen: boolean;
}

function colorToRgba(color: string, alpha: number): string {
  const trimmed = color.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1];
    const r = hex.length === 3 ? parseInt(hex[0] + hex[0], 16) : parseInt(hex.slice(0, 2), 16);
    const g = hex.length === 3 ? parseInt(hex[1] + hex[1], 16) : parseInt(hex.slice(2, 4), 16);
    const b = hex.length === 3 ? parseInt(hex[2] + hex[2], 16) : parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbMatch = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)/iu.exec(trimmed);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  return `rgba(0, 106, 214, ${alpha})`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/**
 * Closed Shadow DOM overlay styled exclusively via `el.style` for 100% CSP immunity
 * (even under `style-src 'none'`).
 */
export class GrabOverlay {
  readonly host: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private readonly pill: HTMLDivElement;
  private readonly pillLabel: HTMLSpanElement;
  private readonly pillMeta: HTMLSpanElement;
  private readonly accent: OverlayAccent;
  private readonly reducedMotion: boolean;
  private rafId = 0;
  private pendingUpdate: OverlayUpdate | null = null;
  private visible = false;

  constructor(accent: OverlayAccent, reducedMotion = false) {
    this.accent = accent;
    this.reducedMotion =
      reducedMotion ||
      (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

    this.host = document.createElement("div");
    this.host.setAttribute("data-aiden-grab-host", "true");
    Object.assign(this.host.style, {
      position: "fixed",
      inset: "0",
      width: "0",
      height: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      contain: "layout style",
    });

    const shadow = this.host.attachShadow({ mode: "closed" });

    this.box = document.createElement("div");
    const tint = colorToRgba(this.accent.bg, 0.1);
    Object.assign(this.box.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      boxSizing: "border-box",
      border: `1.5px solid ${this.accent.bg}`,
      backgroundColor: tint,
      borderRadius: "4px",
      boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.72), 0 0 0 2px rgba(0, 0, 0, 0.24)",
      pointerEvents: "none",
      display: "none",
      transition: this.reducedMotion
        ? "none"
        : "left 70ms ease-out, top 70ms ease-out, width 70ms ease-out, height 70ms ease-out",
      willChange: this.reducedMotion ? "auto" : "left, top, width, height",
    });

    this.pill = document.createElement("div");
    Object.assign(this.pill.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      display: "none",
      alignItems: "center",
      gap: "6px",
      maxWidth: "360px",
      padding: "3px 7px",
      borderRadius: "6px",
      backgroundColor: this.accent.bg,
      color: this.accent.fg,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: "11px",
      fontWeight: "600",
      lineHeight: "1.25",
      letterSpacing: "-0.01em",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(255, 255, 255, 0.22)",
      pointerEvents: "none",
    });

    this.pillLabel = document.createElement("span");
    Object.assign(this.pillLabel.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    this.pillMeta = document.createElement("span");
    Object.assign(this.pillMeta.style, {
      opacity: "0.78",
      fontWeight: "500",
      fontSize: "10px",
      flexShrink: "0",
    });

    this.pill.append(this.pillLabel, this.pillMeta);
    shadow.append(this.box, this.pill);
    (document.documentElement || document.body).append(this.host);
  }

  update(next: OverlayUpdate): void {
    this.pendingUpdate = next;
    if (this.rafId) return;
    if (typeof requestAnimationFrame === "function") {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        if (this.pendingUpdate) this.apply(this.pendingUpdate);
      });
    } else {
      this.apply(next);
    }
  }

  private apply(data: OverlayUpdate): void {
    const { rect, label, dimensions, stepDepth, frozen } = data;
    if (rect.width <= 0 && rect.height <= 0) {
      this.hide();
      return;
    }

    this.visible = true;
    Object.assign(this.box.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });

    this.pillLabel.textContent = label;
    const metaParts = [dimensions];
    if (stepDepth > 0) metaParts.push(`↑${stepDepth}`);
    if (frozen) metaParts.push("Frozen");
    this.pillMeta.textContent = metaParts.join(" · ");

    const pillHeight = 22;
    const gap = 6;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 720;

    let pillTop = rect.y - pillHeight - gap;
    if (pillTop < 4) {
      pillTop = Math.min(vh - pillHeight - 4, rect.y + rect.height + gap);
    }
    if (pillTop < 4) pillTop = 4;

    const pillLeft = Math.max(4, Math.min(vw - 120, rect.x));
    Object.assign(this.pill.style, {
      display: "inline-flex",
      left: `${pillLeft}px`,
      top: `${pillTop}px`,
    });
  }

  hide(): void {
    this.visible = false;
    this.box.style.display = "none";
    this.pill.style.display = "none";
  }

  /**
   * Immediately hides the overlay and waits two animation frames so Chromium
   * paints an overlay-free frame before `capturePage()` runs.
   */
  async hideForCapture(removeHost: boolean): Promise<void> {
    if (this.rafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.pendingUpdate = null;
    this.hide();
    this.host.style.display = "none";
    if (removeHost) {
      this.host.remove();
    }
    await nextFrame();
    await nextFrame();
  }

  showAfterCapture(): void {
    this.host.style.display = "block";
    if (!this.host.isConnected) {
      (document.documentElement || document.body)?.append(this.host);
    }
    if (!this.visible) {
      this.box.style.display = "none";
      this.pill.style.display = "none";
    }
  }

  destroy(): void {
    if (this.rafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.pendingUpdate = null;
    this.host.remove();
  }
}
