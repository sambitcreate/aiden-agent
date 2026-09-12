import path from "node:path";
import { randomUUID } from "node:crypto";
import { crashReporter } from "electron";

import {
  RENDERER_DIAGNOSTIC_KINDS,
  normalizeDiagnosticErrorType,
  type RendererDiagnosticKind,
  type RendererDiagnosticPolicy,
  type RendererDiagnosticReport,
} from "../../renderer/shared/diagnostics.js";
import { app, BrowserWindow, dialog, ipcMain, shell } from "../platform.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import { writeDiagnosticEvent } from "../services/diagnostic-journal.js";
import type { DiagnosticEventName } from "../services/diagnostics-contract.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { createRendererDiagnosticRateLimiter } from "../services/renderer-diagnostic-rate.js";
import {
  createDiagnosticExport,
  deleteAllDiagnosticData,
  diagnosticSupportStatus,
  enableLocalCrashCapture,
  pruneExpiredDiagnosticCrashDumps,
} from "../services/diagnostic-support.js";

const RENDERER_CONTEXTS = new Set(["root", "router", "subtree", "window"]);
const SAFE_REFERENCE = /^RD-[A-Za-z0-9-]{8,80}$/u;
const MAIN_RATE_WINDOW_MS = 60_000;
const MAIN_MAX_PER_KEY = 3;
const MAIN_MAX_PER_WINDOW = 60;

const mainRateLimiter = createRendererDiagnosticRateLimiter(
  MAIN_RATE_WINDOW_MS,
  MAIN_MAX_PER_KEY,
  MAIN_MAX_PER_WINDOW,
);
const registeredRateDocuments = new Set<string>();

function diagnosticOwner(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(event, () => new Error("Untrusted diagnostics sender."));
}

function parseRendererReport(value: unknown): RendererDiagnosticReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid renderer diagnostic report.");
  }
  const input = value as Record<string, unknown>;
  if (!RENDERER_DIAGNOSTIC_KINDS.includes(input.kind as RendererDiagnosticKind)) {
    throw new Error("Invalid renderer diagnostic kind.");
  }
  if (typeof input.errorType !== "string" || normalizeDiagnosticErrorType(input.errorType) !== input.errorType) {
    throw new Error("Invalid renderer diagnostic error type.");
  }
  if (typeof input.context !== "string" || !RENDERER_CONTEXTS.has(input.context)) {
    throw new Error("Invalid renderer diagnostic context.");
  }
  if (typeof input.referenceId !== "string" || !SAFE_REFERENCE.test(input.referenceId)) {
    throw new Error("Invalid renderer diagnostic reference.");
  }
  if (
    input.suppressed !== undefined &&
    (!Number.isSafeInteger(input.suppressed) || Number(input.suppressed) < 1 || Number(input.suppressed) > 10_000)
  ) {
    throw new Error("Invalid renderer diagnostic suppression count.");
  }
  return input as unknown as RendererDiagnosticReport;
}

const RENDERER_EVENT_NAMES: Readonly<Record<RendererDiagnosticKind, DiagnosticEventName>> = {
  "global-error": "renderer-global-error",
  "unhandled-rejection": "renderer-unhandled-rejection",
  "react-uncaught": "renderer-react-uncaught",
  "react-caught": "renderer-react-caught",
  "react-recoverable": "renderer-react-recoverable",
  "route-error": "renderer-route-error",
};

export function registerDiagnosticHandlers(): void {
  const profile = currentRuntimeProfile();
  const roots = { logsPath: profile.logsPath, crashDumpsPath: profile.crashDumpsPath };
  const rendererForwardingEnabled =
    process.env.AIDEN_DISABLE_RENDERER_DIAGNOSTICS !== "1" &&
    !(profile.id === "production" && process.env.AIDEN_DISABLE_PRODUCTION_DIAGNOSTICS === "1");

  ipcMain.handle("diagnostics:policy", async (event): Promise<RendererDiagnosticPolicy> => {
    diagnosticOwner(event);
    return {
      enabled: rendererForwardingEnabled,
      runtimeProfile: profile.id,
      windowMs: MAIN_RATE_WINDOW_MS,
      maxPerKey: MAIN_MAX_PER_KEY,
    };
  });

  ipcMain.handle("diagnostics:renderer-event", async (event, value: unknown) => {
    const owner = diagnosticOwner(event);
    const report = parseRendererReport(value);
    if (!registeredRateDocuments.has(owner.documentId)) {
      registeredRateDocuments.add(owner.documentId);
      owner.onInvalidated(() => {
        mainRateLimiter.clear(owner.documentId);
        registeredRateDocuments.delete(owner.documentId);
      });
    }
    if (!rendererForwardingEnabled || !mainRateLimiter.admit(owner.documentId, report)) {
      return { accepted: false, referenceId: report.referenceId };
    }
    const durableReferenceId = `RD-${randomUUID()}`;
    writeDiagnosticEvent({
      level: report.suppressed ? "warn" : "error",
      area: "renderer",
      event: RENDERER_EVENT_NAMES[report.kind],
      outcome: report.suppressed ? "degraded" : "failed",
      code: "renderer-crashed",
      fields: {
        errorType: report.errorType,
        rendererContext: report.context,
        referenceId: durableReferenceId,
        suppressed: report.suppressed ?? 0,
      },
    });
    return { accepted: true, referenceId: durableReferenceId };
  });

  ipcMain.handle("diagnostics:status", async (event) => {
    diagnosticOwner(event);
    return diagnosticSupportStatus(roots);
  });
  ipcMain.handle("diagnostics:reveal", async (event) => {
    diagnosticOwner(event);
    const error = await shell.openPath(profile.logsPath);
    if (error) throw new Error("Aiden could not reveal the diagnostics folder.");
    return true;
  });
  ipcMain.handle("diagnostics:export", async (event, includeCrashDumps: unknown) => {
    diagnosticOwner(event);
    if (typeof includeCrashDumps !== "boolean") throw new Error("Invalid crash dump export choice.");
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) throw new Error("Diagnostics require the active Aiden window.");
    if (includeCrashDumps) {
      const confirmation = await dialog.showMessageBox(parent, {
        type: "warning",
        title: "Include sensitive crash dumps?",
        message: "Crash memory may contain prompts, workspace content, credentials, or other in-memory data.",
        detail: "The export stays on this device. Aiden will not upload it.",
        buttons: ["Cancel", "Include & export"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { exported: false as const };
    }
    const selection = parent
      ? await dialog.showSaveDialog(parent, {
          title: "Export Aiden diagnostics",
          defaultPath: path.join(app.getPath("downloads"), `Aiden-Diagnostics-${Date.now()}.json.gz`),
          filters: [{ name: "Compressed JSON", extensions: ["gz"] }],
        })
      : await dialog.showSaveDialog({
          title: "Export Aiden diagnostics",
          defaultPath: path.join(app.getPath("downloads"), `Aiden-Diagnostics-${Date.now()}.json.gz`),
          filters: [{ name: "Compressed JSON", extensions: ["gz"] }],
        });
    if (selection.canceled || !selection.filePath) return { exported: false as const };
    const manifest = await createDiagnosticExport({
      ...roots,
      destination: selection.filePath,
      includeCrashDumps,
      app: { name: app.getName(), version: app.getVersion(), runtimeProfile: profile.id },
    });
    return { exported: true as const, manifest };
  });
  ipcMain.handle("diagnostics:delete", async (event) => {
    diagnosticOwner(event);
    await deleteAllDiagnosticData(roots);
    return true;
  });
  ipcMain.handle("diagnostics:mode-enable", async (event) => {
    diagnosticOwner(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) throw new Error("Diagnostics require the active Aiden window.");
    const confirmation = await dialog.showMessageBox(parent, {
      type: "warning",
      title: "Enable local crash capture?",
      message: "Crash memory may contain prompts, workspace content, credentials, or other in-memory data.",
      detail: "Dumps stay on this device, are never uploaded automatically, and capture turns off when Aiden restarts.",
      buttons: ["Cancel", "Enable until restart"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { enabled: false as const, expiresAt: null, disablesOnRestart: true as const };
    await pruneExpiredDiagnosticCrashDumps(profile.crashDumpsPath);
    const result = enableLocalCrashCapture(() => {
      crashReporter.start({
        uploadToServer: false,
        compress: false,
        globalExtra: { runtimeProfile: profile.id, diagnosticMode: "explicit" },
      });
    });
    writeDiagnosticEvent({
      level: "warn",
      area: "diagnostics",
      event: "diagnostic-mode-enabled",
      outcome: "started",
      fields: { uploadEnabled: false },
    });
    return result;
  });
}
