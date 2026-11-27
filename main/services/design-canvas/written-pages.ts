// HTML pages Aiden writes or edits under design/ while design mode is on land
// on the canvas by themselves, so the person watches the design take shape
// without waiting for the model to call `canvas_place_frame`. A page that is
// already on the canvas is left where it is: the watcher reloads it after each
// edit. The rule is pure (`placeWrittenPageFrames`) and llm-client runs it
// after each completed `write_file` or `edit_file`, and after each terminal
// command for the design/ pages it made or changed (`createDesignPageScanner`).
// The design-mode switch runs it once over the pages this chat wrote before
// the canvas opened. Pages elsewhere in the workspace stay off the canvas
// unless Aiden or the person places them.
//
// With live app frames on (3b, S83), a route file Aiden writes in an app
// (`app/pricing/page.tsx`) lands the same way, as an `app` frame for its
// route: read by its path alone, with one app snapshot and canvas.json read
// per turn and no disk walk, at most 12 a turn, never a route the person took
// off the canvas.

import { constants as fsConstants, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DesignAppsSnapshot, FrameworkId } from "../../../renderer/shared/design-app.js";
import { APP_DEFAULT_VIEWPORT, appFrameBox, fitAppScale } from "../../../renderer/shared/design-canvas/app-frame.js";
import { fillRoute, isConcreteRoute, patternParams } from "../../../renderer/shared/design-canvas/app-routes.js";
import { canvasView } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { placeFrame } from "../../../renderer/shared/design-canvas/placement.js";
import { parseProducedFile } from "../../../renderer/shared/produced-file.js";
import { deletePage } from "../../../renderer/shared/design-canvas/pages.js";
import {
  addChatPage,
  chatsOnPage,
  ChatPagesFullError,
  claimPage,
  landedPageId,
  withLazyClaim,
  chatsOnCanvas,
  withoutGoneClaims,
  type IsChatLive,
} from "../../../renderer/shared/design-canvas/chat-pages.js";
import {
  appRouteKey,
  DESIGN_CANVAS_LIMITS,
  DESIGN_DEFAULT_FILE_WIDTH,
  defaultFileBox,
  framesOnPage,
  isDesignRelativePath,
  type DesignCanvas,
  type DesignWidth,
} from "../../../renderer/shared/design-canvas/schema.js";
import { DESIGN_FRESH_VIEWPORT, type DesignChatView } from "../../../renderer/shared/design-canvas/view.js";
import { routeForWrittenFile } from "./app-server/app-routes.js";
import type { CanvasConfig } from "./canvas-config.js";
import { claimWithRoom } from "./lazy-claim.js";
import { resolveDesignFile } from "./resolve-core.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";
import type { DesignTurnPages } from "./views.js";

/** How much of a written page is read for a width hint. */
export const DESIGN_WIDTH_HINT_BYTES = 16 * 1024;

/** At most this many earlier pages are put on a canvas when design mode opens. */
export const EARLIER_PAGES_LIMIT = 12;

/** Per-chat in-memory cap on recently written pages so deleted newest pages do not starve older ones. */
export const RECENT_WRITTEN_PAGES_LIMIT = 50;

/** The workspace folder whose pages land on the canvas by themselves. */
export const DESIGN_PAGES_FOLDER = "design";

/** A terminal command's design/ pages are looked for among at most this many entries, this deep. */
export const DESIGN_PAGE_SCAN_LIMITS = { entries: 2_000, depth: 6 } as const;

const PAGE_EXTENSION = /\.html?$/iu;

/** A design/ HTML page outside hidden folders and `node_modules`, which may land on the canvas by itself. */
export function isAutoPlacedPagePath(relativePath: string): boolean {
  if (!PAGE_EXTENSION.test(relativePath) || !isDesignRelativePath(relativePath)) return false;
  const segments = relativePath.split("/");
  if (segments[0] !== DESIGN_PAGES_FOLDER || segments.length < 2) return false;
  return !segments.some((segment) => segment.startsWith(".") || segment === "node_modules");
}

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
 * when the call was not a first-party write or edit of an HTML file under
 * design/, outside hidden folders and `node_modules`.
 */
export function writtenPagePath(toolName: string, details: unknown): string | undefined {
  const produced = parseProducedFile(
    details && typeof details === "object" ? (details as { producedFile?: unknown }).producedFile : undefined,
    toolName,
  );
  if (!produced) return undefined;
  return isAutoPlacedPagePath(produced.relativePath) ? produced.relativePath : undefined;
}

/** Each design/ page's modification stamp, by workspace-relative path. */
/** The workspace-relative file a completed first-party write or edit produced, whatever it is (3b: route files). */
export function writtenFilePath(toolName: string, details: unknown): string | undefined {
  return parseProducedFile(
    details && typeof details === "object" ? (details as { producedFile?: unknown }).producedFile : undefined,
    toolName,
  )?.relativePath;
}

export type DesignPageStamps = ReadonlyMap<string, { mtimeMs: number; size: number }>;

/**
 * The HTML pages under the workspace's design/ folder with their size and
 * modification time. Symbolic links, hidden folders and `node_modules` are
 * skipped, and the walk stops at `DESIGN_PAGE_SCAN_LIMITS`. A missing folder
 * has no pages.
 */
export async function scanDesignPages(workspaceRoot: string): Promise<DesignPageStamps> {
  const stamps = new Map<string, { mtimeMs: number; size: number }>();
  let seen = 0;
  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(workspaceRoot, ...relativeDir.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (seen >= DESIGN_PAGE_SCAN_LIMITS.entries) return;
      seen += 1;
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < DESIGN_PAGE_SCAN_LIMITS.depth && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          await walk(relativePath, depth + 1);
        }
      } else if (entry.isFile() && isAutoPlacedPagePath(relativePath)) {
        try {
          const stat = await fs.lstat(path.join(workspaceRoot, ...relativePath.split("/")));
          if (stat.isFile()) stamps.set(relativePath, { mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Gone between the listing and the stat: not a page any more.
        }
      }
    }
  };
  await walk(DESIGN_PAGES_FOLDER, 1);
  return stamps;
}

/**
 * How long before the scanner's first look a page's modification time may be
 * and still count as written after it, for file systems whose clock lags
 * `Date.now()` by a tick.
 */
export const DESIGN_PAGE_CLOCK_SLACK_MS = 100;

/**
 * The pages that are new in `after` or whose size or modification time
 * changed, oldest change first. With `changedSince`, a page `before` already
 * had also counts when it was modified at or after that time: the first look
 * runs while the first command may already be writing.
 */
export function changedDesignPages(before: DesignPageStamps, after: DesignPageStamps, changedSince?: number): string[] {
  return [...after]
    .filter(([relativePath, stamp]) => {
      const earlier = before.get(relativePath);
      if (!earlier || earlier.mtimeMs !== stamp.mtimeMs || earlier.size !== stamp.size) return true;
      return changedSince !== undefined && stamp.mtimeMs >= changedSince;
    })
    .sort(([pathA, a], [pathB, b]) => a.mtimeMs - b.mtimeMs || (pathA < pathB ? -1 : pathA > pathB ? 1 : 0))
    .map(([relativePath]) => relativePath);
}

/**
 * Finds the design/ pages each terminal command made or changed: it notes the
 * folder when created (before the turn's first command) and, after each
 * command, answers the pages that changed since the last look. Looks run one
 * after another, so commands that end together are each compared with the
 * state before them.
 */
export function createDesignPageScanner(
  workspaceRoot: string,
  scan: (workspaceRoot: string) => Promise<DesignPageStamps> = scanDesignPages,
  now: () => number = Date.now,
): { changedSinceLastLook(): Promise<string[]> } {
  const safeScan = (fallback: DesignPageStamps) => scan(workspaceRoot).catch(() => fallback);
  // The first look is not awaited before a command starts, so it can see a
  // page that command wrote; anything modified from now on is still news.
  let changedSince: number | undefined = now() - DESIGN_PAGE_CLOCK_SLACK_MS;
  let last: Promise<DesignPageStamps> = safeScan(new Map());
  return {
    changedSinceLastLook() {
      const since = changedSince;
      changedSince = undefined;
      const look = last.then(async (before) => ({ before, after: await safeScan(before) }));
      last = look.then(({ after }) => after);
      return look.then(({ before, after }) => changedDesignPages(before, after, since));
    },
  };
}

function basename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1) || relativePath;
}

/**
 * Puts each page that is not on the chat's page yet beside the frames in view
 * there (a frame of it on another page is that page's own), at the design width
 * its source asked for (`widths`, 1280 otherwise) and that width's box. A page
 * the person took off the canvas (`removedPagePaths`) is not put back: it is
 * listed in `removed`, and comes back only when Aiden places it with
 * canvas_place_frame or the person adds it. Returns the new frames' ids;
 * `changed` is false when every page was already there or removed.
 */
export function placeWrittenPageFrames(
  doc: DesignCanvas,
  paths: readonly string[],
  newId: () => string,
  widths: ReadonlyMap<string, DesignWidth>,
  /** The chat's view for the turn (`designTurnPages`): the pages land on its page, beside what is in view. */
  view: DesignChatView,
): { doc: DesignCanvas; changed: boolean; placedIds: string[]; removed: string[] } {
  let next = doc;
  const placedIds: string[] = [];
  const removed: string[] = [];
  const takenOff = new Set(doc.removedPagePaths ?? []);
  for (const relativePath of paths) {
    // Already on this page: the watcher reloads it. Another page's frame of it is that page's.
    if (next.frames.some((frame) => frame.kind === "file" && frame.path === relativePath && frame.pageId === view.pageId)) continue;
    if (takenOff.has(relativePath)) {
      removed.push(relativePath);
      continue;
    }
    const designWidth = widths.get(relativePath) ?? DESIGN_DEFAULT_FILE_WIDTH;
    const placed = placeFrame(
      next,
      {
        kind: "file",
        title: basename(relativePath).slice(0, DESIGN_CANVAS_LIMITS.titleChars),
        path: relativePath,
        designWidth,
        pageId: view.pageId,
        createdBy: "aiden",
        ...defaultFileBox(designWidth),
      },
      canvasView(next, view),
      newId,
    );
    // A full canvas takes no more frames; the file is still in the workspace.
    if ("error" in placed) break;
    next = placed.doc;
    placedIds.push(placed.id);
  }
  return { doc: next, changed: placedIds.length > 0, placedIds, removed };
}

/** Whether a design/ page still exists as an HTML file the canvas can show. */
export async function isShowablePage(workspaceRoot: string, relativePath: string): Promise<boolean> {
  const resolved = await resolveDesignFile(workspaceRoot, relativePath.split("/").map(encodeURIComponent).join("/"));
  return resolved.ok && resolved.mimeType.split(";")[0] === "text/html";
}

/** A route an app frame shows: written-route placement's unit (S83). */
export type WrittenAppRoute = { appRoot: string; route: string };

/** What a turn resolves written route files against (S83), read once per turn. */
export type WrittenRouteData = {
  /** Every app root the workspace knows, with its framework when one is known. */
  owners: readonly { appRoot: string; framework?: FrameworkId }[];
  /** canvas.json's `params`, by app root. */
  params: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>>;
};

/** The roots of the snapshot's candidates and apps, and canvas.json's described roots, each with its framework. */
export function writtenRouteData(snapshot: Pick<DesignAppsSnapshot, "apps" | "candidates"> | null, config: CanvasConfig | null): WrittenRouteData {
  const frameworks = new Map<string, FrameworkId | undefined>();
  const add = (appRoot: string, framework: FrameworkId | undefined) => {
    if (!frameworks.has(appRoot) || (frameworks.get(appRoot) === undefined && framework !== undefined)) frameworks.set(appRoot, framework);
  };
  for (const candidate of snapshot?.candidates ?? []) add(candidate.appRoot, candidate.framework);
  for (const app of snapshot?.apps ?? []) add(app.appRoot, app.framework);
  const params = new Map<string, Record<string, readonly string[]>>();
  for (const app of config?.apps ?? []) {
    add(app.root, undefined);
    if (app.params) params.set(app.root, app.params);
  }
  return {
    owners: [...frameworks].map(([appRoot, framework]) => (framework ? { appRoot, framework } : { appRoot })),
    params,
  };
}

/** The deepest known root holding `relativePath`, or undefined. */
function routeOwner(relativePath: string, data: WrittenRouteData): WrittenRouteData["owners"][number] | undefined {
  let best: WrittenRouteData["owners"][number] | undefined;
  for (const owner of data.owners) {
    const holds = owner.appRoot === "." || relativePath.startsWith(`${owner.appRoot}/`);
    if (!holds) continue;
    const depth = owner.appRoot === "." ? 0 : owner.appRoot.split("/").length;
    const bestDepth = best === undefined ? -1 : best.appRoot === "." ? 0 : best.appRoot.split("/").length;
    if (depth > bestDepth) best = owner;
  }
  return best;
}

/** The route pattern a written file declares under its root, by its path alone; null for any other file. */
export function writtenRoutePattern(relativePath: string, data: WrittenRouteData): { appRoot: string; pattern: string } | null {
  const owner = routeOwner(relativePath, data);
  if (!owner) return null;
  const pattern = routeForWrittenFile(owner.appRoot, owner.framework, relativePath);
  return pattern === null ? null : { appRoot: owner.appRoot, pattern };
}

/**
 * The route a written file shows (S83): its pattern when concrete; a
 * single-parameter pattern filled with canvas.json's first value for it; null
 * otherwise (no root, no convention, not a route file, or a pattern nothing fills).
 */
export function writtenAppRoute(relativePath: string, data: WrittenRouteData): WrittenAppRoute | null {
  const found = writtenRoutePattern(relativePath, data);
  if (!found) return null;
  if (isConcreteRoute(found.pattern)) return { appRoot: found.appRoot, route: found.pattern };
  const params = patternParams(found.pattern);
  if (params.length !== 1) return null;
  const values = data.params.get(found.appRoot);
  const first = values && Object.prototype.hasOwnProperty.call(values, found.pattern) ? values[found.pattern]?.[0] : undefined;
  if (first === undefined) return null;
  const route = fillRoute(found.pattern, { [params[0]!.name]: first });
  return route === null ? null : { appRoot: found.appRoot, route };
}

/**
 * A turn's written routes (S83): the first route candidate starts the turn's
 * one data read, which every later write shares, and the turn places at most
 * `limit` app frames.
 */
export function createWrittenRouteTurn(deps: { load(): Promise<WrittenRouteData>; limit?: number }): {
  routeFor(relativePath: string): Promise<WrittenAppRoute | null>;
  room(): number;
  placed(count: number): void;
} {
  const limit = deps.limit ?? EARLIER_PAGES_LIMIT;
  let data: Promise<WrittenRouteData> | undefined;
  let placed = 0;
  return {
    async routeFor(relativePath) {
      // design/ pages are v1 pages, never route files.
      if (isAutoPlacedPagePath(relativePath) || !isDesignRelativePath(relativePath)) return null;
      data ??= deps.load();
      return writtenAppRoute(relativePath, await data);
    },
    room: () => Math.max(0, limit - placed),
    placed(count) {
      placed += count;
    },
  };
}

/**
 * Puts each route not on the view's page yet beside what is in view there, as
 * an `app` frame at 1280 × 800 and scale 0.5. A route the person took off the
 * canvas (`removedAppRoutes`) is not put back. `added` lists each new frame's
 * viewport width.
 */
export function placeWrittenAppRoutes(
  doc: DesignCanvas,
  routes: readonly WrittenAppRoute[],
  newId: () => string,
  view: DesignChatView,
): { doc: DesignCanvas; placedIds: string[]; added: number[] } {
  let next = doc;
  const placedIds: string[] = [];
  const added: number[] = [];
  const takenOff = new Set(doc.removedAppRoutes ?? []);
  for (const { appRoot, route } of routes) {
    const shown = next.frames.some(
      (frame) => frame.kind === "app" && frame.pageId === view.pageId && (frame.appRoot ?? ".") === appRoot && (frame.route ?? "/") === route,
    );
    if (shown || takenOff.has(appRouteKey(appRoot, route))) continue;
    const viewport = { ...APP_DEFAULT_VIEWPORT };
    const scale = fitAppScale(viewport, 0.5, DESIGN_CANVAS_LIMITS.maxSize);
    const placed = placeFrame(
      next,
      {
        kind: "app",
        title: route.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
        appRoot,
        route,
        viewport,
        scale,
        pageId: view.pageId,
        createdBy: "aiden",
        ...appFrameBox(viewport, scale),
      },
      canvasView(next, view),
      newId,
    );
    if ("error" in placed) break;
    next = placed.doc;
    placedIds.push(placed.id);
    added.push(viewport.width);
  }
  return { doc: next, placedIds, added };
}

/**
 * The HTML pages this chat's earlier replies wrote or edited, newest last,
 * read from the saved activity of its messages. Each path appears once.
 */
export function pagesWrittenInChat(
  messages: readonly { timeline?: { steps?: readonly unknown[] } | null }[],
  /** 3b (S83): also keeps the files this says are route files, in the same timeline. Left out, only design/ pages. */
  options: { isRouteFile?: (relativePath: string) => boolean } = {},
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const message of messages) {
    for (const step of message.timeline?.steps ?? []) {
      if (!step || typeof step !== "object") continue;
      const tool = step as { kind?: unknown; toolName?: unknown; status?: unknown; producedFile?: unknown };
      if (tool.kind !== "tool" || tool.status !== "completed" || typeof tool.toolName !== "string") continue;
      const details = { producedFile: tool.producedFile };
      const relativePath =
        writtenPagePath(tool.toolName, details) ??
        (options.isRouteFile ? routeFileOf(writtenFilePath(tool.toolName, details), options.isRouteFile) : undefined);
      if (!relativePath) continue;
      // A page edited again moves to the end, so the newest pages are kept.
      if (seen.has(relativePath)) ordered.splice(ordered.indexOf(relativePath), 1);
      seen.add(relativePath);
      ordered.push(relativePath);
    }
  }
  return ordered;
}

function routeFileOf(relativePath: string | undefined, isRouteFile: (relativePath: string) => boolean): string | undefined {
  return relativePath !== undefined && isRouteFile(relativePath) ? relativePath : undefined;
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

/**
 * The design-mode entry running for each chat, so a design turn's first
 * canvas write waits for entry's claim instead of claiming a page first.
 * Memory only.
 */
export class PendingEntries {
  private readonly byChat = new Map<string, Promise<unknown>>();

  /** Remembers `entry` until it settles, and returns it. */
  track<T>(chatId: string, entry: Promise<T>): Promise<T> {
    this.byChat.set(chatId, entry);
    const clear = () => {
      if (this.byChat.get(chatId) === entry) this.byChat.delete(chatId);
    };
    entry.then(clear, clear);
    return entry;
  }

  /** Settles once the chat's running entry has, whether or not it failed. */
  async wait(chatId: string): Promise<void> {
    await this.byChat.get(chatId)?.catch(() => undefined);
  }
}

const UNCHANGED = Symbol("unchanged");

/** What design mode's entry decides the chat's page by, read before the canvas update. */
type EntryRules = {
  chatId: string;
  /** Names a page made for the chat. */
  pageName: string;
  /** The pages other chats' kept views are on. */
  otherViews: ReadonlySet<string>;
  isLive: IsChatLive;
};

/** The claim, or undefined when the canvas has no room for another chat's page. */
function tryClaim(claim: () => DesignCanvas): DesignCanvas | undefined {
  try {
    return claim();
  } catch (error) {
    if (error instanceof ChatPagesFullError) return undefined;
    throw error;
  }
}

/**
 * Which page design mode's entry makes the chat's own, and which of its
 * earlier pages go there. In order:
 * 1. the chat's claim, when it has one, stays;
 * 2. else the page holding most of its earlier pages already on the canvas,
 *    leaving out pages another live chat claims (on a tie the resolved page,
 *    then the earliest page);
 * 3. else the resolved page as it is, when it is not named for another chat,
 *    no other live chat claims it, and it holds no frames or no other chat's
 *    kept view is on it;
 * 4. else a new page named after the chat, right after the resolved page. At
 *    the page limit the resolved page is shared instead.
 * Pages already on the canvas, on any page, are not placed again; the missing
 * ones go on the chat's page. Claims and `namedFor` marks of chats that are
 * gone are dropped first, so a gone chat's mark does not keep rule 3 off a page.
 */
function entryPlacement(
  doc: DesignCanvas,
  paths: readonly string[],
  view: DesignChatView,
  rules: EntryRules,
  newId: () => string,
): { doc: DesignCanvas; view: DesignChatView; missing: string[]; added?: string } {
  const base = withoutGoneClaims(doc, rules.isLive);
  const takenOff = new Set(base.removedPagePaths ?? []);
  const holding = new Map<string, number>();
  const missing: string[] = [];
  for (const relativePath of paths) {
    const shown = base.frames.filter((frame) => frame.kind === "file" && frame.path === relativePath);
    if (shown.length === 0) {
      if (!takenOff.has(relativePath)) missing.push(relativePath);
      continue;
    }
    for (const pageId of new Set(shown.map((frame) => frame.pageId))) {
      // Another live chat's page is not counted: the chat does not take it over.
      if (claimedByOther(base, pageId, rules)) continue;
      holding.set(pageId, (holding.get(pageId) ?? 0) + 1);
    }
  }
  const lookAt = (pageId: string): DesignChatView => ({
    ...view,
    pageId,
    viewport: { ...(pageId === view.pageId ? view.viewport : DESIGN_FRESH_VIEWPORT) },
  });
  const own = base.chatPages[rules.chatId];
  let pageId: string;
  if (Object.prototype.hasOwnProperty.call(base.chatPages, rules.chatId) && base.pages.some((page) => page.id === own)) {
    pageId = own!;
  } else if (holding.size > 0) {
    const most = Math.max(...holding.values());
    pageId = holding.get(view.pageId) === most ? view.pageId : base.pages.find((page) => holding.get(page.id) === most)!.id;
  } else if (takeAsItIs(base, view.pageId, rules)) {
    pageId = view.pageId;
  } else {
    const id = newId();
    const added = tryClaim(() => addChatPage(base, rules.chatId, rules.pageName, id, view.pageId, rules.isLive));
    if (added && added !== base) return { doc: added, view: lookAt(id), missing, added: id };
    pageId = view.pageId;
  }
  const claimed = tryClaim(() => claimPage(base, rules.chatId, pageId, rules.isLive)) ?? base;
  return { doc: claimed, view: lookAt(pageId), missing };
}

/** Whether another live chat claims the page. */
function claimedByOther(doc: DesignCanvas, pageId: string, rules: EntryRules): boolean {
  return chatsOnPage(doc, pageId, rules.isLive).some((chatId) => chatId !== rules.chatId);
}

/** Rule 3: the resolved page is not another chat's, by name, claim or what it is looking at. */
function takeAsItIs(doc: DesignCanvas, pageId: string, rules: EntryRules): boolean {
  const page = doc.pages.find((entry) => entry.id === pageId)!;
  if (page.namedFor !== undefined && page.namedFor !== rules.chatId) return false;
  if (claimedByOther(doc, pageId, rules)) return false;
  return framesOnPage(doc, pageId).length === 0 || !rules.otherViews.has(pageId);
}

/**
 * Places the pages that still exist and the canvas can show in the chat's
 * workspace canvas, on the page its turn works on, and tells open canvases.
 * Saves and announces nothing when every page is already there. Returns the
 * new frames' ids and the page they are on. Entry also returns the chat's
 * page and main's `focusId` for showing it.
 */
export async function placeWrittenPagesOnCanvas(input: {
  chatId: string;
  workspaceRoot: string;
  paths: readonly string[];
  store: Pick<DesignChatCanvases, "get" | "update" | "workspaceIdOf">;
  /** The turn's page resolver (`designTurnPages`); entry without a message or turn. */
  pages: Pick<DesignTurnPages, "resolver" | "show">;
  broadcast(update: DesignCanvasUpdated): void;
  newId(): string;
  /**
   * Design mode opening: the chat claims its page (`entryPlacement`) and its
   * earlier pages go there, even when there are none. `pageName` names a page
   * made for the chat; `otherViews` lists the pages other chats' kept views
   * are on; `isLive` says which of the claimed chats are live in the workspace.
   */
  entry?: {
    pageName: string;
    otherViews(workspaceId: string): Promise<Set<string>>;
    isLive(chatIds: string[], workspaceId: string): Promise<Set<string>>;
  };
  /** At most this many newest existing pages are placed, in chronological order. */
  limit?: number;
  /** Checked on the canvas's own chain just before the save, so a deleted chat or exited mode is not saved. */
  shouldSave?: () => Promise<boolean> | boolean;
  /** Told the pages left off because the person took them off the canvas. */
  onRemoved?: (paths: readonly string[]) => void;
  /**
   * Settles once a design-mode entry running for this chat has claimed its
   * page. A turn's placement waits for it, then claims the turn's page for
   * a chat with none, in the same write. Not used with `entry`.
   */
  pendingEntry?(): Promise<void>;
  /** Which claimed chats are live, asked only when a turn's lazy claim finds `chatPages` full. */
  isLive?(chatIds: string[], workspaceId: string): Promise<Set<string>>;
  /** 3b (S83): app routes to show as live frames on the same page, after the pages. */
  routes?: readonly WrittenAppRoute[];
  /**
   * 3b (S83, entry): placed only when the target page is still empty after
   * the pages and routes, and the person hasn't taken it off the canvas.
   */
  fallbackRoute?: WrittenAppRoute;
}): Promise<{ frameIds: string[]; pageId?: string; focusId?: number; added: number[] }> {
  if (input.limit !== undefined && input.limit <= 0) return { frameIds: [], added: [] };
  // A chat deleted meanwhile has no canvas to put them on.
  const workspaceId = await input.store.workspaceIdOf(input.chatId);
  if (workspaceId === null) return { frameIds: [], added: [] };
  const routes = input.routes ?? [];
  let rules: EntryRules | undefined;
  if (input.entry) {
    const otherViews = await input.entry.otherViews(workspaceId);
    const { doc: current } = await input.store.get(input.chatId, { workspaceId });
    const checked = new Set(chatsOnCanvas(current).filter((chatId) => chatId !== input.chatId));
    const live = await input.entry.isLive([...checked], workspaceId);
    // A claim made after this check is a live chat's.
    const isLive: IsChatLive = (chatId) => !checked.has(chatId) || live.has(chatId);
    rules = { chatId: input.chatId, pageName: input.entry.pageName, otherViews, isLive };
  }
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
  // Entry claims a page even when the chat wrote none.
  if (showable.length === 0 && !rules && routes.length === 0) return { frameIds: [], added: [] };
  if (!rules) await input.pendingEntry?.();
  const viewOf = await input.pages.resolver(workspaceId);
  // Asked on the canvas's chain before the write, and again after it: the
  // chat must still be in design mode, if the caller asks that, and still in
  // this workspace. A chat that moved while this ran writes nothing back to the
  // canvas it left, whose cleanup may already have run.
  const callerAllows = input.shouldSave;
  const shouldSave = async (): Promise<boolean> =>
    (await input.store.workspaceIdOf(input.chatId)) === workspaceId && (!callerAllows || (await callerAllows()));
  let placedIds: string[] = [];
  let routeWidths: number[] = [];
  let removed: string[] = [];
  let pageId: string | undefined;
  // The page entry added in the save that landed, so taking the frames back also takes it.
  let addedPageId: string | undefined;
  let refused = false;
  let landed: string | undefined;
  // Reported whether or not anything was saved, once the canvas has been read.
  const reportRemoved = () => {
    if (removed.length > 0) input.onRemoved?.(removed);
  };
  // Entry always shows the chat's page, so the view and the open canvas move to it.
  const show = async (): Promise<number | undefined> =>
    rules && pageId !== undefined ? await input.pages.show(workspaceId, pageId) : undefined;
  try {
    const { doc: saved } = await input.store.update(
      input.chatId,
      (doc) => {
        let view = viewOf(doc);
        let base = doc;
        let paths: readonly string[] = showable;
        addedPageId = undefined;
        if (rules) {
          const placement = entryPlacement(doc, showable, view, rules, input.newId);
          base = placement.doc;
          view = placement.view;
          paths = placement.missing;
          addedPageId = placement.added;
        }
        pageId = view.pageId;
        const pagesPlaced = placeWrittenPageFrames(base, paths, input.newId, widths, view);
        let routesPlaced = placeWrittenAppRoutes(pagesPlaced.doc, routes, input.newId, view);
        if (input.fallbackRoute && framesOnPage(routesPlaced.doc, view.pageId).length === 0) {
          routesPlaced = placeWrittenAppRoutes(routesPlaced.doc, [input.fallbackRoute], input.newId, view);
        }
        const placed = { ...pagesPlaced, doc: routesPlaced.doc, placedIds: [...pagesPlaced.placedIds, ...routesPlaced.placedIds] };
        removed = placed.removed;
        routeWidths = [];
        if (placed.doc === doc) throw UNCHANGED;
        placedIds = placed.placedIds;
        routeWidths = routesPlaced.added;
        // A turn's placement claims the page it landed on for a chat with none; entry has claimed already.
        if (rules) return placed.doc;
        landed = landedPageId(doc, placed.doc, view.pageId);
        return withLazyClaim(placed.doc, input.chatId, landed);
      },
      {
        workspaceId,
        // Leaving design mode, deleting the chat or moving it while this waited keeps the frames off the stored canvas.
        beforeWrite: async () => {
          if (!(await shouldSave())) {
            removed = [];
            refused = true;
            throw UNCHANGED;
          }
        },
      },
    );
    // The mode can still turn off while the file is being written. Then the
    // frames are taken back off, unless the person changed the canvas since
    // or design mode is on again by the time that runs.
    if (!(await shouldSave())) {
      if (placedIds.length > 0 || addedPageId !== undefined) {
        await retractPlacedFrames(input, workspaceId, saved.revision, placedIds, shouldSave, addedPageId);
      }
      return { frameIds: [], added: [] };
    }
    input.broadcast({ workspaceId, chatId: input.chatId, revision: saved.revision });
    await claimWithRoom({
      chatId: input.chatId,
      workspaceId,
      pageId: landed,
      saved,
      store: input.store,
      isLive: input.isLive,
      broadcast: input.broadcast,
    });
    reportRemoved();
    const focusId = await show();
    return { frameIds: placedIds, ...(pageId ? { pageId } : {}), ...(focusId !== undefined ? { focusId } : {}), added: routeWidths };
  } catch (error) {
    if (error === UNCHANGED) {
      reportRemoved();
      if (!rules || refused || !(await shouldSave())) return { frameIds: [], added: [] };
      const focusId = await show();
      return { frameIds: [], ...(pageId ? { pageId } : {}), ...(focusId !== undefined ? { focusId } : {}), added: [] };
    }
    throw error;
  }
}

async function retractPlacedFrames(
  input: { chatId: string; store: Pick<DesignChatCanvases, "update">; broadcast(update: DesignCanvasUpdated): void },
  workspaceId: string,
  savedRevision: number,
  placedIds: readonly string[],
  shouldSave: () => Promise<boolean> | boolean,
  /** A page the same save added; it goes too once nothing is left on it. */
  addedPageId?: string,
): Promise<void> {
  const placed = new Set(placedIds);
  try {
    const { doc: retracted } = await input.store.update(
      input.chatId,
      (doc) => {
        if (doc.revision !== savedRevision) throw UNCHANGED;
        const frames = doc.frames.filter((frame) => !placed.has(frame.id));
        const dropPage =
          addedPageId !== undefined && doc.pages.length > 1 && !frames.some((frame) => frame.pageId === addedPageId);
        if (!dropPage) return { ...doc, frames };
        // The claim on the added page goes with it, rather than moving to the first page.
        const chatPages = Object.fromEntries(
          Object.entries(doc.chatPages).filter(([chatId, pageId]) => chatId !== input.chatId || pageId !== addedPageId),
        );
        return deletePage({ ...doc, frames, chatPages }, addedPageId);
      },
      {
        workspaceId,
        beforeWrite: async () => {
          if (await shouldSave()) throw UNCHANGED;
        },
      },
    );
    input.broadcast({ workspaceId, chatId: input.chatId, revision: retracted.revision });
  } catch (error) {
    if (error !== UNCHANGED) throw error;
  }
}
