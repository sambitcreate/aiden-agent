// What a live app frame's Download decides (design mode v2 Phase 3a, D18,
// S73), apart from the window itself (app-export.ts), so it can be tested
// without Electron.
//
// The export window is hidden, sandboxed, has no preload and shows no
// dialog, on the default session so cookies and storage match the canvas.
// Its web contents is registered as an export window for the render's whole
// life, so the network policy (the CSP `sandbox` header, the cancel rules),
// the permission layer and the download cancel all apply to it. It renders
// at zoom 1, set on each commit; PNGs are 1× (Task 2's probe 9: device
// emulation doesn't raise `capturePage`'s pixels).

/** Probe 9: `capturePage` stays at 1× under device emulation, so PNGs are 1×. */
export const APP_EXPORT_DEVICE_SCALE = 1;
/** The app has started no request for this long: it has settled. */
export const APP_EXPORT_QUIET_MS = 500;
/** A cold compile gets this long to settle before the frame is drawn anyway. */
export const APP_EXPORT_SETTLE_CAP_MS = 15_000;
/** The whole render gives up after this long. */
export const APP_EXPORT_TIMEOUT_MS = 30_000;

export type AppExportViewport = { width: number; height: number };

/** The hidden export window's options: no `session` or `partition` means the default session. */
export function appExportWindowOptions(viewport: AppExportViewport) {
  return {
    show: false,
    width: viewport.width,
    height: viewport.height,
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
      disableDialogs: true,
      zoomFactor: 1,
    },
  } as const;
}

/** The PNG's pixels: the viewport's width, the page's height (at least the viewport's), at 1×. */
export function appExportPixels(viewport: AppExportViewport, pageHeight: number, maxHeight: number): { width: number; height: number } {
  const height = Number.isFinite(pageHeight) ? Math.ceil(pageHeight) : viewport.height;
  return {
    width: viewport.width * APP_EXPORT_DEVICE_SCALE,
    height: Math.min(maxHeight, Math.max(viewport.height, height)) * APP_EXPORT_DEVICE_SCALE,
  };
}

type NavigationDetails = { url: string; isMainFrame: boolean; preventDefault(): void };

type ExportContents = {
  on(event: "did-navigate", listener: () => void): unknown;
  on(event: "will-navigate" | "will-redirect" | "will-frame-navigate", listener: (details: NavigationDetails) => void): unknown;
  setZoomFactor(factor: number): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  setWebRTCIPHandlingPolicy(policy: "disable_non_proxied_udp"): void;
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The export window's navigation rules: zoom 1 on every commit; the page may
 * not navigate itself or open windows; a main-frame redirect may land only on
 * the app's own origin; the first main-frame load is the only one allowed,
 * and frames inside the app draw empty (S65).
 */
export function guardAppExportContents(contents: ExportContents, appOrigin: string): { markLoaded(): void } {
  let loaded = false;
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The default session keeps zoom per host, and in development the app's
  // host is also the main window's, so the zoom is set again on each commit.
  contents.on("did-navigate", () => contents.setZoomFactor(1));
  contents.on("will-navigate", (details) => details.preventDefault());
  contents.on("will-redirect", (details) => {
    if (!details.isMainFrame || originOf(details.url) !== appOrigin) details.preventDefault();
  });
  contents.on("will-frame-navigate", (details) => {
    if (loaded || !details.isMainFrame || originOf(details.url) !== appOrigin) details.preventDefault();
  });
  return { markLoaded: () => (loaded = true) };
}

/**
 * Runs `work` with `contentsId` registered as an export window, giving up
 * after `timeoutMs`; it is unregistered on success, failure and timeout. With
 * no registry (the network policy isn't installed) nothing is drawn.
 */
export async function withAppExportRegistration<T>(
  registry: { addExportContents(webContentsId: number): () => void } | null,
  contentsId: number,
  work: () => Promise<T>,
  options: { timeoutMs?: number; schedule?: (callback: () => void, ms: number) => { cancel(): void } } = {},
): Promise<T> {
  if (!registry) throw new Error("Live app frames can't be drawn before the network policy is installed.");
  const remove = registry.addExportContents(contentsId);
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(timer) };
    });
  let timer: { cancel(): void } | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = schedule(() => reject(new Error("The app took too long to draw.")), options.timeoutMs ?? APP_EXPORT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    timer?.cancel();
    remove();
  }
}

/**
 * Waits until the window has started no request for `quietMs` (counting from
 * `startedAt` when it has started none), or `capMs` has passed since then.
 */
export async function waitForQuietNetwork(options: {
  lastRequestAt(): number | undefined;
  now(): number;
  sleep(ms: number): Promise<void>;
  startedAt?: number;
  quietMs?: number;
  capMs?: number;
}): Promise<"quiet" | "cap"> {
  const quietMs = options.quietMs ?? APP_EXPORT_QUIET_MS;
  const capMs = options.capMs ?? APP_EXPORT_SETTLE_CAP_MS;
  const startedAt = options.startedAt ?? options.now();
  for (;;) {
    const now = options.now();
    const last = Math.max(startedAt, options.lastRequestAt() ?? startedAt);
    if (now - last >= quietMs) return "quiet";
    if (now - startedAt >= capMs) return "cap";
    await options.sleep(Math.max(1, Math.min(quietMs - (now - last), capMs - (now - startedAt))));
  }
}

/**
 * The one script an export window runs besides the settle: the frame's dark
 * look, as the bridge's `set-scheme` sets it.
 */
export const APP_EXPORT_DARK_SCRIPT = `(() => {
  const root = document.documentElement;
  if (!root) return;
  root.style.colorScheme = "dark";
  root.setAttribute("data-theme", "dark");
  root.classList.add("dark");
})()`;
