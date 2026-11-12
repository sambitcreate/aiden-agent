// HTML pages Aiden writes or edits while design mode is on land on the canvas
// by themselves, so the person watches the design take shape without waiting
// for the model to call `canvas_place_frame`. A page that is already on the
// canvas is left where it is: the watcher reloads it after each edit. The
// rule is pure (`placeWrittenPageFrames`) and llm-client runs it after each
// completed `write_file` or `edit_file`, and the design-mode switch runs it
// once over the pages this chat wrote before the canvas opened.

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { canvasView } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { placeFrame } from "../../../renderer/shared/design-canvas/placement.js";
import { parseProducedFile } from "../../../renderer/shared/produced-file.js";
import {
  DESIGN_CANVAS_LIMITS,
  DESIGN_DEFAULT_FILE_WIDTH,
  defaultFileBox,
  isDesignRelativePath,
  type DesignCanvas,
  type DesignWidth,
} from "../../../renderer/shared/design-canvas/schema.js";
import { resolveDesignFile } from "./resolve-core.js";
import type { DesignCanvasStore } from "./store.js";

/** A page frame's box and design width when it first lands with no width hint; the canvas's File… item uses the same. */
export const WRITTEN_PAGE_BOX = defaultFileBox(DESIGN_DEFAULT_FILE_WIDTH);

/** How much of a written page is read for a width hint. */
export const DESIGN_WIDTH_HINT_BYTES = 16 * 1024;

/** At most this many earlier pages are put on a canvas when design mode opens. */
export const EARLIER_PAGES_LIMIT = 12;

/** Per-chat in-memory cap on recently written pages so deleted newest pages do not starve older ones. */
export const RECENT_WRITTEN_PAGES_LIMIT = 50;

const PAGE_EXTENSION = /\.html?$/iu;

/** The design width a numeric viewport or shell width stands for, when it clearly names one. */
function widthFromPixels(pixels: number): DesignWidth | undefined {
  if (pixels >= 320 && pixels <= 480) return 390;
  if (pixels >= 700 && pixels <= 860) return 768;
  if (pixels >= 1180 && pixels <= 1360) return 1280;
  if (pixels >= 1400 && pixels <= 1600) return 1440;
  return undefined;
}

function metaContent(tag: string): string | undefined {
  const match = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/**
 * The design width the start of a page asks for, or undefined when it does
 * not say: `<meta name="aiden-design-width" content="390">`, a numeric
 * viewport width (`width=390`), or a phone or tablet shell set on `body`,
 * `html` or a `.phone`/`.device`/`.mobile`/`.screen` wrapper when every such
 * width agrees. Pure, so it is tested on strings.
 */
export function inferDesignWidth(html: string): DesignWidth | undefined {
  const metas = html.match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of metas) {
    if (!/\bname\s*=\s*["']?aiden-design-width\b/iu.test(tag)) continue;
    const value = Number(metaContent(tag)?.trim());
    if (value === 390 || value === 768 || value === 1280 || value === 1440) return value;
  }
  for (const tag of metas) {
    if (!/\bname\s*=\s*["']?viewport\b/iu.test(tag)) continue;
    const width = /(?:^|[\s,;])width\s*=\s*(\d{3,4})\b/iu.exec(metaContent(tag) ?? "");
    const named = width ? widthFromPixels(Number(width[1])) : undefined;
    if (named) return named;
  }
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style>|$)/giu)]
    .map((match) =>
      match[1]!
        .replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, " ")
        .replace(/@media\b[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*(?:\}|$)/giu, " "),
    )
    .join("\n");
  if (!styles) return undefined;
  for (const match of styles.matchAll(/(?:^|[;{\s])(?:max-)?width\s*:\s*(\d{4})px\b/giu)) {
    const wide = widthFromPixels(Number(match[1]));
    if (wide === 1280 || wide === 1440) return undefined;
  }
  const shell =
    /(?:^|[}\s,>])(?:body|html|\.(?:phone|device|mobile|mobile-shell|app-shell|screen|iphone|tablet|ipad))\b[^{}]*\{(?:[^}]*?[;\s])?(?:max-)?width\s*:\s*(\d{3,4})px\b/giu;
  const found = new Set<DesignWidth>();
  for (const match of styles.matchAll(shell)) {
    const named = widthFromPixels(Number(match[1]));
    if (named === 390 || named === 768) found.add(named);
    else return undefined;
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Reads the first `DESIGN_WIDTH_HINT_BYTES` of a resolved page, never through
 * a symbolic link and only from a regular file, and infers its design width.
 */
export async function readDesignWidthHint(absolutePath: string): Promise<DesignWidth | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(DESIGN_WIDTH_HINT_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return inferDesignWidth(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

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
 * frames in view on the page the person is looking at, at the design width
 * its source asked for (`widths`, 1280 otherwise) and that width's box.
 * Returns the new frames' ids; `changed` is false when every page was
 * already there.
 */
export function placeWrittenPageFrames(
  doc: DesignCanvas,
  paths: readonly string[],
  newId: () => string,
  widths: ReadonlyMap<string, DesignWidth> = new Map(),
): { doc: DesignCanvas; changed: boolean; placedIds: string[] } {
  let next = doc;
  const placedIds: string[] = [];
  for (const relativePath of paths) {
    if (next.frames.some((frame) => frame.kind === "file" && frame.path === relativePath)) continue;
    const designWidth = widths.get(relativePath) ?? DESIGN_DEFAULT_FILE_WIDTH;
    const placed = placeFrame(
      next,
      {
        kind: "file",
        title: basename(relativePath).slice(0, DESIGN_CANVAS_LIMITS.titleChars),
        path: relativePath,
        designWidth,
        createdBy: "aiden",
        ...defaultFileBox(designWidth),
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

/**
 * The HTML pages each chat's replies wrote in this app run, newest last. A
 * reply's activity is saved only when it ends, so this is how opening design
 * mode in the middle of a reply still finds the pages that reply wrote
 * before. Memory only, and bounded per chat.
 */
export class RecentWrittenPages {
  private readonly byChat = new Map<string, string[]>();

  note(chatId: string, relativePath: string): void {
    const paths = (this.byChat.get(chatId) ?? []).filter((entry) => entry !== relativePath);
    paths.push(relativePath);
    this.byChat.set(chatId, paths.slice(-RECENT_WRITTEN_PAGES_LIMIT));
  }

  /** The chat's pages from saved history, then from this run, each once, newest last. */
  merged(chatId: string, saved: readonly string[]): string[] {
    const recent = this.byChat.get(chatId);
    if (!recent || recent.length === 0) return [...saved];
    const recentSet = new Set(recent);
    return [...saved.filter((entry) => !recentSet.has(entry)), ...recent];
  }

  forget(chatId: string): void {
    this.byChat.delete(chatId);
  }
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
  /** At most this many newest existing pages are placed, in chronological order. */
  limit?: number;
  /** Re-checked after file reads settle so a deleted chat or exited mode is not saved. */
  shouldSave?: () => Promise<boolean> | boolean;
}): Promise<string[]> {
  if (input.limit !== undefined && input.limit <= 0) return [];
  const newestFirst: string[] = [];
  const widths = new Map<string, DesignWidth>();
  const seen = new Set<string>();
  for (let index = input.paths.length - 1; index >= 0; index -= 1) {
    const relativePath = input.paths[index]!;
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const resolved = await resolveDesignFile(
      input.workspaceRoot,
      relativePath.split("/").map(encodeURIComponent).join("/"),
    );
    if (resolved.ok && resolved.mimeType.split(";")[0] === "text/html") {
      newestFirst.push(relativePath);
      const width = await readDesignWidthHint(resolved.absolute);
      if (width) widths.set(relativePath, width);
      if (input.limit !== undefined && newestFirst.length >= input.limit) break;
    }
  }
  const showable = newestFirst.reverse();
  if (showable.length === 0) return [];
  if (input.shouldSave && !(await input.shouldSave())) return [];
  let placedIds: string[] = [];
  try {
    const saved = await input.store.update(input.chatId, (doc) => {
      if (input.onlyIfEmpty && doc.frames.length > 0) throw UNCHANGED;
      const placed = placeWrittenPageFrames(doc, showable, input.newId, widths);
      if (!placed.changed) throw UNCHANGED;
      placedIds = placed.placedIds;
      return placed.doc;
    });
    if (input.shouldSave && !(await input.shouldSave())) return [];
    input.broadcast({ chatId: input.chatId, revision: saved.revision });
    return placedIds;
  } catch (error) {
    if (error === UNCHANGED) return [];
    throw error;
  }
}
