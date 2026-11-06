// Draws a design frame's page in a hidden window for Download: a PNG at twice
// its CSS pixels, or a PDF on the frame's paper. Production wiring only; what
// is exported and where it goes is decided (and tested) in the IPC handler.
//
// The window is hidden, sandboxed, has no preload, opens nothing and
// navigates nowhere. The page loads from its own `aiden-design:` or
// `aiden-genui:` address, so the scheme's no-network policy still applies.
// Each export gets a fresh window that is destroyed when it is done.

import { BrowserWindow } from "../../platform.js";
import { markAuxiliaryWindow } from "../../windows/auxiliary-windows.js";
import {
  DESIGN_EXPORT_MAX_HEIGHT,
  DESIGN_EXPORT_PNG_SCALE,
  designPdfLayout,
} from "../../../renderer/shared/design-canvas/frame-export.js";
import type { DesignFrameRenderRequest } from "../../handlers/design-canvas.js";

const START_HEIGHT = 800;
const SETTLE_MS = 300;
const RENDER_TIMEOUT_MS = 20_000;

/** Waits for fonts and two frames, so what is captured is what a person would see. */
const SETTLE_SCRIPT = `new Promise((resolve) => {
  const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, ${SETTLE_MS})));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle, settle); else settle();
})`;
const HEIGHT_SCRIPT =
  "Math.ceil(Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0))";

export async function renderDesignFrame(request: DesignFrameRenderRequest): Promise<Uint8Array> {
  const zoom = request.format === "png" ? DESIGN_EXPORT_PNG_SCALE : 1;
  const window = new BrowserWindow({
    show: false,
    width: request.width * zoom,
    height: START_HEIGHT * zoom,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      zoomFactor: zoom,
    },
  });
  markAuxiliaryWindow(window);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Only the page itself loads; it may not navigate away or frame anything else in.
  let loaded = false;
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (loaded || !event.isMainFrame) event.preventDefault();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The page took too long to draw.")), RENDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([draw(window, request, () => (loaded = true)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}

async function draw(
  window: InstanceType<typeof BrowserWindow>,
  request: DesignFrameRenderRequest,
  onLoaded: () => void,
): Promise<Uint8Array> {
  const contents = window.webContents;
  await window.loadURL(request.url);
  onLoaded();
  await contents.executeJavaScript(SETTLE_SCRIPT);
  if (request.format === "pdf") {
    const layout = designPdfLayout({ paper: request.paper, printMode: request.printMode, width: request.width });
    return contents.printToPDF({
      pageSize: layout.pageSize,
      printBackground: true,
      scale: layout.scale,
      margins: {
        top: layout.marginInches,
        bottom: layout.marginInches,
        left: layout.marginInches,
        right: layout.marginInches,
      },
    });
  }
  const measured = Number(await contents.executeJavaScript(HEIGHT_SCRIPT));
  const height = Math.max(1, Math.min(DESIGN_EXPORT_MAX_HEIGHT, Number.isFinite(measured) ? measured : START_HEIGHT));
  // The window is zoomed 2×, so it lays the page out at its own width and
  // draws twice the pixels; it grows to the page's full height for one capture.
  const pixels = { width: request.width * DESIGN_EXPORT_PNG_SCALE, height: height * DESIGN_EXPORT_PNG_SCALE };
  window.setContentSize(pixels.width, pixels.height);
  await contents.executeJavaScript(SETTLE_SCRIPT);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let image = await contents.capturePage({ x: 0, y: 0, ...pixels }, { stayHidden: true });
    if (!image.isEmpty()) {
      // A high-density display captures more pixels than asked for; the file is always 2×.
      const size = image.getSize();
      if (size.width !== pixels.width || size.height !== pixels.height) image = image.resize({ ...pixels, quality: "best" });
      return image.toPNG();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The page could not be drawn.");
}
