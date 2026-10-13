import { BrowserWindow, logger } from "../platform.js";
import { getWindowUrl } from "../windows/window-paths.js";
import { markAuxiliaryWindow } from "../windows/auxiliary-windows.js";
import { wrapGenerativeUiHtml } from "./generative-ui-html.js";
import {
  GENERATIVE_UI_RESIZE_MESSAGE,
  MAX_INLINE_VISUAL_HEIGHT,
  MIN_INLINE_VISUAL_HEIGHT,
} from "../../renderer/shared/generative-ui-bridge.js";
import { GENERATIVE_UI_GUEST_CSP, GENERATIVE_UI_IFRAME_SANDBOX } from "../../renderer/shared/generative-ui.js";
import {
  createVisualSnapshotQueue,
  snapshotAttachment,
  type CapturedImage,
  type SnapshotVisual,
  type VisualSnapshotJob,
} from "./visual-snapshot-core.js";
import type { Attachment } from "./types.js";

/**
 * Captures visuals offscreen in one hidden, sandboxed window on the default
 * session (the only one serving `aiden-genui:`):
 * - HTML visuals load through an opaque-origin `sandbox="allow-scripts"`
 *   iframe of their main-built preview URL, under the guest CSP.
 * - Native visuals render `AidenUiBlock` in the `visual-snapshot` entry with
 *   the default light tokens and no preload.
 * The window never shows, opens nothing, navigates nowhere, and closes after
 * the queue goes idle. A capture that is abandoned (timeout or chat deletion)
 * destroys its own window, because a guest that never yields keeps running
 * script that `webContents.stop()` cannot interrupt.
 */

const COLUMN_WIDTH = 720;
const WIDE_WIDTH = 1024;
const PADDING = 16;
const CANVAS = "#f6f7f9";
const SETTLE_MS = 400;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const IDLE_CLOSE_MS = 10_000;

const LIGHT_THEME = { colorScheme: "light" as const, canvas: CANVAS, foreground: "#181817", secondary: "#6b6b68", accent: "#0b7de5" };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Snapshot cancelled."));
    }, { once: true });
  });
}

/**
 * The guest document is inlined as `srcdoc`, not loaded from its own
 * `aiden-genui:` URL. Chromium keeps one renderer per site, so a guest on that
 * URL would share a process with every other aiden-genui guest (including the
 * chat's own visuals) and a runaway one would block all of them. A srcdoc
 * frame runs in this capture window's own host process instead, which the
 * window takes down with it when the capture is abandoned.
 *
 * A srcdoc document inherits this page's CSP on top of its own, so the host
 * uses the guest policy (host libraries, no network) and differs only in
 * framing that one srcdoc document.
 */
const HOST_PAGE_CSP = GENERATIVE_UI_GUEST_CSP.replace("frame-src 'none'", "frame-src about:srcdoc");

/** Escapes a value for a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function hostPage(guestDocument: string, width: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HOST_PAGE_CSP}"><style>
html,body{margin:0;background:${CANVAS};}
body{padding:${PADDING}px;}
iframe{border:0;display:block;width:${width}px;height:${MIN_INLINE_VISUAL_HEIGHT}px;}
</style></head><body><iframe sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" srcdoc="${escapeAttribute(guestDocument)}"></iframe><script>
window.__snap = { height: 0, changedAt: 0 };
addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== ${JSON.stringify(GENERATIVE_UI_RESIZE_MESSAGE)} || typeof data.height !== "number") return;
  const height = Math.max(${MIN_INLINE_VISUAL_HEIGHT}, Math.min(${MAX_INLINE_VISUAL_HEIGHT}, Math.ceil(data.height)));
  document.querySelector("iframe").style.height = height + "px";
  window.__snap = { height, changedAt: Date.now() };
});
</script></body></html>`;
}

export function createElectronVisualSnapshotCapture(deps: {
  htmlFor: (chatId: string, mediaId: string) => Promise<string | undefined>;
}) {
  let window: InstanceType<typeof BrowserWindow> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const closeWindow = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  };

  /**
   * Ends an abandoned capture's window and clears the shared reference, so the
   * next capture creates a fresh one. Fenced by identity: a late abandoned
   * capture never acts on the window that replaced its own.
   */
  const discardWindow = (target: InstanceType<typeof BrowserWindow>) => {
    if (window !== target) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    window = null;
    if (!target.isDestroyed()) target.destroy();
  };

  const ensureWindow = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (window && !window.isDestroyed()) return window;
    window = new BrowserWindow({
      show: false,
      width: COLUMN_WIDTH + PADDING * 2,
      height: 400,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    markAuxiliaryWindow(window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // The guest is inline, so no frame may navigate anywhere: a guest can always try to navigate its own frame.
    window.webContents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && event.url === "about:srcdoc") return;
      event.preventDefault();
    });
    return window;
  };

  const scheduleClose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeWindow, IDLE_CLOSE_MS);
  };

  const captureSized = async (target: InstanceType<typeof BrowserWindow>, width: number, height: number, signal: AbortSignal): Promise<CapturedImage | null> => {
    const fullWidth = width + PADDING * 2;
    const fullHeight = Math.min(height, MAX_INLINE_VISUAL_HEIGHT) + PADDING * 2;
    if (signal.aborted) return null;
    target.setContentSize(fullWidth, fullHeight);
    await target.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) return null;
      const image = await target.webContents.capturePage({ x: 0, y: 0, width: fullWidth, height: fullHeight }, { stayHidden: true });
      if (signal.aborted) return null;
      if (!image.isEmpty()) {
        const png = image.toPNG();
        if (png.length <= MAX_PNG_BYTES) return { bytes: png, mimeType: "image/png" };
        return { bytes: image.toJPEG(88), mimeType: "image/jpeg" };
      }
      await sleep(150, signal);
    }
    return null;
  };

  const captureHtml = async (
    visual: Extract<SnapshotVisual, { kind: "html" }>,
    html: string,
    target: InstanceType<typeof BrowserWindow>,
    signal: AbortSignal,
  ): Promise<CapturedImage | null> => {
    const width = visual.layout === "wide" ? WIDE_WIDTH : COLUMN_WIDTH;
    // Inline, as the desktop draws it: the same font size and a body that
    // measures its own margins. The host page paints the opaque canvas.
    const guest = wrapGenerativeUiHtml(html, visual.title, LIGHT_THEME, { inline: true, stillImage: true });
    target.setContentSize(width + PADDING * 2, 400);
    await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hostPage(guest, width))}`);
    // Wait for the guest to report its height and then stop changing.
    let height = 0;
    while (!signal.aborted) {
      const snap = (await target.webContents.executeJavaScript("window.__snap")) as { height: number; changedAt: number };
      if (signal.aborted) return null;
      if (snap.height > 0 && Date.now() - snap.changedAt >= SETTLE_MS) {
        height = snap.height;
        break;
      }
      await sleep(100, signal);
    }
    return height > 0 ? captureSized(target, width, height, signal) : null;
  };

  const captureUi = async (
    visual: Extract<SnapshotVisual, { kind: "ui" }>,
    target: InstanceType<typeof BrowserWindow>,
    signal: AbortSignal,
  ): Promise<CapturedImage | null> => {
    const width = visual.layout === "wide" ? WIDE_WIDTH : COLUMN_WIDTH;
    target.setContentSize(width + PADDING * 2, 400);
    await target.loadURL(getWindowUrl("visual-snapshot.html"));
    while (!signal.aborted) {
      const ready = await target.webContents.executeJavaScript("typeof window.__aidenSnapshot === 'function'");
      if (signal.aborted) return null;
      if (ready) break;
      await sleep(50, signal);
    }
    if (signal.aborted) return null;
    // Only the images this visual shows travel to the page: id, type, and data.
    const payload = {
      visual: visual.visual,
      attachments: (visual.attachments ?? []).map(({ id, mimeType, data }) => ({ id, mimeType, data })),
    };
    const height = (await target.webContents.executeJavaScript(
      `window.__aidenSnapshot(${JSON.stringify(JSON.stringify(payload))}, ${width}, ${PADDING})`,
    )) as number | null;
    if (!height || signal.aborted) return null;
    return captureSized(target, width, height, signal);
  };

  return {
    async capture(visual: SnapshotVisual, signal: AbortSignal, job: VisualSnapshotJob): Promise<CapturedImage | null> {
      if (signal.aborted) return null;
      const html = visual.kind === "html" ? ((await deps.htmlFor(job.chatId, visual.visualId)) ?? "") : "";
      // Checked again before a window is claimed, so an abandoned capture never takes one.
      if (signal.aborted || (visual.kind === "html" && !html)) return null;
      const target = ensureWindow();
      // Abandoning this capture ends its own window: a guest that never yields
      // cannot be stopped any other way, and the queue has already moved on.
      const discard = () => discardWindow(target);
      signal.addEventListener("abort", discard, { once: true });
      try {
        return visual.kind === "ui" ? await captureUi(visual, target, signal) : await captureHtml(visual, html, target, signal);
      } finally {
        signal.removeEventListener("abort", discard);
        // An abandoned capture no longer owns the window, so it leaves the idle timer alone.
        if (window === target) scheduleClose();
      }
    },
    dispose: closeWindow,
  };
}

/** Wires the capture to the chat store; returns the queue the service registry installs. */
export function createMainVisualSnapshotQueue(deps: {
  htmlFor: (chatId: string, mediaId: string) => Promise<string | undefined>;
  addVisualSnapshots: (chatId: string, messageId: string, snapshots: { visualId: string; attachment: Attachment }[]) => Promise<boolean>;
}) {
  const capture = createElectronVisualSnapshotCapture({ htmlFor: deps.htmlFor });
  const queue = createVisualSnapshotQueue({
    capture: (visual, signal, job) => capture.capture(visual, signal, job),
    store: (chatId, messageId, snapshots) =>
      deps.addVisualSnapshots(
        chatId,
        messageId,
        snapshots.map((snapshot) => ({ visualId: snapshot.visualId, attachment: snapshotAttachment(chatId, messageId, snapshot) })),
      ),
    onError: (error) => logger.warn("visuals", "A visual snapshot could not be captured.", error),
  });
  return {
    ...queue,
    dispose() {
      queue.dispose();
      capture.dispose();
    },
  };
}
