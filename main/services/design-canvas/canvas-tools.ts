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
import {
  clampCoord,
  clampSize,
  placeFrame,
  type PlaceFrameInput,
} from "../../../renderer/shared/design-canvas/placement.js";
import {
  DESIGN_CANVAS_LIMITS,
  DESIGN_WIDTHS,
  isDesignRelativePath,
  type DesignCanvasV1,
  type DesignFrame,
  type DesignWidth,
} from "../../../renderer/shared/design-canvas/schema.js";
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

/** Default boxes, matching the canvas's Add menu. */
const DEFAULT_BOX: Record<"file" | "image" | "note" | "group", { w: number; h: number }> = {
  file: { w: 640, h: 436 },
  image: { w: 320, h: 240 },
  note: { w: 240, h: 160 },
  group: { w: 640, h: 400 },
};
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
  "- After placing or moving frames, call canvas_focus with their ids so the person sees them. canvas_read with snapshot: true shows you the canvas as the person sees it.",
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

function groupOf(doc: DesignCanvasV1, groupId: unknown): string | undefined {
  if (groupId === undefined || groupId === null || groupId === "") return undefined;
  if (typeof groupId !== "string" || !doc.frames.some((frame) => frame.id === groupId && frame.kind === "group")) {
    throw new CanvasToolError("groupId must be the id of a group frame on this canvas.");
  }
  return groupId;
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
  const edit = async <T>(change: (doc: DesignCanvasV1) => { doc: DesignCanvasV1; value: T }): Promise<T> => {
    let value: T | undefined;
    const saved = await deps.store.update(deps.chatId, (doc) => {
      const next = change(doc);
      value = next.value;
      return next.doc;
    });
    deps.broadcast({ chatId: deps.chatId, revision: saved.revision });
    return value as T;
  };

  const frameIn = (doc: DesignCanvasV1, id: unknown): DesignFrame => {
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
          "Read the design canvas beside this chat: the visible area, the frames in it (id, kind, title, path, box, group, open comments) and a count of frames elsewhere. Boxes are in canvas units. Pass snapshot: true to also see a picture of the canvas as the person sees it.",
        parameters: Type.Object({ snapshot: Type.Optional(Type.Boolean()) }),
        execute: async (_id, raw, signal) =>
          run(async () => {
            const answer = describeCanvas(await deps.store.get(deps.chatId));
            if ((raw as { snapshot?: unknown } | undefined)?.snapshot !== true) return answer;
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
          "Put a frame on the design canvas: a workspace HTML page (kind file), an image, a note or a group. Write the file first with your file tools; path is workspace-relative. Leave x and y out to place it right of the last frame in its group or in view. Boxes are in canvas units.",
        parameters: Type.Object({
          kind: Type.Union([Type.Literal("file"), Type.Literal("image"), Type.Literal("note"), Type.Literal("group")]),
          title: Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars }),
          path: Type.Optional(Type.String({ maxLength: 1024 })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
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
            const kind = p.kind;
            if (kind !== "file" && kind !== "image" && kind !== "note" && kind !== "group") {
              throw new CanvasToolError('kind must be "file", "image", "note" or "group".');
            }
            const title = text(p.title, "title", DESIGN_CANVAS_LIMITS.titleChars);
            const path = kind === "file" || kind === "image" ? await checkedPath(deps.workspaceRoot, p.path, kind) : undefined;
            const x = optionalNumber(p.x, "x");
            const y = optionalNumber(p.y, "y");
            const w = optionalNumber(p.w, "w") ?? DEFAULT_BOX[kind].w;
            const h = optionalNumber(p.h, "h") ?? DEFAULT_BOX[kind].h;
            const width = kind === "file" ? (designWidth(p.designWidth) ?? DEFAULT_DESIGN_WIDTH) : undefined;
            const note = kind === "note" ? (typeof p.text === "string" ? p.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) : "") : undefined;
            const id = newId();
            return edit((doc) => {
              const groupId = groupOf(doc, p.groupId);
              const input: PlaceFrameInput = {
                kind,
                title,
                w,
                h,
                createdBy: "aiden",
                ...(x !== undefined && y !== undefined ? { x, y } : {}),
                ...(groupId ? { groupId } : {}),
                ...(path ? { path } : {}),
                ...(width ? { designWidth: width } : {}),
                ...(note !== undefined ? { text: note } : {}),
              };
              const placed = placeFrame(doc, input, canvasView(doc), () => id);
              if ("error" in placed) {
                throw new CanvasToolError(`The canvas is full (${DESIGN_CANVAS_LIMITS.frames} frames). Remove a frame first.`);
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
          "Move, resize, retitle or regroup a frame on the design canvas, or change a note's text. Pass groupId \"\" to take a frame out of its group. Boxes are in canvas units.",
        parameters: Type.Object({
          id: Type.String(),
          title: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.titleChars })),
          text: Type.Optional(Type.String({ maxLength: DESIGN_CANVAS_LIMITS.noteChars })),
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
            return edit((doc) => {
              const frame = frameIn(doc, p.id);
              if (p.text !== undefined && frame.kind !== "note") throw new CanvasToolError("Only a note has text.");
              if (width !== undefined && frame.kind !== "file") throw new CanvasToolError("Only a file frame has a design width.");
              let next: DesignFrame = {
                ...frame,
                ...(title !== undefined ? { title } : {}),
                ...(typeof p.text === "string" ? { text: p.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) } : {}),
                ...(x !== undefined ? { x: clampCoord(x) } : {}),
                ...(y !== undefined ? { y: clampCoord(y) } : {}),
                ...(w !== undefined ? { w: clampSize(w) } : {}),
                ...(h !== undefined ? { h: clampSize(h) } : {}),
                ...(width !== undefined ? { designWidth: width } : {}),
              };
              if (p.groupId !== undefined) {
                if (frame.kind === "group") throw new CanvasToolError("A group cannot be put inside another group.");
                const groupId = groupOf(doc, p.groupId);
                const { groupId: _old, ...rest } = next;
                next = groupId ? { ...rest, groupId } : rest;
              }
              // A moved group takes its frames with it, as dragging it does.
              const dx = frame.kind === "group" ? next.x - frame.x : 0;
              const dy = frame.kind === "group" ? next.y - frame.y : 0;
              const frames = doc.frames.map((entry) => {
                if (entry.id === frame.id) return next;
                if ((dx !== 0 || dy !== 0) && entry.groupId === frame.id) {
                  return { ...entry, x: clampCoord(entry.x + dx), y: clampCoord(entry.y + dy) };
                }
                return entry;
              });
              return { doc: { ...doc, frames }, value: { status: "updated", units: "canvas", frame: summarizeFrame(next) } };
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
          "Remove a frame from the design canvas. The file it shows is not deleted. A frame the person added needs confirm: true and only after they asked; say in your reply that you removed it. Removing a group keeps its frames.",
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
                doc: { ...doc, frames },
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
          "Pan and zoom the design canvas so the person sees these frames (every frame when ids is empty). The canvas leaves the view alone while the person is moving around it.",
        parameters: Type.Object({
          ids: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
        }),
        execute: async (_id, raw) =>
          run(async () => {
            if (!deps.focus) return { status: "unavailable", reason: "No window is showing this canvas." };
            const requested = (raw as { ids?: unknown } | undefined)?.ids;
            const ids = Array.isArray(requested) ? [...new Set(requested)] : [];
            const doc = await deps.store.get(deps.chatId);
            for (const id of ids) frameIn(doc, id);
            if (ids.length === 0 && doc.frames.length === 0) throw new CanvasToolError("The canvas is empty.");
            deps.focus(ids as string[]);
            return { status: "requested", frames: ids.length || doc.frames.length };
          }),
      },
      "never",
    ),
  ];
}
