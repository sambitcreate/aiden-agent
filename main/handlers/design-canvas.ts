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
  isDesignRelativePath,
  type DesignCanvas,
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
import { placeFrame } from "../../renderer/shared/design-canvas/placement.js";
import { isHtmlArtifactMediaId } from "../../renderer/shared/generative-ui.js";
import { isWorkspaceArtifactWorkspaceId } from "../../renderer/shared/workspace-artifacts.js";
import { ARTIFACT_FRAME_BOX } from "../services/design-canvas/artifact-frames.js";
import type { DesignGrantRegistry } from "../services/design-canvas/grants.js";
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
import type { ChatMeta } from "../services/types.js";

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

/** `designCanvas:export` reply. */
export type DesignCanvasExportResult =
  | { saved: true }
  | { canceled: true }
  | { error: "unavailable" | "missing" | "failed" };

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

/**
 * A save's options: the pages it says the person's undo took off, and the
 * workspace whose canvas the renderer is saving. Anything malformed is refused.
 */
function saveOptions(options: unknown): { undone: string[]; workspaceId?: string } {
  if (options === undefined || options === null) return { undone: [] };
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid canvas save options.");
  const { undone, workspaceId } = options as { undone?: unknown; workspaceId?: unknown };
  if (
    undone !== undefined &&
    (!Array.isArray(undone) ||
      undone.length > DESIGN_CANVAS_LIMITS.frames ||
      !undone.every((entry) => typeof entry === "string" && isDesignRelativePath(entry)))
  ) {
    throw new Error("Invalid canvas save options.");
  }
  if (workspaceId !== undefined && !isWorkspaceArtifactWorkspaceId(workspaceId)) {
    throw new Error("Invalid canvas save options.");
  }
  return { undone: (undone as string[] | undefined) ?? [], ...(workspaceId !== undefined ? { workspaceId } : {}) };
}

/** The workspace whose canvas a chat works on. */
/** A `designCanvas:view` report, checked; anything malformed is refused. */
function parseViewReport(
  value: unknown,
): "unmounted" | { workspaceId: string; view: DesignChatView; focusId: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid canvas view.");
  const raw = value as Record<string, unknown>;
  if (raw.mounted === false && Object.keys(raw).length === 1) return "unmounted";
  const { workspaceId, focusId } = raw;
  if (!isWorkspaceArtifactWorkspaceId(workspaceId)) throw new Error("Invalid canvas view.");
  if (typeof focusId !== "number" || !Number.isSafeInteger(focusId) || focusId < 0) throw new Error("Invalid canvas view.");
  const view = parseDesignChatView(raw.view);
  if (!view) throw new Error("Invalid canvas view.");
  return { workspaceId, view, focusId };
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
  views: Pick<DesignCanvasViews, "report" | "unmount" | "kept" | "unmountAll" | "get" | "viewports" | "showPage">;
  /**
   * Calls `reset` whenever the window that sent `event` reloads, crashes or is
   * destroyed, since every canvas in it is then gone; called for every view report.
   */
  whenSenderResets?(event: Event, reset: () => void): void;
  /** Sends `designCanvas:focus` to the window that sent `event`, if it is still there. */
  sendFocus?(event: Event, request: { chatId: string; pageId: string; frameIds: string[]; focusId: number }): void;
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
  deps.handle("designCanvas:view", async (event, chatId, report) => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    assertDesignCanvasChatId(chatId);
    const parsed = parseViewReport(report);
    if (parsed === "unmounted") {
      deps.views.unmount(chatId);
      return;
    }
    const chat = await requireChat(chatId);
    deps.whenSenderResets?.(event, () => deps.views.unmountAll());
    if (parsed.workspaceId !== designCanvasWorkspaceOf(chat)) return;
    await deps.views.report(chat.id, parsed.workspaceId, parsed.view, parsed.focusId);
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
    const { undone, workspaceId: expected } = saveOptions(options);
    const chat = await requireChat(chatId);
    // One workspace for the whole save: the one this chat is in now.
    const workspaceId = designCanvasWorkspaceOf(chat);
    // The canvas the renderer is saving belongs to a workspace the chat has
    // since left: nothing is written, and the renderer drops those edits and
    // opens the canvas of the workspace the chat is in now.
    if (expected !== undefined && expected !== workspaceId) {
      return { ok: false, reason: "moved", workspaceId } satisfies DesignCanvasSaveResult;
    }
    const { result } = await deps.store.save(chat.id, doc as DesignCanvas, baseRevision, { undone, workspaceId });
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

      let url: string;
      let source: string | null = null;
      if (frame.kind === "artifact") {
        if (!frame.mediaId) return { error: "unavailable" };
        if (kind === "source") {
          try {
            const result = await deps.exportArtifactSource(event, chat.id, frame.mediaId);
            return result.saved ? { saved: true } : { canceled: true };
          } catch {
            return { error: "failed" };
          }
        }
        // The theme is the renderer's and untrusted; the preview reads only what it knows, and only for a dark frame.
        const preview = await deps.artifactPreview(chat.id, frame.mediaId, frame.dark ? theme : undefined);
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
      const html = await deps.artifactHtml(chat.id, frame.mediaId).catch(() => undefined);
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
