// Aiden's tools for a chat's design canvas (design mode P3a).
//
// They exist only for an attended desktop turn in a chat with design mode on
// (see `designCanvasToolsAllowed`). Every edit goes through the store's
// serialized `update`, then a `designCanvas:updated` broadcast, so an open
// canvas refetches and shows it the same way it shows another window's save.

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { canvasView, describeCanvas, summarizeFrame } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { canAttachTo, syncConnectors, translateConnector } from "../../../renderer/shared/design-canvas/connectors.js";
import {
  clampCoord,
  clampSize,
  placeFrame,
  type PlaceFrameInput,
} from "../../../renderer/shared/design-canvas/placement.js";
import {
  DESIGN_CANVAS_LIMITS,
  DESIGN_COLORS,
  DESIGN_WIDTHS,
  framesOnPage,
  isDesignContainer,
  isDesignRelativePath,
  type DesignCanvas,
  type DesignColor,
  type DesignConnectorEnd,
  type DesignFrame,
  type DesignSide,
  type DesignTextSize,
  type DesignWidth,
} from "../../../renderer/shared/design-canvas/schema.js";
import { showPage } from "../../../renderer/shared/design-canvas/pages.js";
import { resolveDesignFile } from "./resolve-core.js";
import type { DesignCanvasStore } from "./store.js";

export const DESIGN_CANVAS_TOOL_NAMES = [
  "canvas_read",
  "canvas_place_frame",
  "canvas_update_frame",
  "canvas_remove_frame",
  "canvas_focus",
] as const;

/** Canvas tool calls one turn may make; past it each call returns `limit_reached`. */
export const DESIGN_CANVAS_CALLS_PER_TURN = 20;

type PlacedKind = "file" | "image" | "note" | "group" | "text" | "shape" | "connector" | "frame";
const PLACED_KINDS: readonly PlacedKind[] = ["file", "image", "note", "group", "text", "shape", "connector", "frame"];

/** Default boxes, matching the canvas's Add menu and drawing tools. A text box's height follows its lines. */
const DEFAULT_BOX: Record<Exclude<PlacedKind, "connector">, { w: number; h: number }> = {
  file: { w: 640, h: 436 },
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
const DEFAULT_DESIGN_WIDTH: DesignWidth = 1280;

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
  "- Call canvas_read before changing the canvas, and again if the person says they moved things.",
  "- To show a design, write a self-contained HTML file in the workspace (for example under design/), then place it with canvas_place_frame. Put each direction in its own group.",
  "- A visual you draw with render_artifact also lands on the canvas. Drawing it again under the same title replaces it in place.",
  "- Move, resize or retitle your own frames with canvas_update_frame. Remove a frame the person added only when they ask, with confirm: true.",
  "- For a flow or diagram, place shapes (with their labels in text), text and frames (artboards), then connectors between them by frameId; a connector follows its frames when they move.",
  "- After placing or moving frames, call canvas_focus with their ids so the person sees them. canvas_read with snapshot: true shows you the canvas as the person sees it.",
  "- The canvas can have several pages. Work on the page the person is looking at unless they name another; canvas_read lists the pages, and canvas_read and canvas_place_frame take a page.",
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

  return [
    declarePiRuntimeReplay(
      {
        name: "canvas_read",
        label: "Read design canvas",
        description:
          "Read the design canvas beside this chat: its pages, and on one page (the one the person is looking at unless you name another) the visible area, the frames in it (id, kind, title, path, box, group, open comments), a count of frames elsewhere, and the page's open and sent comments (each with its commentId, note, frame, file and the element it points at). Boxes are in canvas units. Pass snapshot: true to also see a picture of the canvas as the person sees it.",
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
          "Put a frame on the design canvas: a workspace HTML page (kind file), an image, a note, a group, or a drawn item for flows and diagrams: text, a shape (rect or oval, with an optional label in text), a frame (an empty artboard that holds shapes and text like a group) or a connector (an arrow or line from one frame or point to another; an end on a frame follows it). Notes and text items take a small Markdown subset: **bold**, *italic*, <u>underline</u>, [links](https://…), and lines starting \"- \" or \"1. \" for lists; size and color apply to the whole note or text, and fill gives a note its colour. Write the file first with your file tools; path is workspace-relative. It goes on the page the person is looking at unless you name another. Leave x and y out to place it right of the last frame in its group or in view. Boxes are in canvas units.",
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
            const box = kind === "connector" ? { w: 1, h: 1 } : DEFAULT_BOX[kind];
            const lines = words ? words.split("\n").length : 1;
            const w = optionalNumber(p.w, "w") ?? box.w;
            const h = optionalNumber(p.h, "h") ?? (kind === "text" && size ? TEXT_LINE[size] * lines : box.h);
            const width = kind === "file" ? (designWidth(p.designWidth) ?? DEFAULT_DESIGN_WIDTH) : undefined;
            const fill = kind === "shape" ? (color(p.fill, "fill") ?? "blue") : kind === "note" ? color(p.fill, "fill") : undefined;
            const outline =
              kind === "shape" || kind === "text" || kind === "note" || kind === "connector"
                ? (color(p.color, "color") ?? (kind === "shape" ? "blue" : kind === "connector" ? "gray" : undefined))
                : undefined;
            const id = newId();
            return edit((doc) => {
              const pageId = pageOf(doc, p.page);
              const groupId = isDesignContainer(kind) ? undefined : groupOf(doc, p.groupId, pageId);
              const ends: [DesignConnectorEnd, DesignConnectorEnd] | undefined =
                kind === "connector" ? [endOf(doc, p.from, "from", pageId), endOf(doc, p.to, "to", pageId)] : undefined;
              if (ends && ends[0].frameId !== undefined && ends[0].frameId === ends[1].frameId) {
                throw new CanvasToolError("A connector joins two different frames, or a frame and a point.");
              }
              const arrow = kind === "connector" ? arrowOf(p.arrow) : undefined;
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
                ...(kind === "shape" ? { shape: p.shape === "oval" ? ("oval" as const) : ("rect" as const), strokeWidth: 2 } : {}),
                ...(kind === "connector" ? { strokeWidth: 2 } : {}),
                ...(size ? { size } : {}),
                ...(fill ? { fill } : {}),
                ...(outline ? { color: outline } : {}),
                ...(arrow ? { arrow } : {}),
              };
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
          "Move, resize, retitle or regroup a frame on the design canvas, change the words of a note, text item or shape (notes and text keep the same Markdown subset as canvas_place_frame), a note's or drawn item's colours and size, or where a connector's ends are. Pass groupId \"\" to take a frame out of its group. Moving a connector moves its free ends. Boxes are in canvas units.",
        parameters: Type.Object({
          id: Type.String(),
          title: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
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
            const fill = color(p.fill, "fill");
            const outline = color(p.color, "color");
            const size = textSize(p.size);
            return edit((doc) => {
              const frame = frameIn(doc, p.id);
              const worded = frame.kind === "note" || frame.kind === "text" || frame.kind === "shape";
              if (p.text !== undefined && !worded) throw new CanvasToolError("Only a note, a text item or a shape has text.");
              if (width !== undefined && frame.kind !== "file") throw new CanvasToolError("Only a file frame has a design width.");
              if (fill !== undefined && frame.kind !== "shape" && frame.kind !== "note") {
                throw new CanvasToolError("Only a shape or a note has a fill.");
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
              let next: DesignFrame = {
                ...frame,
                ...(title !== undefined ? { title } : {}),
                ...(typeof p.text === "string" ? { text: p.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) } : {}),
                ...(x !== undefined && !connector ? { x: clampCoord(x) } : {}),
                ...(y !== undefined && !connector ? { y: clampCoord(y) } : {}),
                ...(w !== undefined ? { w: clampSize(w, frame.kind) } : {}),
                ...(h !== undefined ? { h: clampSize(h, frame.kind) } : {}),
                ...(width !== undefined ? { designWidth: width } : {}),
                ...(fill !== undefined ? { fill } : {}),
                ...(outline !== undefined ? { color: outline } : {}),
                ...(size !== undefined ? { size } : {}),
              };
              if (connector) {
                next = translateConnector(next, x !== undefined ? x - frame.x : 0, y !== undefined ? y - frame.y : 0);
                const ends = next.ends!;
                const from = p.from !== undefined ? endOf(doc, p.from, "from", frame.pageId, frame.id) : ends[0];
                const to = p.to !== undefined ? endOf(doc, p.to, "to", frame.pageId, frame.id) : ends[1];
                if (from.frameId !== undefined && from.frameId === to.frameId) {
                  throw new CanvasToolError("A connector joins two different frames, or a frame and a point.");
                }
                const { arrow: _arrow, ...rest } = next;
                const arrow = p.arrow !== undefined ? arrowOf(p.arrow) : frame.arrow;
                next = { ...rest, ends: [from, to], ...(arrow ? { arrow } : {}) };
              }
              if (p.groupId !== undefined) {
                if (isDesignContainer(frame.kind)) {
                  throw new CanvasToolError("A group or frame (artboard) cannot be put inside another.");
                }
                const groupId = groupOf(doc, p.groupId, frame.pageId);
                const { groupId: _old, ...rest } = next;
                next = groupId ? { ...rest, groupId } : rest;
              }
              // A moved group or artboard takes its frames with it, as dragging it does.
              const dx = isDesignContainer(frame.kind) ? next.x - frame.x : 0;
              const dy = isDesignContainer(frame.kind) ? next.y - frame.y : 0;
              const frames = doc.frames.map((entry) => {
                if (entry.id === frame.id) return next;
                if ((dx !== 0 || dy !== 0) && entry.groupId === frame.id) {
                  return entry.kind === "connector"
                    ? translateConnector(entry, dx, dy)
                    : { ...entry, x: clampCoord(entry.x + dx), y: clampCoord(entry.y + dy) };
                }
                return entry;
              });
              // Connectors on a moved frame follow it.
              const synced = syncConnectors({ ...doc, frames });
              const updated = synced.frames.find((entry) => entry.id === frame.id)!;
              return { doc: synced, value: { status: "updated", units: "canvas", frame: summarizeFrame(updated) } };
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
          "Remove a frame from the design canvas. The file it shows is not deleted. A frame the person added needs confirm: true and only after they asked; say in your reply that you removed it. Removing a group or an artboard keeps what is in it; a connector on a removed frame keeps its place there.",
        parameters: Type.Object({ id: Type.String(), confirm: Type.Optional(Type.Boolean()) }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            return edit((doc) => {
              const frame = frameIn(doc, p.id);
              if (frame.createdBy === "person" && p.confirm !== true) {
                throw new CanvasToolError(
                  "The person added this frame. Remove it only if they asked, and then pass confirm: true.",
                );
              }
              const frames = doc.frames
                .filter((entry) => entry.id !== frame.id)
                .map((entry) => {
                  if (entry.groupId !== frame.id) return entry;
                  const { groupId: _groupId, ...rest } = entry;
                  return rest;
                });
              return {
                doc: syncConnectors({ ...doc, frames }),
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
          "Pan and zoom the design canvas so the person sees these frames (every frame on the page on screen when ids is empty). Frames on another page bring that page on screen. The canvas leaves the view alone while the person is moving around it.",
        parameters: Type.Object({
          ids: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            if (!deps.focus) return { status: "unavailable", reason: "No window is showing this canvas." };
            const requested = (raw as { ids?: unknown } | undefined)?.ids;
            const ids = Array.isArray(requested) ? [...new Set(requested)] : [];
            const doc = await deps.store.get(deps.chatId);
            const pages = new Set(ids.map((id) => frameIn(doc, id).pageId));
            if (pages.size > 1) throw new CanvasToolError("Those frames are on different pages; show one page's frames at a time.");
            const [pageId = doc.activePageId] = pages;
            const onPage = framesOnPage(doc, pageId).length;
            if (onPage === 0) throw new CanvasToolError("This page of the canvas is empty.");
            // Frames on another page: that page comes on screen first.
            if (pageId !== doc.activePageId) await edit((latest) => ({ doc: showPage(latest, pageId), value: null }));
            deps.focus(ids as string[]);
            return { status: "requested", frames: ids.length || onPage };
          }),
      },
      "never",
    ),
  ];
}
