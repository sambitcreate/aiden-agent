// HTML pages Aiden writes or edits while design mode is on land on the canvas
// by themselves, so the person watches the design take shape without waiting
// for the model to call `canvas_place_frame`. A page that is already on the
// canvas is left where it is: the watcher reloads it after each edit. The
// rule is pure (`placeWrittenPageFrames`) and llm-client runs it after each
// completed `write_file` or `edit_file`, and the design-mode switch runs it
// once over the pages this chat wrote before the canvas opened.

import { canvasView } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { placeFrame } from "../../../renderer/shared/design-canvas/placement.js";
import { parseProducedFile } from "../../../renderer/shared/produced-file.js";
import {
  DESIGN_CANVAS_LIMITS,
  isDesignRelativePath,
  type DesignCanvas,
  type DesignWidth,
} from "../../../renderer/shared/design-canvas/schema.js";
import { resolveDesignFile } from "./resolve-core.js";
import type { DesignCanvasStore } from "./store.js";

/** A page frame's box and design width when it first lands; the canvas's File… item uses the same. */
export const WRITTEN_PAGE_BOX = { w: 640, h: 436 } as const;
const WRITTEN_PAGE_WIDTH: DesignWidth = 1280;

/** At most this many earlier pages are put on a canvas when design mode opens. */
export const EARLIER_PAGES_LIMIT = 12;

const PAGE_EXTENSION = /\.html?$/iu;

/**
 * The workspace-relative page a completed file tool call wrote, or undefined
 * when the call was not a first-party write or edit of an HTML file outside
 * hidden folders and `node_modules`.
 */
export function writtenPagePath(toolName: string, details: unknown): string | undefined {
  const produced = parseProducedFile(
    details && typeof details === "object" ? (details as { producedFile?: unknown }).producedFile : undefined,
    toolName,
  );
  if (!produced) return undefined;
  const relativePath = produced.relativePath;
  if (!PAGE_EXTENSION.test(relativePath) || !isDesignRelativePath(relativePath)) return undefined;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.startsWith(".") || segment === "node_modules")) return undefined;
  return relativePath;
}

function basename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1) || relativePath;
}

/**
 * Puts each page that is not on the canvas yet (on any page of it) beside the
 * frames in view on the page the person is looking at. Returns the new
 * frames' ids; `changed` is false when every page was already there.
 */
export function placeWrittenPageFrames(
  doc: DesignCanvas,
  paths: readonly string[],
  newId: () => string,
): { doc: DesignCanvas; changed: boolean; placedIds: string[] } {
  let next = doc;
  const placedIds: string[] = [];
  for (const relativePath of paths) {
    if (next.frames.some((frame) => frame.kind === "file" && frame.path === relativePath)) continue;
    const placed = placeFrame(
      next,
      {
        kind: "file",
        title: basename(relativePath).slice(0, DESIGN_CANVAS_LIMITS.titleChars),
        path: relativePath,
        designWidth: WRITTEN_PAGE_WIDTH,
        createdBy: "aiden",
        ...WRITTEN_PAGE_BOX,
      },
      canvasView(next),
      newId,
    );
    // A full canvas takes no more frames; the file is still in the workspace.
    if ("error" in placed) break;
    next = placed.doc;
    placedIds.push(placed.id);
  }
  return { doc: next, changed: placedIds.length > 0, placedIds };
}

/**
 * The HTML pages this chat's earlier replies wrote or edited, newest last,
 * read from the saved activity of its messages. Each path appears once.
 */
export function pagesWrittenInChat(
  messages: readonly { timeline?: { steps?: readonly unknown[] } | null }[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const message of messages) {
    for (const step of message.timeline?.steps ?? []) {
      if (!step || typeof step !== "object") continue;
      const tool = step as { kind?: unknown; toolName?: unknown; status?: unknown; producedFile?: unknown };
      if (tool.kind !== "tool" || tool.status !== "completed" || typeof tool.toolName !== "string") continue;
      const relativePath = writtenPagePath(tool.toolName, { producedFile: tool.producedFile });
      if (!relativePath) continue;
      // A page edited again moves to the end, so the newest pages are kept.
      if (seen.has(relativePath)) ordered.splice(ordered.indexOf(relativePath), 1);
      seen.add(relativePath);
      ordered.push(relativePath);
    }
  }
  return ordered;
}

const UNCHANGED = Symbol("unchanged");

/**
 * Places the pages that still exist and the canvas can show in the chat's
 * stored canvas, and tells open canvases. Saves and announces nothing when
 * every page is already there. Returns the new frames' ids.
 */
export async function placeWrittenPagesOnCanvas(input: {
  chatId: string;
  workspaceRoot: string;
  paths: readonly string[];
  store: Pick<DesignCanvasStore, "update">;
  broadcast(update: { chatId: string; revision: number }): void;
  newId(): string;
  /** Only when the canvas has no frames at all, so a person who cleared it is not refilled. */
  onlyIfEmpty?: boolean;
}): Promise<string[]> {
  const showable: string[] = [];
  for (const relativePath of input.paths) {
    const resolved = await resolveDesignFile(
      input.workspaceRoot,
      relativePath.split("/").map(encodeURIComponent).join("/"),
    );
    if (resolved.ok && resolved.mimeType.split(";")[0] === "text/html") showable.push(relativePath);
  }
  if (showable.length === 0) return [];
  let placedIds: string[] = [];
  try {
    const saved = await input.store.update(input.chatId, (doc) => {
      if (input.onlyIfEmpty && doc.frames.length > 0) throw UNCHANGED;
      const placed = placeWrittenPageFrames(doc, showable, input.newId);
      if (!placed.changed) throw UNCHANGED;
      placedIds = placed.placedIds;
      return placed.doc;
    });
    input.broadcast({ chatId: input.chatId, revision: saved.revision });
    return placedIds;
  } catch (error) {
    if (error === UNCHANGED) return [];
    throw error;
  }
}
