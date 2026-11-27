// Each chat's view of its workspace canvas: the page the chat looks at, where
// it looked on each page, and whether its canvas is open. Main owns it; the
// renderer keeps no copy. Aiden's canvas tools read the page on screen from
// here, since the shared document holds no view.
//
// The renderer reports the view as the person pans, zooms and switches pages
// (`designCanvas:view`), and says when the canvas unmounts. Main keeps the
// page after an unmount, so a placement for that chat in the background still
// lands where the person last looked, and the canvas reads it back when it
// mounts again (`designCanvas:view:get`).
//
// When Aiden shows a page, it counts at once: main sets the page here and
// gives the change a new `focusId`, which `designCanvas:focus` carries to the
// canvas. Every view report echoes the highest `focusId` its canvas has seen,
// and a report older than main's is dropped, so a pan reported just before
// the focus arrived cannot take Aiden's page back.
//
// Persisted per workspace in `<root>/<workspaceId>.json` as
// `{ [chatId]: { pageId, viewports, focusId } }`: read lazily on first use,
// written at most once a second. Whether a canvas is open (`mounted`) and its
// size on screen are memory only. Keyed by chat: design mode lives in the one
// main window.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../durable-fs.js";
import type { DesignViewState } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { DESIGN_CANVAS_LIMITS, isDesignChatId, type DesignCanvas, type DesignViewport } from "../../../renderer/shared/design-canvas/schema.js";
import { DESIGN_FRESH_VIEWPORT, parseDesignViewport, type DesignChatView } from "../../../renderer/shared/design-canvas/view.js";
import { assertDesignCanvasWorkspaceId } from "./store.js";

/** What a mounting canvas reads back: the page, where it looked there, and the latest Aiden page change. */
/**
 * What a mounting canvas reads: the chat's page, its viewport there, the newest
 * `focusId`, and where the chat last looked at every page it has looked at, so
 * switching pages in the canvas opens each where it was left.
 */
export type DesignKeptView = {
  pageId: string;
  viewport: DesignViewport;
  focusId: number;
  viewports: Record<string, DesignViewport>;
};

type Entry = {
  pageId: string;
  /** Where the chat last looked at each page, the most recently visited last. */
  viewports: Map<string, DesignViewport>;
  /** The latest Aiden page change for this chat; 0 before any. */
  focusId: number;
  mounted: boolean;
  /** The canvas pane is shown (2b's presence, with `windowShown`). */
  visible: boolean;
  /** Whether the window that reported the canvas is shown: not minimized or hidden. Absent counts as shown. */
  windowShown?: () => boolean;
  size?: { w: number; h: number };
};

type Workspace = {
  entries: Map<string, Entry>;
  loaded: Promise<void>;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** The write in flight, so writes to one file never overlap. */
  writing: Promise<void>;
};

const MAX_PAGE_ID_CHARS = 128;
const WRITE_DELAY_MS = 1000;

export class DesignCanvasViews {
  private readonly root?: () => string;
  private readonly writeJson: (file: string, value: unknown) => Promise<void>;
  private readonly writeDelayMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly workspaces = new Map<string, Workspace>();
  /** Workspaces removed in this run: their views are never written again. */
  private readonly removed = new Set<string>();
  private readonly presenceListeners = new Set<(workspaceId: string, visibleCount: number) => void>();
  /** The visible count each workspace last announced. */
  private readonly announced = new Map<string, number>();

  /** Without `root` the views live in memory only (tests). */
  constructor(
    options: {
      root?: () => string;
      writeJson?: (file: string, value: unknown) => Promise<void>;
      writeDelayMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    this.root = options.root;
    this.writeJson =
      options.writeJson ?? ((file, value) => writeJsonAtomic(file, value, { mode: 0o600, mkdirMode: 0o700 }));
    this.writeDelayMs = options.writeDelayMs ?? WRITE_DELAY_MS;
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * A mounted canvas's report of its view. `focusId` is the highest Aiden page
   * change that canvas has seen; a report behind main's is not taken as the
   * view, though it still says the canvas is open.
   */
  async report(
    chatId: string,
    workspaceId: string,
    view: DesignChatView,
    focusId: number,
    visible = false,
    windowShown?: () => boolean,
  ): Promise<void> {
    const workspace = await this.workspace(workspaceId);
    const entry = workspace.entries.get(chatId);
    if (entry && focusId < entry.focusId) {
      entry.mounted = true;
      entry.visible = visible;
      if (windowShown) entry.windowShown = windowShown;
      this.announce(workspaceId);
      return;
    }
    const next: Entry = entry ?? { pageId: view.pageId, viewports: new Map(), focusId: 0, mounted: true, visible };
    next.pageId = view.pageId;
    remember(next, view.pageId, view.viewport);
    next.focusId = Math.max(next.focusId, focusId);
    next.mounted = true;
    next.visible = visible;
    if (windowShown) next.windowShown = windowShown;
    if (view.size) next.size = { ...view.size };
    else delete next.size;
    workspace.entries.set(chatId, next);
    this.changed(workspaceId, workspace);
    this.announce(workspaceId);
  }

  /** The chat's canvas unmounted. Its page is kept. */
  unmount(chatId: string): void {
    for (const [workspaceId, workspace] of this.workspaces) {
      const entry = workspace.entries.get(chatId);
      if (!entry) continue;
      entry.mounted = false;
      entry.visible = false;
      this.announce(workspaceId);
    }
  }

  /** How many chats show this workspace's canvas right now: mounted, its pane shown and its window shown. */
  visible(workspaceId: string): number {
    let count = 0;
    for (const entry of this.workspaces.get(workspaceId)?.entries.values() ?? []) {
      if (entry.mounted && entry.visible && (entry.windowShown?.() ?? true)) count += 1;
    }
    return count;
  }

  /** A window was minimized, restored, hidden or shown: every workspace's count is announced again if it changed. */
  windowChanged(): void {
    for (const workspaceId of this.workspaces.keys()) this.announce(workspaceId);
  }

  /** Hears a workspace's visible count whenever it changes. */
  onPresence(listener: (workspaceId: string, visibleCount: number) => void): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }

  private announce(workspaceId: string): void {
    const count = this.visible(workspaceId);
    if ((this.announced.get(workspaceId) ?? 0) === count) return;
    if (count === 0) this.announced.delete(workspaceId);
    else this.announced.set(workspaceId, count);
    for (const listener of this.presenceListeners) {
      try {
        listener(workspaceId, count);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /**
   * Aiden shows `pageId` to the chat: from now on its tools read that page,
   * whether or not a canvas is open, looked at from where the chat last looked
   * at it. Returns the change's `focusId`. With `stillOwned`, it is asked
   * after the views load and right before the change, which is synchronous:
   * false keeps nothing and answers undefined (the chat left the workspace).
   */
  showPage(chatId: string, workspaceId: string, pageId: string): Promise<number>;
  showPage(chatId: string, workspaceId: string, pageId: string, stillOwned: () => Promise<boolean>): Promise<number | undefined>;
  async showPage(chatId: string, workspaceId: string, pageId: string, stillOwned?: () => Promise<boolean>): Promise<number | undefined> {
    const workspace = await this.workspace(workspaceId);
    if (stillOwned && !(await stillOwned())) return undefined;
    const entry: Entry = workspace.entries.get(chatId) ?? { pageId, viewports: new Map(), focusId: 0, mounted: false, visible: false };
    entry.pageId = pageId;
    entry.focusId += 1;
    workspace.entries.set(chatId, entry);
    this.changed(workspaceId, workspace);
    return entry.focusId;
  }

  /** The chat's view: its page, where it looks there, and the canvas's size when one is open. */
  async get(chatId: string, workspaceId: string): Promise<DesignChatView | undefined> {
    const entry = (await this.workspace(workspaceId)).entries.get(chatId);
    if (!entry) return undefined;
    return {
      pageId: entry.pageId,
      viewport: { ...(entry.viewports.get(entry.pageId) ?? DESIGN_FRESH_VIEWPORT) },
      ...(entry.size ? { size: { ...entry.size } } : {}),
    };
  }

  /** Where the chat last looked at each page it has looked at. */
  async viewports(chatId: string, workspaceId: string): Promise<Map<string, DesignViewport>> {
    const entry = (await this.workspace(workspaceId)).entries.get(chatId);
    return new Map([...(entry?.viewports ?? [])].map(([pageId, viewport]) => [pageId, { ...viewport }]));
  }

  /** The kept view and the latest `focusId`, for a canvas that is mounting. */
  async kept(chatId: string, workspaceId: string): Promise<DesignKeptView | undefined> {
    const entry = (await this.workspace(workspaceId)).entries.get(chatId);
    if (!entry) return undefined;
    return {
      pageId: entry.pageId,
      viewport: { ...(entry.viewports.get(entry.pageId) ?? DESIGN_FRESH_VIEWPORT) },
      focusId: entry.focusId,
      viewports: Object.fromEntries([...entry.viewports].map(([pageId, viewport]) => [pageId, { ...viewport }])),
    };
  }

  /** The pages every other chat on the workspace was last on, whether or not its canvas is open. */
  async pageIdsOf(workspaceId: string, exceptChatId: string): Promise<Set<string>> {
    const pageIds = new Set<string>();
    for (const [chatId, entry] of (await this.workspace(workspaceId)).entries) {
      if (chatId !== exceptChatId) pageIds.add(entry.pageId);
    }
    return pageIds;
  }

  /** How many chats have this workspace's canvas open. */
  mounted(workspaceId: string): number {
    let count = 0;
    for (const entry of this.workspaces.get(workspaceId)?.entries.values() ?? []) if (entry.mounted) count += 1;
    return count;
  }

  /** The window went away, reloaded or crashed: no canvas is open, and every page is kept. */
  unmountAll(): void {
    for (const [workspaceId, workspace] of this.workspaces) {
      for (const entry of workspace.entries.values()) {
        entry.mounted = false;
        entry.visible = false;
      }
      this.announce(workspaceId);
    }
  }

  /** The chat was deleted: its view leaves the workspace's file. */
  async forget(chatId: string, workspaceId: string): Promise<void> {
    const workspace = await this.workspace(workspaceId);
    if (workspace.entries.delete(chatId)) this.changed(workspaceId, workspace);
    for (const [otherId, other] of this.workspaces) {
      other.entries.delete(chatId);
      this.announce(otherId);
    }
  }

  /** The workspace was removed: its views file goes, and is never written again. */
  async removeWorkspace(workspaceId: string): Promise<void> {
    assertDesignCanvasWorkspaceId(workspaceId);
    this.removed.add(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      if (workspace.timer) clearTimeout(workspace.timer);
      workspace.dirty = false;
      await workspace.writing;
    }
    this.workspaces.delete(workspaceId);
    this.announce(workspaceId);
    if (this.root) await rm(this.file(workspaceId), { force: true });
  }

  /** Writes every pending change now (tests, quit). */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.workspaces].map(([workspaceId, workspace]) => {
        if (workspace.timer) clearTimeout(workspace.timer);
        workspace.timer = undefined;
        return this.write(workspaceId, workspace);
      }),
    );
  }

  private async workspace(workspaceId: string): Promise<Workspace> {
    assertDesignCanvasWorkspaceId(workspaceId);
    let workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      const entries = new Map<string, Entry>();
      workspace = { entries, loaded: this.load(workspaceId, entries), dirty: false, writing: Promise.resolve() };
      this.workspaces.set(workspaceId, workspace);
    }
    await workspace.loaded;
    return workspace;
  }

  private async load(workspaceId: string, into: Map<string, Entry>): Promise<void> {
    if (!this.root || this.removed.has(workspaceId)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file(workspaceId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error);
      return;
    }
    if (!isRecord(raw)) return;
    for (const [chatId, value] of Object.entries(raw)) {
      const entry = parseStoredEntry(value);
      // A view the person changed while the file loaded is newer than the file.
      if (isDesignChatId(chatId) && entry && !into.has(chatId)) into.set(chatId, entry);
    }
  }

  private changed(workspaceId: string, workspace: Workspace): void {
    if (!this.root || this.removed.has(workspaceId)) return;
    workspace.dirty = true;
    if (workspace.timer) return;
    workspace.timer = setTimeout(() => {
      workspace.timer = undefined;
      void this.write(workspaceId, workspace);
    }, this.writeDelayMs);
    workspace.timer.unref?.();
  }

  private write(workspaceId: string, workspace: Workspace): Promise<void> {
    workspace.writing = workspace.writing.then(async () => {
      if (!this.root || !workspace.dirty || this.removed.has(workspaceId)) return;
      workspace.dirty = false;
      const stored: Record<string, { pageId: string; viewports: Record<string, DesignViewport>; focusId: number }> = {};
      for (const [chatId, entry] of workspace.entries) {
        stored[chatId] = { pageId: entry.pageId, viewports: Object.fromEntries(entry.viewports), focusId: entry.focusId };
      }
      try {
        await this.writeJson(this.file(workspaceId), stored);
      } catch (error) {
        workspace.dirty = true;
        this.onError(error);
      }
    });
    return workspace.writing;
  }

  private file(workspaceId: string): string {
    return path.join(this.root!(), `${workspaceId}.json`);
  }
}

/**
 * The page a chat's Aiden turn works on, resolved the same way everywhere in
 * the turn (tools, auto-placed pages and images, the prompt line), in order:
 * a page Aiden showed earlier in this turn, the page the person's message was
 * sent from, the chat's kept page, the chat's own page (`chatPages`), then
 * the first page. Each counts only while the page exists. The renderer's
 * canvas falls back in the same order (`useDesignView`). Background and entry
 * placements use it without a message.
 */
export type DesignTurnPages = {
  /**
   * Reads what main keeps for the chat in `workspaceId` once, and answers the
   * turn's view for any version of the document without waiting, so a store
   * update's mutate can use it on the latest document.
   */
  resolver(workspaceId: string): Promise<(doc: Pick<DesignCanvas, "pages" | "chatPages">) => DesignChatView>;
  /** The chat's view for this turn, on a page that exists in `doc`. */
  view(doc: Pick<DesignCanvas, "pages" | "chatPages">, workspaceId: string): Promise<DesignChatView>;
  /**
   * Aiden shows `pageId`: later calls in the turn work on it. The change's
   * `focusId`, when main keeps views. With `stillOwned`, nothing is kept when
   * it answers false just before the change.
   */
  show(workspaceId: string, pageId: string, stillOwned?: () => Promise<boolean>): Promise<number | undefined>;
};

export function designTurnPages(options: {
  views?: Pick<DesignCanvasViews, "get" | "viewports" | "showPage">;
  chatId: string;
  message?: DesignViewState;
}): DesignTurnPages {
  let shown: string | undefined;
  const resolver: DesignTurnPages["resolver"] = async (workspaceId) => {
    const kept = await options.views?.get(options.chatId, workspaceId);
    const viewports = (await options.views?.viewports(options.chatId, workspaceId)) ?? new Map<string, DesignViewport>();
    return (doc) => {
      const exists = (pageId: string | undefined): pageId is string =>
        pageId !== undefined && doc.pages.some((page) => page.id === pageId);
      const claim = Object.prototype.hasOwnProperty.call(doc.chatPages, options.chatId)
        ? doc.chatPages[options.chatId]
        : undefined;
      const pageId = [shown, options.message?.pageId, kept?.pageId, claim].find(exists) ?? doc.pages[0]!.id;
      const size = options.message?.viewSize ?? kept?.size;
      return {
        pageId,
        viewport: { ...(viewports.get(pageId) ?? DESIGN_FRESH_VIEWPORT) },
        ...(size ? { size: { ...size } } : {}),
      };
    };
  };
  return {
    resolver,
    async view(doc, workspaceId) {
      return (await resolver(workspaceId))(doc);
    },
    async show(workspaceId, pageId, stillOwned) {
      shown = pageId;
      return stillOwned
        ? options.views?.showPage(options.chatId, workspaceId, pageId, stillOwned)
        : options.views?.showPage(options.chatId, workspaceId, pageId);
    },
  };
}

function remember(entry: Entry, pageId: string, viewport: DesignViewport): void {
  entry.viewports.delete(pageId);
  entry.viewports.set(pageId, { ...viewport });
  while (entry.viewports.size > DESIGN_CANVAS_LIMITS.pages) {
    entry.viewports.delete(entry.viewports.keys().next().value!);
  }
}

function parseStoredEntry(value: unknown): Entry | null {
  if (!isRecord(value)) return null;
  const { pageId, focusId } = value;
  if (typeof pageId !== "string" || pageId.length === 0 || pageId.length > MAX_PAGE_ID_CHARS) return null;
  const entry: Entry = {
    pageId,
    viewports: new Map(),
    focusId: typeof focusId === "number" && Number.isSafeInteger(focusId) && focusId >= 0 ? focusId : 0,
    mounted: false,
    visible: false,
  };
  if (isRecord(value.viewports)) {
    for (const [page, raw] of Object.entries(value.viewports)) {
      const viewport = parseDesignViewport(raw);
      if (viewport && page.length > 0 && page.length <= MAX_PAGE_ID_CHARS) remember(entry, page, viewport);
    }
  }
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
