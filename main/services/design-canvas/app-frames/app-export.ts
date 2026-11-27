// Draws a live app frame for Download (design mode v2 Phase 3a, D18, S73):
// a hidden window on the default session, so cookies and storage match the
// canvas, registered as an export window for its whole life. Production
// wiring only; what it decides is in app-export-core.ts, the registry, the
// network policy (the CSP `sandbox` header), the frame guard and the
// dispatchers, all tested, plus the E2E.

import { BrowserWindow } from "../../../platform.js";
import { markAuxiliaryWindow } from "../../../windows/auxiliary-windows.js";
import { DESIGN_EXPORT_MAX_HEIGHT, designPdfLayout } from "../../../../renderer/shared/design-canvas/frame-export.js";
import type { DesignAppRenderRequest } from "../../../handlers/design-canvas.js";
import { designFrameZoomGate } from "../frame-render.js";
import type { AppFrameRegistry } from "./app-frame-registry.js";
import {
  APP_EXPORT_DARK_SCRIPT,
  appExportPixels,
  appExportWindowOptions,
  guardAppExportContents,
  waitForQuietNetwork,
  withAppExportRegistration,
} from "./app-export-core.js";

/** Waits for fonts and two frames, so what is captured is what a person would see. */
const SETTLE_SCRIPT = `new Promise((resolve) => {
  const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle, settle); else settle();
})`;
const HEIGHT_SCRIPT =
  "Math.ceil(Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0))";

export async function renderAppFrame(
  request: DesignAppRenderRequest,
  registry: () => Pick<AppFrameRegistry, "addExportContents" | "lastExportRequest"> | null,
): Promise<Uint8Array> {
  const leave = await designFrameZoomGate.enter(1);
  try {
    const live = registry();
    const viewport = { width: request.width, height: request.height };
    const window = new BrowserWindow(appExportWindowOptions(viewport));
    markAuxiliaryWindow(window);
    try {
      const contents = window.webContents;
      const guard = guardAppExportContents(contents as never, request.origin);
      return await withAppExportRegistration(live, contents.id, async () => {
        const startedAt = Date.now();
        await window.loadURL(request.url);
        guard.markLoaded();
        if (request.colorScheme === "dark") await contents.executeJavaScript(APP_EXPORT_DARK_SCRIPT);
        await waitForQuietNetwork({
          lastRequestAt: () => live?.lastExportRequest(contents.id),
          now: Date.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          startedAt,
        });
        await contents.executeJavaScript(SETTLE_SCRIPT);
        if (request.format === "pdf") {
          const layout = designPdfLayout({ width: request.width });
          return contents.printToPDF({
            pageSize: layout.pageSize,
            printBackground: true,
            scale: layout.scale,
            margins: { top: layout.marginInches, bottom: layout.marginInches, left: layout.marginInches, right: layout.marginInches },
          });
        }
        const pixels = appExportPixels(viewport, Number(await contents.executeJavaScript(HEIGHT_SCRIPT)), DESIGN_EXPORT_MAX_HEIGHT);
        window.setContentSize(pixels.width, pixels.height);
        await contents.executeJavaScript(SETTLE_SCRIPT);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let image = await contents.capturePage({ x: 0, y: 0, ...pixels }, { stayHidden: true });
          if (!image.isEmpty()) {
            // A high-density display captures more pixels than asked for; the file is 1× (S73).
            const size = image.getSize();
            if (size.width !== pixels.width || size.height !== pixels.height) image = image.resize({ ...pixels, quality: "best" });
            return image.toPNG();
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error("The app could not be drawn.");
      });
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  } finally {
    leave();
  }
}
