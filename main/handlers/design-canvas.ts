// IPC for the design canvas. A canvas belongs to a workspace and is shared by
// its chats, but every handler takes the asking chat's id: that chat is the
// authority check (an attended chat, and design mode where a handler needs
// it), and the workspace is the one that chat is in. Registered only while
// design mode is on (it is, unless AIDEN_DESIGN_MODE=0), and every handler
// re-checks it the way `chats:setDesignMode` does.

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as fs from "node:fs/promises";
import {
  DESIGN_CANVAS_LIMITS,
  isAppRouteKey,
  isDesignRelativePath,
  type DesignCanvas,
  type DesignFrame,
  type DesignPaper,
  type DesignPrintMode,
} from "../../renderer/shared/design-canvas/schema.js";
import {
  DESIGN_EXPORT_FORMATS,
  designExportFileName,
  designExportFormats,
  designExportWidth,
  type DesignExportFormat,
} from "../../renderer/shared/design-canvas/frame-export.js";
import { designUrl } from "../../renderer/shared/design-canvas/url.js";
import {
  bakeDesignTweakDefaults,
  designTweakState,
  parseDesignTweakValues,
  withDesignTweakQuery,
} from "../../renderer/shared/design-canvas/tweaks.js";
import {
  DESIGN_TEXT_EDIT_LIMITS,
  planDesignTextEdit,
  type DesignTextChange,
} from "../../renderer/shared/design-canvas/text-edit.js";
import { canvasView, parseDesignViewState } from "../../renderer/shared/design-canvas/canvas-summary.js";
import { parseDesignChatView, type DesignChatView } from "../../renderer/shared/design-canvas/view.js";
import { placeFrame, refitGroups } from "../../renderer/shared/design-canvas/placement.js";
import { isHtmlArtifactMediaId } from "../../renderer/shared/generative-ui.js";
import { isWorkspaceArtifactWorkspaceId } from "../../renderer/shared/workspace-artifacts.js";
import { ARTIFACT_FRAME_BOX } from "../services/design-canvas/artifact-frames.js";
import type { DesignGrantRegistry } from "../services/design-canvas/grants.js";
import { readCanvasConfig } from "../services/design-canvas/canvas-config.js";
import { locateDesignMd, type DesignAppRoots } from "../services/design-canvas/design-md/locate.js";
import type { DesignMdReader, DesignMdSummary } from "../services/design-canvas/design-md/reader.js";
import { checkedAppRoot } from "../services/design-canvas/design-md/tool.js";
import { designTurnPages, type DesignCanvasViews } from "../services/design-canvas/views.js";
import { validateGenerativeUiHtml } from "../services/generative-ui-html.js";
import { replaceWorkspaceText } from "../services/design-canvas/text-write.js";
import { resolveDesignFile } from "../services/design-canvas/resolve-core.js";
import type { DesignFileWatcher } from "../services/design-canvas/watch.js";
import { isPathInside } from "../shared/path-containment.js";
import {
  assertDesignCanvasChatId,
  DESIGN_CANVAS_UPDATED_CHANNEL,
  type DesignCanvasSaveResult,
  type DesignCanvasUpdated,
  type DesignChatCanvases,
} from "../services/design-canvas/store.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { appFrameName } from "../../renderer/shared/design-canvas/app-frame.js";
import {
  DESIGN_APP_FRAME_MOUNT_CHANNEL,
  type DesignAppFrameMountResult,
} from "../../renderer/shared/design-canvas/app-frame-events.js";
import type { DesignAppsSnapshot } from "../../renderer/shared/design-app.js";
import { APP_DEFAULT_SCALE, APP_DEFAULT_VIEWPORT, appFrameBox, fitAppScale, isAppRoot, isAppViewportSide } from "../../renderer/shared/design-canvas/app-frame.js";
import { APP_DEVICES, isAppDevice } from "../../renderer/shared/design-canvas/app-devices.js";
import { placeAppVariant, variantRootOf } from "../../renderer/shared/design-canvas/app-variants.js";
import { isConcreteRoute, type AppRouteList } from "../../renderer/shared/design-canvas/app-routes.js";
import type { DesignAppRoutesResult } from "../services/design-canvas/app-server/app-server-main.js";
import type { AppFrameRegistry } from "../services/design-canvas/app-frames/app-frame-registry.js";
import type { ChatMeta, WorkspacePermission } from "../services/types.js";
import { realpath, rmdir } from "node:fs/promises";
import { commentsWithoutFrames } from "../../renderer/shared/design-canvas/comments.js";
import { syncConnectors } from "../../renderer/shared/design-canvas/connectors.js";
import {
  ownerOf,
  pagePath,
  relativeImportsMoved,
  rewriteTanstackLiteral,
  specialFilesLost,
  tanstackRouteId,
  variantBase,
  variantPathCandidates,
  workspaceRelPath,
  type AppPageRefusal,
  type OwnerFile,
} from "../services/design-canvas/app-server/app-page-files-core.js";
import {
  confinedTarget,
  readRegularFileBytes,
  routeFiles,
  writeConfinedFile,
  type PageFileFs,
  type RouteFileWalk,
} from "../services/design-canvas/app-server/app-page-files.js";
import { routeFromFile } from "../services/design-canvas/app-server/app-routes-core.js";
import { routeFs } from "../services/design-canvas/app-server/app-routes.js";
import { PageFileLedger, pageDigest, type PageFileOutcome } from "../services/design-canvas/app-page-ledger.js";
import type { FrameworkId } from "../../renderer/shared/design-app.js";

export { DESIGN_CANVAS_UPDATED_CHANNEL, type DesignCanvasUpdated };

/** The chat fields the canvas handlers decide on. */
export type DesignCanvasChat = Pick<
  ChatMeta,
  "id" | "workspaceId" | "designMode" | "botId" | "owner"
>;

/**
 * `designCanvas:placeArtifact` reply. `already` names the frame that shows the
 * visual and, when it was on another page, that page's name (the canvas now
 * shows that page); `missing` means the chat no longer has it, `unsafe` that
 * its HTML no longer passes the visual checks, and `full` that the canvas
 * holds no more frames.
 */
export type DesignCanvasPlaceArtifactResult =
  | { status: "placed"; frameId: string }
  | { status: "already"; frameId: string; page?: string }
  | { error: "missing" | "unsafe" | "full" };

/** `designCanvas:appRoutes` reply (3b, S87): the workspace's apps and one app's routes. */
export type DesignCanvasAppRoutesResult =
  | { apps: { appRoot: string; label: string }[]; appRoot: string; list: AppRouteList }
  | { error: "unavailable" | "no-app" };

/** `designCanvas:placeAppRoute` reply (3b, S87). */
export type DesignCanvasPlaceAppRouteResult =
  | { placed: string; pageId: string }
  | { already: string; pageId: string }
  | { error: "unavailable" | "bad-route" | "unknown-root" | "full" };

/** `designCanvas:addAppView` reply (3c, S93): the new view of a page, beside its set. */
export type DesignCanvasAddAppViewResult =
  | { placed: string; pageId: string }
  | { error: "unavailable" | "not-found" | "locked" | "full" | "bad-size" };

/** `designCanvas:appPageVariant` reply (3c, S95). `kept` says a copy written before the canvas refused stays on disk, because it changed. */
export type DesignCanvasAppPageVariantResult =
  | { placed: string; pageId: string; route: string; file: string }
  | { error: "unavailable" | "not-found" | "locked" | "full" | "io" | AppPageRefusal; kept?: string };

/** `designCanvas:appPageTrash` reply (3c, S96). `restore: "failed"` means the file is in the Trash though the canvas kept its frames. */
export type DesignCanvasAppPageTrashResult =
  | { trashed: string; route: string; removed: string[]; revision: number }
  | { error: "unavailable" | "not-found" | "locked" | "io" | AppPageRefusal; restore?: "failed" };

/** 3c (S97): the ledger's outcomes, broadcast to every window; each shows only its own chat's. */
export const DESIGN_PAGE_FILE_CHANNEL = "designCanvas:pageFile";
export type { PageFileOutcome };

/** `designCanvas:grant` reply: an `aiden-design://<grant>/` host, or no access. */
export type DesignCanvasGrantResult = { grant: string } | { error: "unavailable" };

/** The parts of Electron's NativeImage a frame snapshot uses. */
export interface DesignCanvasCaptureImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality?: "good" | "better" | "best" }): DesignCanvasCaptureImage;
  /** A `data:image/png;base64,` URL. */
  toDataURL(): string;
}

/** The asking window's page, as `designCanvas:capture` sees it. */
export interface DesignCanvasCaptureWindow {
  /** Content width and height in window points (device-independent pixels). */
  getContentSize(): number[];
  /** The page's zoom; a CSS pixel covers this many window points. */
  getZoomFactor?(): number;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<DesignCanvasCaptureImage>;
}

/** `designCanvas:capture` reply. */
export type DesignCanvasCaptureResult = { dataUrl: string } | { error: "unavailable" };

/** What `designCanvas:pickFile` may add: a page or an image. */
export type DesignCanvasPickKind = "file" | "image";

/** How the open dialog is shown: in the workspace folder, for one kind of file. */
export type DesignCanvasPickOptions = {
  defaultPath: string;
  kind: DesignCanvasPickKind;
  filters: Array<{ name: string; extensions: string[] }>;
};

/** `designCanvas:pickFile` reply: a workspace-relative path, or why there is none. */
export type DesignCanvasPickResult =
  | { path: string }
  | { cancelled: true }
  | { error: "outside-workspace" | "unsupported" | "unavailable" };

const PICK_EXTENSIONS: Readonly<Record<DesignCanvasPickKind, readonly string[]>> = {
  file: ["html", "htm"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
};
const PICK_FILTER_NAMES: Readonly<Record<DesignCanvasPickKind, string>> = {
  file: "Web pages",
  image: "Images",
};

/**
 * `designCanvas:designSystem` reply (S41, R9): the app's DESIGN.md state with
 * at most 50 findings, or `unavailable`. Read only; it sends no event.
 */
export type DesignCanvasDesignSystemResult =
  | {
      status: string;
      appRoot: string;
      path?: string;
      summary?: DesignMdSummary;
      sections?: string[];
      findings?: { severity: string; rule?: string; path?: string; message: string }[];
    }
  | { error: "unavailable" };

const DESIGN_SYSTEM_MAX_FINDINGS = 50;

/** `designCanvas:export` reply. */
export type DesignCanvasExportResult =
  | { saved: true }
  | { canceled: true }
  /** `app-not-running` and `live-off` are a live app frame's (design mode v2 Phase 3a, D18). */
  | { error: "unavailable" | "missing" | "failed" | "app-not-running" | "live-off" };

/**
 * What a live app frame's Download draws (D18): main's own address for it
 * (the running app's origin plus the frame's route), at its viewport.
 */
export type DesignAppRenderRequest = {
  url: string;
  origin: string;
  width: number;
  height: number;
  format: "png" | "pdf";
  colorScheme?: "light" | "dark";
};

/** `designCanvas:source` reply: a page's or artifact's code, for the side panel's Code tab. */
export type DesignCanvasSourceResult =
  | { text: string; truncated: boolean }
  | { error: "unavailable" | "missing" };

/** The most of a file the Code tab shows. */
export const DESIGN_SOURCE_MAX_BYTES = 512 * 1024;

/** `designCanvas:editText` reply: the words were written into the page's file, or why not. */
/** Runs one task per file at a time, in the order they arrive. */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const before = fileLocks.get(file) ?? Promise.resolve();
  const run = before.then(task, task);
  const settled = run.catch(() => undefined);
  fileLocks.set(file, settled);
  void settled.then(() => {
    if (fileLocks.get(file) === settled) fileLocks.delete(file);
  });
  return run;
}

export type DesignCanvasFileRewriteFailure =
  | "unavailable"
  | "missing"
  | "not-found"
  | "ambiguous"
  | "unchanged"
  | "too-long"
  | "changed"
  | "words";

export type DesignCanvasEditTextResult = { ok: true } | { ok: false; reason: DesignCanvasFileRewriteFailure };

/**
 * `designCanvas:bakeTweaks` reply: `kept` names the targets whose words couldn't be placed in the page,
 * and `undoId` names this Make default, so its Undo can't undo a later one.
 */
export type DesignCanvasBakeTweaksResult =
  | { ok: true; written: Record<string, string>; previous: Record<string, string>; kept: string[]; undoId: string }
  | { ok: false; reason: DesignCanvasFileRewriteFailure };

/** What the hidden export window draws: a page at its width, as a picture or a PDF. */
export type DesignFrameRenderRequest = {
  url: string;
  width: number;
  format: "png" | "pdf";
  paper?: DesignPaper;
  printMode?: DesignPrintMode;
};

/** How the save dialog is shown for an export. */
export type DesignCanvasSaveOptions = {
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
};

const EXPORT_FILTERS: Readonly<Record<"png" | "pdf", { name: string; extensions: string[] }>> = {
  png: { name: "PNG image", extensions: ["png"] },
  pdf: { name: "PDF", extensions: ["pdf"] },
};

/** A frame snapshot's longest side, in pixels. */
export const DESIGN_CAPTURE_MAX_SIDE = 1024;

const UNAVAILABLE = "Design mode is not available.";

function isKeyList(value: unknown, isKey: (entry: string) => boolean): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= DESIGN_CANVAS_LIMITS.frames &&
      value.every((entry) => typeof entry === "string" && isKey(entry)))
  );
}

/**
 * A save's options: the pages and app routes it says the person's undo took
 * off, and the workspace whose canvas the renderer is saving. Anything
 * malformed is refused.
 */
function saveOptions(options: unknown): { undone: string[]; undoneRoutes: string[]; workspaceId: string } {
  // The workspace is required: without it a stale canvas from a workspace the
  // chat has left could replace the new one whenever their revisions match.
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error("Invalid canvas save options.");
  const { undone, undoneRoutes, workspaceId } = options as { undone?: unknown; undoneRoutes?: unknown; workspaceId?: unknown };
  if (!isKeyList(undone, isDesignRelativePath) || !isKeyList(undoneRoutes, isAppRouteKey)) {
    throw new Error("Invalid canvas save options.");
  }
  if (!isWorkspaceArtifactWorkspaceId(workspaceId)) {
    throw new Error("Invalid canvas save options.");
  }
  return { undone: undone ?? [], undoneRoutes: undoneRoutes ?? [], workspaceId };
}

/** The workspace whose canvas a chat works on. */
/** A `designCanvas:view` report, checked; anything malformed is refused. */
function parseViewReport(
  value: unknown,
): "unmounted" | { workspaceId: string; view: DesignChatView; focusId: number; visible: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid canvas view.");
  const raw = value as Record<string, unknown>;
  if (raw.mounted === false && Object.keys(raw).length === 1) return "unmounted";
  const { workspaceId, focusId } = raw;
  if (!isWorkspaceArtifactWorkspaceId(workspaceId)) throw new Error("Invalid canvas view.");
  if (typeof focusId !== "number" || !Number.isSafeInteger(focusId) || focusId < 0) throw new Error("Invalid canvas view.");
  const view = parseDesignChatView(raw.view);
  if (!view) throw new Error("Invalid canvas view.");
  // A report without `visible` (an older renderer) is a hidden canvas, so it never keeps a live app running.
  if (raw.visible !== undefined && typeof raw.visible !== "boolean") throw new Error("Invalid canvas view.");
  return { workspaceId, view, focusId, visible: raw.visible === true };
}

export function designCanvasWorkspaceOf(chat: Pick<DesignCanvasChat, "workspaceId">): string {
  return persistedChatWorkspaceId(chat.workspaceId);
}

export function registerDesignCanvasHandlers<Event>(deps: {
  enabled: () => boolean;
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  store: Pick<DesignChatCanvases, "get" | "save" | "update">;
  broadcast(update: DesignCanvasUpdated): void;
  getChat(chatId: string): Promise<DesignCanvasChat | null>;
  grants: Pick<DesignGrantRegistry, "issue" | "revokeChat">;
  /** Each chat's view of its canvas, as the renderer reports it. */
  views: Pick<DesignCanvasViews, "report" | "unmount" | "kept" | "unmountAll" | "get" | "viewports" | "showPage" | "windowChanged">;
  /**
   * Calls `reset` whenever the window that sent `event` reloads, crashes or is
   * destroyed, since every canvas in it is then gone; called for every view report.
   */
  whenSenderResets?(event: Event, reset: () => void): void;
  /**
   * Whether the sender's window is shown (not minimized or hidden), for 2b's
   * presence; `changed` runs whenever that may have changed.
   */
  senderWindowShown?(event: Event, changed: () => void): () => boolean;
  /** Sends `designCanvas:focus` to the window that sent `event`, if it is still there. */
  sendFocus?(event: Event, request: { chatId: string; pageId: string; frameIds: string[]; focusId: number; own?: true }): void;
  /** The chat's workspace folder, or null when the chat has no folder to frame. */
  workspaceRoot(chat: DesignCanvasChat): Promise<string | null>;
  /** The window that sent `event`, or null when it has none (or it is gone). */
  windowFor(event: Event): DesignCanvasCaptureWindow | null;
  watcher: Pick<DesignFileWatcher, "set" | "clear" | "ownWrite">;
  /** Shows the open dialog over the asking window; the chosen absolute path, or null. */
  pickFile(event: Event, options: DesignCanvasPickOptions): Promise<string | null>;
  /** Shows the save dialog over the asking window; the chosen absolute path, or null. */
  saveFile(event: Event, options: DesignCanvasSaveOptions): Promise<string | null>;
  /** Draws a page in a hidden window and returns the PNG or PDF bytes. */
  renderFrame(request: DesignFrameRenderRequest): Promise<Uint8Array>;
  /** An artifact's preview address, or undefined when it is gone. */
  artifactPreview(chatId: string, mediaId: string, theme?: unknown): Promise<{ src: string } | undefined>;
  /** Saves an artifact as a standalone HTML file through its own save dialog. */
  exportArtifactSource(event: Event, chatId: string, mediaId: string): Promise<{ saved: boolean; canceled: boolean }>;
  /** An artifact's own HTML, or undefined when it is gone. */
  artifactHtml(chatId: string, mediaId: string): Promise<string | undefined>;
  /** An artifact's title, or undefined when this chat has no such artifact. */
  artifactTitle(chatId: string, mediaId: string): Promise<string | undefined>;
  /** New frame ids; tests pin them. */
  newId?: () => string;
  /**
   * DESIGN.md reads for `designCanvas:designSystem`, behind the live flag
   * (`enabled`). Left out, the channel answers `unavailable`.
   */
  designMd?: {
    enabled(): boolean;
    reader: Pick<DesignMdReader, "read">;
    appRoots: DesignAppRoots;
  };
  /**
   * Live app frames (design mode v2 Phase 3a, D2, D16), behind the live flag.
   * Left out, or off, `designCanvas:appFrameMount` answers `live-off`.
   */
  appFrames?: {
    enabled(): boolean;
    /** The frame registry, or null before the design subscribers are installed. */
    registry(): Pick<AppFrameRegistry, "expectPlacement"> | null;
    /**
     * Resolves once no service-worker clear of `origin` is queued or running
     * (S76): a frame is told its origin only after, so its page never loads
     * mid-clear. Left out, there's nothing to wait for.
     */
    clearSettled?(origin: string): Promise<void>;
    /** Draws a live app frame on the default session (app-export.ts); left out, Download answers unavailable. */
    renderApp?(request: DesignAppRenderRequest): Promise<Uint8Array>;
    apps: {
      snapshot(workspaceId: string): Promise<DesignAppsSnapshot>;
      /** 2b/2c's exact-address lookup; undefined while a holder is lost. */
      appForOrigin(origin: string): { workspaceId: string; appRoot: string } | undefined;
      /** 3b (S81): an app root's routes, for Add ▸ Page from app…. Left out, the picker is unavailable. */
      routes?(workspaceId: string, appRoot?: string): Promise<DesignAppRoutesResult>;
    };
    /** 3b (S88, call site 4): each app frame the person's Add placed. */
    onAppFrameAdded?(viewportWidth: number): void;
    /** 3c (S96): moves a file to the Trash. Left out, Duplicate page as variant and Move page file to Trash are unavailable. */
    trash?(absolute: string): Promise<void>;
    /** 3c (S97): sends a page-file outcome on `designCanvas:pageFile`. */
    broadcastPageFile?(outcome: PageFileOutcome): void;
  };
  /**
   * 3c (S99): the chat's workspace folder and its permission, for the page-file
   * actions. Left out, they are unavailable.
   */
  workspaceAccess?(chat: DesignCanvasChat): Promise<{ root: string; permission: WorkspacePermission | "read-only" } | null>;
  /** 3c: parts of the page-file writes a test replaces (a case-insensitive volume). */
  pageFs?: Partial<PageFileFs>;
}): void {
  if (!deps.enabled()) return;

  // Only an attended desktop chat has a canvas: Bot and routine chats never
  // enter design mode, so they never get a canvas file either.
  const attended = (chat: DesignCanvasChat): boolean => !chat.botId && !chat.owner;
  /**
   * Each frame's last Make default, by chat and frame, for its Undo: the file
   * before, and a hash of what was written to tell whether it changed since.
   * Only the most recent few are kept; an older Undo finds nothing to put back.
   */
  const tweakDefaultsUndo = new Map<string, { id: string; before: string; after: string }>();
  const TWEAK_UNDO_LIMIT = 16;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");

  // Reading and saving do not require design mode to still be on: turning it
  // off unmounts the canvas, and the edit that unmount flushes may land after
  // the flag has cleared. Framing workspace files (`canFrame`) does require it.
  const requireChat = async (chatId: unknown): Promise<DesignCanvasChat> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    const chat = await deps.getChat(chatId);
    if (!chat) throw new Error("This chat is no longer available.");
    if (!attended(chat)) throw new Error(UNAVAILABLE);
    return chat;
  };

  // ── 3c (S95–S97, S99): the person's page-file actions ──

  /** A workspace permission that lets the person's actions write files. */
  const writable = (permission: WorkspacePermission | "read-only"): boolean => permission !== "none" && permission !== "read-only";

  /**
   * The chat's workspace folder as its real path, when it may still be written:
   * `read-only` for a permission that can't, null when there's no folder.
   */
  const writableWorkspace = async (chat: DesignCanvasChat): Promise<{ real: string } | "read-only" | null> => {
    const access = await deps.workspaceAccess?.(chat);
    if (!access) return null;
    if (!writable(access.permission)) return "read-only";
    try {
      return { real: await realpath(access.root) };
    } catch {
      return null;
    }
  };

  /**
   * The ledger, when this build can trash files. Its gate is the person's own:
   * an attended chat in design mode, in the same workspace, whose folder is
   * still that real path and still writable.
   */
  const pageTrash = deps.appFrames?.trash;
  const pageLedger = pageTrash
    ? new PageFileLedger({
        lock: (absolute, task) => withFileLock(absolute, task),
        canAct: async (chatId, workspaceId, workspaceRoot) => {
          if (!deps.appFrames?.enabled()) return false;
          const chat = await deps.getChat(chatId);
          if (!canFrame(chat) || designCanvasWorkspaceOf(chat) !== workspaceId) return false;
          const folder = await writableWorkspace(chat);
          return typeof folder === "object" && folder !== null && folder.real === workspaceRoot;
        },
        target: (workspaceRoot, file) => confinedTarget(workspaceRoot, file, { create: false, ...(deps.pageFs ? { fs: deps.pageFs } : {}) }),
        read: (absolute) => readRegularFileBytes(absolute, DESIGN_SOURCE_MAX_BYTES),
        trash: (absolute) => pageTrash(absolute),
        write: (workspaceRoot, file, bytes, mode, create) =>
          writeConfinedFile(workspaceRoot, file, bytes, mode, { create, ...(deps.pageFs ? { fs: deps.pageFs } : {}) }),
        removeEmptyFolder: async (dir) => {
          await (deps.pageFs?.rmdir ?? rmdir)(dir);
        },
        notify: (outcome) => {
          try {
            deps.appFrames?.broadcastPageFile?.(outcome);
          } catch {
            // A lost notice never changes what was done.
          }
        },
      })
    : undefined;

  deps.handle("designCanvas:get", async (_event, chatId) => {
    const chat = await requireChat(chatId);
    return (await deps.store.get(chat.id, { workspaceId: designCanvasWorkspaceOf(chat) })).doc;
  });

  // The canvas's view as the person moves around it: the workspace it shows,
  // the page on screen, where it looks and how big it is, with the highest
  // Aiden page change it has seen (`focusId`). `{mounted: false}` says the
  // canvas unmounted; that needs only a well-formed chat id, so an unmount
  // after the chat is deleted still lands. A report naming a workspace the
  // chat has left is dropped: it comes from a canvas about to remount.
  // A chat's reports are handled in the order they were sent, so the unmount
  // that follows a last report is never overtaken by it (which would leave the
  // canvas counted as open).
  const viewQueues = new Map<string, Promise<void>>();
  const inViewOrder = (chatId: string, run: () => Promise<void>): Promise<void> => {
    const next = (viewQueues.get(chatId) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    viewQueues.set(chatId, tail);
    void tail.then(() => {
      if (viewQueues.get(chatId) === tail) viewQueues.delete(chatId);
    });
    return next;
  };
  deps.handle("designCanvas:view", async (event, chatId, report) => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    const parsed = parseViewReport(report);
    if (parsed === "unmounted") {
      return inViewOrder(chatId, async () => deps.views.unmount(chatId));
    }
    return inViewOrder(chatId, async () => {
      const chat = await requireChat(chatId);
      deps.whenSenderResets?.(event, () => deps.views.unmountAll());
      if (parsed.workspaceId !== designCanvasWorkspaceOf(chat)) return;
      const windowShown = deps.senderWindowShown?.(event, () => deps.views.windowChanged());
      await deps.views.report(chat.id, parsed.workspaceId, parsed.view, parsed.focusId, parsed.visible, windowShown);
    });
  });

  // The view main kept for the chat, for a canvas that is mounting: its page,
  // where it last looked there, and the latest Aiden page change. Null when
  // main has none, and the canvas opens the first page.
  deps.handle("designCanvas:view:get", async (_event, chatId) => {
    const chat = await requireChat(chatId);
    return (await deps.views.kept(chat.id, designCanvasWorkspaceOf(chat))) ?? null;
  });

  deps.handle("designCanvas:save", async (_event, chatId, doc, baseRevision, options) => {
    if (
      typeof baseRevision !== "number" ||
      !Number.isSafeInteger(baseRevision) ||
      baseRevision < 0
    ) {
      throw new Error("Invalid canvas revision.");
    }
    const { undone, undoneRoutes, workspaceId: expected } = saveOptions(options);
    const chat = await requireChat(chatId);
    // One workspace for the whole save: the one this chat is in now.
    const workspaceId = designCanvasWorkspaceOf(chat);
    // The canvas the renderer is saving belongs to a workspace the chat has
    // since left: nothing is written, and the renderer drops those edits and
    // opens the canvas of the workspace the chat is in now.
    if (expected !== workspaceId) {
      return { ok: false, reason: "moved", workspaceId } satisfies DesignCanvasSaveResult;
    }
    const { result } = await deps.store.save(chat.id, doc as DesignCanvas, baseRevision, {
      undone,
      undoneRoutes,
      workspaceId,
      // 3c (S97): the page-file ledger reads each committed save on its own queue; the reply never waits for it.
      ...(pageLedger ? { onCommitted: (committed: DesignCanvas) => void pageLedger.reconcile(workspaceId, chat.id, committed, undoneRoutes) } : {}),
    });
    if (result.ok) deps.broadcast({ workspaceId, chatId: chat.id, revision: result.revision });
    return result;
  });

  // The person's Send to canvas on a visual in the chat: puts that visual on
  // the chat's page as a frame of their own, beside the frames in view, the
  // way Add would. It needs no design mode (the renderer turns it on after),
  // only an attended chat that still holds the visual and HTML that still
  // passes the visual checks. `options.viewSize` is the canvas's size on
  // screen, when the renderer knows it; a size that does not parse is ignored.
  const UNCHANGED = Symbol("unchanged");
  deps.handle("designCanvas:placeArtifact", async (event, chatId, mediaId, options): Promise<DesignCanvasPlaceArtifactResult> => {
    const chat = await requireChat(chatId);
    if (!isHtmlArtifactMediaId(mediaId)) throw new Error("Invalid visual.");
    const viewSize =
      typeof options === "object" && options !== null && "viewSize" in options
        ? parseDesignViewState({ selection: [], viewSize: (options as { viewSize: unknown }).viewSize })?.viewSize
        : undefined;
    const [title, html] = await Promise.all([
      deps.artifactTitle(chat.id, mediaId),
      deps.artifactHtml(chat.id, mediaId),
    ]);
    if (title === undefined || html === undefined) return { error: "missing" };
    try {
      validateGenerativeUiHtml(html);
    } catch {
      return { error: "unsafe" };
    }
    const frameTitle = title.trim().slice(0, DESIGN_CANVAS_LIMITS.titleChars) || "Visual";
    let outcome: DesignCanvasPlaceArtifactResult = { error: "full" };
    const workspaceId = designCanvasWorkspaceOf(chat);
    const pages = designTurnPages({
      views: deps.views,
      chatId: chat.id,
      ...(viewSize ? { message: { selection: [], viewSize } } : {}),
    });
    const viewOf = await pages.resolver(workspaceId);
    // A visual already placed on another page: that page is shown instead.
    let elsewhere: { pageId: string; frameId: string } | undefined;
    try {
      const saved = await deps.store.update(
        chat.id,
        (doc) => {
          const view = viewOf(doc);
          const existing = doc.frames.find(
            (frame) => frame.kind === "artifact" && frame.mediaId === mediaId && (frame.chatId ?? chat.id) === chat.id,
          );
          if (existing) {
            const page = existing.pageId === view.pageId ? undefined : doc.pages.find((entry) => entry.id === existing.pageId)?.name;
            outcome = { status: "already", frameId: existing.id, ...(page ? { page } : {}) };
            if (page) elsewhere = { pageId: existing.pageId, frameId: existing.id };
            throw UNCHANGED;
          }
          const placed = placeFrame(
            doc,
            { kind: "artifact", title: frameTitle, mediaId, chatId: chat.id, pageId: view.pageId, createdBy: "person", ...ARTIFACT_FRAME_BOX },
            canvasView(doc, view),
            deps.newId ?? randomUUID,
          );
          if ("error" in placed) {
            outcome = { error: "full" };
            throw UNCHANGED;
          }
          outcome = { status: "placed", frameId: placed.id };
          return placed.doc;
        },
        { workspaceId },
      );
      // A placed frame is the person's undo step.
      deps.broadcast({ workspaceId, chatId: chat.id, revision: saved.doc.revision, step: `send-to-canvas:${saved.doc.revision}` });
    } catch (error) {
      if (error !== UNCHANGED) throw error;
    }
    if (elsewhere) {
      // Only this chat's view moves; the shared document is unchanged.
      const focusId = await pages.show(workspaceId, elsewhere.pageId);
      if (focusId !== undefined) {
        deps.sendFocus?.(event, { chatId: chat.id, pageId: elsewhere.pageId, frameIds: [elsewhere.frameId], focusId });
      }
    }
    return outcome;
  });

  // A visual on the shared canvas belongs to the chat that made it (a frame
  // from before chats shared canvases, to the chat asking). It is read
  // through that chat, and only while it still exists and shares the asking
  // chat's workspace; otherwise null.
  const artifactOwner = async (chat: DesignCanvasChat, frame: { chatId?: string }): Promise<string | null> => {
    const ownerId = frame.chatId ?? chat.id;
    if (ownerId === chat.id) return chat.id;
    const owner = await deps.getChat(ownerId);
    // Only an attended chat's visuals: a Bot or routine chat's never show on a canvas.
    return owner && attended(owner) && designCanvasWorkspaceOf(owner) === designCanvasWorkspaceOf(chat) ? owner.id : null;
  };

  // Only an attended desktop chat in design mode may frame its own workspace
  // folder; Bot and routine chats never get a grant.
  const canFrame = (chat: DesignCanvasChat | null): chat is DesignCanvasChat =>
    chat !== null && chat.designMode === true && attended(chat);

  deps.handle("designCanvas:grant", async (_event, chatId): Promise<DesignCanvasGrantResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    const chat = await deps.getChat(chatId);
    if (!canFrame(chat)) return { error: "unavailable" };
    const root = await deps.workspaceRoot(chat);
    if (!root) return { error: "unavailable" };
    const grant = deps.grants.issue(chat.id, root);
    // Design mode may have turned off, the chat moved, or its workspace was
    // removed or re-pointed while we awaited.
    const current = await deps.getChat(chat.id);
    if (
      !canFrame(current) ||
      current.workspaceId !== chat.workspaceId ||
      (await deps.workspaceRoot(current)) !== root
    ) {
      deps.grants.revokeChat(chat.id);
      return { error: "unavailable" };
    }
    return { grant };
  });

  /**
   * The origin of the app a live frame shows, when that app root is running
   * in the chat's own workspace and main can tie the origin back to it; null
   * otherwise (stopped, elsewhere, or a lost holder).
   */
  const runningAppOrigin = async (
    live: NonNullable<typeof deps.appFrames>,
    workspaceId: string,
    appRoot: string,
  ): Promise<string | null> => {
    const snapshot = await live.apps.snapshot(workspaceId);
    const running = snapshot.apps.find(
      (app) => app.workspaceId === workspaceId && app.appRoot === appRoot && app.phase === "running" && typeof app.origin === "string",
    );
    const origin = running?.origin;
    if (!origin || !LOOPBACK_APP_ORIGIN.test(origin)) return null;
    const owner = live.apps.appForOrigin(origin);
    return owner && owner.workspaceId === workspaceId && owner.appRoot === appRoot ? origin : null;
  };

  // The app's DESIGN.md for a workspace chat, read only (S41, R9). Like
  // designCanvas:get it doesn't need design mode on; it never writes, and it
  // reads with report: false, so it sends no event.
  // Main decides the origin an app frame shows (D2, D16): the renderer names
  // the frame and a fresh token, never a URL. A running app in the chat's own
  // workspace, tied to its origin by 2b/2c's exact address check, gets a
  // one-use placement record the registry admits on the first navigation.
  const LOOPBACK_APP_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/u;
  deps.handle(DESIGN_APP_FRAME_MOUNT_CHANNEL, async (_event, chatId, request): Promise<DesignAppFrameMountResult> => {
    const live = deps.appFrames;
    if (!live || !live.enabled()) return { error: "live-off" };
    const chat = await requireChat(chatId);
    // Like a workspace file's grant, a live app needs design mode on (D2).
    if (!canFrame(chat)) return { error: "unavailable" };
    if (typeof request !== "object" || request === null) return { error: "unavailable" };
    const { frameId, mountToken } = request as { frameId?: unknown; mountToken?: unknown };
    if (typeof frameId !== "string" || typeof mountToken !== "string") return { error: "unavailable" };
    try {
      appFrameName(frameId, mountToken);
    } catch {
      return { error: "unavailable" };
    }
    const workspaceId = designCanvasWorkspaceOf(chat);
    const { doc } = await deps.store.get(chat.id, { workspaceId });
    const frame = doc.frames.find((entry) => entry.id === frameId);
    if (!frame || frame.kind !== "app" || typeof frame.appRoot !== "string") return { error: "unavailable" };
    const origin = await runningAppOrigin(live, workspaceId, frame.appRoot);
    if (!origin) return { error: "app-not-running" };
    // A page that loaded while its origin's workers were being cleared could lose its own (S76).
    await live.clearSettled?.(origin).catch(() => undefined);
    // Design mode may have turned off, or the chat moved, while we awaited.
    const current = await deps.getChat(chat.id);
    if (!canFrame(current) || designCanvasWorkspaceOf(current) !== workspaceId) return { error: "unavailable" };
    const registry = live.registry();
    if (!registry) return { error: "unavailable" };
    if (registry.expectPlacement({ frameId, mountToken, expectedOrigin: origin }) !== "ok") return { error: "too-many-frames" };
    return { origin };
  });

  // ── 3b (S87): Add ▸ Page from app… ──

  /** The workspace's app roots for the picker: candidates, then started or attached apps, then canvas.json's choices. */
  const pickerApps = (snapshot: DesignAppsSnapshot): { appRoot: string; label: string }[] => {
    const apps = new Map<string, string>();
    for (const candidate of snapshot.candidates) apps.set(candidate.appRoot, candidate.name ?? (candidate.appRoot === "." ? candidate.frameworkLabel : candidate.appRoot));
    for (const app of snapshot.apps) if (!apps.has(app.appRoot)) apps.set(app.appRoot, app.appRoot === "." ? app.frameworkLabel : app.appRoot);
    for (const root of snapshot.chosen) if (!apps.has(root)) apps.set(root, root);
    return [...apps].map(([appRoot, label]) => ({ appRoot, label }));
  };

  /** A live-flag, design-mode, attended chat and its workspace, or null. A Bot or routine chat is refused outright. */
  const liveChat = async (chatId: unknown): Promise<{ chat: DesignCanvasChat; workspaceId: string; live: NonNullable<typeof deps.appFrames> } | null> => {
    const live = deps.appFrames;
    if (!live || !live.enabled()) return null;
    const chat = await requireChat(chatId);
    if (!canFrame(chat)) return null;
    return { chat, workspaceId: designCanvasWorkspaceOf(chat), live };
  };

  /** `liveChat`, for Add ▸ Page from app…, which also needs route discovery. */
  const pickerChat = async (chatId: unknown) => (deps.appFrames?.apps.routes ? liveChat(chatId) : null);

  /** Whether the chat is still framing in `workspaceId`: design mode on and not moved while main awaited. */
  const stillFraming = async (chatId: string, workspaceId: string): Promise<boolean> => {
    const current = await deps.getChat(chatId);
    return canFrame(current) && designCanvasWorkspaceOf(current) === workspaceId;
  };

  deps.handle("designCanvas:appRoutes", async (_event, chatId, request): Promise<DesignCanvasAppRoutesResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const asked = await pickerChat(chatId);
    if (!asked) return { error: "unavailable" };
    const appRoot = typeof request === "object" && request !== null ? (request as { appRoot?: unknown }).appRoot : undefined;
    if (appRoot !== undefined && (typeof appRoot !== "string" || !isAppRoot(appRoot))) return { error: "no-app" };
    const snapshot = await asked.live.apps.snapshot(asked.workspaceId);
    if (snapshot.target === "unavailable") return { error: "unavailable" };
    if (!(await stillFraming(asked.chat.id, asked.workspaceId))) return { error: "unavailable" };
    const apps = pickerApps(snapshot);
    const root = appRoot ?? apps[0]?.appRoot;
    if (root === undefined || !apps.some((app) => app.appRoot === root)) return { error: "no-app" };
    const list = await asked.live.apps.routes!(asked.workspaceId, root);
    if ("error" in list) return list.error === "unavailable" ? { error: "unavailable" } : { error: "no-app" };
    if (!(await stillFraming(asked.chat.id, asked.workspaceId))) return { error: "unavailable" };
    return { apps, appRoot: root, list };
  });

  deps.handle("designCanvas:placeAppRoute", async (event, chatId, request): Promise<DesignCanvasPlaceAppRouteResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const asked = await pickerChat(chatId);
    if (!asked) return { error: "unavailable" };
    if (typeof request !== "object" || request === null || Array.isArray(request)) return { error: "bad-route" };
    const { appRoot, route, pageId, viewSize: rawSize } = request as { appRoot?: unknown; route?: unknown; pageId?: unknown; viewSize?: unknown };
    if (typeof appRoot !== "string" || !isAppRoot(appRoot)) return { error: "unknown-root" };
    if (typeof route !== "string" || !isConcreteRoute(route)) return { error: "bad-route" };
    const { chat, workspaceId, live } = asked;
    const snapshot = await live.apps.snapshot(workspaceId);
    if (snapshot.target === "unavailable") return { error: "unavailable" };
    if (!(await stillFraming(chat.id, workspaceId))) return { error: "unavailable" };
    if (!pickerApps(snapshot).some((app) => app.appRoot === appRoot)) return { error: "unknown-root" };
    const viewSize = rawSize === undefined ? undefined : parseDesignViewState({ selection: [], viewSize: rawSize })?.viewSize;
    const pages = designTurnPages({
      views: deps.views,
      chatId: chat.id,
      message: {
        selection: [],
        ...(typeof pageId === "string" && pageId.length > 0 && pageId.length <= 128 ? { pageId } : {}),
        ...(viewSize ? { viewSize } : {}),
      },
    });
    const viewOf = await pages.resolver(workspaceId);
    const viewport = { ...APP_DEFAULT_VIEWPORT };
    const scale = fitAppScale(viewport, 0.5, DESIGN_CANVAS_LIMITS.maxSize);
    let outcome: DesignCanvasPlaceAppRouteResult = { error: "full" };
    try {
      const saved = await deps.store.update(
        chat.id,
        (doc) => {
          const view = viewOf(doc);
          const existing = doc.frames.find(
            (frame) => frame.kind === "app" && frame.pageId === view.pageId && (frame.appRoot ?? ".") === appRoot && (frame.route ?? "/") === route,
          );
          if (existing) {
            outcome = { already: existing.id, pageId: view.pageId };
            throw UNCHANGED;
          }
          const placed = placeFrame(
            doc,
            {
              kind: "app",
              title: route.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
              appRoot,
              route,
              viewport,
              scale,
              pageId: view.pageId,
              createdBy: "person",
              ...appFrameBox(viewport, scale),
            },
            canvasView(doc, view),
            deps.newId ?? randomUUID,
          );
          if ("error" in placed) {
            outcome = { error: "full" };
            throw UNCHANGED;
          }
          outcome = { placed: placed.id, pageId: view.pageId };
          return placed.doc;
        },
        {
          workspaceId,
          // Leaving design mode, deleting the chat or moving it while this waited writes nothing.
          beforeWrite: async () => {
            if (!(await stillFraming(chat.id, workspaceId))) {
              outcome = { error: "unavailable" };
              throw UNCHANGED;
            }
          },
        },
      );
      // The person's own undo step.
      deps.broadcast({ workspaceId, chatId: chat.id, revision: saved.doc.revision, step: `add-app-route:${saved.doc.revision}` });
    } catch (error) {
      if (error !== UNCHANGED) throw error;
    }
    const result = outcome as DesignCanvasPlaceAppRouteResult;
    if (("placed" in result || "already" in result) && (await stillFraming(chat.id, workspaceId))) {
      const frameId = "placed" in result ? result.placed : result.already;
      // Unlike a visual, the frame is focused on its own page too, so the person sees what Add did.
      // The view is kept only while the chat still frames this workspace, checked again after the show's own load.
      const focusId = await pages.show(workspaceId, result.pageId, () => stillFraming(chat.id, workspaceId));
      // The person's own focus: the canvas shows it even though they just clicked there.
      if (focusId !== undefined && (await stillFraming(chat.id, workspaceId))) {
        deps.sendFocus?.(event, { chatId: chat.id, pageId: result.pageId, frameIds: [frameId], focusId, own: true });
      }
    }
    if ("placed" in result) {
      try {
        live.onAppFrameAdded?.(viewport.width);
      } catch {
        // Reporting never changes the placement.
      }
    }
    return result;
  });

  /** An Add view at width request's size: a device, or a whole width and height in range, never both. */
  const viewSizeOf = (request: unknown): { frameId: string; viewport: { width: number; height: number }; label: string } | null => {
    if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
    const { frameId, device, width, height } = request as { frameId?: unknown; device?: unknown; width?: unknown; height?: unknown };
    if (typeof frameId !== "string" || frameId.length === 0 || frameId.length > 128) return null;
    if (device !== undefined) {
      if (!isAppDevice(device) || width !== undefined || height !== undefined) return null;
      const { label, width: w, height: h } = APP_DEVICES[device];
      return { frameId, viewport: { width: w, height: h }, label };
    }
    if (!isAppViewportSide(width) || !isAppViewportSide(height)) return null;
    return { frameId, viewport: { width, height }, label: `${width} px` };
  };

  deps.handle("designCanvas:addAppView", async (event, chatId, request): Promise<DesignCanvasAddAppViewResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const asked = await liveChat(chatId);
    if (!asked) return { error: "unavailable" };
    const size = viewSizeOf(request);
    if (!size) return { error: "bad-size" };
    const { chat, workspaceId, live } = asked;
    const newId = deps.newId ?? randomUUID;
    let outcome: DesignCanvasAddAppViewResult = { error: "not-found" };
    try {
      const saved = await deps.store.update(
        chat.id,
        (doc) => {
          const frame = doc.frames.find((entry) => entry.id === size.frameId);
          if (!frame || frame.kind !== "app") {
            outcome = { error: "not-found" };
            throw UNCHANGED;
          }
          // The view joins the root's set, but shows the chosen frame's own page (a page variant's is not the root's).
          const original = variantRootOf(doc, frame);
          const scale = fitAppScale(size.viewport, frame.scale ?? original.scale ?? APP_DEFAULT_SCALE, DESIGN_CANVAS_LIMITS.maxSize);
          const placed = placeAppVariant(doc, original, {
            id: newId(),
            groupId: newId(),
            title: frame.title,
            route: frame.route ?? "/",
            viewport: size.viewport,
            scale,
            label: size.label,
            createdBy: "person",
          });
          if ("error" in placed) {
            outcome = { error: placed.error === "locked" || placed.error === "locked-group" ? "locked" : "full" };
            throw UNCHANGED;
          }
          outcome = { placed: placed.frameId, pageId: original.pageId };
          return placed.doc;
        },
        {
          workspaceId,
          beforeWrite: async () => {
            if (!(await stillFraming(chat.id, workspaceId))) {
              outcome = { error: "unavailable" };
              throw UNCHANGED;
            }
          },
        },
      );
      // The person's own undo step.
      deps.broadcast({ workspaceId, chatId: chat.id, revision: saved.doc.revision, step: `add-app-view:${saved.doc.revision}` });
    } catch (error) {
      if (error !== UNCHANGED) throw error;
    }
    const result = outcome as DesignCanvasAddAppViewResult;
    if (!("placed" in result)) return result;
    if (await stillFraming(chat.id, workspaceId)) {
      const pages = designTurnPages({ views: deps.views, chatId: chat.id, message: { selection: [], pageId: result.pageId } });
      const focusId = await pages.show(workspaceId, result.pageId, () => stillFraming(chat.id, workspaceId));
      if (focusId !== undefined && (await stillFraming(chat.id, workspaceId))) {
        deps.sendFocus?.(event, { chatId: chat.id, pageId: result.pageId, frameIds: [result.placed], focusId, own: true });
      }
    }
    try {
      live.onAppFrameAdded?.(size.viewport.width);
    } catch {
      // Reporting never changes the placement.
    }
    return result;
  });

  /** A request naming one frame, or null. */
  const frameIdOf = (request: unknown): string | null => {
    if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
    const { frameId } = request as { frameId?: unknown };
    return typeof frameId === "string" && frameId.length > 0 && frameId.length <= 128 ? frameId : null;
  };

  /**
   * What a page-file action needs before it touches anything: the chat, its
   * workspace's real path, the app frame, its app's framework, the owner walk
   * and the page's one owning file. Every S95 refusal that applies to both
   * actions is answered here.
   */
  const pageFileContext = async (
    chatId: unknown,
    request: unknown,
  ): Promise<
    | {
        chat: DesignCanvasChat;
        workspaceId: string;
        live: NonNullable<typeof deps.appFrames>;
        trash: (absolute: string) => Promise<void>;
        real: string;
        doc: DesignCanvas;
        frame: DesignFrame;
        appRoot: string;
        page: { path: string; query: string };
        framework: FrameworkId | undefined;
        walk: RouteFileWalk;
        owner: OwnerFile;
      }
    | { error: "unavailable" | "not-found" | AppPageRefusal }
  > => {
    const asked = await liveChat(chatId);
    if (!asked || !asked.live.trash || !pageLedger) return { error: "unavailable" };
    const frameId = frameIdOf(request);
    if (!frameId) return { error: "not-found" };
    const { chat, workspaceId, live } = asked;
    const folder = await writableWorkspace(chat);
    if (folder === null) return { error: "unavailable" };
    if (folder === "read-only") return { error: "read-only" };
    const { doc } = await deps.store.get(chat.id, { workspaceId });
    const frame = doc.frames.find((entry) => entry.id === frameId);
    if (!frame || frame.kind !== "app" || frame.route === undefined) return { error: "not-found" };
    const appRoot = frame.appRoot ?? ".";
    const snapshot = await live.apps.snapshot(workspaceId);
    if (snapshot.target === "unavailable") return { error: "unavailable" };
    const known = [...snapshot.candidates, ...snapshot.apps].filter((app) => app.appRoot === appRoot);
    const framework = known.find((app) => app.framework)?.framework;
    // 3d (S108): a design app's pages follow TanStack's flat-file rules.
    const mock = known.some((app) => app.mock === true);
    const walk = await routeFiles(routeFs(), folder.real, appRoot, { ...(framework ? { framework } : {}), ...(mock ? { mock: true as const } : {}) });
    if (!(await stillFraming(chat.id, workspaceId))) return { error: "unavailable" };
    if (!walk) return { error: "no-file" };
    if (walk.configRouter) return { error: "config-router" };
    if (walk.truncated) return { error: "truncated" };
    const page = pagePath(frame.route);
    const owned = ownerOf(page.path, walk);
    if ("refused" in owned) return { error: owned.refused };
    return { chat, workspaceId, live, trash: asked.live.trash, real: folder.real, doc, frame, appRoot, page, framework, walk, owner: owned.owner };
  };

  /** Whether `current` still shows the page `pageFileContext` read: the same app root and page path (Pullfrog r4724521921). */
  const showsSamePage = (current: DesignFrame | undefined, appRoot: string, page: { path: string }): boolean =>
    current?.kind === "app" && current.route !== undefined && (current.appRoot ?? ".") === appRoot && pagePath(current.route).path === page.path;

  /** The owner's bytes through a confined, no-follow read. */
  const ownerBytes = async (real: string, file: string): Promise<{ bytes: Buffer; mode: number; absolute: string } | { error: AppPageRefusal | "io" }> => {
    const target = await confinedTarget(real, file, { create: false, ...(deps.pageFs ? { fs: deps.pageFs } : {}) });
    if (!target.ok) return { error: target.reason === "io" ? "io" : "not-regular" };
    const read = await readRegularFileBytes(target.absolute, DESIGN_SOURCE_MAX_BYTES);
    if (!read.ok) return { error: read.reason === "missing" ? "no-file" : read.reason };
    return { bytes: read.bytes, mode: read.mode, absolute: target.absolute };
  };

  const placeVariantRefusal = (error: "locked" | "locked-group" | "page-full" | "canvas-full"): "locked" | "full" =>
    error === "locked" || error === "locked-group" ? "locked" : "full";

  deps.handle("designCanvas:appPageVariant", async (event, chatId, request): Promise<DesignCanvasAppPageVariantResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const context = await pageFileContext(chatId, request);
    if ("error" in context) return { error: context.error };
    const { chat, workspaceId, live, real, doc, frame, appRoot, page, walk, owner } = context;
    const newId = deps.newId ?? randomUUID;
    const viewport = frame.viewport ?? APP_DEFAULT_VIEWPORT;
    const scale = frame.scale ?? APP_DEFAULT_SCALE;
    const variantInput = (route: string, n: number) => ({
      id: newId(),
      groupId: newId(),
      title: route.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
      route,
      viewport,
      scale,
      label: `v${n}`,
      createdBy: "person" as const,
    });
    // The canvas is checked before the disk: a locked or full canvas writes nothing.
    const dry = placeAppVariant(doc, variantRootOf(doc, frame), { ...variantInput(frame.route ?? "/", 2), id: "dry-run", groupId: "dry-run-group" });
    if ("error" in dry) return { error: placeVariantRefusal(dry.error) };

    const source = workspaceRelPath(appRoot, owner.appRelPath);
    const read = await ownerBytes(real, source);
    if ("error" in read) return { error: read.error };
    const tanstack = owner.convention === "tanstack";
    const kind = owner.appRelPath.endsWith(".astro") ? "astro" : "ts";
    const text = read.bytes.toString("utf8");
    const siblings = await walk.siblings(owner.appRelPath);
    const base = variantBase(page.path);

    let written: { n: number; route: string; file: string; absolute: string; bytes: Buffer; createdFolder?: string } | undefined;
    for (let n = 2; n <= 9 && !written; n += 1) {
      const wanted = `${base}-v${n}`;
      if (walk.files.has(wanted) || walk.layouts.has(wanted)) continue;
      const candidate = variantPathCandidates(owner, n).find((entry) => routeFromFile(owner.convention, entry.appRelPath) === wanted);
      if (!candidate) return { error: "no-file" };
      if (specialFilesLost(owner, candidate, siblings)) return { error: "special-files" };
      if (relativeImportsMoved(text, path.posix.dirname(owner.appRelPath), path.posix.dirname(candidate.appRelPath), kind)) return { error: "relative-imports" };
      let bytes = read.bytes;
      if (tanstack) {
        const from = tanstackRouteId(owner.appRelPath);
        const to = tanstackRouteId(candidate.appRelPath);
        if (from === null || to === null) return { error: "route-literal" };
        const rewritten = rewriteTanstackLiteral(read.bytes, from, to);
        if ("refused" in rewritten) return { error: "route-literal" };
        bytes = rewritten.bytes;
        // A longer literal can take the copy past what its own undo (and a rollback) may read back.
        if (bytes.length > DESIGN_SOURCE_MAX_BYTES) return { error: "too-large" };
      }
      const file = workspaceRelPath(appRoot, candidate.appRelPath);
      const absolute = path.resolve(real, file);
      // Every gate again under the file's lock, as the Trash does: the walk and read above took time.
      const result = await withFileLock(absolute, async () => {
        if (!(await stillFraming(chat.id, workspaceId))) return { ok: false as const, refused: "unavailable" as const };
        const folder = await writableWorkspace(chat);
        if (folder === "read-only") return { ok: false as const, refused: "read-only" as const };
        if (folder === null || folder.real !== real) return { ok: false as const, refused: "unavailable" as const };
        return writeConfinedFile(real, file, bytes, read.mode, { create: candidate.newFolder !== undefined, ...(deps.pageFs ? { fs: deps.pageFs } : {}) });
      });
      if ("refused" in result) return { error: result.refused };
      if (!result.ok) {
        // Taken on disk (a case-insensitive clash, or a concurrent copy): the next number.
        if (result.reason === "exists") continue;
        return { error: result.reason === "io" ? "io" : "not-regular" };
      }
      written = { n, route: `${wanted}${page.query}`, file, absolute, bytes, ...(result.createdFolder ? { createdFolder: result.createdFolder } : {}) };
    }
    if (!written) return { error: "too-many" };
    const copy = written;

    let outcome: DesignCanvasAppPageVariantResult = { error: "io" };
    let saved: DesignCanvas | undefined;
    try {
      const update = await deps.store.update(
        chat.id,
        (latest) => {
          const current = latest.frames.find((entry) => entry.id === frame.id);
          // Another save may have pointed the frame at another page since the file was chosen.
          if (!current || !showsSamePage(current, appRoot, page)) {
            outcome = { error: "not-found" };
            throw UNCHANGED;
          }
          const placed = placeAppVariant(latest, variantRootOf(latest, current), variantInput(copy.route, copy.n));
          if ("error" in placed) {
            outcome = { error: placeVariantRefusal(placed.error) };
            throw UNCHANGED;
          }
          outcome = { placed: placed.frameId, pageId: current.pageId, route: copy.route, file: copy.file };
          return placed.doc;
        },
        {
          workspaceId,
          beforeWrite: async () => {
            if (!(await stillFraming(chat.id, workspaceId))) {
              outcome = { error: "unavailable" };
              throw UNCHANGED;
            }
          },
        },
      );
      saved = update.doc;
    } catch (error) {
      if (error !== UNCHANGED) outcome = { error: "io" };
    }
    const result = outcome as DesignCanvasAppPageVariantResult;
    if (!saved || !("placed" in result)) {
      // Rolled back: the copy goes to the Trash only while it is exactly what was written.
      const refusal = "error" in result ? result.error : "io";
      const kept = await withFileLock(copy.absolute, async () => {
        const now = await readRegularFileBytes(copy.absolute, DESIGN_SOURCE_MAX_BYTES);
        if (!now.ok) return now.reason !== "missing";
        if (pageDigest(now.bytes) !== pageDigest(copy.bytes)) return true;
        try {
          await context.trash(copy.absolute);
        } catch {
          return true;
        }
        if (copy.createdFolder) await (deps.pageFs?.rmdir ?? rmdir)(copy.createdFolder).catch(() => undefined);
        return false;
      });
      return kept ? { error: refusal, kept: copy.file } : { error: refusal };
    }
    deps.broadcast({ workspaceId, chatId: chat.id, revision: saved.revision, step: `app-page-variant:${saved.revision}` });
    pageLedger!.record({
      kind: "copy",
      chatId: chat.id,
      workspaceId,
      workspaceRoot: real,
      appRoot,
      route: copy.route,
      file: copy.file,
      bytes: copy.bytes,
      mode: read.mode,
      digest: pageDigest(copy.bytes),
      frameId: result.placed,
      state: "present",
      revision: saved.revision,
      ...(copy.createdFolder ? { newFolder: true as const } : {}),
    });
    if (await stillFraming(chat.id, workspaceId)) {
      const pages = designTurnPages({ views: deps.views, chatId: chat.id, message: { selection: [], pageId: result.pageId } });
      const focusId = await pages.show(workspaceId, result.pageId, () => stillFraming(chat.id, workspaceId));
      if (focusId !== undefined && (await stillFraming(chat.id, workspaceId))) {
        deps.sendFocus?.(event, { chatId: chat.id, pageId: result.pageId, frameIds: [result.placed], focusId, own: true });
      }
    }
    try {
      live.onAppFrameAdded?.(viewport.width);
    } catch {
      // Reporting never changes the placement.
    }
    return result;
  });

  deps.handle("designCanvas:appPageTrash", async (_event, chatId, request): Promise<DesignCanvasAppPageTrashResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const context = await pageFileContext(chatId, request);
    if ("error" in context) return { error: context.error };
    const { chat, workspaceId, real, frame, appRoot, page, owner, trash } = context;
    const file = workspaceRelPath(appRoot, owner.appRelPath);
    // Fail fast on what the lock would refuse anyway; nothing is kept from this read.
    const first = await ownerBytes(real, file);
    if ("error" in first) return { error: first.error };
    const absolute = path.resolve(real, file);
    const ofPage = (entry: DesignFrame) => entry.kind === "app" && (entry.appRoot ?? ".") === appRoot && entry.route !== undefined && pagePath(entry.route).path === page.path;

    let outcome: DesignCanvasAppPageTrashResult = { error: "io" };
    let removed: string[] = [];
    let taken: { bytes: Buffer; mode: number } | undefined;
    let saved: DesignCanvas | undefined;
    try {
      const update = await deps.store.update(
        chat.id,
        (latest) => {
          // The frame asked about must still show the page whose file was chosen; another save may have moved it.
          if (!showsSamePage(latest.frames.find((entry) => entry.id === frame.id), appRoot, page)) {
            outcome = { error: "not-found" };
            throw UNCHANGED;
          }
          const frames = latest.frames.filter(ofPage);
          if (frames.length === 0) {
            outcome = { error: "not-found" };
            throw UNCHANGED;
          }
          if (frames.some((entry) => entry.locked)) {
            outcome = { error: "locked" };
            throw UNCHANGED;
          }
          removed = frames.map((entry) => entry.id);
          const gone = new Set(removed);
          // A set's group is fitted to what is left, as canvas_remove does.
          return refitGroups(
            syncConnectors({
              ...latest,
              frames: latest.frames.filter((entry) => !gone.has(entry.id)),
              comments: commentsWithoutFrames(latest.comments, gone),
            }),
            frames.map((entry) => entry.groupId),
          );
        },
        {
          workspaceId,
          byPerson: true,
          // The file goes only once the canvas is ready to write, under the file's lock, with every gate checked again.
          beforeWrite: () =>
            withFileLock(absolute, async () => {
              if (!(await stillFraming(chat.id, workspaceId))) {
                outcome = { error: "unavailable" };
                throw UNCHANGED;
              }
              const folder = await writableWorkspace(chat);
              if (folder === "read-only" || folder === null || folder.real !== real) {
                outcome = { error: folder === "read-only" ? "read-only" : "unavailable" };
                throw UNCHANGED;
              }
              const now = await ownerBytes(real, file);
              if ("error" in now) {
                outcome = { error: now.error };
                throw UNCHANGED;
              }
              try {
                await trash(now.absolute);
              } catch {
                outcome = { error: "io" };
                throw UNCHANGED;
              }
              taken = { bytes: now.bytes, mode: now.mode };
            }),
        },
      );
      saved = update.doc;
    } catch (error) {
      if (error !== UNCHANGED) outcome = { error: "io" };
    }
    if (!saved) {
      const kept = taken;
      if (!kept) return outcome;
      // The file went but the canvas didn't change: it is written back where it was.
      const back = await withFileLock(absolute, () =>
        writeConfinedFile(real, file, kept.bytes, kept.mode, { create: false, ...(deps.pageFs ? { fs: deps.pageFs } : {}) }),
      );
      return back.ok ? { error: "io" } : { error: "io", restore: "failed" };
    }
    const bytes = taken!;
    deps.broadcast({ workspaceId, chatId: chat.id, revision: saved.revision, step: `app-page-trash:${saved.revision}` });
    pageLedger!.record({
      kind: "trash",
      chatId: chat.id,
      workspaceId,
      workspaceRoot: real,
      appRoot,
      route: frame.route ?? "/",
      file,
      bytes: bytes.bytes,
      mode: bytes.mode,
      digest: pageDigest(bytes.bytes),
      frameIds: removed,
      state: "trashed",
      revision: saved.revision,
    });
    return { trashed: file, route: frame.route ?? "/", removed, revision: saved.revision };
  });

  deps.handle("designCanvas:designSystem", async (_event, request): Promise<DesignCanvasDesignSystemResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new Error("Invalid design system request.");
    }
    const { chatId, appRoot } = request as { chatId?: unknown; appRoot?: unknown };
    assertDesignCanvasChatId(chatId);
    const unavailable = { error: "unavailable" } as const;
    const designMd = deps.designMd;
    if (!designMd?.enabled()) return unavailable;
    const chat = await deps.getChat(chatId);
    if (!chat || !attended(chat)) return unavailable;
    const root = await deps.workspaceRoot(chat);
    if (!root) return unavailable;
    const config = await readCanvasConfig(root);
    let app: string;
    try {
      app = await checkedAppRoot(
        root,
        appRoot === undefined ? ((await designMd.appRoots(root, { config })).roots[0] ?? ".") : appRoot,
      );
    } catch {
      return unavailable;
    }
    const state = await designMd.reader.read(root, await locateDesignMd(root, app, config), { report: false });
    if (state.status !== "ok") {
      return { status: state.status, appRoot: app, ...("path" in state ? { path: state.path } : {}) };
    }
    return {
      status: "ok",
      appRoot: app,
      path: state.path,
      summary: state.summary,
      sections: state.sections,
      findings: state.findings.slice(0, DESIGN_SYSTEM_MAX_FINDINGS).map((finding) => ({
        severity: finding.severity,
        ...(finding.rule ? { rule: finding.rule } : {}),
        ...(finding.path ? { path: finding.path } : {}),
        message: finding.message,
      })),
    };
  });

  // Replaces the set of workspace files whose changes reload this chat's frames.
  deps.handle("designCanvas:watch", async (_event, chatId, paths): Promise<void> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string")) {
      throw new Error("Invalid design file list.");
    }
    const chat = await deps.getChat(chatId);
    const root = canFrame(chat) ? await deps.workspaceRoot(chat) : null;
    if (!root) {
      deps.watcher.clear(chatId);
      return;
    }
    await deps.watcher.set(chatId, root, paths as string[]);
  });

  // Lets the person add a page or image from the chat's workspace. Only the
  // workspace-relative path comes back; the frame loads it through its grant.
  deps.handle("designCanvas:pickFile", async (event, chatId, kind): Promise<DesignCanvasPickResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    if (kind !== "file" && kind !== "image") throw new Error("Invalid design file kind.");
    const chat = await deps.getChat(chatId);
    const root = canFrame(chat) ? await deps.workspaceRoot(chat) : null;
    if (!root) return { error: "unavailable" };
    const chosen = await deps.pickFile(event, {
      defaultPath: root,
      kind,
      filters: [{ name: PICK_FILTER_NAMES[kind], extensions: [...PICK_EXTENSIONS[kind]] }],
    });
    if (chosen === null) return { cancelled: true };
    return validatePickedFile(root, chosen, kind);
  });

  // Saves one frame as a picture, a PDF or its original file, wherever the
  // person chooses. The frame is read from the stored canvas, never from the
  // renderer, so only a page this chat really shows can be exported.
  deps.handle(
    "designCanvas:export",
    async (event, chatId, frameId, format, theme): Promise<DesignCanvasExportResult> => {
      if (!deps.enabled()) throw new Error(UNAVAILABLE);
      assertDesignCanvasChatId(chatId);
      if (typeof frameId !== "string" || frameId.length === 0 || frameId.length > 128) {
        throw new Error("Invalid design frame.");
      }
      if (!(DESIGN_EXPORT_FORMATS as readonly unknown[]).includes(format)) throw new Error("Invalid export format.");
      const kind = format as DesignExportFormat;
      const chat = await deps.getChat(chatId);
      if (!chat || !attended(chat)) return { error: "unavailable" };
      const { doc } = await deps.store.get(chat.id, { workspaceId: designCanvasWorkspaceOf(chat) });
      const frame = doc.frames.find((entry) => entry.id === frameId);
      if (!frame || !designExportFormats(frame).includes(kind)) return { error: "unavailable" };

      // A live app frame is drawn from its running app, on the default session
      // (D18). Everything is checked before the Save dialog opens, and the
      // address is main's own: the renderer never names a URL.
      if (frame.kind === "app") {
        const live = deps.appFrames;
        if (!live || !live.enabled()) return { error: "live-off" };
        if (!live.renderApp || (kind !== "png" && kind !== "pdf") || typeof frame.appRoot !== "string" || !frame.viewport) {
          return { error: "unavailable" };
        }
        const origin = await runningAppOrigin(live, designCanvasWorkspaceOf(chat), frame.appRoot);
        if (!origin) return { error: "app-not-running" };
        const destination = await deps.saveFile(event, { defaultPath: designExportFileName(frame, kind), filters: [EXPORT_FILTERS[kind]] });
        if (destination === null) return { canceled: true };
        // The dialog can stay open a long time: the app may have stopped, or
        // another server taken its port. Only the same app, still running here, is drawn.
        const current = await deps.getChat(chat.id);
        if (!current || !attended(current) || !live.enabled()) return { error: "unavailable" };
        const stillRunning = await runningAppOrigin(live, designCanvasWorkspaceOf(current), frame.appRoot);
        if (stillRunning !== origin) return { error: "app-not-running" };
        try {
          const bytes = await live.renderApp({
            url: `${origin}${frame.route ?? "/"}`,
            origin,
            width: frame.viewport.width,
            height: frame.viewport.height,
            format: kind,
            ...(frame.colorScheme ? { colorScheme: frame.colorScheme } : {}),
          });
          await fs.writeFile(destination, bytes);
        } catch {
          return { error: "failed" };
        }
        return { saved: true };
      }

      let url: string;
      let source: string | null = null;
      if (frame.kind === "artifact") {
        const owner = await artifactOwner(chat, frame);
        if (!frame.mediaId || owner === null) return { error: "unavailable" };
        if (kind === "source") {
          try {
            const result = await deps.exportArtifactSource(event, owner, frame.mediaId);
            return result.saved ? { saved: true } : { canceled: true };
          } catch {
            return { error: "failed" };
          }
        }
        // The theme is the renderer's and untrusted; the preview reads only what it knows, and only for a dark frame.
        const preview = await deps.artifactPreview(owner, frame.mediaId, frame.dark ? theme : undefined);
        if (!preview) return { error: "missing" };
        url = preview.src;
      } else {
        // Workspace files go out only while the chat may still frame its folder.
        const root = canFrame(chat) ? await deps.workspaceRoot(chat) : null;
        if (!root || !frame.path) return { error: "unavailable" };
        const resolved = await resolveDesignFile(root, frame.path.split("/").map(encodeURIComponent).join("/"));
        if (!resolved.ok) return { error: "missing" };
        source = resolved.absolute;
        url = withDesignTweakQuery(designUrl(deps.grants.issue(chat.id, root), frame.path), designTweakState(frame));
      }

      const name = designExportFileName(frame, kind);
      const extension = path.extname(name).slice(1).toLowerCase();
      const destination = await deps.saveFile(event, {
        defaultPath: name,
        filters:
          kind === "source"
            ? [{ name: "Original file", extensions: extension ? [extension] : [] }]
            : [EXPORT_FILTERS[kind]],
      });
      if (destination === null) return { canceled: true };
      try {
        if (kind === "source") {
          await fs.copyFile(source!, destination);
        } else {
          const bytes = await deps.renderFrame({
            url,
            width: designExportWidth(frame),
            format: kind,
            ...(frame.paper ? { paper: frame.paper } : {}),
            ...(frame.printMode ? { printMode: frame.printMode } : {}),
          });
          await fs.writeFile(destination, bytes);
        }
      } catch {
        return { error: "failed" };
      }
      return { saved: true };
    },
  );

  // The Code tab: a page's file (read, never written) or an artifact's HTML,
  // cut at 512 KiB. Like export, a workspace file is read only while the
  // chat may still frame its folder.
  deps.handle("designCanvas:source", async (_event, chatId, frameId): Promise<DesignCanvasSourceResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    if (typeof frameId !== "string" || frameId.length === 0 || frameId.length > 128) {
      throw new Error("Invalid design frame.");
    }
    const chat = await deps.getChat(chatId);
    if (!chat || !attended(chat)) return { error: "unavailable" };
    const { doc } = await deps.store.get(chat.id, { workspaceId: designCanvasWorkspaceOf(chat) });
    const frame = doc.frames.find((entry) => entry.id === frameId);
    if (frame?.kind === "artifact" && frame.mediaId) {
      const owner = await artifactOwner(chat, frame);
      if (owner === null) return { error: "unavailable" };
      const html = await deps.artifactHtml(owner, frame.mediaId).catch(() => undefined);
      if (html === undefined) return { error: "missing" };
      const bytes = Buffer.from(html, "utf8");
      const truncated = bytes.length > DESIGN_SOURCE_MAX_BYTES;
      return { text: truncated ? bytes.subarray(0, DESIGN_SOURCE_MAX_BYTES).toString("utf8") : html, truncated };
    }
    if (frame?.kind !== "file" || !frame.path) return { error: "unavailable" };
    const root = canFrame(chat) ? await deps.workspaceRoot(chat) : null;
    if (!root) return { error: "unavailable" };
    const resolved = await resolveDesignFile(root, frame.path.split("/").map(encodeURIComponent).join("/"));
    if (!resolved.ok) return { error: "missing" };
    try {
      const handle = await fs.open(resolved.absolute, "r");
      try {
        const buffer = Buffer.alloc(DESIGN_SOURCE_MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const truncated = bytesRead > DESIGN_SOURCE_MAX_BYTES;
        return { text: buffer.subarray(0, Math.min(bytesRead, DESIGN_SOURCE_MAX_BYTES)).toString("utf8"), truncated };
      } finally {
        await handle.close();
      }
    } catch {
      return { error: "missing" };
    }
  });

  // Editing a page's words in place: a plain text change is written into the
  // page's own file, only where its old words are found exactly once (see
  // text-edit.ts). Like export, the frame comes from the stored canvas and the
  // file is written only while the chat may still frame its folder. The canvas
  // already shows the new words, or reloads the page itself, so the watcher
  // does not report this write back to it.
  /**
   * Rewrites a page frame's file with `plan`, one write per file at a time.
   * Like export, the frame comes from the stored canvas and the file is
   * written only while the chat may still frame its folder. The canvas
   * already shows the change, or reloads the page itself, so the watcher does
   * not report this write back to it.
   */
  async function rewriteFrameFile<T extends { ok: true; source: string }>(
    chatId: string,
    frameId: string,
    plan: (source: string, framePath: string) => T | { ok: false; reason: DesignCanvasFileRewriteFailure },
  ): Promise<T | { ok: false; reason: DesignCanvasFileRewriteFailure }> {
    const chat = await deps.getChat(chatId);
    if (!chat || !attended(chat)) return { ok: false, reason: "unavailable" };
    const { doc } = await deps.store.get(chat.id, { workspaceId: designCanvasWorkspaceOf(chat) });
    const frame = doc.frames.find((entry) => entry.id === frameId);
    if (frame?.kind !== "file" || !frame.path) return { ok: false, reason: "unavailable" };
    const root = canFrame(chat) ? await deps.workspaceRoot(chat) : null;
    if (!root) return { ok: false, reason: "unavailable" };
    const resolved = await resolveDesignFile(root, frame.path.split("/").map(encodeURIComponent).join("/"));
    if (!resolved.ok) return { ok: false, reason: "missing" };
    if (!resolved.mimeType.startsWith("text/html")) return { ok: false, reason: "unavailable" };
    const framePath = frame.path;
    // One edit of a file at a time, so two quick edits each plan from what the other wrote.
    return withFileLock(resolved.absolute, async () => {
      let source: string;
      try {
        source = await fs.readFile(resolved.absolute, "utf8");
      } catch {
        return { ok: false as const, reason: "missing" as const };
      }
      const planned = plan(source, framePath);
      if (!planned.ok) return planned;
      const next = planned.source;
      // Another writer (an editor, Aiden) may have changed the file since it was read.
      const current = await fs.readFile(resolved.absolute, "utf8").catch(() => null);
      if (current === null) return { ok: false as const, reason: "missing" as const };
      if (current !== source) return { ok: false as const, reason: "changed" as const };
      const settle = deps.watcher.ownWrite(chat.id, framePath, next);
      let written: Awaited<ReturnType<typeof replaceWorkspaceText>> = "failed";
      try {
        written = await replaceWorkspaceText(resolved.absolute, next, source);
      } finally {
        settle(written === "written");
      }
      if (written === "written") {
        tweakDefaultsUndo.delete(`${chat.id}\n${frameId}`);
        return planned;
      }
      return { ok: false as const, reason: written === "changed" ? ("changed" as const) : ("missing" as const) };
    });
  }

  // Editing a page's words in place: a plain text change is written into the
  // page's own file, only where its old words are found exactly once (see
  // text-edit.ts).
  deps.handle(
    "designCanvas:editText",
    async (_event, chatId, frameId, changes, stamp): Promise<DesignCanvasEditTextResult> => {
      if (!deps.enabled()) throw new Error(UNAVAILABLE);
      assertDesignCanvasChatId(chatId);
      if (typeof frameId !== "string" || frameId.length === 0 || frameId.length > 128) {
        throw new Error("Invalid design frame.");
      }
      const parsed = parseTextChanges(changes);
      if (!parsed) throw new Error("Invalid text change.");
      if (stamp !== undefined && (typeof stamp !== "string" || stamp.length > 1024)) throw new Error("Invalid stamp.");
      const result = await rewriteFrameFile(chatId, frameId, (source, framePath) => {
        const plan = planDesignTextEdit(source, parsed, { stamp: stamp as string | undefined, path: framePath });
        return plan.ok ? { ok: true as const, source: plan.source } : plan;
      });
      return result.ok ? { ok: true } : (result as DesignCanvasEditTextResult);
    },
  );

  // Tweaks' Make default: the frame's values become the page's defaults in
  // its file (see bakeDesignTweakDefaults). A text control's words change in
  // its marked elements, or where they stand once in the page; any that
  // can't be placed are listed in `kept` and left as they were, for the
  // frame to keep. Undo puts back the file as it was, while nothing else
  // has changed it since.
  deps.handle(
    "designCanvas:bakeTweaks",
    async (_event, chatId, frameId, values): Promise<DesignCanvasBakeTweaksResult> => {
      if (!deps.enabled()) throw new Error(UNAVAILABLE);
      assertDesignCanvasChatId(chatId);
      if (typeof frameId !== "string" || frameId.length === 0 || frameId.length > 128) {
        throw new Error("Invalid design frame.");
      }
      const tweaks = parseDesignTweakValues(values);
      if (values !== undefined && values !== null && !tweaks) throw new Error("Invalid tweak values.");
      let before = "";
      const result = await rewriteFrameFile<{
        ok: true;
        source: string;
        written: Record<string, string>;
        previous: Record<string, string>;
        kept: string[];
      }>(
        chatId,
        frameId,
        (source) => {
          const baked = bakeDesignTweakDefaults(source, tweaks);
          if (baked.ok) before = source;
          return baked;
        },
      );
      if (!result.ok) return result;
      const undoId = randomUUID();
      const key = `${chatId}\n${frameId}`;
      tweakDefaultsUndo.delete(key);
      tweakDefaultsUndo.set(key, { id: undoId, before, after: digest(result.source) });
      while (tweakDefaultsUndo.size > TWEAK_UNDO_LIMIT) tweakDefaultsUndo.delete(tweakDefaultsUndo.keys().next().value as string);
      return { ok: true, written: result.written, previous: result.previous, kept: result.kept, undoId };
    },
  );

  deps.handle("designCanvas:undoBakeTweaks", async (_event, chatId, frameId, undoId): Promise<DesignCanvasEditTextResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    if (typeof frameId !== "string" || frameId.length === 0 || frameId.length > 128) {
      throw new Error("Invalid design frame.");
    }
    if (typeof undoId !== "string" || undoId.length === 0 || undoId.length > 64) throw new Error("Invalid undo.");
    const key = `${chatId}\n${frameId}`;
    const saved = tweakDefaultsUndo.get(key);
    if (!saved) return { ok: false, reason: "unchanged" };
    // An older Make default's Undo: a later one has changed the file since.
    if (saved.id !== undoId) return { ok: false, reason: "changed" };
    const result = await rewriteFrameFile(chatId, frameId, (source) =>
      digest(source) === saved.after ? { ok: true as const, source: saved.before } : { ok: false as const, reason: "changed" as const },
    );
    return result.ok ? { ok: true } : (result as DesignCanvasEditTextResult);
  });

  // Snapshots a frame's rectangle of the asking window's own page, so a frame
  // that leaves the live set keeps a picture instead of going blank. A window
  // can only ever capture itself.
  deps.handle("designCanvas:capture", async (event, rect): Promise<DesignCanvasCaptureResult> => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const area = clampCaptureRect(rect, deps.windowFor(event));
    if (!area) return { error: "unavailable" };
    try {
      let image = await area.window.capturePage(area.rect);
      if (image.isEmpty()) return { error: "unavailable" };
      const { width, height } = image.getSize();
      const longest = Math.max(width, height);
      if (longest > DESIGN_CAPTURE_MAX_SIDE) {
        const ratio = DESIGN_CAPTURE_MAX_SIDE / longest;
        image = image.resize({
          width: Math.max(1, Math.round(width * ratio)),
          height: Math.max(1, Math.round(height * ratio)),
          quality: "good",
        });
      }
      return { dataUrl: image.toDataURL() };
    } catch {
      // The window closed or the page navigated mid-capture: the frame keeps its old picture.
      return { error: "unavailable" };
    }
  });
}

function clampCaptureRect(
  rect: unknown,
  window: DesignCanvasCaptureWindow | null,
): { window: DesignCanvasCaptureWindow; rect: { x: number; y: number; width: number; height: number } } | null {
  if (!window || !rect || typeof rect !== "object") return null;
  const { x, y, width, height } = rect as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  // The page measures in CSS pixels; the capture takes window points.
  const zoom = window.getZoomFactor?.() ?? 1;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const [left, top, w, h] = (numbers as number[]).map((value) => value * scale);
  if (w! <= 0 || h! <= 0) return null;
  const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
  const x0 = Math.max(0, Math.floor(left!));
  const y0 = Math.max(0, Math.floor(top!));
  const x1 = Math.min(contentWidth, Math.ceil(left! + w!));
  const y1 = Math.min(contentHeight, Math.ceil(top! + h!));
  if (x1 <= x0 || y1 <= y0) return null;
  return { window, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

async function validatePickedFile(
  root: string,
  chosen: string,
  kind: DesignCanvasPickKind,
): Promise<DesignCanvasPickResult> {
  const extension = path.extname(chosen).slice(1).toLowerCase();
  if (!PICK_EXTENSIONS[kind].includes(extension)) return { error: "unsupported" };
  let realRoot: string;
  let realChosen: string;
  try {
    realRoot = await fs.realpath(root);
    realChosen = await fs.realpath(chosen);
  } catch {
    return { error: "outside-workspace" };
  }
  if (!isPathInside(realRoot, realChosen, { allowRoot: false })) return { error: "outside-workspace" };
  // A link inside the folder may name a file of another type.
  if (!PICK_EXTENSIONS[kind].includes(path.extname(realChosen).slice(1).toLowerCase())) {
    return { error: "unsupported" };
  }
  const relative = path.relative(realRoot, realChosen).split(path.sep).join("/");
  // Hidden folders are never served, so a frame there could never load.
  if (!isDesignRelativePath(relative)) return { error: "outside-workspace" };
  const resolved = await resolveDesignFile(
    realRoot,
    relative.split("/").map(encodeURIComponent).join("/"),
  );
  if (resolved.ok) return { path: relative };
  return resolved.status === 413 ? { error: "unsupported" } : { error: "outside-workspace" };
}

function parseTextChanges(value: unknown): DesignTextChange[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DESIGN_TEXT_EDIT_LIMITS.changes) return null;
  const changes: DesignTextChange[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { before, after } = entry as Record<string, unknown>;
    if (typeof before !== "string" || typeof after !== "string") return null;
    if (before.length > DESIGN_TEXT_EDIT_LIMITS.chars || after.length > DESIGN_TEXT_EDIT_LIMITS.chars) return null;
    changes.push({ before, after });
  }
  return changes;
}
