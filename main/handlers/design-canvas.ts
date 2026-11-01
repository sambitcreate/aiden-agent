// IPC for the per-chat design canvas. Registered only while
// AIDEN_EXPERIMENTAL_DESIGN_MODE is on, and every handler re-checks the flag
// the way `chats:setDesignMode` does.

import path from "node:path";
import * as fs from "node:fs/promises";
import {
  isDesignRelativePath,
  type DesignCanvasV1,
} from "../../renderer/shared/design-canvas/schema.js";
import type { DesignGrantRegistry } from "../services/design-canvas/grants.js";
import { resolveDesignFile } from "../services/design-canvas/resolve-core.js";
import type { DesignFileWatcher } from "../services/design-canvas/watch.js";
import { isPathInside } from "../shared/path-containment.js";
import {
  assertDesignCanvasChatId,
  type DesignCanvasStore,
} from "../services/design-canvas/store.js";
import type { ChatMeta } from "../services/types.js";

/** Broadcast on `designCanvas:updated` after a save or an Aiden edit lands. */
export type DesignCanvasUpdated = { chatId: string; revision: number };

/** The chat fields the canvas handlers decide on. */
export type DesignCanvasChat = Pick<
  ChatMeta,
  "id" | "workspaceId" | "designMode" | "botId" | "owner"
>;

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

/** A frame snapshot's longest side, in pixels. */
export const DESIGN_CAPTURE_MAX_SIDE = 1024;

export const DESIGN_CANVAS_UPDATED_CHANNEL = "designCanvas:updated";
const UNAVAILABLE = "Design mode is not available.";

export function registerDesignCanvasHandlers<Event>(deps: {
  enabled: () => boolean;
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  store: Pick<DesignCanvasStore, "get" | "save">;
  broadcast(update: DesignCanvasUpdated): void;
  getChat(chatId: string): Promise<DesignCanvasChat | null>;
  grants: Pick<DesignGrantRegistry, "issue" | "revokeChat">;
  /** The chat's workspace folder, or null when the chat has no folder to frame. */
  workspaceRoot(chat: DesignCanvasChat): Promise<string | null>;
  /** The window that sent `event`, or null when it has none (or it is gone). */
  windowFor(event: Event): DesignCanvasCaptureWindow | null;
  watcher: Pick<DesignFileWatcher, "set" | "clear">;
  /** Shows the open dialog over the asking window; the chosen absolute path, or null. */
  pickFile(event: Event, options: DesignCanvasPickOptions): Promise<string | null>;
}): void {
  if (!deps.enabled()) return;

  // Only an attended desktop chat has a canvas: Bot and routine chats never
  // enter design mode, so they never get a canvas file either.
  const attended = (chat: DesignCanvasChat): boolean => !chat.botId && !chat.owner;

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
    return deps.store.get(chat.id);
  });

  deps.handle("designCanvas:save", async (_event, chatId, doc, baseRevision) => {
    if (
      typeof baseRevision !== "number" ||
      !Number.isSafeInteger(baseRevision) ||
      baseRevision < 0
    ) {
      throw new Error("Invalid canvas revision.");
    }
    const chat = await requireChat(chatId);
    const result = await deps.store.save(chat.id, doc as DesignCanvasV1, baseRevision);
    if (result.ok) deps.broadcast({ chatId: chat.id, revision: result.revision });
    return result;
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
