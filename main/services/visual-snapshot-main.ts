import { BrowserWindow, logger } from "../platform.js";
import { getWindowUrl } from "../windows/window-paths.js";
import { markAuxiliaryWindow } from "../windows/auxiliary-windows.js";
import { wrapGenerativeUiHtml } from "./generative-ui-html.js";
import { registerGenerativeUiPreviewDocument } from "./generative-ui-preview-store.js";
import {
  GENERATIVE_UI_RESIZE_MESSAGE,
  MAX_INLINE_VISUAL_HEIGHT,
  MIN_INLINE_VISUAL_HEIGHT,
} from "../../renderer/shared/generative-ui-bridge.js";
import { GENERATIVE_UI_IFRAME_SANDBOX } from "../../renderer/shared/generative-ui.js";
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
 * the queue goes idle.
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

function hostPage(src: string, width: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${CANVAS};}
body{padding:${PADDING}px;}
iframe{border:0;display:block;width:${width}px;height:${MIN_INLINE_VISUAL_HEIGHT}px;}
</style></head><body><iframe sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" src="${src}"></iframe><script>
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
    return window;
  };

  const scheduleClose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeWindow, IDLE_CLOSE_MS);
  };

  const captureSized = async (target: InstanceType<typeof BrowserWindow>, width: number, height: number, signal: AbortSignal): Promise<CapturedImage | null> => {
    const fullWidth = width + PADDING * 2;
    const fullHeight = Math.min(height, MAX_INLINE_VISUAL_HEIGHT) + PADDING * 2;
    target.setContentSize(fullWidth, fullHeight);
    await target.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) return null;
      const image = await target.webContents.capturePage({ x: 0, y: 0, width: fullWidth, height: fullHeight }, { stayHidden: true });
      if (!image.isEmpty()) {
        const png = image.toPNG();
        if (png.length <= MAX_PNG_BYTES) return { bytes: png, mimeType: "image/png" };
        return { bytes: image.toJPEG(88), mimeType: "image/jpeg" };
      }
      await sleep(150, signal);
    }
    return null;
  };

  const captureHtml = async (visual: SnapshotVisual, job: VisualSnapshotJob, signal: AbortSignal): Promise<CapturedImage | null> => {
    const html = await deps.htmlFor(job.chatId, visual.visualId);
    if (!html || signal.aborted) return null;
    const width = visual.layout === "wide" ? WIDE_WIDTH : COLUMN_WIDTH;
    const src = registerGenerativeUiPreviewDocument(wrapGenerativeUiHtml(html, visual.title, LIGHT_THEME, { inline: false }));
    const target = ensureWindow();
    target.setContentSize(width + PADDING * 2, 400);
    await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hostPage(src, width))}`);
    // Wait for the guest to report its height and then stop changing.
    let height = 0;
    while (!signal.aborted) {
      const snap = (await target.webContents.executeJavaScript("window.__snap")) as { height: number; changedAt: number };
      if (snap.height > 0 && Date.now() - snap.changedAt >= SETTLE_MS) {
        height = snap.height;
        break;
      }
      await sleep(100, signal);
    }
    return height > 0 ? captureSized(target, width, height, signal) : null;
  };

  const captureUi = async (visual: Extract<SnapshotVisual, { kind: "ui" }>, signal: AbortSignal): Promise<CapturedImage | null> => {
    const width = visual.layout === "wide" ? WIDE_WIDTH : COLUMN_WIDTH;
    const target = ensureWindow();
    target.setContentSize(width + PADDING * 2, 400);
    await target.loadURL(getWindowUrl("visual-snapshot.html"));
    while (!signal.aborted) {
      const ready = await target.webContents.executeJavaScript("typeof window.__aidenSnapshot === 'function'");
      if (ready) break;
      await sleep(50, signal);
    }
    if (signal.aborted) return null;
    const height = (await target.webContents.executeJavaScript(
      `window.__aidenSnapshot(${JSON.stringify(JSON.stringify(visual.visual))}, ${width}, ${PADDING})`,
    )) as number | null;
    if (!height || signal.aborted) return null;
    return captureSized(target, width, height, signal);
  };

  return {
    async capture(visual: SnapshotVisual, signal: AbortSignal, job: VisualSnapshotJob): Promise<CapturedImage | null> {
      // A cancelled capture stops the window's page so a runaway guest cannot keep working.
      const stop = () => {
        if (window && !window.isDestroyed()) window.webContents.stop();
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        return visual.kind === "ui" ? await captureUi(visual, signal) : await captureHtml(visual, job, signal);
      } finally {
        signal.removeEventListener("abort", stop);
        scheduleClose();
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
