// What a frame on the design canvas can be saved as, what the saved file is
// called, and how its PDF is laid out. Shared by the renderer (the Download
// menu) and main (the export itself), so both agree on every answer.

import type { DesignFrame, DesignPaper, DesignPrintMode } from "./schema.js";
import { isDesignPrintable } from "./schema.js";

export type DesignExportFormat = "png" | "pdf" | "source";
export const DESIGN_EXPORT_FORMATS = ["png", "pdf", "source"] as const satisfies readonly DesignExportFormat[];

/** A picture of a page is drawn at most this tall, in the page's own CSS pixels. */
export const DESIGN_EXPORT_MAX_HEIGHT = 8000;
/** PNG pictures are drawn at twice the page's CSS pixels. */
export const DESIGN_EXPORT_PNG_SCALE = 2;
/** The PDF's margin on every side, in inches. */
export const DESIGN_PDF_MARGIN_IN = 0.4;

const PAPER_INCHES: Readonly<Record<DesignPaper, { width: number; height: number }>> = {
  letter: { width: 8.5, height: 11 },
  a4: { width: 8.27, height: 11.69 },
};

/** The formats a frame offers, in the order the Download menu lists them. */
export function designExportFormats(frame: Pick<DesignFrame, "kind">): DesignExportFormat[] {
  if (isDesignPrintable(frame.kind)) return ["png", "pdf", "source"];
  if (frame.kind === "image") return ["source"];
  return [];
}

/** The width a frame's page is laid out at when it is exported. */
export function designExportWidth(frame: Pick<DesignFrame, "kind" | "designWidth" | "w">): number {
  if (frame.kind === "file") return frame.designWidth ?? 1280;
  return Math.min(1440, Math.max(320, Math.round(frame.w)));
}

/**
 * The name the save dialog suggests. The original file keeps its own name; a
 * picture or PDF is named after the frame's title, made safe for any disk.
 */
export function designExportFileName(
  frame: Pick<DesignFrame, "kind" | "title" | "path">,
  format: DesignExportFormat,
): string {
  if (format === "source" && frame.path) return frame.path.slice(frame.path.lastIndexOf("/") + 1);
  const stem =
    frame.title
      .replace(/\.[a-z0-9]{1,5}$/iu, "")
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .replace(/[\s-]+/gu, "-")
      .replace(/^[-.]+|[-.]+$/gu, "")
      .slice(0, 80) || "design";
  if (format === "source") return `${stem}.html`;
  return `${stem}.${format}`;
}

export type DesignPdfLayout = {
  paper: DesignPaper;
  /** Electron's `pageSize` name. */
  pageSize: "Letter" | "A4";
  marginInches: number;
  /** How much the page is scaled; 1 for flow. */
  scale: number;
};

/**
 * Flow prints the page reflowed to the paper. Fixed lays it out at its design
 * width and scales that to the paper's printable width, as a picture of the
 * design would be.
 */
export function designPdfLayout(input: {
  paper?: DesignPaper;
  printMode?: DesignPrintMode;
  width: number;
}): DesignPdfLayout {
  const paper = input.paper ?? "letter";
  const printable = (PAPER_INCHES[paper].width - DESIGN_PDF_MARGIN_IN * 2) * 96;
  const fixed = input.printMode === "fixed" && input.width > 0;
  const scale = fixed ? Math.min(2, Math.max(0.1, Math.round((printable / input.width) * 1000) / 1000)) : 1;
  return { paper, pageSize: paper === "a4" ? "A4" : "Letter", marginInches: DESIGN_PDF_MARGIN_IN, scale };
}
