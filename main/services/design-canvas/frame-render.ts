// Draws a design frame's page in a hidden window for Download: a PNG at twice
// its CSS pixels, or a PDF on the frame's paper. Production wiring only; what
// is exported and where it goes is decided (and tested) in the IPC handler.
// canvas_inspect draws a page the same way and reports what the page said
// and did while it drew (`inspectDesignFrame`); what that means is decided,
// and tested, in inspect.ts.
//
// The window is hidden, sandboxed, has no preload, opens nothing, navigates
// nowhere and shows no dialog. The page loads from its own `aiden-design:` or
// `aiden-genui:` address, so the scheme's no-network policy still applies,
// and in a session of its own (offline-session.ts) that has no route out for
// what that policy does not cover, such as WebRTC. Each export gets a fresh
// window that is destroyed when it is done.

import { BrowserWindow } from "../../platform.js";
import { markAuxiliaryWindow } from "../../windows/auxiliary-windows.js";
import { designOfflineSession } from "./offline-session.js";
import {
  DESIGN_EXPORT_MAX_HEIGHT,
  DESIGN_EXPORT_PNG_SCALE,
  designPdfLayout,
} from "../../../renderer/shared/design-canvas/frame-export.js";
import type { DesignFrameRenderRequest } from "../../handlers/design-canvas.js";
import { boundedUnicodePrefix } from "../../../renderer/shared/unicode-prefix.js";
import {
  DESIGN_INSPECT_MAX_MESSAGES,
  DESIGN_INSPECT_PROBE_STRING_CHARS,
  designInspectPictureWindow,
  designInspectProbeScript,
  type DesignConsoleEntry,
  type DesignInspectProbe,
  type DesignInspectRequest,
} from "./inspect.js";

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

type HiddenWindow = InstanceType<typeof BrowserWindow>;

/** A fresh hidden, sandboxed window, in the offline session, that may load one page and go nowhere else. */
async function openHiddenWindow(width: number, zoom: number): Promise<{ window: HiddenWindow; markLoaded(): void }> {
  const offline = designOfflineSession();
  await offline.ready;
  const window = new BrowserWindow({
    show: false,
    width: width * zoom,
    height: START_HEIGHT * zoom,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      session: offline.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      disableDialogs: true,
      zoomFactor: zoom,
    },
  });
  markAuxiliaryWindow(window);
  const contents = window.webContents;
  // WebRTC may use only TCP through the session's proxy, which goes nowhere.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Only the page itself loads; it may not navigate away or frame anything else in.
  let loaded = false;
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (loaded || !event.isMainFrame) event.preventDefault();
  });
  return { window, markLoaded: () => (loaded = true) };
}

/** Runs `work` against the window, giving up after the render timeout or when `signal` aborts; the window is always destroyed. */
async function withHiddenWindow<T>(window: HiddenWindow, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The page took too long to draw.")), RENDER_TIMEOUT_MS);
    if (signal) {
      onAbort = () => reject(new Error("The inspect was stopped."));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([work(), stop]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (!window.isDestroyed()) window.destroy();
  }
}

export async function renderDesignFrame(request: DesignFrameRenderRequest): Promise<Uint8Array> {
  const zoom = request.format === "png" ? DESIGN_EXPORT_PNG_SCALE : 1;
  const { window, markLoaded } = await openHiddenWindow(request.width, zoom);
  return withHiddenWindow(window, () => draw(window, request, markLoaded));
}

const measureHeight = async (window: HiddenWindow): Promise<number> => {
  const measured = Number(await window.webContents.executeJavaScript(HEIGHT_SCRIPT));
  return Math.max(1, Math.min(DESIGN_EXPORT_MAX_HEIGHT, Number.isFinite(measured) ? Math.ceil(measured) : START_HEIGHT));
};

/**
 * Draws a page at its design width, at 1×, and reports its height, what
 * sticks out, what its console said and which tweak names it reads; with
 * `picture`, a JPEG of part of it sized for a model to read.
 */
export async function inspectDesignFrame(request: DesignInspectRequest): Promise<DesignInspectProbe> {
  const { window, markLoaded } = await openHiddenWindow(request.width, 1);
  const messages: DesignConsoleEntry[] = [];
  window.webContents.on("console-message", (details) => {
    if (messages.length >= DESIGN_INSPECT_MAX_MESSAGES) return;
    messages.push({
      message: boundedUnicodePrefix(String(details.message ?? ""), DESIGN_INSPECT_PROBE_STRING_CHARS),
      level: String(details.level ?? ""),
      ...(typeof details.lineNumber === "number" ? { lineNumber: details.lineNumber } : {}),
      ...(typeof details.sourceId === "string" && details.sourceId
        ? { sourceId: boundedUnicodePrefix(details.sourceId, DESIGN_INSPECT_PROBE_STRING_CHARS) }
        : {}),
    });
  });
  return withHiddenWindow(
    window,
    async () => {
      const contents = window.webContents;
      await window.loadURL(request.url);
      markLoaded();
      await contents.executeJavaScript(SETTLE_SCRIPT);
      const height = await measureHeight(window);
      const frame = request.picture ? designInspectPictureWindow(request.width, height, request.picture.top) : undefined;
      if (frame) {
        // Tall enough to hold the part of the page that is captured.
        window.setContentSize(request.width, Math.min(DESIGN_EXPORT_MAX_HEIGHT, frame.top + frame.height));
        await contents.executeJavaScript(SETTLE_SCRIPT);
      }
      const seen = (await contents.executeJavaScript(designInspectProbeScript(request.tweakTargets, request.width))) as Omit<
        DesignInspectProbe,
        "height" | "console" | "picture"
      >;
      const probe: DesignInspectProbe = {
        height,
        scrollWidth: Number(seen?.scrollWidth) || 0,
        hidesSideways: seen?.hidesSideways === true,
        overflowing: strings(seen?.overflowing),
        brokenImages: strings(seen?.brokenImages),
        failedFonts: strings(seen?.failedFonts),
        tweaksRead: strings(seen?.tweaksRead).filter((name) => request.tweakTargets.includes(name)),
        readsTheme: seen?.readsTheme === true,
        console: messages.slice(),
      };
      if (frame) {
        const picture = await capture(window, { x: 0, y: frame.top, width: request.width, height: frame.height }, frame.scale);
        if (picture) probe.picture = { ...picture, top: frame.top, height: frame.height };
      }
      return probe;
    },
    request.signal,
  );
}

/** Up to 50 of the strings the page handed back, each cut short: the page chose them. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 50)
        .map((entry) => boundedUnicodePrefix(entry, DESIGN_INSPECT_PROBE_STRING_CHARS))
    : [];
}

/** A JPEG of one part of the page, scaled by `scale`, or null when nothing could be captured. */
async function capture(
  window: HiddenWindow,
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): Promise<{ data: string; mimeType: string } | null> {
  const size = { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let image = await window.webContents.capturePage(rect, { stayHidden: true });
    if (!image.isEmpty()) {
      const got = image.getSize();
      if (got.width !== size.width || got.height !== size.height) image = image.resize({ ...size, quality: "best" });
      return { data: image.toJPEG(80).toString("base64"), mimeType: "image/jpeg" };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function draw(
  window: HiddenWindow,
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
  const height = await measureHeight(window);
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
