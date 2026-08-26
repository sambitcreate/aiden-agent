import { app, BrowserWindow, dialog, ipcMain, logger, powerMonitor } from "../platform.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  diagnosticMetadata,
  performanceDiagnosticsEnabled,
  parseRendererDiagnosticReport,
  recordDiagnosticCounter,
  recordDiagnosticEvent,
  recordDiagnosticGauge,
  writePerformanceDiagnosticExport,
} from "../services/performance-diagnostics.js";

export interface PerformanceDiagnosticExportResult {
  saved: boolean;
}

let exportInFlight = false;

function invalidDiagnosticRequest(): Error {
  return new Error("Invalid performance diagnostics request.");
}

export function registerPerformanceDiagnosticHandlers(): void {
  ipcMain.handle("app:diagnostics:report", (event, ...args: unknown[]) => {
    if (!performanceDiagnosticsEnabled) throw invalidDiagnosticRequest();
    rendererDocumentOwner(event, invalidDiagnosticRequest);
    if (args.length !== 1) throw invalidDiagnosticRequest();
    const [value] = args;
    const report = parseRendererDiagnosticReport(value);
    if (report.name === "renderer.scheduler_snapshot") {
      recordDiagnosticGauge("live:renderer-raf", report.rafCount);
      recordDiagnosticGauge("live:renderer-timer", report.timerCount);
      recordDiagnosticCounter("renderer:scroll-write", { count: report.scrollWrites });
      recordDiagnosticEvent({ name: report.name, count: report.rafCount + report.timerCount });
    } else {
      recordDiagnosticEvent(report);
    }
    return true;
  });

  ipcMain.handle(
    "app:diagnostics:export",
    async (event, ...args: unknown[]): Promise<PerformanceDiagnosticExportResult> => {
      if (!performanceDiagnosticsEnabled) throw invalidDiagnosticRequest();
      const owner = rendererDocumentOwner(event, invalidDiagnosticRequest);
      if (args.length !== 0) throw invalidDiagnosticRequest();
      if (exportInFlight) throw new Error("A performance diagnostics export is already open.");
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) throw invalidDiagnosticRequest();
      exportInFlight = true;
      let invalidated = false;
      const disposeInvalidation = owner.onInvalidated(() => {
        invalidated = true;
      });
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        const result = await dialog.showSaveDialog(parent, {
          title: "Export performance diagnostics",
          defaultPath: `aiden-performance-diagnostics-${stamp}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        if (invalidated || result.canceled || !result.filePath) return { saved: false };
        try {
          await writePerformanceDiagnosticExport(
            result.filePath,
            diagnosticMetadata({
              appVersion: app.getVersion(),
              buildMode: currentRuntimeProfile().id,
              powerSource: powerMonitor.isOnBatteryPower() ? "battery" : "ac",
            }),
          );
        } catch {
          logger.warn("performance", "Performance diagnostics export failed after selection.");
          throw new Error("Aiden could not save the performance diagnostics report.");
        }
        return { saved: true };
      } finally {
        disposeInvalidation();
        exportInFlight = false;
      }
    },
  );
}
