// Aiden's tools for a chat's design canvas (design mode P3a).
//
// They exist only for an attended desktop turn in a chat with design mode on
// (see `designCanvasToolsAllowed`). Every edit goes through the store's
// serialized `update`, then a `designCanvas:updated` broadcast, so an open
// canvas refetches and shows it the same way it shows another window's save.
//
// Aiden may move, restyle, group, arrange and reorder any frame that is not
// locked, the person's included, so it can organise the whole canvas when
// asked. A locked frame refuses every change but unlocking, and removing a
// frame the person added still needs their explicit say-so.

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { canvasView, describeCanvas, summarizeFrame } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { commentsWithoutFrames } from "../../../renderer/shared/design-canvas/comments.js";
import { canAttachTo, syncConnectors, translateConnector } from "../../../renderer/shared/design-canvas/connectors.js";
import {
  bringLayerToFront,
  reorderLayer,
  sendLayerToBack,
  stepLayer,
} from "../../../renderer/shared/design-canvas/layers.js";
import {
  clampCoord,
  clampSize,
  DESIGN_FRAME_GAP,
  fitGroupToMembers,
  GROUP_PADDING,
  growGroupToHold,
  placeFrame,
  type PlaceFrameInput,
} from "../../../renderer/shared/design-canvas/placement.js";
import {
  canDesignGuide,
  DESIGN_CANVAS_LIMITS,
  DESIGN_COLORS,
  DESIGN_DEFAULT_FILE_WIDTH,
  DESIGN_GUIDES,
  DESIGN_WIDTHS,
  defaultFileBox,
  framesOnPage,
  isDesignContainer,
  isDesignPrintable,
  isDesignRelativePath,
  type DesignCanvas,
  type DesignColor,
  type DesignConnectorEnd,
  type DesignFrame,
  type DesignFrameKind,
  type DesignGuide,
  type DesignShapeKind,
  type DesignSide,
  type DesignTextSize,
  type DesignWidth,
} from "../../../renderer/shared/design-canvas/schema.js";
import {
  addPage,
  canAddPage,
  deletePage,
  duplicatePage,
  moveFramesToPage,
  movePage,
  renamePage,
  showPage,
} from "../../../renderer/shared/design-canvas/pages.js";
import {
  DESIGN_TWEAK_LIMITS,
  isDesignTweakTarget,
  isDesignTweakValue,
  type DesignTweakValues,
} from "../../../renderer/shared/design-canvas/tweaks.js";
import { resolveDesignFile } from "./resolve-core.js";
import type { DesignCanvasStore } from "./store.js";

export const DESIGN_CANVAS_TOOL_NAMES = [
  "canvas_read",
  "canvas_place_frame",
  "canvas_update_frame",
  "canvas_remove_frame",
  "canvas_focus",
  "canvas_arrange",
  "canvas_page",
] as const;

/** Canvas tool calls one turn may make; past it each call returns `limit_reached`. */
export const DESIGN_CANVAS_CALLS_PER_TURN = 60;

type PlacedKind = "file" | "image" | "note" | "group" | "text" | "shape" | "connector" | "frame";
const PLACED_KINDS: readonly PlacedKind[] = ["file", "image", "note", "group", "text", "shape", "connector", "frame"];

/** Default boxes, matching the canvas's Add menu and drawing tools. A text box's height follows its lines; a page's follows its design width. */
const DEFAULT_BOX: Record<Exclude<PlacedKind, "connector" | "file">, { w: number; h: number }> = {
  image: { w: 320, h: 240 },
  note: { w: 240, h: 160 },
  group: { w: 640, h: 400 },
  text: { w: 240, h: 24 },
  shape: { w: 160, h: 100 },
  frame: { w: 640, h: 400 },
};
/** Canvas text sizes and the line height a placed text box gets per line, matching the canvas. */
const TEXT_LINE: Record<DesignTextSize, number> = { small: 19, medium: 24, large: 42 };
const SIDES: readonly DesignSide[] = ["top", "right", "bottom", "left"];
const TextSizeSchema = Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]);
const ColorSchema = Type.Union(DESIGN_COLORS.map((color) => Type.Literal(color)));
const EndSchema = Type.Object({
  frameId: Type.Optional(Type.String({ description: "Join this end to a frame; it follows the frame when it moves." })),
  side: Type.Optional(Type.Union(SIDES.map((side) => Type.Literal(side)))),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
});
const GuideSchema = Type.Union([...DESIGN_GUIDES.map((guide) => Type.Literal(guide)), Type.Literal("none")]);
const PaperSchema = Type.Union([Type.Literal("letter"), Type.Literal("a4")]);
const PrintModeSchema = Type.Union([Type.Literal("flow"), Type.Literal("fixed")]);
const TweaksSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
  description: "A page's tweak values by CSS variable (--accent) or data attribute (data-density); null resets one.",
});
/** What a page, artifact, artboard or shape can look like, shared by place and update. */
const STYLE_PARAMETERS = {
  dark: Type.Optional(Type.Boolean({ description: "file or artifact: show its dark look." })),
  tweaks: Type.Optional(TweaksSchema),
  radius: Type.Optional(Type.Number({ minimum: 0, maximum: DESIGN_CANVAS_LIMITS.maxRadius, description: "artboard or rect shape: corner radius." })),
  guide: Type.Optional(GuideSchema),
  paper: Type.Optional(PaperSchema),
  printMode: Type.Optional(PrintModeSchema),
};

type DesignTurn = {
  flagEnabled: boolean;
  /** A window on this desktop is the turn's owner (not a phone or paired Mac). */
  localRenderer: boolean;
  botId?: string;
  assistant: boolean;
  telegram: boolean;
  hasWorkspaceFolder: boolean;
};

/** An attended desktop turn with a workspace folder, where design mode could apply at all. */
function designTurnEligible(turn: DesignTurn): boolean {
  return (
    turn.flagEnabled &&
    turn.localRenderer &&
    !turn.botId &&
    !turn.assistant &&
    !turn.telegram &&
    turn.hasWorkspaceFolder
  );
}

/** Which turns get the canvas tools. Pure, so the rule is tested on its own. */
export function designCanvasToolsAllowed(turn: DesignTurn & { designMode: boolean | undefined }): boolean {
  return designTurnEligible(turn) && turn.designMode === true;
}

/**
 * Which turns get `design_mode`: the same turns, in an ordinary project chat
 * (not one a feature owns), while Settings → Inline visuals is automatic.
 * People can still enter design mode themselves in every mode.
 */
export function designModeToolAllowed(
  turn: DesignTurn & { regularChat: boolean; inlineVisuals: string | undefined },
): boolean {
  return designTurnEligible(turn) && turn.regularChat && (turn.inlineVisuals ?? "automatic") === "automatic";
}

/**
 * The design mode part of the system prompt. Static, so it never breaks the
 * prompt cache; the canvas's current contents go in the volatile line
 * (`canvasPromptLine`) and in `canvas_read`.
 */
export const DESIGN_MODE_PROMPT_SECTION = [
  "## Design mode is on",
  "This chat sits beside an infinite design canvas. The person sees its frames while you talk. Load the aiden-design skill before you design on it.",
  "- Call canvas_read before changing the canvas, and again if the person says they moved things. It lists every frame on the page, in view and outside it, with ids and boxes.",
  "- Pages, screens and UI mockups are workspace HTML files under design/ (a shared design/tokens.css plus one HTML file per screen), not render_artifact visuals. Each page you write or edit lands on the canvas by itself and reloads as you save it.",
  "- Pick the design width that matches the screen: 390 phone, 768 tablet, 1280 or 1440 desktop. A page can declare it with <meta name=\"aiden-design-width\" content=\"390\">; canvas_place_frame or canvas_update_frame with designWidth resizes its frame to fit.",
  "- canvas_place_frame on a page already on the canvas moves that frame; pass duplicate: true to show the same file twice, for example a light and a dark (dark: true) variant or phone and desktop widths side by side.",
  "- You can move, resize, retitle, restyle, regroup, hide, lock or reorder any unlocked frame, the person's too, with canvas_update_frame. A locked frame stays as it is unless the person asks you to unlock it. Remove a frame the person added only when they ask, with force: true.",
  "- Use canvas_arrange to lay frames out in a tidy row, column or grid, put them in a group (it fits itself around them) or take them out, in one call. Put each direction in its own group.",
  "- For a flow or diagram, place shapes (with their labels in text), text and frames (artboards), then connectors between them by frameId; a connector follows its frames when they move.",
  "- The canvas can have several pages. Work on the page the person is looking at unless they name another; canvas_page adds, renames, duplicates, reorders, shows or deletes pages, and canvas_update_frame with page moves a frame to another.",
  "- After placing or moving frames, call canvas_focus with their ids so the person sees them (canvas_arrange does this by itself). canvas_read with snapshot: true shows you the canvas as the person sees it.",
  "- Coordinates and sizes are canvas units. Say which file you changed.",
].join("\n");

export type DesignCanvasToolDeps = {
  chatId: string;
  /** The chat's workspace folder. Frames may name only files inside it. */
  workspaceRoot: string;
  store: Pick<DesignCanvasStore, "get" | "update">;
  broadcast(update: { chatId: string; revision: number }): void;
  /** False once the chat left design mode or was deleted. Checked on every call. */
  stillAvailable?(): Promise<boolean>;
  newId?(): string;
  /** Asks the window showing the canvas to fit these frames (all of them when empty). */
  focus?(frameIds: string[]): void;
  /** A downscaled PNG of the canvas as the person sees it, or null when it is not on screen. */
  snapshot?(signal?: AbortSignal): Promise<{ data: string; mimeType: string } | null>;
};

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; details: null };
/** A tool answer that also shows the model a picture. */
class WithImage {
  constructor(
    readonly value: unknown,
    readonly image: { data: string; mimeType: string },
  ) {}
}
const result = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: null,
});

class CanvasToolError extends Error {}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new CanvasToolError(`${field} must be a non-empty string.`);
  return value.trim().slice(0, max);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CanvasToolError(`${field} must be a number.`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new CanvasToolError(`${field} must be true or false.`);
  return value;
}

function designWidth(value: unknown): DesignWidth | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(DESIGN_WIDTHS as readonly number[]).includes(value as number)) {
    throw new CanvasToolError(`designWidth must be one of ${DESIGN_WIDTHS.join(", ")}.`);
  }
  return value as DesignWidth;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

async function checkedPath(root: string, value: unknown, kind: "file" | "image"): Promise<string> {
  if (!isDesignRelativePath(value)) {
    throw new CanvasToolError("path must be a workspace-relative path such as design/home.html.");
  }
  const resolved = await resolveDesignFile(root, value.split("/").map(encodeURIComponent).join("/"));
  if (!resolved.ok) {
    throw new CanvasToolError(
      resolved.status === 413
        ? "That file is larger than 8 MiB, so the canvas cannot show it."
        : `There is no file the canvas can show at ${value}. Write the file first, inside the workspace.`,
    );
  }
  if (kind === "file" && resolved.mimeType.split(";")[0] !== "text/html") {
    throw new CanvasToolError("A file frame shows an HTML page; use kind \"image\" for a picture.");
  }
  if (kind === "image" && !IMAGE_TYPES.has(resolved.mimeType.split(";")[0]!)) {
    throw new CanvasToolError("An image frame needs a PNG, JPEG, GIF, WebP or SVG file.");
  }
  return value;
}

function groupOf(doc: DesignCanvas, groupId: unknown, pageId: string): string | undefined {
  if (groupId === undefined || groupId === null || groupId === "") return undefined;
  if (
    typeof groupId !== "string" ||
    !doc.frames.some((frame) => frame.id === groupId && isDesignContainer(frame.kind) && frame.pageId === pageId)
  ) {
    throw new CanvasToolError("groupId must be the id of a group or frame (artboard) on the same page.");
  }
  return groupId;
}

function color(value: unknown, field: string): DesignColor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(DESIGN_COLORS as readonly unknown[]).includes(value)) {
    throw new CanvasToolError(`${field} must be one of ${DESIGN_COLORS.join(", ")}.`);
  }
  return value as DesignColor;
}

function textSize(value: unknown): DesignTextSize | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "small" && value !== "medium" && value !== "large") {
    throw new CanvasToolError('size must be "small", "medium" or "large".');
  }
  return value;
}

function arrowOf(value: unknown): DesignFrame["arrow"] {
  if (value === undefined || value === null || value === "end") return "end";
  if (value === "none") return undefined;
  if (value === "both") return "both";
  throw new CanvasToolError('arrow must be "end", "both" or "none".');
}

/** Which kinds take a fill: a shape, a note, or an artboard's background. */
function takesFill(kind: DesignFrameKind): boolean {
  return kind === "shape" || kind === "note" || kind === "frame";
}

/** A change to how a frame looks: fields to set and fields to clear. */
type StylePatch = { set: Partial<DesignFrame>; clear: (keyof DesignFrame)[] };

/**
 * Reads the look fields shared by place and update (dark, tweaks, radius,
 * guide, paper, printMode) for a frame of `kind`, refusing ones it cannot
 * have. Tweaks merge into `tweaksBefore`; a null value drops that key.
 */
function stylePatch(
  kind: DesignFrameKind,
  shape: DesignShapeKind | undefined,
  p: Record<string, unknown>,
  tweaksBefore: DesignTweakValues | undefined,
): StylePatch {
  const patch: StylePatch = { set: {}, clear: [] };
  const dark = optionalBoolean(p.dark, "dark");
  if (dark !== undefined) {
    if (!isDesignPrintable(kind)) throw new CanvasToolError("Only a file or artifact frame has a dark look.");
    if (dark) patch.set.dark = true;
    else patch.clear.push("dark");
  }
  if (p.tweaks !== undefined && p.tweaks !== null) {
    if (kind !== "file") throw new CanvasToolError("Only a file frame has tweaks.");
    if (typeof p.tweaks !== "object" || Array.isArray(p.tweaks)) {
      throw new CanvasToolError("tweaks must map CSS variables (--name) or data attributes (data-name) to values.");
    }
    const next: DesignTweakValues = { ...tweaksBefore };
    for (const [name, value] of Object.entries(p.tweaks as Record<string, unknown>)) {
      if (!isDesignTweakTarget(name)) {
        throw new CanvasToolError(`The tweak ${JSON.stringify(name)} must be a CSS variable (--name) or a data attribute (data-name).`);
      }
      if (value === null) {
        delete next[name];
        continue;
      }
      if (!isDesignTweakValue(value)) {
        throw new CanvasToolError(
          `The value for ${name} must be text of at most ${DESIGN_TWEAK_LIMITS.valueChars} characters without quotes, braces, semicolons or url().`,
        );
      }
      next[name] = value;
    }
    if (Object.keys(next).length > DESIGN_TWEAK_LIMITS.controls) {
      throw new CanvasToolError(`A page keeps at most ${DESIGN_TWEAK_LIMITS.controls} tweak values.`);
    }
    if (Object.keys(next).length > 0) patch.set.tweaks = next;
    else patch.clear.push("tweaks");
  }
  const radius = optionalNumber(p.radius, "radius");
  if (radius !== undefined) {
    if (kind !== "frame" && !(kind === "shape" && shape === "rect")) {
      throw new CanvasToolError("Only an artboard (kind frame) or a rect shape has a corner radius.");
    }
    patch.set.radius = Math.min(DESIGN_CANVAS_LIMITS.maxRadius, Math.max(0, Math.round(radius)));
  }
  if (p.guide !== undefined && p.guide !== null) {
    if (!canDesignGuide(kind)) throw new CanvasToolError("Only a file, artifact or artboard has a layout guide.");
    if (p.guide === "none") patch.clear.push("guide");
    else if ((DESIGN_GUIDES as readonly unknown[]).includes(p.guide)) patch.set.guide = p.guide as DesignGuide;
    else throw new CanvasToolError(`guide must be one of ${[...DESIGN_GUIDES, "none"].join(", ")}.`);
  }
  if (p.paper !== undefined && p.paper !== null) {
    if (!isDesignPrintable(kind)) throw new CanvasToolError("Only a file or artifact frame has a paper size.");
    if (p.paper !== "letter" && p.paper !== "a4") throw new CanvasToolError('paper must be "letter" or "a4".');
    patch.set.paper = p.paper;
  }
  if (p.printMode !== undefined && p.printMode !== null) {
    if (!isDesignPrintable(kind)) throw new CanvasToolError("Only a file or artifact frame has a print mode.");
    if (p.printMode !== "flow" && p.printMode !== "fixed") throw new CanvasToolError('printMode must be "flow" or "fixed".');
    patch.set.printMode = p.printMode;
  }
  return patch;
}

function applyStyle(frame: DesignFrame, patch: StylePatch): DesignFrame {
  const next: DesignFrame = { ...frame, ...patch.set };
  for (const key of patch.clear) delete next[key];
  return next;
}

/** A connector end from a tool call: on a frame of the page (by id), or at a point. */
function endOf(doc: DesignCanvas, value: unknown, field: string, pageId: string, self?: string): DesignConnectorEnd {
  if (typeof value !== "object" || value === null) {
    throw new CanvasToolError(`${field} must be { frameId } or { x, y }.`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.frameId !== undefined && raw.frameId !== null && raw.frameId !== "") {
    const frame = typeof raw.frameId === "string" ? doc.frames.find((entry) => entry.id === raw.frameId) : undefined;
    if (!frame || frame.pageId !== pageId || frame.id === self || !canAttachTo(frame)) {
      throw new CanvasToolError(`${field}.frameId must be the id of a frame on the same page that is not an arrow, line or drawing.`);
    }
    const side = raw.side;
    if (side !== undefined && !(SIDES as readonly unknown[]).includes(side)) {
      throw new CanvasToolError(`${field}.side must be top, right, bottom or left.`);
    }
    // The place is set from the frame when the connector is synced.
    return {
      x: Math.round(frame.x + frame.w / 2),
      y: Math.round(frame.y + frame.h / 2),
      frameId: frame.id,
      ...(side ? { side: side as DesignSide } : {}),
    };
  }
  const x = optionalNumber(raw.x, `${field}.x`);
  const y = optionalNumber(raw.y, `${field}.y`);
  if (x === undefined || y === undefined) throw new CanvasToolError(`${field} must be { frameId } or { x, y }.`);
  return { x: clampCoord(x), y: clampCoord(y) };
}

/** A page named by its id or its name (case-insensitive); the page on screen when left out. */
function pageOf(doc: DesignCanvas, value: unknown): string {
  if (value === undefined || value === null || value === "") return doc.activePageId;
  const wanted = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  const page = doc.pages.find((entry) => entry.id === value) ??
    doc.pages.find((entry) => entry.name.toLocaleLowerCase() === wanted);
  if (!page) {
    throw new CanvasToolError(
      `There is no page named ${JSON.stringify(value)}. The pages are: ${doc.pages.map((entry) => JSON.stringify(entry.name)).join(", ")}.`,
    );
  }
  return page.id;
}

const LOCKED_MESSAGE =
  "That frame is locked, so it stays as it is. Unlock it (canvas_update_frame with locked: false) only if the person asked you to.";

/**
 * A page frame's box after its design width changes from `before` to
 * `after`: the new width's default box when it had the old one, or its
 * width scaled to match (as the side panel's Width menu does).
 */
function boxForWidth(frame: DesignFrame, before: DesignWidth, after: DesignWidth): { w: number; h: number } {
  if (before === after) return { w: frame.w, h: frame.h };
  const old = defaultFileBox(before);
  if (frame.w === old.w && frame.h === old.h) return defaultFileBox(after);
  return { w: clampSize((frame.w * after) / before, "file"), h: frame.h };
}

/** Moves a frame by (dx, dy); a group or artboard takes its members along, except those in `skip`. */
function translateFrames(frames: DesignFrame[], id: string, dx: number, dy: number, skip: ReadonlySet<string>): DesignFrame[] {
  if (dx === 0 && dy === 0) return frames;
  const moved = frames.find((entry) => entry.id === id);
  const container = moved ? isDesignContainer(moved.kind) : false;
  return frames.map((entry) => {
    if (entry.id === id || (container && entry.groupId === id && !skip.has(entry.id))) {
      return entry.kind === "connector"
        ? translateConnector(entry, dx, dy)
        : { ...entry, x: clampCoord(entry.x + dx), y: clampCoord(entry.y + dy) };
    }
    return entry;
  });
}

type Layout = "row" | "column" | "grid";
type Align = "start" | "center" | "end";

/** Where each box goes in a row, column or grid laid from `anchor`. */
export function layoutBoxes(
  boxes: readonly { w: number; h: number }[],
  options: { layout: Layout; columns: number; gap: number; rowGap: number; align: Align; anchor: { x: number; y: number } },
): { x: number; y: number }[] {
  const { layout, gap, rowGap, align, anchor } = options;
  const offset = (space: number, size: number) => (align === "center" ? (space - size) / 2 : align === "end" ? space - size : 0);
  if (layout === "column") {
    const widest = Math.max(...boxes.map((box) => box.w));
    let y = anchor.y;
    return boxes.map((box) => {
      const at = { x: anchor.x + offset(widest, box.w), y };
      y += box.h + rowGap;
      return at;
    });
  }
  const columns = layout === "row" ? boxes.length : Math.max(1, Math.min(options.columns, boxes.length));
  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  boxes.forEach((box, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, box.w);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, box.h);
  });
  return boxes.map((box, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = anchor.x + columnWidths.slice(0, column).reduce((sum, width) => sum + width + gap, 0);
    const y = anchor.y + rowHeights.slice(0, row).reduce((sum, height) => sum + height + rowGap, 0);
    return { x, y: y + offset(rowHeights[row]!, box.h) };
  });
}

export function createDesignCanvasTools(deps: DesignCanvasToolDeps): AgentTool[] {
  const newId = deps.newId ?? randomUUID;
  let calls = 0;

  /** Runs one tool call: the per-turn limit, the availability check and error shaping. */
  const run = async (body: () => Promise<unknown>): Promise<ToolResult> => {
    calls += 1;
    if (calls > DESIGN_CANVAS_CALLS_PER_TURN) {
      return result({ status: "limit_reached", limit: DESIGN_CANVAS_CALLS_PER_TURN });
    }
    if (deps.stillAvailable && !(await deps.stillAvailable())) {
      return result({ status: "unavailable", reason: "Design mode is off in this chat." });
    }
    try {
      const value = await body();
      if (value instanceof WithImage) {
        return {
          content: [{ type: "text", text: JSON.stringify(value.value) }, { type: "image", ...value.image }],
          details: null,
        };
      }
      return result(value);
    } catch (error) {
      if (error instanceof CanvasToolError) return result({ status: "error", message: error.message });
      throw error;
    }
  };

  /** Applies a change and tells open canvases about it. `change` throws to refuse. */
  const edit = async <T>(change: (doc: DesignCanvas) => { doc: DesignCanvas; value: T }): Promise<T> => {
    let value: T | undefined;
    const saved = await deps.store.update(deps.chatId, (doc) => {
      const next = change(doc);
      value = next.value;
      return next.doc;
    });
    deps.broadcast({ chatId: deps.chatId, revision: saved.revision });
    return value as T;
  };

  const frameIn = (doc: DesignCanvas, id: unknown): DesignFrame => {
    const frame = typeof id === "string" ? doc.frames.find((entry) => entry.id === id) : undefined;
    if (!frame) throw new CanvasToolError("No frame on this canvas has that id. Call canvas_read for the current frames.");
    return frame;
  };

  const pagesAnswer = (doc: DesignCanvas) =>
    doc.pages.map((entry) => ({
      id: entry.id,
      name: entry.name,
      frames: doc.frames.filter((frame) => frame.pageId === entry.id).length,
      onScreen: entry.id === doc.activePageId,
    }));

  return [
    declarePiRuntimeReplay(
      {
        name: "canvas_read",
        label: "Read design canvas",
        description:
          "Read the design canvas beside this chat: its pages, and on one page (the one the person is looking at unless you name another) the visible area, the frames in it (id, kind, title, path, box, group, look, open comments), every frame outside it (outsideFrames, with ids and boxes so you can move, group or focus them), counts by group, and the page's open and sent comments (each with its commentId, note, frame, file and the element it points at). Boxes are in canvas units. Pass snapshot: true to also see a picture of the canvas as the person sees it.",
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id." })),
          snapshot: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, raw, signal) =>
          run(async () => {
            const p = (raw ?? {}) as { page?: unknown; snapshot?: unknown };
            const doc = await deps.store.get(deps.chatId);
            const answer = describeCanvas(doc, { pageId: pageOf(doc, p.page) });
            // The snapshot shows the screen, so it only describes the page on screen.
            if (p.snapshot !== true || answer.page.id !== doc.activePageId) return answer;
            const image = deps.snapshot ? await deps.snapshot(signal) : null;
            return image
              ? new WithImage({ ...answer, snapshot: "attached" }, image)
              : { ...answer, snapshot: "unavailable", snapshotReason: "The canvas is not on screen right now." };
          }),
      },
      "safe",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_place_frame",
        label: "Place on design canvas",
        description:
          "Put a frame on the design canvas: a workspace HTML page (kind file), an image, a note, a group, or a drawn item for flows and diagrams: text, a shape (rect or oval, with an optional label in text), a frame (an empty artboard that holds shapes and text like a group) or a connector (an arrow or line from one frame or point to another; an end on a frame follows it). Notes and text items take a small Markdown subset: **bold**, *italic*, <u>underline</u>, [links](https://…), and lines starting \"- \" or \"1. \" for lists; size and color apply to the whole note or text, and fill gives a note, shape or artboard its colour. Write the file first with your file tools; path is workspace-relative. A page's frame is sized for its designWidth (390 phone, 768 tablet, 1280 or 1440 desktop) unless you pass w and h. Placing a page already on the canvas moves and resizes that frame; pass duplicate: true to add another frame of the same file (for example a dark: true variant or another width). It goes on the page the person is looking at unless you name another. Leave x and y out to place it right of the last frame in its group or in view; a group grows to hold what you place in it. Boxes are in canvas units.",
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id." })),
          kind: Type.Union(PLACED_KINDS.map((kind) => Type.Literal(kind))),
          title: Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars }),
          path: Type.Optional(Type.String({ maxLength: 1024 })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
          shape: Type.Optional(Type.Union([Type.Literal("rect"), Type.Literal("oval")])),
          fill: Type.Optional(ColorSchema),
          color: Type.Optional(ColorSchema),
          size: Type.Optional(TextSizeSchema),
          from: Type.Optional(EndSchema),
          to: Type.Optional(EndSchema),
          arrow: Type.Optional(Type.Union([Type.Literal("end"), Type.Literal("both"), Type.Literal("none")])),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          w: Type.Optional(Type.Number()),
          h: Type.Optional(Type.Number()),
          groupId: Type.Optional(Type.String()),
          designWidth: Type.Optional(Type.Union(DESIGN_WIDTHS.map((width) => Type.Literal(width)))),
          duplicate: Type.Optional(Type.Boolean({ description: "file: always add a new frame, even when this page is already on the canvas." })),
          ...STYLE_PARAMETERS,
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            const kind = p.kind as PlacedKind;
            if (!PLACED_KINDS.includes(kind)) {
              throw new CanvasToolError(`kind must be one of ${PLACED_KINDS.map((entry) => `"${entry}"`).join(", ")}.`);
            }
            const title = text(p.title, "title", DESIGN_CANVAS_LIMITS.titleChars);
            const path = kind === "file" || kind === "image" ? await checkedPath(deps.workspaceRoot, p.path, kind) : undefined;
            const x = optionalNumber(p.x, "x");
            const y = optionalNumber(p.y, "y");
            const words = typeof p.text === "string" ? p.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) : undefined;
            if (kind === "text" && !words?.trim()) throw new CanvasToolError("A text item needs text.");
            const size = kind === "text" ? (textSize(p.size) ?? "medium") : kind === "note" ? textSize(p.size) : undefined;
            const width = kind === "file" ? (designWidth(p.designWidth) ?? DESIGN_DEFAULT_FILE_WIDTH) : undefined;
            const box = kind === "connector" ? { w: 1, h: 1 } : kind === "file" ? defaultFileBox(width) : DEFAULT_BOX[kind];
            const lines = words ? words.split("\n").length : 1;
            const givenW = optionalNumber(p.w, "w");
            const givenH = optionalNumber(p.h, "h");
            const w = givenW ?? box.w;
            const h = givenH ?? (kind === "text" && size ? TEXT_LINE[size] * lines : box.h);
            if (p.fill !== undefined && p.fill !== null && !takesFill(kind)) {
              throw new CanvasToolError("Only a shape, a note or an artboard (kind frame) has a fill.");
            }
            const fill = kind === "shape" ? (color(p.fill, "fill") ?? "blue") : takesFill(kind) ? color(p.fill, "fill") : undefined;
            const outline =
              kind === "shape" || kind === "text" || kind === "note" || kind === "connector"
                ? (color(p.color, "color") ?? (kind === "shape" ? "blue" : kind === "connector" ? "gray" : undefined))
                : undefined;
            const shape: DesignShapeKind | undefined = kind === "shape" ? (p.shape === "oval" ? "oval" : "rect") : undefined;
            const duplicate = optionalBoolean(p.duplicate, "duplicate") === true;
            const id = newId();
            return edit<Record<string, unknown>>((doc) => {
              const pageId = pageOf(doc, p.page);
              const groupId = isDesignContainer(kind) ? undefined : groupOf(doc, p.groupId, pageId);
              const ends: [DesignConnectorEnd, DesignConnectorEnd] | undefined =
                kind === "connector" ? [endOf(doc, p.from, "from", pageId), endOf(doc, p.to, "to", pageId)] : undefined;
              if (ends && ends[0].frameId !== undefined && ends[0].frameId === ends[1].frameId) {
                throw new CanvasToolError("A connector joins two different frames, or a frame and a point.");
              }
              const arrow = kind === "connector" ? arrowOf(p.arrow) : undefined;
              // A page Aiden wrote is already on the canvas by itself (see
              // written-pages.ts). Placing it again adopts that frame, keeping
              // its id, instead of adding a second copy beside it, whatever
              // width it had; one at the same width is preferred.
              const candidates =
                kind === "file" && !duplicate
                  ? doc.frames.filter(
                      (entry) =>
                        entry.kind === "file" &&
                        entry.pageId === pageId &&
                        entry.path === path &&
                        entry.createdBy === "aiden" &&
                        entry.groupId === undefined &&
                        !entry.locked,
                    )
                  : [];
              const adopted =
                candidates.find((entry) => (entry.designWidth ?? DESIGN_DEFAULT_FILE_WIDTH) === width) ?? candidates[0];
              const style = stylePatch(kind, shape, p, adopted?.tweaks);
              const input: PlaceFrameInput = {
                kind,
                title,
                pageId,
                w,
                h,
                createdBy: "aiden",
                ...(ends ? { x: ends[0].x, y: ends[0].y, ends } : x !== undefined && y !== undefined ? { x, y } : {}),
                ...(groupId ? { groupId } : {}),
                ...(path ? { path } : {}),
                ...(width ? { designWidth: width } : {}),
                ...(kind === "note" ? { text: words ?? "" } : {}),
                ...((kind === "text" || kind === "shape") && words ? { text: words } : {}),
                ...(shape ? { shape, strokeWidth: 2 } : {}),
                ...(kind === "connector" ? { strokeWidth: 2 } : {}),
                ...(size ? { size } : {}),
                ...(fill ? { fill } : {}),
                ...(outline ? { color: outline } : {}),
                ...(arrow ? { arrow } : {}),
                ...style.set,
              };
              if (adopted) {
                // The adopted frame's box: as asked, the new width's box when
                // its width changed, or the box it already had.
                const resized = boxForWidth(adopted, adopted.designWidth ?? DESIGN_DEFAULT_FILE_WIDTH, width!);
                const nextW = givenW !== undefined ? clampSize(givenW, "file") : resized.w;
                const nextH = givenH !== undefined ? clampSize(givenH, "file") : resized.h;
                // Keep what the person set on the adopted frame (tweaks, dark, guide); take the new look on top.
                const merge = (box: Pick<DesignFrame, "x" | "y" | "w" | "h">, group?: string): DesignFrame => {
                  const { groupId: _oldGroup, ...kept } = adopted;
                  return applyStyle({ ...kept, title, designWidth: width!, ...box, ...(group ? { groupId: group } : {}) }, style);
                };
                if (!groupId && (x === undefined || y === undefined)) {
                  const frames = doc.frames.map((entry) =>
                    entry.id === adopted.id ? merge({ x: entry.x, y: entry.y, w: nextW, h: nextH }) : entry,
                  );
                  // A new size moves the ends of connectors on the page's sides.
                  const next = syncConnectors({ ...doc, frames });
                  const frame = next.frames.find((entry) => entry.id === adopted.id)!;
                  return { doc: next, value: { status: "placed", adopted: true, units: "canvas", frame: summarizeFrame(frame) } };
                }
                const base = { ...doc, frames: doc.frames.filter((entry) => entry.id !== adopted.id) };
                const placed = placeFrame(base, { ...input, w: nextW, h: nextH }, canvasView(base, undefined, pageId), () => adopted.id);
                if ("error" in placed) {
                  throw new CanvasToolError(
                    `The canvas is full (${DESIGN_CANVAS_LIMITS.frames} frames, ${DESIGN_CANVAS_LIMITS.framesPerPage} on a page). Remove a frame first.`,
                  );
                }
                // placeFrame synced connectors to the new box and grew its group; the merge keeps both.
                const placedDoc = syncConnectors({
                  ...placed.doc,
                  frames: placed.doc.frames.map((entry) =>
                    entry.id === adopted.id ? merge({ x: entry.x, y: entry.y, w: entry.w, h: entry.h }, entry.groupId) : entry,
                  ),
                });
                const frame = placedDoc.frames.find((entry) => entry.id === adopted.id)!;
                return { doc: placedDoc, value: { status: "placed", adopted: true, units: "canvas", frame: summarizeFrame(frame) } };
              }
              const placed = placeFrame(doc, input, canvasView(doc, undefined, pageId), () => id);
              if ("error" in placed) {
                throw new CanvasToolError(
                  `The canvas is full (${DESIGN_CANVAS_LIMITS.frames} frames, ${DESIGN_CANVAS_LIMITS.framesPerPage} on a page). Remove a frame first.`,
                );
              }
              const frame = placed.doc.frames.find((entry) => entry.id === id)!;
              return { doc: placed.doc, value: { status: "placed", units: "canvas", frame: summarizeFrame(frame) } };
            });
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_update_frame",
        label: "Update design canvas frame",
        description:
          "Change any unlocked frame on the design canvas, the person's too: move, resize, retitle or regroup it (groupId \"\" takes it out of its group), move it to another page (page), hide or lock it, change its layer order (layer front, back, forward or backward, or aboveFrameId / belowFrameId of a sibling), change the words of a note, text item or shape (notes and text keep the same Markdown subset as canvas_place_frame), colours (fill \"none\" clears a fill), size, a connector's ends, a page's designWidth (its frame resizes to match unless you pass w and h), dark look, tweaks, guide, corner radius, paper or print mode. A locked frame accepts only locked: false, and only unlock it when the person asked. Moving a group or artboard moves its frames; moving a connector moves its free ends. Boxes are in canvas units.",
        parameters: Type.Object({
          id: Type.String(),
          title: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
          fill: Type.Optional(Type.Union([ColorSchema, Type.Literal("none")])),
          color: Type.Optional(ColorSchema),
          size: Type.Optional(TextSizeSchema),
          from: Type.Optional(EndSchema),
          to: Type.Optional(EndSchema),
          arrow: Type.Optional(Type.Union([Type.Literal("end"), Type.Literal("both"), Type.Literal("none")])),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          w: Type.Optional(Type.Number()),
          h: Type.Optional(Type.Number()),
          groupId: Type.Optional(Type.String()),
          designWidth: Type.Optional(Type.Union(DESIGN_WIDTHS.map((width) => Type.Literal(width)))),
          hidden: Type.Optional(Type.Boolean()),
          locked: Type.Optional(Type.Boolean()),
          page: Type.Optional(Type.String({ maxLength: 128, description: "Move the frame (a group or artboard with its frames) to this page, by name or id." })),
          layer: Type.Optional(
            Type.Union([Type.Literal("front"), Type.Literal("back"), Type.Literal("forward"), Type.Literal("backward")]),
          ),
          aboveFrameId: Type.Optional(Type.String({ description: "Put it just in front of this sibling." })),
          belowFrameId: Type.Optional(Type.String({ description: "Put it just behind this sibling." })),
          ...STYLE_PARAMETERS,
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            const x = optionalNumber(p.x, "x");
            const y = optionalNumber(p.y, "y");
            const w = optionalNumber(p.w, "w");
            const h = optionalNumber(p.h, "h");
            const width = designWidth(p.designWidth);
            const title = p.title === undefined ? undefined : text(p.title, "title", DESIGN_CANVAS_LIMITS.titleChars);
            const clearFill = p.fill === "none";
            const fill = clearFill ? undefined : color(p.fill, "fill");
            const outline = color(p.color, "color");
            const size = textSize(p.size);
            const hidden = optionalBoolean(p.hidden, "hidden");
            const locked = optionalBoolean(p.locked, "locked");
            const layer = p.layer;
            if (layer !== undefined && layer !== null && !["front", "back", "forward", "backward"].includes(layer as string)) {
              throw new CanvasToolError('layer must be "front", "back", "forward" or "backward".');
            }
            const layerOptions = [layer, p.aboveFrameId, p.belowFrameId].filter((value) => value !== undefined && value !== null && value !== "");
            if (layerOptions.length > 1) throw new CanvasToolError("Pass only one of layer, aboveFrameId and belowFrameId.");
            return edit((doc) => {
              const frame = frameIn(doc, p.id);
              if (frame.locked && locked !== false) throw new CanvasToolError(LOCKED_MESSAGE);
              const worded = frame.kind === "note" || frame.kind === "text" || frame.kind === "shape";
              if (p.text !== undefined && !worded) throw new CanvasToolError("Only a note, a text item or a shape has text.");
              if (width !== undefined && frame.kind !== "file") throw new CanvasToolError("Only a file frame has a design width.");
              if ((fill !== undefined || clearFill) && !takesFill(frame.kind)) {
                throw new CanvasToolError("Only a shape, a note or an artboard (kind frame) has a fill.");
              }
              if (outline !== undefined && !["shape", "text", "note", "connector", "stroke"].includes(frame.kind)) {
                throw new CanvasToolError("Only a shape, text, note, connector or drawing has a color.");
              }
              if (size !== undefined && frame.kind !== "text" && frame.kind !== "note") {
                throw new CanvasToolError("Only a text item or a note has a size.");
              }
              const connector = frame.kind === "connector";
              if (!connector && (p.from !== undefined || p.to !== undefined || p.arrow !== undefined)) {
                throw new CanvasToolError("Only a connector has from, to and arrow.");
              }
              if (connector && (w !== undefined || h !== undefined)) {
                throw new CanvasToolError("A connector's size follows its ends; move them with from and to.");
              }
              const style = stylePatch(frame.kind, frame.shape, p, frame.tweaks);
              const targetPage =
                p.page !== undefined && p.page !== null && p.page !== "" ? pageOf(doc, p.page) : frame.pageId;
              const movingPage = targetPage !== frame.pageId;
              const containerMembers = isDesignContainer(frame.kind)
                ? doc.frames.filter((entry) => entry.groupId === frame.id && entry.pageId === frame.pageId)
                : [];
              const willTranslate =
                isDesignContainer(frame.kind) &&
                ((x !== undefined && clampCoord(x) !== frame.x) || (y !== undefined && clampCoord(y) !== frame.y));
              if (willTranslate || movingPage) {
                const lockedMember = containerMembers.find((entry) => entry.locked);
                if (lockedMember) {
                  throw new CanvasToolError(
                    `${JSON.stringify(lockedMember.title || lockedMember.id)} inside ${JSON.stringify(frame.title || frame.id)} is locked; unlock or ungroup it first.`,
                  );
                }
              }
              if (movingPage) {
                const onTarget = doc.frames.filter((entry) => entry.pageId === targetPage).length;
                if (onTarget + 1 + containerMembers.length > DESIGN_CANVAS_LIMITS.framesPerPage) {
                  throw new CanvasToolError(`That page is full (${DESIGN_CANVAS_LIMITS.framesPerPage} frames).`);
                }
              }
              const baseDoc = movingPage ? moveFramesToPage(doc, [frame.id], targetPage) : doc;
              const current = baseDoc.frames.find((entry) => entry.id === frame.id)!;
              // A new design width resizes the page's frame to match on any axis not explicitly given.
              const widthBox =
                width !== undefined
                  ? boxForWidth(current, current.designWidth ?? DESIGN_DEFAULT_FILE_WIDTH, width)
                  : undefined;
              let next: DesignFrame = {
                ...current,
                ...(title !== undefined ? { title } : {}),
                ...(typeof p.text === "string" ? { text: p.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) } : {}),
                ...(x !== undefined && !connector ? { x: clampCoord(x) } : {}),
                ...(y !== undefined && !connector ? { y: clampCoord(y) } : {}),
                ...(widthBox ?? {}),
                ...(w !== undefined ? { w: clampSize(w, current.kind) } : {}),
                ...(h !== undefined ? { h: clampSize(h, current.kind) } : {}),
                ...(width !== undefined ? { designWidth: width } : {}),
                ...(fill !== undefined ? { fill } : {}),
                ...(outline !== undefined ? { color: outline } : {}),
                ...(size !== undefined ? { size } : {}),
                ...(hidden === true ? { hidden: true as const } : {}),
                ...(locked === true ? { locked: true as const } : {}),
              };
              if (clearFill) delete next.fill;
              if (hidden === false) delete next.hidden;
              if (locked === false) delete next.locked;
              next = applyStyle(next, style);
              if (connector) {
                next = translateConnector(
                  next,
                  x !== undefined ? clampCoord(x) - current.x : 0,
                  y !== undefined ? clampCoord(y) - current.y : 0,
                );
                const ends = next.ends!;
                const from = p.from !== undefined ? endOf(baseDoc, p.from, "from", current.pageId, current.id) : ends[0];
                const to = p.to !== undefined ? endOf(baseDoc, p.to, "to", current.pageId, current.id) : ends[1];
                if (from.frameId !== undefined && from.frameId === to.frameId) {
                  throw new CanvasToolError("A connector joins two different frames, or a frame and a point.");
                }
                const { arrow: _arrow, ...rest } = next;
                const arrow = p.arrow !== undefined ? arrowOf(p.arrow) : current.arrow;
                next = { ...rest, ends: [from, to], ...(arrow ? { arrow } : {}) };
              }
              if (p.groupId !== undefined) {
                if (isDesignContainer(current.kind)) {
                  throw new CanvasToolError("A group or frame (artboard) cannot be put inside another.");
                }
                const groupId = groupOf(baseDoc, p.groupId, current.pageId);
                const { groupId: _old, ...rest } = next;
                next = groupId ? { ...rest, groupId } : rest;
              }
              // A moved group or artboard takes its frames with it, as dragging it does.
              const dx = isDesignContainer(current.kind) ? next.x - current.x : 0;
              const dy = isDesignContainer(current.kind) ? next.y - current.y : 0;
              let frames = baseDoc.frames.map((entry) => (entry.id === current.id ? { ...next, x: current.x, y: current.y } : entry));
              frames = translateFrames(frames, current.id, dx, dy, new Set());
              frames = frames.map((entry) => (entry.id === current.id ? next : entry));
              // A group grows to hold a frame moved into it or past its edge.
              const group = next.groupId ? frames.find((entry) => entry.id === next.groupId) : undefined;
              if (group?.kind === "group") {
                const grown = growGroupToHold(group, next);
                if (grown !== group) frames = frames.map((entry) => (entry.id === group.id ? grown : entry));
              }
              // Connectors on a moved frame follow it.
              let updatedDoc = syncConnectors({ ...baseDoc, frames });
              if (layerOptions.length === 1) {
                const sibling = p.aboveFrameId ?? p.belowFrameId;
                if (typeof sibling === "string" && sibling) {
                  const target = frameIn(updatedDoc, sibling);
                  const current = updatedDoc.frames.find((entry) => entry.id === frame.id)!;
                  if (
                    target.id === current.id ||
                    target.pageId !== current.pageId ||
                    (target.groupId ?? null) !== (current.groupId ?? null) ||
                    isDesignContainer(target.kind) !== isDesignContainer(current.kind)
                  ) {
                    throw new CanvasToolError(
                      "aboveFrameId and belowFrameId must name a sibling: another frame in the same group (or none) on the same page, and a group or artboard only beside another.",
                    );
                  }
                  updatedDoc = reorderLayer(updatedDoc, frame.id, target.id, p.aboveFrameId ? "above" : "below");
                } else if (layer === "front") updatedDoc = bringLayerToFront(updatedDoc, frame.id);
                else if (layer === "back") updatedDoc = sendLayerToBack(updatedDoc, frame.id);
                else if (layer === "forward" || layer === "backward") updatedDoc = stepLayer(updatedDoc, frame.id, layer);
              }
              const updated = updatedDoc.frames.find((entry) => entry.id === frame.id)!;
              return { doc: updatedDoc, value: { status: "updated", units: "canvas", frame: summarizeFrame(updated) } };
            });
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_remove_frame",
        label: "Remove design canvas frame",
        description:
          "Remove a frame from the design canvas. The file it shows is not deleted. A locked frame cannot be removed. A frame the person added needs force: true, and only after they asked you to delete it; say in your reply that you removed it. Removing a group or an artboard keeps what is in it; a connector on a removed frame keeps its place there.",
        parameters: Type.Object({
          id: Type.String(),
          force: Type.Optional(Type.Boolean({ description: "Only when the person asked you to delete their own items." })),
          confirm: Type.Optional(Type.Boolean({ description: "The same as force." })),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            return edit((doc) => {
              const frame = frameIn(doc, p.id);
              if (frame.locked) {
                throw new CanvasToolError("That frame is locked, so it cannot be removed. The person can unlock it first.");
              }
              if (frame.createdBy === "person" && p.force !== true && p.confirm !== true) {
                throw new CanvasToolError(
                  "The person added this frame. Remove it only if they asked you to delete it, and then pass force: true.",
                );
              }
              const frames = doc.frames
                .filter((entry) => entry.id !== frame.id)
                .map((entry) => {
                  if (entry.groupId !== frame.id) return entry;
                  const { groupId: _groupId, ...rest } = entry;
                  return rest;
                });
              // Its comments go with it, as when the person removes a frame.
              const comments = commentsWithoutFrames(doc.comments, new Set([frame.id]));
              return {
                doc: syncConnectors({ ...doc, frames, comments }),
                value: { status: "removed", id: frame.id, ...(frame.createdBy === "person" ? { personFrame: true } : {}) },
              };
            });
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_focus",
        label: "Show on design canvas",
        description:
          "Pan and zoom the design canvas so the person sees these frames (every frame on the page when ids is empty). Frames on another page bring that page on screen; pass page alone to show a page. The canvas leaves the view alone while the person is moving around it.",
        parameters: Type.Object({
          ids: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id to show." })),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            if (!deps.focus) return { status: "unavailable", reason: "No window is showing this canvas." };
            const p = (raw ?? {}) as { ids?: unknown; page?: unknown };
            const ids = Array.isArray(p.ids) ? [...new Set(p.ids)] : [];
            const doc = await deps.store.get(deps.chatId);
            const pages = new Set(ids.map((id) => frameIn(doc, id).pageId));
            if (pages.size > 1) throw new CanvasToolError("Those frames are on different pages; show one page's frames at a time.");
            const named = p.page !== undefined && p.page !== null && p.page !== "" ? pageOf(doc, p.page) : undefined;
            if (named && pages.size === 1 && !pages.has(named)) {
              throw new CanvasToolError("Those frames are not on that page. Leave page out to show the page they are on.");
            }
            const [pageId = named ?? doc.activePageId] = pages;
            const onPage = framesOnPage(doc, pageId).length;
            // Frames on another page: that page comes on screen first.
            if (pageId !== doc.activePageId) await edit((latest) => ({ doc: showPage(latest, pageId), value: null }));
            if (onPage === 0) {
              if (named) return { status: "shown", page: pageId, frames: 0 };
              throw new CanvasToolError("This page of the canvas is empty.");
            }
            deps.focus(ids as string[]);
            return { status: "requested", frames: ids.length || onPage };
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_arrange",
        label: "Arrange design canvas",
        description:
          "Lay out unlocked frames of one page in a tidy row, column or grid in one call, and optionally put them in a group or artboard (groupId) or take them out of one (groupId null). Name the frames with frameIds; leave frameIds out to arrange a group's members (with groupId) or every top-level frame on the page. Groups fit themselves around their members afterwards; pass fitGroupIds to tighten or expand other groups or artboards around what they hold. A group or artboard moves with its frames. x and y set the top-left corner (by default the group's inside corner, or where the frames already start). The page comes on screen and the arranged frames are shown unless focus is false.",
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id, when frameIds are not given." })),
          frameIds: Type.Optional(Type.Array(Type.String(), { maxItems: DESIGN_CANVAS_LIMITS.framesPerPage })),
          layout: Type.Optional(Type.Union([Type.Literal("row"), Type.Literal("column"), Type.Literal("grid")])),
          columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          gap: Type.Optional(Type.Number({ minimum: 0, maximum: 2000, description: "Space between columns (default 64)." })),
          rowGap: Type.Optional(Type.Number({ minimum: 0, maximum: 2000, description: "Space between rows (default 80)." })),
          align: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("center"), Type.Literal("end")])),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          groupId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          fitGroupIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
          focus: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = (raw ?? {}) as Record<string, unknown>;
            const layoutValue = p.layout;
            if (layoutValue !== undefined && layoutValue !== null && layoutValue !== "row" && layoutValue !== "column" && layoutValue !== "grid") {
              throw new CanvasToolError('layout must be "row", "column" or "grid".');
            }
            const align = (p.align ?? "start") as Align;
            if (align !== "start" && align !== "center" && align !== "end") {
              throw new CanvasToolError('align must be "start", "center" or "end".');
            }
            const gap = Math.min(2000, Math.max(0, optionalNumber(p.gap, "gap") ?? DESIGN_FRAME_GAP));
            const rowGap = Math.min(2000, Math.max(0, optionalNumber(p.rowGap, "rowGap") ?? 80));
            const columnsValue = optionalNumber(p.columns, "columns");
            const anchorX = optionalNumber(p.x, "x");
            const anchorY = optionalNumber(p.y, "y");
            const focus = optionalBoolean(p.focus, "focus") ?? true;
            const requested = Array.isArray(p.frameIds) ? [...new Set(p.frameIds as unknown[])] : undefined;
            const fitIds = Array.isArray(p.fitGroupIds) ? [...new Set(p.fitGroupIds as unknown[])] : [];
            const ungroup = p.groupId === null || p.groupId === "";
            const intoGroup = typeof p.groupId === "string" && p.groupId !== "" ? p.groupId : undefined;
            const answer = await edit((doc) => {
              // The page: the frames', the group's, or the named one.
              let pageId: string;
              let chosen: DesignFrame[];
              const skippedLocked: string[] = [];
              const containerHasLockedMember = (container: DesignFrame) =>
                isDesignContainer(container.kind) &&
                doc.frames.some((entry) => entry.groupId === container.id && entry.pageId === container.pageId && entry.locked);
              if (requested && requested.length > 0) {
                chosen = requested.map((id) => frameIn(doc, id));
                const pages = new Set(chosen.map((frame) => frame.pageId));
                if (pages.size > 1) throw new CanvasToolError("Arrange frames of one page at a time.");
                pageId = chosen[0]!.pageId;
                const locked = chosen.filter((frame) => frame.locked || containerHasLockedMember(frame));
                if (locked.length > 0) {
                  throw new CanvasToolError(`${locked.map((frame) => JSON.stringify(frame.title || frame.id)).join(", ")} ${locked.length === 1 ? "is" : "are"} locked; leave ${locked.length === 1 ? "it" : "them"} out.`);
                }
                if (chosen.some((frame) => frame.kind === "connector")) {
                  throw new CanvasToolError("Connectors follow their frames; leave them out of frameIds.");
                }
              } else {
                const group = intoGroup ? frameIn(doc, intoGroup) : undefined;
                const firstFit =
                  !group && (p.page === undefined || p.page === null || p.page === "") && fitIds.length > 0
                    ? frameIn(doc, fitIds[0])
                    : undefined;
                pageId = group ? group.pageId : firstFit ? firstFit.pageId : pageOf(doc, p.page);
                const arrangeNothing = !intoGroup && fitIds.length > 0 && layoutValue === undefined;
                chosen = arrangeNothing
                  ? []
                  : doc.frames.filter(
                      (frame) =>
                        frame.pageId === pageId &&
                        frame.kind !== "connector" &&
                        (intoGroup ? frame.groupId === intoGroup : frame.groupId === undefined),
                    );
                for (const frame of chosen) if (frame.locked || containerHasLockedMember(frame)) skippedLocked.push(frame.id);
                chosen = chosen.filter((frame) => !frame.locked && !containerHasLockedMember(frame));
              }
              const target = intoGroup ? groupOf(doc, intoGroup, pageId) : undefined;
              if (target && chosen.some((frame) => isDesignContainer(frame.kind))) {
                throw new CanvasToolError("A group or frame (artboard) cannot be put inside another.");
              }
              const fitTargets = fitIds.map((id) => {
                const group = frameIn(doc, id);
                if (!isDesignContainer(group.kind)) throw new CanvasToolError("fitGroupIds must name groups or artboards.");
                if (group.pageId !== pageId) throw new CanvasToolError("Arrange frames of one page at a time.");
                if (group.locked) throw new CanvasToolError(`${JSON.stringify(group.title || group.id)} is locked.`);
                return group;
              });
              if (chosen.length === 0 && fitTargets.length === 0) {
                throw new CanvasToolError("There are no unlocked frames to arrange there.");
              }
              let frames = doc.frames;
              const chosenIds = new Set(chosen.map((frame) => frame.id));
              if (!target && !ungroup && chosen.some((frame) => frame.groupId !== undefined && chosenIds.has(frame.groupId))) {
                throw new CanvasToolError(
                  "A group or artboard moves with its frames; pass either the group or its members in frameIds, or pass groupId: null to ungroup them.",
                );
              }
              const layout: Layout = (layoutValue as Layout | undefined) ?? (chosen.length > 4 ? "grid" : "row");
              if (chosen.length > 0) {
                const container = target ? doc.frames.find((frame) => frame.id === target)! : undefined;
                const anchor = {
                  x: anchorX ?? (container ? container.x + GROUP_PADDING.left : Math.min(...chosen.map((frame) => frame.x))),
                  y: anchorY ?? (container ? container.y + GROUP_PADDING.top : Math.min(...chosen.map((frame) => frame.y))),
                };
                const columns = Math.min(50, Math.max(1, Math.round(columnsValue ?? Math.ceil(Math.sqrt(chosen.length)))));
                const spots = layoutBoxes(chosen, { layout, columns, gap, rowGap, align, anchor });
                chosen.forEach((frame, index) => {
                  const spot = spots[index]!;
                  frames = translateFrames(frames, frame.id, clampCoord(spot.x) - frame.x, clampCoord(spot.y) - frame.y, chosenIds);
                });
                if (target || ungroup) {
                  frames = frames.map((entry) => {
                    if (!chosenIds.has(entry.id)) return entry;
                    const { groupId: _old, ...rest } = entry;
                    return target ? { ...rest, groupId: target } : rest;
                  });
                }
              }
              let next = syncConnectors({ ...doc, frames });
              // Groups the frames went into or left fit themselves around their members; artboards keep their size unless named.
              const affected = new Set<string>();
              for (const frame of chosen) if (frame.groupId) affected.add(frame.groupId);
              if (target) affected.add(target);
              for (const id of affected) {
                if (next.frames.find((entry) => entry.id === id)?.kind === "group") next = fitGroupToMembers(next, id);
              }
              for (const group of fitTargets) next = fitGroupToMembers(next, group.id);
              const fitted = [...new Set([...affected, ...fitTargets.map((group) => group.id)])]
                .map((id) => next.frames.find((entry) => entry.id === id))
                .filter((entry): entry is DesignFrame => entry !== undefined && (entry.kind === "group" || fitIds.includes(entry.id)));
              if (focus && pageId !== next.activePageId) next = showPage(next, pageId);
              const arranged = chosen.map((frame) => next.frames.find((entry) => entry.id === frame.id)!);
              return {
                doc: next,
                value: {
                  status: "arranged",
                  units: "canvas",
                  page: pageId,
                  ...(chosen.length > 0 ? { layout } : {}),
                  frames: arranged.map((frame) => ({ id: frame.id, title: frame.title, box: { x: frame.x, y: frame.y, w: frame.w, h: frame.h }, ...(frame.groupId ? { groupId: frame.groupId } : {}) })),
                  ...(fitted.length > 0 ? { groups: fitted.map((frame) => ({ id: frame.id, title: frame.title, box: { x: frame.x, y: frame.y, w: frame.w, h: frame.h } })) } : {}),
                  ...(skippedLocked.length > 0 ? { skippedLocked } : {}),
                  focusIds: [...arranged.map((frame) => frame.id), ...fitted.map((frame) => frame.id)],
                },
              };
            });
            const { focusIds, ...value } = answer as { focusIds: string[] } & Record<string, unknown>;
            if (focus && deps.focus && focusIds.length > 0) deps.focus(focusIds);
            return value;
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_page",
        label: "Change design canvas pages",
        description:
          "Organise the design canvas's pages: add one (name; it comes on screen unless show is false), rename one, duplicate one with everything on it, delete one with its frames (never the last page; one holding the person's or locked frames needs force: true, only when they asked), move one earlier (step -1) or later (step 1) in the list, or show one. Pages are named by name or id.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("add"),
            Type.Literal("rename"),
            Type.Literal("duplicate"),
            Type.Literal("delete"),
            Type.Literal("move"),
            Type.Literal("show"),
          ]),
          page: Type.Optional(Type.String({ maxLength: 128 })),
          name: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.pageNameChars })),
          show: Type.Optional(Type.Boolean()),
          step: Type.Optional(Type.Union([Type.Literal(-1), Type.Literal(1)])),
          force: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = (raw ?? {}) as Record<string, unknown>;
            const action = p.action;
            const name = typeof p.name === "string" ? p.name.trim() : undefined;
            const pageNeeded = () => {
              if (p.page === undefined || p.page === null || p.page === "") {
                throw new CanvasToolError(`The ${String(action)} action needs page.`);
              }
            };
            return edit((doc) => {
              let next = doc;
              let pageId: string;
              switch (action) {
                case "add": {
                  if (!canAddPage(doc)) throw new CanvasToolError(`The canvas has its most pages (${DESIGN_CANVAS_LIMITS.pages}).`);
                  pageId = newId();
                  next = addPage(doc, pageId, name);
                  if (optionalBoolean(p.show, "show") === false) next = { ...next, activePageId: doc.activePageId };
                  break;
                }
                case "rename": {
                  pageNeeded();
                  pageId = pageOf(doc, p.page);
                  if (!name) throw new CanvasToolError("rename needs a non-empty name.");
                  next = renamePage(doc, pageId, name);
                  break;
                }
                case "duplicate": {
                  pageNeeded();
                  const source = pageOf(doc, p.page);
                  if (!canAddPage(doc)) throw new CanvasToolError(`The canvas has its most pages (${DESIGN_CANVAS_LIMITS.pages}).`);
                  pageId = newId();
                  next = duplicatePage(doc, source, pageId, newId);
                  if (next === doc) throw new CanvasToolError(`A copy would pass the canvas's ${DESIGN_CANVAS_LIMITS.frames} frames.`);
                  if (name) next = renamePage(next, pageId, name);
                  break;
                }
                case "delete": {
                  pageNeeded();
                  pageId = pageOf(doc, p.page);
                  if (doc.pages.length <= 1) throw new CanvasToolError("The canvas keeps at least one page, so its only page cannot be deleted.");
                  const kept = doc.frames.filter((frame) => frame.pageId === pageId && (frame.createdBy === "person" || frame.locked));
                  if (kept.length > 0 && p.force !== true) {
                    throw new CanvasToolError(
                      `That page holds ${kept.length} ${kept.length === 1 ? "frame" : "frames"} the person added or locked. Delete it only if they asked, and then pass force: true.`,
                    );
                  }
                  next = deletePage(doc, pageId);
                  break;
                }
                case "move": {
                  pageNeeded();
                  pageId = pageOf(doc, p.page);
                  if (p.step !== -1 && p.step !== 1) throw new CanvasToolError("move needs step -1 (earlier) or 1 (later).");
                  next = movePage(doc, pageId, p.step);
                  break;
                }
                case "show": {
                  pageNeeded();
                  pageId = pageOf(doc, p.page);
                  next = showPage(doc, pageId);
                  break;
                }
                default:
                  throw new CanvasToolError('action must be "add", "rename", "duplicate", "delete", "move" or "show".');
              }
              return {
                doc: next,
                value: {
                  status: action === "delete" ? "deleted" : "done",
                  action,
                  ...(action !== "delete" ? { page: { id: pageId, name: next.pages.find((entry) => entry.id === pageId)?.name } } : { page: { id: pageId } }),
                  pages: pagesAnswer(next),
                },
              };
            });
          }),
      },
      "never",
    ),
  ];
}
