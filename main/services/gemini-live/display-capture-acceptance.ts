import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, session } from "electron";

import type { RuntimeProfile } from "../../runtime-profile-core.js";
import {
  evaluateDisplayCaptureAcceptance,
  GEMINI_LIVE_CAPTURE_ACCEPTANCE_RECEIPT,
  parseCaptureAcceptanceLaunch,
} from "./display-capture-acceptance-core.js";

const ACCEPTANCE_TIMEOUT_MS = 15 * 60 * 1_000;
const AIDEN_BUNDLE_ID = "com.sambitcreate.aiden-agent";

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Aiden display capture acceptance</title>
<style>
  body { font: 15px system-ui; max-width: 620px; margin: 48px auto; padding: 0 24px; line-height: 1.5; }
  button { font: inherit; padding: 10px 16px; }
  #status { margin-top: 20px; white-space: pre-wrap; }
</style>
<h1>Aiden display capture acceptance</h1>
<p>This isolated test opens the macOS screen/window chooser twice. Select a disposable source, stop sharing from macOS, then cancel the second chooser.</p>
<button id="start" type="button">Begin acceptance</button>
<div id="status" role="status">Nothing is captured until you begin.</div>
<script type="module">
  let resolveResult;
  window.aidenCaptureAcceptanceResult = new Promise((resolve) => { resolveResult = resolve; });
  const status = document.querySelector("#status");
  const start = document.querySelector("#start");
  start.addEventListener("click", async () => {
    start.disabled = true;
    try {
      status.textContent = "Choose one disposable screen or window.";
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      if (!track || track.readyState !== "live") throw new Error("display_source_not_live");
      status.textContent = "Now stop sharing using the macOS sharing control. Do not close this window.";
      await new Promise((resolve) => track.addEventListener("ended", resolve, { once: true }));
      status.textContent = "The chooser will open again. Cancel it without selecting a source.";
      let pickerCancelled = false;
      let pickerCancellationErrorName = null;
      try {
        await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch (error) {
        pickerCancelled = true;
        pickerCancellationErrorName = error instanceof DOMException ? error.name : null;
      }
      status.textContent = pickerCancelled ? "Capture checks complete. Aiden is verifying the replacement-document boundary." : "The second chooser was not cancelled.";
      resolveResult({ externalSourceEnded: true, pickerCancelled, pickerCancellationErrorName });
    } catch (error) {
      resolveResult({ error: error instanceof Error ? error.message : "capture_failed" });
    }
  }, { once: true });
</script>`;

const replacementHtml = `<!doctype html><meta charset="utf-8"><title>Replacement document</title>`;

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback_bind_failed");
  return address.port;
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operator_timeout")), ACCEPTANCE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

export async function runDisplayCaptureAcceptance(profile: RuntimeProfile): Promise<number> {
  const launch = parseCaptureAcceptanceLaunch({
    argv: process.argv,
    environment: process.env,
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    userDataPath: profile.userDataPath,
  });
  if (!launch.requested || !launch.accepted) {
    process.stderr.write(`Gemini Live display capture acceptance refused: ${launch.requested ? launch.error : "acceptance_flags_missing"}\n`);
    return 1;
  }

  const startedAt = new Date();
  const receiptPath = path.join(
    launch.profilePath,
    GEMINI_LIVE_CAPTURE_ACCEPTANCE_RECEIPT,
  );
  let browser: BrowserWindow | undefined;
  let server: Server | undefined;
  let permissionChecks = 0;
  let permissionRequests = 0;
  let nativeFallbackRequests = 0;
  let replacementPermissionDenials = 0;
  let testingReplacement = false;
  try {
    await app.whenReady();
    server = createServer((request, response) => {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(request.url === "/replacement" ? replacementHtml : html);
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    browser = new BrowserWindow({
      show: true,
      title: "Aiden display capture acceptance",
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const electronSession = session.defaultSession;
    let boundDocument: string | null = null;
    let boundUrl: string | null = null;
    const acceptanceWindow = browser;
    const allowedDocument = (
      webContents: Electron.WebContents | null,
      permission: string,
    ) =>
      webContents === acceptanceWindow.webContents &&
      permission === "display-capture" &&
      boundDocument !== null &&
      acceptanceWindow.webContents.mainFrame.frameToken === boundDocument &&
      acceptanceWindow.webContents.mainFrame.url === boundUrl;

    electronSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const permissionName = String(permission);
      const allowed =
        allowedDocument(webContents, permissionName) &&
        new URL(requestingOrigin).origin === origin &&
        details.isMainFrame === true;
      if (permissionName === "display-capture") permissionChecks += 1;
      if (permissionName === "display-capture" && testingReplacement && !allowed) {
        replacementPermissionDenials += 1;
      }
      return allowed;
    });
    electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const permissionName = String(permission);
      const allowed =
        allowedDocument(webContents, permissionName) && details.isMainFrame === true;
      if (permissionName === "display-capture") permissionRequests += 1;
      if (permissionName === "display-capture" && testingReplacement && !allowed) {
        replacementPermissionDenials += 1;
      }
      callback(allowed);
    });
    electronSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        nativeFallbackRequests += 1;
        callback({});
      },
      { useSystemPicker: true },
    );

    await browser.loadURL(`${origin}/`);
    boundDocument = browser.webContents.mainFrame.frameToken;
    boundUrl = browser.webContents.mainFrame.url;
    const renderer = (await withDeadline(
      browser.webContents.executeJavaScript("window.aidenCaptureAcceptanceResult", true),
    )) as {
      error?: string;
      externalSourceEnded?: boolean;
      pickerCancelled?: boolean;
      pickerCancellationErrorName?: string | null;
    };
    if (renderer.error) throw new Error(renderer.error);

    const fallbackBeforeReplacement = nativeFallbackRequests;
    await browser.loadURL(`${origin}/replacement`);
    testingReplacement = true;
    let navigationRejected = false;
    try {
      await browser.webContents.executeJavaScript(
        "navigator.mediaDevices.getDisplayMedia({video:true,audio:false})",
        true,
      );
    } catch {
      navigationRejected = true;
    } finally {
      testingReplacement = false;
    }
    const replacementChooserFallbackRequests =
      nativeFallbackRequests - fallbackBeforeReplacement;
    const evaluated = evaluateDisplayCaptureAcceptance({
      displayPermissionPath: permissionChecks + permissionRequests > 0,
      externalSourceEnded: renderer.externalSourceEnded === true,
      nativeFallbackRequests,
      navigationRejected,
      pickerCancellationErrorName: renderer.pickerCancellationErrorName ?? null,
      pickerCancelled: renderer.pickerCancelled === true,
      replacementChooserFallbackRequests,
      replacementDocumentDenied:
        navigationRejected && replacementPermissionDenials > 0,
    });
    if (!evaluated.accepted) throw new Error("acceptance_contract_incomplete");

    const completedAt = new Date();
    await writePrivateJson(receiptPath, {
      schemaVersion: 1,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      runTokenSha256: createHash("sha256").update(launch.token).digest("hex"),
      artifact: {
        bundleIdentifier: AIDEN_BUNDLE_ID,
        shortVersion: app.getVersion(),
        appAsarSha256: await sha256(app.getAppPath()),
      },
      runtime: {
        electron: process.versions.electron,
        macOS: os.release(),
        arch: process.arch,
      },
      checks: evaluated.checks,
    });
    return 0;
  } catch (error) {
    process.stderr.write(
      `Gemini Live display capture acceptance failed: ${error instanceof Error ? error.message : "unknown_error"}\n`,
    );
    return 1;
  } finally {
    session.defaultSession.setPermissionCheckHandler(null);
    session.defaultSession.setPermissionRequestHandler(null);
    session.defaultSession.setDisplayMediaRequestHandler(null);
    browser?.destroy();
    const activeServer = server;
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    }
  }
}
