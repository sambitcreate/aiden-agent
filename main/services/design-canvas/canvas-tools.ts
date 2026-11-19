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
import { Type } from "typebox";
import { declareOnDemandSummary } from "../on-demand-tools.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { CANVAS_READ_FRAME_LIMIT, canvasReadCursorPage, canvasView, describeCanvas, parseCanvasReadCursor, summarizeFrame } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import {
  commentsWithoutFrames,
  replyToComment,
  resolveComment,
} from "../../../renderer/shared/design-canvas/comments.js";
import { canAttachTo, syncConnectors, translateConnector } from "../../../renderer/shared/design-canvas/connectors.js";
import {
  bringLayerToFront,
  reorderLayer,
  sendLayerToBack,
  stepLayer,
} from "../../../renderer/shared/design-canvas/layers.js";
import {
  besideBox,
  clampCoord,
  clampSize,
  copyFrames,
  DESIGN_FRAME_GAP,
  fitGroupToMembers,
  GROUP_PADDING,
  growGroupToHold,
  placeFrame,
  refitGroups,
  type DesignBeside,
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
  designFrameByIdOrPath,
  isDesignLine,
  designPagePath,
  frameShowingDesignPage,
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
import { designPageTweakNames } from "./inspect.js";
import { resolveDesignFile } from "./resolve-core.js";
import type { DesignCanvasStore } from "./store.js";

/**
 * Canvas tool calls one turn may make; past it each call returns
 * `limit_reached`. A canvas_build counts as one call, whatever it draws.
 */
export const DESIGN_CANVAS_CALLS_PER_TURN = 60;
/** Boxes and connectors one canvas_build may draw. */
export const DESIGN_BUILD_ITEMS = 100;
const BUILD_REF_CHARS = 40;

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
/** Where a tool takes a frame id, a page's workspace path names the frame showing it. */
const FRAME_REF = "Frame id or page path.";
const BESIDE: readonly DesignBeside[] = ["right", "left", "below", "above"];
/** `{type, enum}` validates the same as a union of string literals in a fraction of the tokens. */
const enumOf = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });
const BesideSchema = enumOf(BESIDE);
/** Variants one canvas_duplicate call may make. */
export const DESIGN_VARIANTS_PER_CALL = 6;
const TextSizeSchema = enumOf(["small", "medium", "large"] as const);
const ColorSchema = enumOf(DESIGN_COLORS);
const EndSchema = Type.Object({
  frameId: Type.Optional(Type.String({ description: `${FRAME_REF} The end follows it.` })),
  side: Type.Optional(enumOf(SIDES)),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
});
const BuildEndSchema = Type.Object({
  ref: Type.Optional(Type.String({ maxLength: BUILD_REF_CHARS, description: "A box of this call, by its ref." })),
  frameId: Type.Optional(Type.String({ description: FRAME_REF })),
  side: Type.Optional(enumOf(SIDES)),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
});
const GuideSchema = enumOf([...DESIGN_GUIDES, "none"] as const);
const PaperSchema = enumOf(["letter", "a4"] as const);
const PrintModeSchema = enumOf(["flow", "fixed"] as const);
const TweaksSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
  description: "Values for the tweaks the page declares (--accent, data-density); null resets one.",
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
 * prompt cache; the canvas's current counts go to the conversation as a note
 * when they change (`withCanvasStatusNote`), and its contents in `canvas_read`.
 */
export const DESIGN_MODE_PROMPT_SECTION = [
  "## Design mode is on",
  "This chat sits beside an infinite design canvas. The person sees its frames while you talk. Load the aiden-design skill before you design on it.",
  "- Call canvas_read before changing the canvas, and again if the person says they moved things. It lists every frame on the page, in view and outside it, with ids and boxes.",
  "- Pages, screens and UI mockups are workspace HTML files under design/ (a shared design/tokens.css plus one HTML file per screen), not render_artifact visuals. Each design/ page you write, edit or make with a command lands on the canvas by itself and reloads as you save it; HTML elsewhere in the workspace does not.",
  "- Pick the design width that matches the screen: 390 phone, 768 tablet, 1280 or 1440 desktop. A page can declare it with <meta name=\"aiden-design-width\" content=\"390\">; canvas_place_frame or canvas_update_frame with designWidth resizes its frame to fit.",
  "- canvas_place_frame on a page already on this canvas page reuses its frame, whoever placed it and whatever group it is in, and the result says placed: \"reused\"; a page shown only in locked frames is refused. Pass duplicate: true to show the same file twice (placed: \"copy\"), and nextTo: {frameId, side} to put a frame beside another. For light/dark, phone/desktop or density variants of a page, use canvas_duplicate with variants: one call lays them out side by side in one labelled group. canvas_duplicate and canvas_page load on demand: call load_tools for one that is not among your tools.",
  "- You can move, resize, retitle, restyle, regroup, hide, lock or reorder any unlocked frame, the person's too, with canvas_update_frame. A locked frame stays as it is unless the person asks you to unlock it. Remove a frame the person added only when they ask, with force: true.",
  "- Use canvas_arrange to lay frames out in a tidy row, column or grid, put them in a group (it fits itself around them) or take them out, in one call. Put each direction in its own group.",
  "- For a flow or diagram, draw it in one canvas_build call: boxes (shapes with their labels in text, text, notes) with refs of your own, and connectors between them by ref or frameId; a connector follows its frames when they move. A build counts as one of the turn's canvas calls.",
  "- The canvas can have several pages. Work on the page the person is looking at unless they name another; canvas_page adds, renames, duplicates, reorders, shows or deletes pages, and canvas_update_frame with page moves a frame to another.",
  "- After placing or moving frames, call canvas_focus with their ids so the person sees them (canvas_arrange does this by itself). canvas_read with snapshot: true shows you the canvas as the person sees it.",
  "- canvas_inspect draws one page offline at its design width, with its frame's look, and reports script errors, files that did not load, sideways overflow and tweaks that do nothing, with a picture when you can see images. Each page you write is checked the same way without a picture, and the report follows in the conversation before your next step: fix what it lists once, call canvas_inspect for a picture after a big change, and say what you fixed.",
  "- The person's canvas comments come with their message or in canvas_read. After acting on one they sent you, canvas_comment can reply on it in a sentence (what you changed, or a question when it is unclear) and resolve it once it is done. An open comment in canvas_read is still their draft, or one they reopened after your reply, so it is left for them to send.",
  "- Coordinates and sizes are canvas units. Where a tool takes a frame id, a page's workspace path also works: its frame on the page on screen, else its first. Say which file you changed.",
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
  /** False when the turn's model can't see pictures: canvas_read then takes no snapshot and says why. Defaults to true. */
  seesImages?: boolean;
  /**
   * Draws one page frame offline at its design width and reports what went
   * wrong (inspect.ts), with a picture starting `top` px down when `picture`.
   */
  inspect?(
    frame: DesignFrame,
    options: { top: number; picture: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string; image?: { data: string; mimeType: string } }>;
  /** The time a reply or a resolve is stamped with. */
  now?(): Date;
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
/** A tool answer as text: a string as it is (a report), anything else as JSON. */
const result = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
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

/**
 * The group or artboard `groupId` names on the page. A locked one takes no new
 * members, since joining it would grow or refit it; the frame's own current
 * group (`currentGroupId`) still passes, as naming it changes nothing.
 */
function groupOf(doc: DesignCanvas, groupId: unknown, pageId: string, currentGroupId?: string): string | undefined {
  if (groupId === undefined || groupId === null || groupId === "") return undefined;
  const group =
    typeof groupId === "string"
      ? doc.frames.find((frame) => frame.id === groupId && isDesignContainer(frame.kind) && frame.pageId === pageId)
      : undefined;
  if (!group) {
    throw new CanvasToolError("groupId must be the id of a group or frame (artboard) on the same page.");
  }
  if (group.locked && group.id !== currentGroupId) {
    throw new CanvasToolError(`${JSON.stringify(group.title || group.id)} is locked, so nothing can be put in it. Unlock it only if the person asked.`);
  }
  return group.id;
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

/** A drawn or written frame's words and look from a tool call, with the canvas's defaults. */
type DrawnLook = { words?: string; size?: DesignTextSize; fill?: DesignColor; outline?: DesignColor; shape?: DesignShapeKind };

function drawnLook(kind: PlacedKind, p: Record<string, unknown>, field = ""): DrawnLook {
  const at = field.replace(/\.$/, "");
  const words = typeof p.text === "string" ? p.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) : undefined;
  if (kind === "text" && !words?.trim()) throw new CanvasToolError(`${at ? `${at}: a` : "A"} text item needs text.`);
  const size = kind === "text" ? (textSize(p.size) ?? "medium") : kind === "note" ? textSize(p.size) : undefined;
  if (p.fill !== undefined && p.fill !== null && !takesFill(kind)) {
    throw new CanvasToolError(`${at ? `${at}: o` : "O"}nly a shape, a note or an artboard (kind frame) has a fill.`);
  }
  const fill = kind === "shape" ? (color(p.fill, `${field}fill`) ?? "blue") : takesFill(kind) ? color(p.fill, `${field}fill`) : undefined;
  const outline =
    kind === "shape" || kind === "text" || kind === "note" || kind === "connector"
      ? (color(p.color, `${field}color`) ?? (kind === "shape" ? "blue" : kind === "connector" ? "gray" : undefined))
      : undefined;
  const shape: DesignShapeKind | undefined = kind === "shape" ? (p.shape === "oval" ? "oval" : "rect") : undefined;
  return { words, size, fill, outline, shape };
}

/** The frame fields a drawn look sets. */
function drawnFields(kind: PlacedKind, look: DrawnLook): Partial<DesignFrame> {
  return {
    ...(kind === "note" ? { text: look.words ?? "" } : {}),
    ...((kind === "text" || kind === "shape") && look.words ? { text: look.words } : {}),
    ...(look.shape ? { shape: look.shape, strokeWidth: 2 } : {}),
    ...(kind === "connector" ? { strokeWidth: 2 } : {}),
    ...(look.size ? { size: look.size } : {}),
    ...(look.fill ? { fill: look.fill } : {}),
    ...(look.outline ? { color: look.outline } : {}),
  };
}

/** A text box's height follows its lines at its size. */
function drawnHeight(kind: PlacedKind, look: DrawnLook, fallback: number): number {
  return kind === "text" && look.size ? TEXT_LINE[look.size] * (look.words ? look.words.split("\n").length : 1) : fallback;
}

/** A change to how a frame looks: fields to set and fields to clear. */
type StylePatch = { set: Partial<DesignFrame>; clear: (keyof DesignFrame)[] };

/**
 * Reads the look fields shared by place and update (dark, tweaks, radius,
 * guide, paper, printMode) for a frame of `kind`, refusing ones it cannot
 * have. Tweaks merge into `tweaksBefore`; a null value drops that key.
 * `declared` is the page's own tweak names (null when the page could not be
 * read): a value for any other name is refused with the real ones listed,
 * since nothing on the page would pick it up.
 */
function stylePatch(
  kind: DesignFrameKind,
  shape: DesignShapeKind | undefined,
  p: Record<string, unknown>,
  tweaksBefore: DesignTweakValues | undefined,
  declared?: { path: string; names: readonly string[] | null },
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
      if (declared?.names && !declared.names.includes(name)) {
        throw new CanvasToolError(
          declared.names.length === 0
            ? `${declared.path} declares no tweak controls, so ${JSON.stringify(name)} would change nothing. Add a <script type="application/aiden-tweaks"> block to the page first.`
            : `${declared.path} has no tweak ${JSON.stringify(name)}. Its tweaks are ${declared.names.join(", ")}.`,
        );
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

/** Whether a call's tweaks set any value (a null only resets one). */
function hasTweakValues(tweaks: unknown): boolean {
  return typeof tweaks === "object" && tweaks !== null && Object.values(tweaks).some((value) => value !== null);
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
    const frame = designFrameByIdOrPath(doc, raw.frameId);
    if (!frame || frame.pageId !== pageId || frame.id === self || !canAttachTo(frame)) {
      throw new CanvasToolError(
        `${field}.frameId must be the id of a frame on the same page that is not an arrow, line or drawing, or the path of a page that frame shows.`,
      );
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

function besideOf(value: unknown, field: string): DesignBeside {
  if (value === undefined || value === null) return "right";
  if (!(BESIDE as readonly unknown[]).includes(value)) throw new CanvasToolError(`${field} must be right, left, below or above.`);
  return value as DesignBeside;
}

/**
 * The boxes a frame placed beside another must not land on: the page's
 * frames other than lines and drawings, and other than those in `skip` (the
 * frame itself, its anchor, and the group it joins, which surrounds both).
 */
function blockersOn(doc: DesignCanvas, pageId: string, skip: ReadonlySet<string | undefined>): DesignFrame[] {
  return doc.frames.filter((frame) => frame.pageId === pageId && !isDesignLine(frame.kind) && !skip.has(frame.id));
}

/** The plain group a frame placed beside `anchor` joins: its unlocked group, if it has one. */
function groupBeside(doc: DesignCanvas, anchor: DesignFrame): string | undefined {
  if (anchor.groupId === undefined) return undefined;
  const group = doc.frames.find((frame) => frame.id === anchor.groupId);
  return group?.kind === "group" && !group.locked ? group.id : undefined;
}

type Variant = { label: string; dark?: unknown; designWidth?: unknown; tweaks?: unknown };
const VARIANT_LABEL_CHARS = 40;

function variantsOf(value: unknown): Variant[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new CanvasToolError("variants must list one or more variants.");
  if (value.length > DESIGN_VARIANTS_PER_CALL) {
    throw new CanvasToolError(`One call makes at most ${DESIGN_VARIANTS_PER_CALL} variants; make the rest with another call.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CanvasToolError(`variants[${index}] must be { label, dark, designWidth, tweaks }.`);
    }
    const raw = entry as Record<string, unknown>;
    const label = text(raw.label, `variants[${index}].label`, VARIANT_LABEL_CHARS);
    if (raw.dark === undefined && raw.designWidth === undefined && raw.tweaks === undefined) {
      throw new CanvasToolError(`The variant ${JSON.stringify(label)} changes nothing: give it dark, designWidth or tweaks.`);
    }
    return { ...raw, label };
  });
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

/**
 * The order a person reads frames in where they sit now, for an arrange that names no frames. A row or
 * grid reads bands top to bottom, each left to right: a frame joins a band while its top lies above
 * the middle of the band's shortest frame, so a heading above a row stays its own band, ahead of what
 * it heads. A column reads columns left to right, each top to bottom, so frames stacked in a column stay together.
 */
export function readingOrder<T extends { x: number; y: number; w: number; h: number }>(frames: readonly T[], layout: Layout): T[] {
  const across = layout === "column";
  const start = (frame: T) => (across ? frame.x : frame.y);
  const size = (frame: T) => (across ? frame.w : frame.h);
  const along = (frame: T) => (across ? frame.y : frame.x);
  const bands: { reach: number; members: T[] }[] = [];
  for (const frame of [...frames].sort((a, b) => start(a) - start(b) || along(a) - along(b))) {
    const band = bands[bands.length - 1];
    if (band && start(frame) < band.reach) {
      band.members.push(frame);
      band.reach = Math.min(band.reach, start(frame) + size(frame) / 2);
    } else {
      bands.push({ reach: start(frame) + size(frame) / 2, members: [frame] });
    }
  }
  return bands.flatMap((band) => band.members.sort((a, b) => along(a) - along(b)));
}

type FrameBox = { x: number; y: number; w: number; h: number };
const boxOf = (frame: DesignFrame): FrameBox => ({ x: frame.x, y: frame.y, w: frame.w, h: frame.h });
const boxKey = (frame: DesignFrame) => `${frame.x},${frame.y},${frame.w},${frame.h}`;

/**
 * Keeps the person's own moves when Aiden's change is about to undo them. A
 * frame this change alters whose box is no longer the one Aiden last saw
 * (`seen`) was moved or resized by the person since; it is reported with its
 * box now, and when the change would move or resize it too, it keeps the
 * person's box (groups and connectors excepted: they follow their frames).
 * Groups holding a frame that kept its box are fitted to it again.
 */
function keepPersonsMoves(
  before: DesignCanvas,
  after: DesignCanvas,
  seen: ReadonlyMap<string, string>,
): { doc: DesignCanvas; changed: { id: string; title: string; box: FrameBox }[]; kept: Set<string> } {
  const earlier = new Map(before.frames.map((frame) => [frame.id, frame]));
  const changed: { id: string; title: string; box: FrameBox }[] = [];
  const kept = new Set<string>();
  const refit: (string | undefined)[] = [];
  const frames = after.frames.map((frame) => {
    const was = earlier.get(frame.id);
    const saw = seen.get(frame.id);
    if (!was || saw === undefined || saw === boxKey(was)) return frame;
    if (JSON.stringify(was) === JSON.stringify(frame)) return frame;
    changed.push({ id: frame.id, title: was.title, box: boxOf(was) });
    if (boxKey(frame) === boxKey(was) || frame.kind === "group" || frame.kind === "connector") return frame;
    kept.add(frame.id);
    refit.push(frame.groupId, was.groupId);
    return { ...frame, ...boxOf(was) };
  });
  if (kept.size === 0) return { doc: after, changed, kept };
  return { doc: refitGroups(syncConnectors({ ...after, frames }), refit), changed, kept };
}

/**
 * The answer of a change, with the frames it touched that the person changed
 * since Aiden last looked: their boxes now, and which kept the person's box.
 */
function withCoEditReport<T>(value: T, report: ReturnType<typeof keepPersonsMoves> | undefined, saved: DesignCanvas): T {
  if (!report || report.changed.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const now = new Map(saved.frames.map((frame) => [frame.id, frame]));
  const answer = value as Record<string, unknown>;
  // A listed box of a frame that kept the person's box is the stored one.
  const frames = Array.isArray(answer.frames)
    ? answer.frames.map((entry: unknown) => {
        if (!entry || typeof entry !== "object") return entry;
        const listed = entry as { id?: unknown; box?: unknown };
        const frame = typeof listed.id === "string" && report.kept.has(listed.id) ? now.get(listed.id) : undefined;
        return frame && listed.box ? { ...listed, box: boxOf(frame) } : entry;
      })
    : undefined;
  const kept = [...report.kept];
  return {
    ...answer,
    ...(frames ? { frames } : {}),
    changedSinceRead: report.changed.map((entry) => {
      const frame = now.get(entry.id);
      return frame ? { ...entry, box: boxOf(frame) } : entry;
    }),
    ...(kept.length > 0 ? { keptPersonsBox: kept } : {}),
    coEdit:
      kept.length > 0
        ? "The person moved or resized these frames since you last read them, so they keep the person's place and size; the rest of the change landed. Work from the boxes here, and ask before moving them again."
        : "The person moved or resized these frames since you last read them; the boxes here are where they are now.",
  } as T;
}

/**
 * The `load_tools` lines of the canvas tools held back until Aiden loads them
 * (see ON_DEMAND_TOOL_NAMES): the rarely used ones, so a design chat's every
 * request carries fewer tool definitions.
 */
const CANVAS_CATALOG_LINES: Readonly<Record<string, string>> = {
  canvas_page: "Add, rename, duplicate, reorder, show or delete design canvas pages, when the canvas needs another page.",
  canvas_duplicate: "Copy a design canvas frame or group beside it, or lay out a page's light/dark, width or tweak variants in one labelled group.",
};

export function createDesignCanvasTools(deps: DesignCanvasToolDeps): AgentTool[] {
  const newId = deps.newId ?? randomUUID;
  let calls = 0;

  /** Runs one tool call: the per-turn limit, the availability check and error shaping. */
  const run = async (body: () => Promise<unknown>): Promise<ToolResult> => {
    calls += 1;
    if (calls > DESIGN_CANVAS_CALLS_PER_TURN) {
      return result({
        status: "limit_reached",
        limit: DESIGN_CANVAS_CALLS_PER_TURN,
        message: `This turn has used its ${DESIGN_CANVAS_CALLS_PER_TURN} canvas calls, so the canvas takes no more changes until the person's next message. Do not retry: stop, tell the person what you finished and what is left, and let them ask you to go on.`,
      });
    }
    if (deps.stillAvailable && !(await deps.stillAvailable())) {
      return result({ status: "unavailable", reason: "Design mode is off in this chat." });
    }
    try {
      const value = await body();
      if (value instanceof WithImage) {
        return {
          content: [...result(value.value).content, { type: "image", ...value.image }],
          details: null,
        };
      }
      return result(value);
    } catch (error) {
      if (error instanceof CanvasToolError) return result({ status: "error", message: error.message });
      throw error;
    }
  };

  /**
   * Each frame's box as Aiden last saw it this turn: listed by canvas_read or
   * left by one of its own changes. A box that differs now is the person's
   * move (or another window's) since then.
   */
  const seen = new Map<string, string>();
  const remember = (frames: readonly DesignFrame[]) => {
    for (const frame of frames) seen.set(frame.id, boxKey(frame));
  };

  /**
   * Applies a change and tells open canvases about it. `change` throws to
   * refuse. A frame the person moved since Aiden last saw it keeps the
   * person's box, and the answer says so with its box now.
   */
  const edit = async <T>(change: (doc: DesignCanvas) => { doc: DesignCanvas; value: T }): Promise<T> => {
    let value: T | undefined;
    let report: ReturnType<typeof keepPersonsMoves> | undefined;
    let touched = new Set<string>();
    const saved = await deps.store.update(deps.chatId, (doc) => {
      const next = change(doc);
      report = keepPersonsMoves(doc, next.doc, seen);
      const earlier = new Map(doc.frames.map((frame) => [frame.id, JSON.stringify(frame)]));
      touched = new Set(
        report.doc.frames.filter((frame) => earlier.get(frame.id) !== JSON.stringify(frame)).map((frame) => frame.id),
      );
      value = next.value;
      return report.doc;
    });
    deps.broadcast({ chatId: deps.chatId, revision: saved.revision });
    remember(saved.frames.filter((frame) => touched.has(frame.id)));
    for (const entry of report?.changed ?? []) {
      const now = saved.frames.find((frame) => frame.id === entry.id);
      if (now) seen.set(entry.id, boxKey(now));
    }
    return withCoEditReport(value as T, report, saved);
  };

  const frameIn = (doc: DesignCanvas, id: unknown): DesignFrame => {
    const frame = designFrameByIdOrPath(doc, id);
    if (!frame) {
      throw new CanvasToolError(
        "No frame on this canvas has that id or shows that page. Call canvas_read for the current frames, or canvas_place_frame to put the page on the canvas.",
      );
    }
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
          `Read the design canvas: its pages, and on one page (the one on screen unless you name another) the view, the frames in it (id, kind, title, path, box, group, look, open comments), the frames outside it (outsideFrames, with ids and boxes), counts by group, and the page's open and sent comments with what each points at. Up to ${CANVAS_READ_FRAME_LIMIT} frames per call; for more, pass the answer's nextCursor as cursor. snapshot: true adds a picture of the canvas as the person sees it.`,
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id." })),
          cursor: Type.Optional(Type.String({ maxLength: 80, description: "An earlier answer's nextCursor." })),
          snapshot: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, raw, signal) =>
          run(async () => {
            const p = (raw ?? {}) as { page?: unknown; cursor?: unknown; offset?: unknown; snapshot?: unknown };
            if (p.offset !== undefined) {
              throw new CanvasToolError("canvas_read no longer takes offset. To read the frames after an answer, pass its nextCursor as cursor.");
            }
            const doc = await deps.store.get(deps.chatId);
            const cursor = p.cursor === undefined ? undefined : typeof p.cursor === "string" ? parseCanvasReadCursor(p.cursor) : null;
            if (cursor === null) {
              throw new CanvasToolError("cursor must be the nextCursor an earlier canvas_read answer gave, copied as it is.");
            }
            const named = p.page === undefined || p.page === null || p.page === "" ? undefined : pageOf(doc, p.page);
            let pageId = named ?? doc.activePageId;
            if (cursor) {
              const read = canvasReadCursorPage(doc, cursor, named);
              if ("error" in read) throw new CanvasToolError(read.error);
              pageId = read.pageId;
            }
            const answer = describeCanvas(doc, { pageId, ...(cursor ? { cursor } : {}) });
            const listed = new Set([...answer.inView, ...answer.outsideFrames].map((frame) => frame.id));
            remember(doc.frames.filter((frame) => listed.has(frame.id)));
            if (p.snapshot !== true) return answer;
            const unavailable = (snapshotReason: string) => ({ ...answer, snapshot: "unavailable", snapshotReason });
            if (deps.seesImages === false) {
              return unavailable(
                "This model can't see pictures, so no snapshot was taken. The frames listed here describe the page; canvas_inspect reports in words what a page frame draws.",
              );
            }
            // The snapshot shows the screen, so it only pictures the page on screen.
            if (answer.page.id !== doc.activePageId) {
              const onScreen = doc.pages.find((entry) => entry.id === doc.activePageId)?.name ?? "another page";
              return unavailable(
                `A snapshot shows only the page on screen, which is "${onScreen}", not "${answer.page.name}". Call canvas_focus with page "${answer.page.name}" to bring it on screen first, or canvas_inspect for a picture of one of its page frames.`,
              );
            }
            const image = deps.snapshot ? await deps.snapshot(signal) : null;
            return image ? new WithImage({ ...answer, snapshot: "attached" }, image) : unavailable("The canvas is not on screen right now.");
          }),
      },
      "safe",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_place_frame",
        label: "Place on design canvas",
        description:
          "Put a frame on the design canvas: a workspace HTML page (kind file, path workspace-relative; write the file first), an image, a note, a group, text, a shape (rect or oval, label in text), a frame (an empty artboard) or a connector (an arrow or line between frames or points; an end on a frame follows it). Notes and text take **bold**, *italic*, <u>underline</u>, [links](https://…) and \"- \" or \"1. \" lists; size and color apply to the whole item, fill colours a note, shape or artboard. A page's frame is sized for its designWidth (390, 768, 1280, 1440) unless you pass w and h. A page already on this canvas page reuses its frame (placed: reused; refused if shown only in locked frames); duplicate: true adds another (placed: copy). nextTo puts it beside a frame, in that frame's group; with no x, y or nextTo it goes right of the last frame in its group or in view, wrapping inside an artboard. Groups fit their frames.",
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id." })),
          kind: enumOf(PLACED_KINDS),
          title: Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars }),
          path: Type.Optional(Type.String({ maxLength: 1024 })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
          shape: Type.Optional(enumOf(["rect", "oval"] as const)),
          fill: Type.Optional(ColorSchema),
          color: Type.Optional(ColorSchema),
          size: Type.Optional(TextSizeSchema),
          from: Type.Optional(EndSchema),
          to: Type.Optional(EndSchema),
          arrow: Type.Optional(enumOf(["end", "both", "none"] as const)),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          w: Type.Optional(Type.Number()),
          h: Type.Optional(Type.Number()),
          groupId: Type.Optional(Type.String()),
          designWidth: Type.Optional(Type.Union(DESIGN_WIDTHS.map((width) => Type.Literal(width)))),
          duplicate: Type.Optional(Type.Boolean({ description: "file: add a frame even when the page is on the canvas." })),
          nextTo: Type.Optional(Type.Object({ frameId: Type.String({ description: FRAME_REF }), side: Type.Optional(BesideSchema) })),
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
            const look = drawnLook(kind, p);
            const shape = look.shape;
            const width = kind === "file" ? (designWidth(p.designWidth) ?? DESIGN_DEFAULT_FILE_WIDTH) : undefined;
            const box = kind === "connector" ? { w: 1, h: 1 } : kind === "file" ? defaultFileBox(width) : DEFAULT_BOX[kind];
            const givenW = optionalNumber(p.w, "w");
            const givenH = optionalNumber(p.h, "h");
            const w = givenW ?? box.w;
            const h = givenH ?? drawnHeight(kind, look, box.h);
            const duplicate = optionalBoolean(p.duplicate, "duplicate") === true;
            const nextTo = p.nextTo === undefined || p.nextTo === null ? undefined : (p.nextTo as Record<string, unknown>);
            if (nextTo && (typeof nextTo !== "object" || Array.isArray(nextTo))) throw new CanvasToolError("nextTo must be { frameId, side }.");
            if (nextTo && kind === "connector") throw new CanvasToolError("A connector goes between its ends; leave nextTo out.");
            if (nextTo && (x !== undefined || y !== undefined)) throw new CanvasToolError("Pass nextTo or x and y, not both.");
            const side = nextTo ? besideOf(nextTo.side, "nextTo.side") : undefined;
            const declared = kind === "file" && path && hasTweakValues(p.tweaks) ? { path, names: await designPageTweakNames(deps.workspaceRoot, path) } : undefined;
            const id = newId();
            return edit<Record<string, unknown>>((doc) => {
              // Beside a frame, on its page unless another is named.
              const anchor = nextTo ? frameIn(doc, nextTo.frameId) : undefined;
              const pageId = anchor && (p.page === undefined || p.page === null || p.page === "") ? anchor.pageId : pageOf(doc, p.page);
              if (anchor && anchor.pageId !== pageId) {
                throw new CanvasToolError("nextTo must name a frame on the page it goes on.");
              }
              const ends: [DesignConnectorEnd, DesignConnectorEnd] | undefined =
                kind === "connector" ? [endOf(doc, p.from, "from", pageId), endOf(doc, p.to, "to", pageId)] : undefined;
              if (ends && ends[0].frameId !== undefined && ends[0].frameId === ends[1].frameId) {
                throw new CanvasToolError("A connector joins two different frames, or a frame and a point.");
              }
              const arrow = kind === "connector" ? arrowOf(p.arrow) : undefined;
              // A page already on this canvas page, whoever placed it and
              // whatever group it is in (a page Aiden writes lands by itself,
              // see written-pages.ts), is reused, keeping its id, instead of
              // shown twice; one at the same width, then one Aiden placed, is
              // preferred. duplicate: true adds a copy instead. A page shown
              // only in locked frames is refused, since reusing would change one.
              const sameFile = kind === "file" ? doc.frames.filter((entry) => entry.kind === "file" && entry.path === path) : [];
              const onThisPage = sameFile.filter((entry) => entry.pageId === pageId);
              const candidates = duplicate ? [] : onThisPage.filter((entry) => !entry.locked);
              if (!duplicate && onThisPage.length > 0 && candidates.length === 0) {
                throw new CanvasToolError(
                  `${path} is already on this page in locked frame ${onThisPage.map((entry) => `"${entry.id}"`).join(", ")}, so it stays as it is. Pass duplicate: true to show it again in a new frame, or ask the person to unlock it.`,
                );
              }
              const adopted =
                candidates.find((entry) => (entry.designWidth ?? DESIGN_DEFAULT_FILE_WIDTH) === width) ??
                candidates.find((entry) => entry.createdBy === "aiden") ??
                candidates[0];
              // A reused frame may name the locked group it is already in. Beside
              // a frame, it joins that frame's plain group unless one is named.
              const namedGroup = p.groupId === undefined && anchor ? groupBeside(doc, anchor) : p.groupId;
              const groupId = isDesignContainer(kind) ? undefined : groupOf(doc, namedGroup, pageId, adopted?.groupId);
              // The box the frame ends with: a reused one's, resized as asked, or the new one's.
              const resized = adopted ? boxForWidth(adopted, adopted.designWidth ?? DESIGN_DEFAULT_FILE_WIDTH, width!) : undefined;
              const nextW = adopted ? (givenW !== undefined ? clampSize(givenW, "file") : resized!.w) : clampSize(w, kind);
              const nextH = adopted ? (givenH !== undefined ? clampSize(givenH, "file") : resized!.h) : clampSize(h, kind);
              const at = anchor
                ? besideBox(anchor, { w: nextW, h: nextH }, side!, blockersOn(doc, pageId, new Set([anchor.id, adopted?.id, groupId])))
                : x !== undefined && y !== undefined
                  ? { x, y }
                  : undefined;
              // Other frames that show the same file, for the result.
              const others = sameFile.filter((entry) => entry.id !== adopted?.id);
              const copies =
                others.length > 0
                  ? {
                      otherFrames: others.slice(0, 10).map((entry) => ({
                        id: entry.id,
                        ...(entry.pageId !== pageId ? { page: doc.pages.find((page) => page.id === entry.pageId)?.name ?? entry.pageId } : {}),
                      })),
                    }
                  : {};
              const style = stylePatch(kind, shape, p, adopted?.tweaks, declared);
              const input: PlaceFrameInput = {
                kind,
                title,
                pageId,
                w,
                h,
                createdBy: "aiden",
                ...(ends ? { x: ends[0].x, y: ends[0].y, ends } : at ? at : {}),
                ...(groupId ? { groupId } : {}),
                ...(path ? { path } : {}),
                ...(width ? { designWidth: width } : {}),
                ...drawnFields(kind, look),
                ...(arrow ? { arrow } : {}),
                ...style.set,
              };
              if (adopted) {
                // Keep what the person set on the adopted frame (tweaks, dark, guide); take the new look on top.
                const merge = (box: Pick<DesignFrame, "x" | "y" | "w" | "h">, group?: string): DesignFrame => {
                  const { groupId: _oldGroup, ...kept } = adopted;
                  return applyStyle({ ...kept, title, designWidth: width!, ...box, ...(group ? { groupId: group } : {}) }, style);
                };
                const reused = {
                  status: "placed",
                  placed: "reused",
                  note: `${path} was already on this page, so its frame "${adopted.id}" was reused instead of adding a copy. Pass duplicate: true for a second frame.`,
                  units: "canvas",
                  ...copies,
                };
                // Unless a group is named or it goes beside a frame, the frame stays in the group it is in.
                const keptGroup = groupId ?? (anchor ? undefined : adopted.groupId);
                if (!groupId && !at) {
                  const frames = doc.frames.map((entry) =>
                    entry.id === adopted.id ? merge({ x: entry.x, y: entry.y, w: nextW, h: nextH }, adopted.groupId) : entry,
                  );
                  // Its group fits itself to a member that changed size, and a
                  // new size moves the ends of connectors on the page's sides.
                  const next = refitGroups(syncConnectors({ ...doc, frames }), [keptGroup]);
                  const frame = next.frames.find((entry) => entry.id === adopted.id)!;
                  return { doc: next, value: { ...reused, frame: summarizeFrame(frame) } };
                }
                const base = { ...doc, frames: doc.frames.filter((entry) => entry.id !== adopted.id) };
                const placed = placeFrame(
                  base,
                  { ...input, w: nextW, h: nextH, ...(keptGroup ? { groupId: keptGroup } : {}) },
                  canvasView(base, undefined, pageId),
                  () => adopted.id,
                );
                if ("error" in placed) {
                  throw new CanvasToolError(
                    `The canvas is full (${DESIGN_CANVAS_LIMITS.frames} frames, ${DESIGN_CANVAS_LIMITS.framesPerPage} on a page). Remove a frame first.`,
                  );
                }
                // placeFrame synced connectors to the new box; the merge keeps
                // them, and the group it left and the one it is in fit their members.
                const placedDoc = refitGroups(
                  syncConnectors({
                    ...placed.doc,
                    frames: placed.doc.frames.map((entry) =>
                      entry.id === adopted.id ? merge({ x: entry.x, y: entry.y, w: entry.w, h: entry.h }, entry.groupId) : entry,
                    ),
                  }),
                  [adopted.groupId, keptGroup],
                );
                const frame = placedDoc.frames.find((entry) => entry.id === adopted.id)!;
                return { doc: placedDoc, value: { ...reused, frame: summarizeFrame(frame) } };
              }
              const placed = placeFrame(doc, input, canvasView(doc, undefined, pageId), () => id);
              if ("error" in placed) {
                throw new CanvasToolError(
                  `The canvas is full (${DESIGN_CANVAS_LIMITS.frames} frames, ${DESIGN_CANVAS_LIMITS.framesPerPage} on a page). Remove a frame first.`,
                );
              }
              // The group it joined fits itself around its members, this one too.
              const placedDoc = refitGroups(placed.doc, [groupId]);
              const frame = placedDoc.frames.find((entry) => entry.id === id)!;
              if (kind === "file" && others.length > 0) {
                const elsewhere = onThisPage.length === 0;
                return {
                  doc: placedDoc,
                  value: {
                    status: "placed",
                    placed: "copy",
                    note: elsewhere
                      ? `${path} is also on another canvas page; this is a new frame on this one.`
                      : `This is a second frame for ${path}, beside the one already on this page.`,
                    units: "canvas",
                    frame: summarizeFrame(frame),
                    ...copies,
                  },
                };
              }
              return { doc: placedDoc, value: { status: "placed", ...(kind === "file" ? { placed: "new" } : {}), units: "canvas", frame: summarizeFrame(frame) } };
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
          "Change any unlocked frame, the person's too: move, resize, retitle, regroup (groupId \"\" ungroups), move to another page, hide, lock, reorder (layer, or aboveFrameId / belowFrameId of a sibling), or change its words (Markdown as in canvas_place_frame), colours (fill \"none\" clears), size, connector ends, designWidth (the frame resizes unless you pass w and h), dark, tweaks, guide, radius, paper or print mode. A locked frame accepts only locked: false, and only when the person asked. A group or artboard moves with its frames.",
        parameters: Type.Object({
          id: Type.String({ description: FRAME_REF }),
          title: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
          fill: Type.Optional(enumOf([...DESIGN_COLORS, "none"] as const)),
          color: Type.Optional(ColorSchema),
          size: Type.Optional(TextSizeSchema),
          from: Type.Optional(EndSchema),
          to: Type.Optional(EndSchema),
          arrow: Type.Optional(enumOf(["end", "both", "none"] as const)),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          w: Type.Optional(Type.Number()),
          h: Type.Optional(Type.Number()),
          groupId: Type.Optional(Type.String()),
          designWidth: Type.Optional(Type.Union(DESIGN_WIDTHS.map((width) => Type.Literal(width)))),
          hidden: Type.Optional(Type.Boolean()),
          locked: Type.Optional(Type.Boolean()),
          page: Type.Optional(Type.String({ maxLength: 128, description: "Move it (with its members) to this page." })),
          layer: Type.Optional(
            enumOf(["front", "back", "forward", "backward"] as const),
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
            // A page's own tweak names, read before the edit (a frame's file never changes).
            let declared: { path: string; names: readonly string[] | null } | undefined;
            if (hasTweakValues(p.tweaks)) {
              const before = designFrameByIdOrPath(await deps.store.get(deps.chatId), p.id);
              if (before?.kind === "file" && before.path) declared = { path: before.path, names: await designPageTweakNames(deps.workspaceRoot, before.path) };
            }
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
              const style = stylePatch(frame.kind, frame.shape, p, frame.tweaks, declared);
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
                const groupId = groupOf(baseDoc, p.groupId, current.pageId, current.groupId);
                const { groupId: _old, ...rest } = next;
                next = groupId ? { ...rest, groupId } : rest;
              }
              // A moved group or artboard takes its frames with it, as dragging it does.
              const dx = isDesignContainer(current.kind) ? next.x - current.x : 0;
              const dy = isDesignContainer(current.kind) ? next.y - current.y : 0;
              let frames = baseDoc.frames.map((entry) => (entry.id === current.id ? { ...next, x: current.x, y: current.y } : entry));
              frames = translateFrames(frames, current.id, dx, dy, new Set());
              frames = frames.map((entry) => (entry.id === current.id ? next : entry));
              // Connectors on a moved frame follow it, and the group it left and
              // the group it is in fit themselves to their members again.
              let updatedDoc = refitGroups(syncConnectors({ ...baseDoc, frames }), [frame.groupId, next.groupId]);
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
          id: Type.String({ description: FRAME_REF }),
          force: Type.Optional(Type.Boolean({ description: "Only when the person asked to delete their items." })),
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
                // The group it was in fits itself to the members left.
                doc: refitGroups(syncConnectors({ ...doc, frames, comments }), [frame.groupId]),
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
          ids: Type.Optional(Type.Array(Type.String({ description: FRAME_REF }), { maxItems: 50 })),
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id to show." })),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            if (!deps.focus) return { status: "unavailable", reason: "No window is showing this canvas." };
            const p = (raw ?? {}) as { ids?: unknown; page?: unknown };
            const ids = Array.isArray(p.ids) ? [...new Set(p.ids)] : [];
            const doc = await deps.store.get(deps.chatId);
            const shown = [...new Set(ids.map((id) => frameIn(doc, id).id))];
            const pages = new Set(shown.map((id) => doc.frames.find((entry) => entry.id === id)!.pageId));
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
            deps.focus(shown);
            return { status: "requested", frames: shown.length || onPage };
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_arrange",
        label: "Arrange design canvas",
        description:
          "Lay out unlocked frames of one page in a row, column or grid, and put them in a group or artboard (groupId) or take them out (groupId null). frameIds sets the order; without it, a group's members (with groupId) or the page's top-level frames are arranged in reading order. Groups fit their members afterwards; fitGroupIds refits others. x and y set the top-left corner. The frames are shown unless focus is false.",
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id, when frameIds are not given." })),
          frameIds: Type.Optional(Type.Array(Type.String({ description: FRAME_REF }), { maxItems: DESIGN_CANVAS_LIMITS.framesPerPage })),
          layout: Type.Optional(enumOf(["row", "column", "grid"] as const)),
          columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          gap: Type.Optional(Type.Number({ minimum: 0, maximum: 2000, description: "Space between columns (default 64)." })),
          rowGap: Type.Optional(Type.Number({ minimum: 0, maximum: 2000, description: "Space between rows (default 80)." })),
          align: Type.Optional(enumOf(["start", "center", "end"] as const)),
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
                chosen = [...new Map(requested.map((id) => frameIn(doc, id)).map((frame) => [frame.id, frame] as const)).values()];
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
              // Frames named in frameIds keep the order given; otherwise they keep the order they are read in on the canvas.
              if (!(requested && requested.length > 0)) chosen = readingOrder(chosen, layout);
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
                const group = next.frames.find((entry) => entry.id === id);
                // A locked group keeps its box even when frames leave it.
                if (group?.kind === "group" && !group.locked) next = fitGroupToMembers(next, id);
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
          "Add, rename, duplicate (with everything on it), delete (with its frames; never the last; force: true for one holding the person's or locked frames, only when they asked), move (step -1 or 1) or show a design canvas page, named by name or id.",
        parameters: Type.Object({
          action: enumOf(["add", "rename", "duplicate", "delete", "move", "show"] as const),
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
    declarePiRuntimeReplay(
      {
        name: "canvas_inspect",
        label: "Inspect design page",
        description:
          "Draw one design page offline at its design width, with its frame's look and tweaks, and report script errors (file and line), files that did not load, sideways overflow and its cause, the page's height, the tweaks it reads and tweak names nothing reads. Comes with a picture when you can see images (top scrolls down a tall page). Name the page by frameId or path. Call it after a big change, fix what it finds once, and say what you fixed.",
        parameters: Type.Object({
          frameId: Type.Optional(Type.String({ maxLength: 128 })),
          path: Type.Optional(Type.String({ maxLength: 1024, description: "A workspace-relative page path, such as design/home.html." })),
          top: Type.Optional(Type.Number({ minimum: 0, description: "Where the picture starts, in CSS pixels from the top of the page." })),
          picture: Type.Optional(Type.Boolean({ description: "false for the text report only." })),
        }),
        execute: async (_id, raw, signal) =>
          run(async () => {
            const p = (raw ?? {}) as { frameId?: unknown; path?: unknown; top?: unknown; picture?: unknown };
            if (!deps.inspect) throw new CanvasToolError("Pages can't be inspected here.");
            const doc = await deps.store.get(deps.chatId);
            let frame: DesignFrame | undefined;
            if (p.frameId !== undefined) {
              frame = frameIn(doc, p.frameId);
            } else if (typeof p.path === "string" && p.path.trim()) {
              const wanted = designPagePath(p.path);
              frame = frameShowingDesignPage(doc, wanted);
              if (!frame) throw new CanvasToolError(`${wanted} is not on the canvas. Place it with canvas_place_frame first, or name a frameId.`);
            } else {
              throw new CanvasToolError("Name the page to inspect by frameId or path.");
            }
            if (frame.kind !== "file" || !frame.path) throw new CanvasToolError("Only a page (a file frame) can be inspected.");
            const top = optionalNumber(p.top, "top") ?? 0;
            const picture = optionalBoolean(p.picture, "picture") !== false;
            let answer: { text: string; image?: { data: string; mimeType: string } };
            try {
              answer = await deps.inspect(frame, { top: Math.max(0, top), picture }, signal);
            } catch (error) {
              if (signal?.aborted) throw error;
              throw new CanvasToolError(`The page could not be drawn: ${error instanceof Error ? error.message : "it failed"}`);
            }
            const text = `Frame ${frame.id}. ${answer.text}`;
            return answer.image ? new WithImage(text, answer.image) : text;
          }),
      },
      "safe",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_comment",
        label: "Answer design comment",
        description:
          "Reply on a canvas comment the person sent you, resolve it, or both. A reply is a sentence or two under their note (what you changed, or a question); a newer reply replaces your last. Resolve it once what it asks is done. An open comment is still their draft and cannot be answered.",
        parameters: Type.Object({
          commentId: Type.String(),
          reply: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.replyChars })),
          resolve: Type.Optional(Type.Boolean({ description: "true marks the comment resolved." })),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            const reply = p.reply === undefined || p.reply === null ? undefined : text(p.reply, "reply", DESIGN_CANVAS_LIMITS.replyChars);
            const resolve = optionalBoolean(p.resolve, "resolve") === true;
            if (reply === undefined && !resolve) throw new CanvasToolError("Pass a reply, resolve: true, or both.");
            const at = (deps.now?.() ?? new Date()).toISOString();
            return edit((doc) => {
              const comment = typeof p.commentId === "string" ? doc.comments.find((entry) => entry.id === p.commentId) : undefined;
              if (!comment) {
                throw new CanvasToolError("No comment on this canvas has that id. Call canvas_read for the page's open comments.");
              }
              if (comment.state === "open") {
                // A draft may still be in the person's tray; answering it would take it out before they send it.
                throw new CanvasToolError(
                  comment.reply
                    ? "The person reopened that comment after your reply, so it is their draft again until they send it. Leave it for them to send; your earlier reply stays on it."
                    : "That comment is still the person's draft: they have not sent it to you. Reply on or resolve only comments sent with their message; leave an open one for them to send, or ask about it in your reply.",
                );
              }
              let next = reply === undefined ? doc : replyToComment(doc, comment.id, reply, at);
              if (resolve) next = resolveComment(next, comment.id, at);
              const state = next.comments.find((entry) => entry.id === comment.id)!.state;
              return {
                doc: next,
                value: { status: "ok", commentId: comment.id, state, ...(reply !== undefined ? { replied: true } : {}) },
              };
            });
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_duplicate",
        label: "Duplicate on design canvas",
        description:
          `Copy any frame beside it (right unless side says). A group or artboard comes with its members and the arrows between them. With variants, copy a page once per variant (up to ${DESIGN_VARIANTS_PER_CALL}) into one new group named title, beside the original: each variant has a label and sets dark, designWidth and/or tweaks.`,
        parameters: Type.Object({
          id: Type.String({ description: FRAME_REF }),
          side: Type.Optional(BesideSchema),
          title: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars })),
          variants: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String({ maxLength: VARIANT_LABEL_CHARS }),
                dark: Type.Optional(Type.Boolean()),
                designWidth: Type.Optional(Type.Union(DESIGN_WIDTHS.map((width) => Type.Literal(width)))),
                tweaks: Type.Optional(TweaksSchema),
              }),
              { minItems: 1, maxItems: DESIGN_VARIANTS_PER_CALL },
            ),
          ),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            const side = besideOf(p.side, "side");
            const variants = variantsOf(p.variants);
            const groupTitle = p.title === undefined || p.title === null ? undefined : text(p.title, "title", DESIGN_CANVAS_LIMITS.titleChars);
            // A tweak a variant sets must be one the page declares.
            let declared: { path: string; names: readonly string[] | null } | undefined;
            if (variants?.some((variant) => hasTweakValues(variant.tweaks))) {
              const current = designFrameByIdOrPath(await deps.store.get(deps.chatId), p.id);
              if (current?.kind === "file" && current.path) {
                declared = { path: current.path, names: await designPageTweakNames(deps.workspaceRoot, current.path) };
              }
            }
            return edit<Record<string, unknown>>((doc) => {
              const source = frameIn(doc, p.id);
              if (isDesignLine(source.kind)) {
                throw new CanvasToolError("An arrow, line or drawing is copied with the frames it joins: duplicate the group they are in.");
              }
              const full = () =>
                new CanvasToolError(
                  `The canvas is full (${DESIGN_CANVAS_LIMITS.frames} frames, ${DESIGN_CANVAS_LIMITS.framesPerPage} on a page). Remove a frame first.`,
                );
              if (!variants) {
                // A group or artboard brings its members, and the arrows that join two of them.
                const members = isDesignContainer(source.kind) ? doc.frames.filter((frame) => frame.groupId === source.id) : [];
                const inside = new Set(members.map((frame) => frame.id));
                const joining = doc.frames.filter(
                  (frame) =>
                    frame.kind === "connector" &&
                    !inside.has(frame.id) &&
                    frame.ends?.every((end) => end.frameId !== undefined && inside.has(end.frameId)),
                );
                // A frame copied alone joins its group (not a locked one), which then holds it.
                const container =
                  !isDesignContainer(source.kind) && source.groupId !== undefined
                    ? doc.frames.find((frame) => frame.id === source.groupId && !frame.locked)
                    : undefined;
                let at = besideBox(source, source, side, blockersOn(doc, source.pageId, new Set([source.id, container?.id, ...inside])));
                // An artboard keeps the width the person drew: a copy that would run past it starts a row below.
                if (container?.kind === "frame" && at.x + source.w > container.x + container.w - GROUP_PADDING.right) {
                  const held = doc.frames.filter((frame) => frame.groupId === container.id);
                  at = { x: container.x + GROUP_PADDING.left, y: Math.max(...held.map((frame) => frame.y + frame.h)) + DESIGN_FRAME_GAP };
                }
                const copied = copyFrames(doc, [source.id, ...joining.map((frame) => frame.id)], newId, {
                  dx: at.x - source.x,
                  dy: at.y - source.y,
                  createdBy: "aiden",
                  keepGroupLock: false,
                });
                if (!copied) throw full();
                const copyId = copied.copies.get(source.id)!;
                let next = refitGroups(copied.doc, [container?.id]);
                if (container?.kind === "frame") {
                  const copy = next.frames.find((frame) => frame.id === copyId)!;
                  next = { ...next, frames: next.frames.map((frame) => (frame.id === container.id ? { ...frame, h: growGroupToHold(frame, copy).h } : frame)) };
                }
                const frame = next.frames.find((entry) => entry.id === copyId)!;
                return {
                  doc: next,
                  value: {
                    status: "duplicated",
                    units: "canvas",
                    frame: summarizeFrame(frame),
                    // The members and arrows copied with a group or artboard.
                    ...(copied.copies.size > 1 ? { withIt: copied.copies.size - 1 } : {}),
                  },
                };
              }
              if (!isDesignPrintable(source.kind)) {
                throw new CanvasToolError("Variants are of a page (kind file), or of an artifact for a dark look. Duplicate other frames without variants.");
              }
              const keepSource = !source.locked && source.groupId === undefined;
              if (
                doc.frames.length + variants.length + 1 > DESIGN_CANVAS_LIMITS.frames ||
                doc.frames.filter((frame) => frame.pageId === source.pageId).length + variants.length + 1 > DESIGN_CANVAS_LIMITS.framesPerPage
              ) {
                throw full();
              }
              const sourceWidth = source.designWidth ?? DESIGN_DEFAULT_FILE_WIDTH;
              const { groupId: _groupId, locked: _locked, ...base } = source;
              const copies = variants.map((variant): DesignFrame => {
                const width = designWidth(variant.designWidth);
                if (width !== undefined && source.kind !== "file") throw new CanvasToolError("Only a page (kind file) has a design width.");
                const style = stylePatch(source.kind, undefined, variant, source.tweaks, declared?.path === source.path ? declared : undefined);
                const box = width !== undefined ? boxForWidth(source, sourceWidth, width) : { w: source.w, h: source.h };
                return applyStyle(
                  {
                    ...base,
                    id: newId(),
                    title: `${source.title} · ${variant.label}`.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
                    ...(width !== undefined ? { designWidth: width } : {}),
                    ...box,
                    createdBy: "aiden",
                  },
                  style,
                );
              });
              // The copies in a row, top-aligned. Beside an original that stays out of
              // the group, the row leaves room for the group's own padding.
              const rowW = copies.reduce((sum, copy) => sum + copy.w, 0) + DESIGN_FRAME_GAP * (copies.length - 1);
              const rowH = Math.max(...copies.map((copy) => copy.h));
              const pad = keepSource ? { left: 0, top: 0, right: 0, bottom: 0 } : GROUP_PADDING;
              const block = besideBox(
                source,
                { w: rowW + pad.left + pad.right, h: rowH + pad.top + pad.bottom },
                side,
                blockersOn(doc, source.pageId, new Set([source.id])),
              );
              let cursor = block.x + pad.left;
              for (const copy of copies) {
                copy.x = clampCoord(cursor);
                copy.y = clampCoord(block.y + pad.top);
                cursor += copy.w + DESIGN_FRAME_GAP;
              }
              const groupId = newId();
              const group: DesignFrame = {
                id: groupId,
                kind: "group",
                title: groupTitle ?? `${source.title} variants`.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
                pageId: source.pageId,
                x: block.x,
                y: block.y,
                w: DEFAULT_BOX.group.w,
                h: DEFAULT_BOX.group.h,
                createdBy: "aiden",
              };
              const frames = [
                ...doc.frames.map((frame) => (keepSource && frame.id === source.id ? { ...frame, groupId } : frame)),
                group,
                ...copies.map((copy) => ({ ...copy, groupId })),
              ];
              const next = fitGroupToMembers({ ...doc, frames }, groupId);
              const placedGroup = next.frames.find((frame) => frame.id === groupId)!;
              return {
                doc: next,
                value: {
                  status: "duplicated",
                  units: "canvas",
                  group: summarizeFrame(placedGroup),
                  frames: [
                    ...(keepSource ? [{ id: source.id, title: source.title, original: true }] : []),
                    ...copies.map((copy) => ({ id: copy.id, title: copy.title, box: { x: copy.x, y: copy.y, w: copy.w, h: copy.h } })),
                  ],
                },
              };
            });
          }),
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "canvas_build",
        label: "Build on design canvas",
        description: `Draw a flow or diagram in one call: up to ${DESIGN_BUILD_ITEMS} boxes (text, shape or note) and connectors, all or nothing. A connector's from and to name a box by its ref, a frame ({frameId}) or a point ({x, y}). Positions are relative to the drawing; a box without x and y goes right of the one before. The drawing goes at x, y, beside nextTo, in groupId, or right of the frames in view; groupTitle makes a new group. The result maps each ref to its frame id. One canvas call.`,
        parameters: Type.Object({
          page: Type.Optional(Type.String({ maxLength: 128, description: "A page's name or id." })),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          nextTo: Type.Optional(Type.Object({ frameId: Type.String({ description: FRAME_REF }), side: Type.Optional(BesideSchema) })),
          groupId: Type.Optional(Type.String({ description: "An existing group or artboard to draw in." })),
          groupTitle: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars, description: "Put the drawing in a new group with this title." })),
          items: Type.Array(
            Type.Object({
              ref: Type.Optional(Type.String({ maxLength: BUILD_REF_CHARS })),
              kind: enumOf(["text", "shape", "note", "connector"] as const),
              title: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars })),
              text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
              shape: Type.Optional(enumOf(["rect", "oval"] as const)),
              fill: Type.Optional(ColorSchema),
              color: Type.Optional(ColorSchema),
              size: Type.Optional(TextSizeSchema),
              x: Type.Optional(Type.Number()),
              y: Type.Optional(Type.Number()),
              w: Type.Optional(Type.Number()),
              h: Type.Optional(Type.Number()),
              from: Type.Optional(BuildEndSchema),
              to: Type.Optional(BuildEndSchema),
              arrow: Type.Optional(enumOf(["end", "both", "none"] as const)),
            }),
            { minItems: 1, maxItems: DESIGN_BUILD_ITEMS },
          ),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            const p = raw as Record<string, unknown>;
            if (!Array.isArray(p.items) || p.items.length === 0) throw new CanvasToolError("items must list one or more boxes or connectors.");
            if (p.items.length > DESIGN_BUILD_ITEMS) {
              throw new CanvasToolError(`One call draws at most ${DESIGN_BUILD_ITEMS} items; draw the rest with another call.`);
            }
            const x = optionalNumber(p.x, "x");
            const y = optionalNumber(p.y, "y");
            if ((x === undefined) !== (y === undefined)) throw new CanvasToolError("Pass both x and y, or neither.");
            const nextTo = p.nextTo === undefined || p.nextTo === null ? undefined : (p.nextTo as Record<string, unknown>);
            if (nextTo && (typeof nextTo !== "object" || Array.isArray(nextTo))) throw new CanvasToolError("nextTo must be { frameId, side }.");
            if (nextTo && x !== undefined) throw new CanvasToolError("Pass nextTo or x and y, not both.");
            const side = nextTo ? besideOf(nextTo.side, "nextTo.side") : undefined;
            const groupTitle =
              p.groupTitle === undefined || p.groupTitle === null ? undefined : text(p.groupTitle, "groupTitle", DESIGN_CANVAS_LIMITS.titleChars);
            if (groupTitle !== undefined && p.groupId !== undefined && p.groupId !== null && p.groupId !== "") {
              throw new CanvasToolError("Pass groupId to draw in an existing group or groupTitle for a new one, not both.");
            }

            // Every item checked and laid out relative to the drawing before anything changes.
            type Box = { ref?: string; kind: PlacedKind; title: string; look: DrawnLook; x: number; y: number; w: number; h: number };
            type Line = { ref?: string; title?: string; look: DrawnLook; from: Record<string, unknown>; to: Record<string, unknown>; arrow: DesignFrame["arrow"]; index: number };
            const boxes: Box[] = [];
            const lines: Line[] = [];
            const refs = new Set<string>();
            let flow: { x: number; y: number } | undefined;
            p.items.forEach((entry: unknown, index) => {
              const field = `items[${index}].`;
              if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new CanvasToolError(`items[${index}] must be an object.`);
              const item = entry as Record<string, unknown>;
              const kind = item.kind;
              if (kind !== "text" && kind !== "shape" && kind !== "note" && kind !== "connector") {
                throw new CanvasToolError(`${field}kind must be "text", "shape", "note" or "connector".`);
              }
              let ref: string | undefined;
              if (item.ref !== undefined && item.ref !== null && item.ref !== "") {
                ref = text(item.ref, `${field}ref`, BUILD_REF_CHARS).trim();
                if (refs.has(ref)) throw new CanvasToolError(`${field}ref ${JSON.stringify(ref)} is used twice; give each item its own.`);
                refs.add(ref);
              }
              const look = drawnLook(kind, item, field);
              const title = item.title === undefined || item.title === null || item.title === "" ? undefined : text(item.title, `${field}title`, DESIGN_CANVAS_LIMITS.titleChars);
              if (kind === "connector") {
                for (const end of ["from", "to"] as const) {
                  if (typeof item[end] !== "object" || item[end] === null) throw new CanvasToolError(`${field}${end} must be { ref }, { frameId } or { x, y }.`);
                }
                lines.push({ ref, title, look, from: item.from as Record<string, unknown>, to: item.to as Record<string, unknown>, arrow: arrowOf(item.arrow), index });
                return;
              }
              const box = DEFAULT_BOX[kind];
              const w = clampSize(optionalNumber(item.w, `${field}w`) ?? box.w, kind);
              const h = clampSize(optionalNumber(item.h, `${field}h`) ?? drawnHeight(kind, look, box.h), kind);
              const ix = optionalNumber(item.x, `${field}x`);
              const iy = optionalNumber(item.y, `${field}y`);
              if ((ix === undefined) !== (iy === undefined)) throw new CanvasToolError(`items[${index}]: pass both x and y, or neither.`);
              const at = ix !== undefined && iy !== undefined ? { x: ix, y: iy } : (flow ?? { x: 0, y: 0 });
              flow = { x: at.x + w + DESIGN_FRAME_GAP, y: at.y };
              const words = look.words?.trim();
              boxes.push({ ref, kind, title: title ?? (words ? words.split("\n")[0]!.slice(0, DESIGN_CANVAS_LIMITS.titleChars) : kind), look, x: at.x, y: at.y, w, h });
            });
            // A connector's ends that name a ref must name a box of this call.
            const boxRefs = new Set(boxes.flatMap((box) => (box.ref ? [box.ref] : [])));
            for (const line of lines) {
              for (const end of [line.from, line.to]) {
                if (end.ref !== undefined && !boxRefs.has(String(end.ref))) {
                  throw new CanvasToolError(`items[${line.index}] names ref ${JSON.stringify(end.ref)}, which is no box of this call.`);
                }
              }
            }

            return edit<Record<string, unknown>>((doc) => {
              const anchor = nextTo ? frameIn(doc, nextTo.frameId) : undefined;
              const pageId = anchor && (p.page === undefined || p.page === null || p.page === "") ? anchor.pageId : pageOf(doc, p.page);
              if (anchor && anchor.pageId !== pageId) throw new CanvasToolError("nextTo must name a frame on the page it goes on.");
              const added = boxes.length + lines.length + (groupTitle !== undefined ? 1 : 0);
              if (
                doc.frames.length + added > DESIGN_CANVAS_LIMITS.frames ||
                doc.frames.filter((frame) => frame.pageId === pageId).length + added > DESIGN_CANVAS_LIMITS.framesPerPage
              ) {
                throw new CanvasToolError(
                  `This drawing would pass the canvas's limits (${DESIGN_CANVAS_LIMITS.frames} frames, ${DESIGN_CANVAS_LIMITS.framesPerPage} on a page). Remove frames first or draw less.`,
                );
              }
              const namedGroup = p.groupId === undefined && anchor ? groupBeside(doc, anchor) : p.groupId;
              const groupId = groupTitle !== undefined ? undefined : groupOf(doc, namedGroup, pageId);
              // The drawing's own bounds, then where its top-left goes.
              const left = boxes.length > 0 ? Math.min(...boxes.map((box) => box.x)) : 0;
              const top = boxes.length > 0 ? Math.min(...boxes.map((box) => box.y)) : 0;
              const bounds = {
                w: boxes.length > 0 ? Math.max(...boxes.map((box) => box.x + box.w)) - left : 1,
                h: boxes.length > 0 ? Math.max(...boxes.map((box) => box.y + box.h)) - top : 1,
              };
              const pad = groupTitle !== undefined ? GROUP_PADDING : { left: 0, top: 0, right: 0, bottom: 0 };
              const padded = { w: bounds.w + pad.left + pad.right, h: bounds.h + pad.top + pad.bottom };
              let origin: { x: number; y: number };
              if (x !== undefined && y !== undefined) {
                origin = { x, y };
              } else {
                let corner: { x: number; y: number };
                if (anchor) {
                  corner = besideBox(anchor, padded, side!, blockersOn(doc, pageId, new Set([anchor.id, groupId])));
                } else {
                  // Where canvas_place_frame would put one frame the drawing's size.
                  const probe = placeFrame(
                    doc,
                    { kind: "shape", title: "", pageId, w: padded.w, h: padded.h, createdBy: "aiden", ...(groupId ? { groupId } : {}) },
                    canvasView(doc, undefined, pageId),
                    () => "probe",
                  );
                  if ("error" in probe) throw new CanvasToolError("The canvas is full. Remove a frame first.");
                  const spot = probe.doc.frames.find((frame) => frame.id === "probe")!;
                  corner = { x: spot.x, y: spot.y };
                }
                origin = { x: corner.x + pad.left - left, y: corner.y + pad.top - top };
              }

              let next = doc;
              const ids = new Map<string, string>();
              const unnamed: string[] = [];
              const made: string[] = [];
              const place = (input: PlaceFrameInput, ref: string | undefined) => {
                const id = newId();
                const placed = placeFrame(next, input, canvasView(next, undefined, pageId), () => id);
                if ("error" in placed) throw new CanvasToolError("The canvas is full. Remove a frame first.");
                next = placed.doc;
                made.push(id);
                if (ref) ids.set(ref, id);
                else unnamed.push(id);
                return id;
              };
              for (const box of boxes) {
                place(
                  {
                    kind: box.kind,
                    title: box.title,
                    pageId,
                    x: clampCoord(origin.x + box.x),
                    y: clampCoord(origin.y + box.y),
                    w: box.w,
                    h: box.h,
                    createdBy: "aiden",
                    ...(groupId ? { groupId } : {}),
                    ...drawnFields(box.kind, box.look),
                  },
                  box.ref,
                );
              }
              const endIn = (end: Record<string, unknown>, field: string): DesignConnectorEnd => {
                if (end.ref !== undefined) {
                  return endOf(next, { frameId: ids.get(String(end.ref)), ...(end.side !== undefined ? { side: end.side } : {}) }, field, pageId);
                }
                if (end.frameId !== undefined && end.frameId !== null && end.frameId !== "") return endOf(next, end, field, pageId);
                const ex = optionalNumber(end.x, `${field}.x`);
                const ey = optionalNumber(end.y, `${field}.y`);
                if (ex === undefined || ey === undefined) throw new CanvasToolError(`${field} must be { ref }, { frameId } or { x, y }.`);
                return endOf(next, { x: origin.x + ex, y: origin.y + ey }, field, pageId);
              };
              const titleOf = (end: DesignConnectorEnd) =>
                end.frameId ? (next.frames.find((frame) => frame.id === end.frameId)?.title ?? "point") : "point";
              for (const line of lines) {
                const ends: [DesignConnectorEnd, DesignConnectorEnd] = [
                  endIn(line.from, `items[${line.index}].from`),
                  endIn(line.to, `items[${line.index}].to`),
                ];
                if (ends[0].frameId !== undefined && ends[0].frameId === ends[1].frameId) {
                  throw new CanvasToolError(`items[${line.index}] joins a frame to itself; a connector joins two different frames, or a frame and a point.`);
                }
                place(
                  {
                    kind: "connector",
                    title: line.title ?? `${titleOf(ends[0])} to ${titleOf(ends[1])}`.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
                    pageId,
                    x: ends[0].x,
                    y: ends[0].y,
                    w: 1,
                    h: 1,
                    ends,
                    createdBy: "aiden",
                    ...(groupId ? { groupId } : {}),
                    ...(line.arrow ? { arrow: line.arrow } : {}),
                    ...drawnFields("connector", line.look),
                  },
                  line.ref,
                );
              }
              let group: DesignFrame | undefined;
              if (groupTitle !== undefined) {
                const newGroupId = newId();
                next = fitGroupToMembers(
                  {
                    ...next,
                    frames: [
                      ...next.frames.map((frame) => (made.includes(frame.id) ? { ...frame, groupId: newGroupId } : frame)),
                      { id: newGroupId, kind: "group", title: groupTitle, pageId, x: origin.x, y: origin.y, w: DEFAULT_BOX.group.w, h: DEFAULT_BOX.group.h, createdBy: "aiden" },
                    ],
                  },
                  newGroupId,
                );
                group = next.frames.find((frame) => frame.id === newGroupId);
              } else {
                next = refitGroups(next, [groupId]);
              }
              const placedBoxes = next.frames.filter((frame) => made.includes(frame.id) && frame.kind !== "connector");
              const box =
                placedBoxes.length > 0
                  ? {
                      x: Math.min(...placedBoxes.map((frame) => frame.x)),
                      y: Math.min(...placedBoxes.map((frame) => frame.y)),
                      w: Math.max(...placedBoxes.map((frame) => frame.x + frame.w)) - Math.min(...placedBoxes.map((frame) => frame.x)),
                      h: Math.max(...placedBoxes.map((frame) => frame.y + frame.h)) - Math.min(...placedBoxes.map((frame) => frame.y)),
                    }
                  : undefined;
              return {
                doc: next,
                value: {
                  status: "built",
                  units: "canvas",
                  placed: made.length,
                  ids: Object.fromEntries(ids),
                  ...(unnamed.length > 0 ? { unnamed } : {}),
                  ...(box ? { box } : {}),
                  ...(group ? { group: summarizeFrame(group) } : groupId ? { groupId } : {}),
                },
              };
            });
          }),
      },
      "never",
    ),
  ].map((tool) => (CANVAS_CATALOG_LINES[tool.name] ? declareOnDemandSummary(tool, CANVAS_CATALOG_LINES[tool.name]!) : tool));
}
