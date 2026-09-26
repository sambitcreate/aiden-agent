import { createServer } from "node:http";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { app, BrowserWindow, desktopCapturer, session } from "electron";

import {
  CUSTOM_HANDLER_MODE,
  evaluateDisplayCaptureEvidence,
} from "./gemini-live-electron-spike-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const packagedAssets = process.argv.includes("--packaged");
const receiptPath = path.join(
  repositoryRoot,
  "build",
  packagedAssets
    ? "gemini-live-packaged-spike.json"
    : "gemini-live-electron-spike.json",
);

async function findAsar(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "app.asar") return candidate;
    if (entry.isDirectory()) {
      const nested = await findAsar(candidate).catch(() => null);
      if (nested) return nested;
    }
  }
  return null;
}

async function workletSource() {
  if (!packagedAssets) {
    return readFile(path.join(repositoryRoot, "build/renderer/gemini-live-pcm-worklet.js"));
  }
  const asar = await findAsar(path.join(repositoryRoot, "release/development"));
  if (!asar) throw new Error("The development package does not contain app.asar.");
  return readFile(path.join(asar, "build/renderer/gemini-live-pcm-worklet.js"));
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>Gemini Live deterministic Electron contract</title>
<script type="module">
  const deadline = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out")), 5000)),
  ]);
  window.runDeterministicContract = async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule("/gemini-live-pcm-worklet.js");
    const node = new AudioWorkletNode(context, "aiden-gemini-live-pcm");
    const oscillator = new OscillatorNode(context);
    const gain = new GainNode(context, { gain: 0 });
    const pcm = deadline(new Promise((resolve) => { node.port.onmessage = (event) => resolve(event.data); }), "AudioWorklet PCM");
    oscillator.connect(node).connect(gain).connect(context.destination);
    oscillator.start();
    await context.resume();
    const packet = await pcm;
    oscillator.stop();
    node.disconnect();
    await context.close();
    if (packet.type !== "pcm" || packet.sampleRate !== 16000 || packet.durationMs !== 20 || packet.channels !== 1 || packet.data.byteLength !== 640) {
      throw new Error("The built AudioWorklet emitted an invalid packet.");
    }

    const stream = await deadline(navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }), "display capture");
    const [track] = stream.getVideoTracks();
    if (!track || track.readyState !== "live") throw new Error("Display source did not start.");
    track.stop();
    const localTrackStopTeardown = track.readyState === "ended";
    let pickerCancelled = false;
    try {
      await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      pickerCancelled = true;
    }
    return { localTrackStopTeardown, pickerCancelled };
  };
</script>`;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Spike server did not bind.");
  return address.port;
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

async function run() {
  await app.whenReady();
  await rm(receiptPath, { force: true });
  let browser;
  let server;
  let exitCode = 1;
  let customDisplayRequests = 0;
  try {
    const worklet = await workletSource();
    server = createServer((request, response) => {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": request.url === "/gemini-live-pcm-worklet.js"
          ? "text/javascript"
          : "text/html; charset=utf-8",
      });
      response.end(request.url === "/gemini-live-pcm-worklet.js" ? worklet : html);
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    browser = new BrowserWindow({
      show: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let boundDocument = null;
    let boundUrl = null;
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) =>
        webContents === browser.webContents &&
        permission === "display-capture" &&
        new URL(requestingOrigin).origin === origin &&
        details.isMainFrame === true &&
        browser.webContents.mainFrame.frameToken === boundDocument &&
        browser.webContents.mainFrame.url === boundUrl,
    );
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) =>
        callback(
          webContents === browser.webContents &&
          permission === "display-capture" &&
          details.isMainFrame === true &&
          browser.webContents.mainFrame.frameToken === boundDocument &&
          browser.webContents.mainFrame.url === boundUrl,
        ),
    );
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      customDisplayRequests += 1;
      if (customDisplayRequests !== 1) {
        callback({});
        return;
      }
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
      callback(sources[0] ? { video: sources[0] } : {});
    });

    await browser.loadURL(`${origin}/`);
    boundDocument = browser.webContents.mainFrame.frameToken;
    boundUrl = browser.webContents.mainFrame.url;
    const rendererOutcome = await browser.webContents.executeJavaScript(
      "window.runDeterministicContract().then(result => ({ result }), error => ({ error: String(error), stack: error?.stack }))",
      true,
    );
    if (rendererOutcome?.error) {
      throw new Error(
        `${rendererOutcome.error}${rendererOutcome.stack ? `\n${rendererOutcome.stack}` : ""}`,
      );
    }
    const renderer = rendererOutcome?.result;
    await browser.loadURL(`${origin}/replacement`);
    let navigationRejected = false;
    try {
      await browser.webContents.executeJavaScript(
        "navigator.mediaDevices.getDisplayMedia({video:true,audio:false})",
        true,
      );
    } catch {
      navigationRejected = true;
    }
    const evidence = evaluateDisplayCaptureEvidence({
      captureMode: CUSTOM_HANDLER_MODE,
      customDisplayRequests,
      displayPermissionPath: true,
      nativeFallbackRequests: 0,
      navigationRejected,
      replacementChooserFallbackRequests: 0,
      replacementDocumentDenied: navigationRejected,
      pickerCancelled: renderer.pickerCancelled === true,
      pickerCancellationErrorName: null,
      requireDisplay: false,
      externalSourceEnded: false,
      localTrackStopTeardown: renderer.localTrackStopTeardown === true,
    });
    if (!evidence.deterministicCustomHandlerContract) {
      throw new Error("The deterministic custom-handler contract was incomplete.");
    }
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        electron: process.versions.electron,
        packagedAssets,
        evidenceClass: "dependency_electron_deterministic_only",
        builtAudioWorkletExecuted: true,
        deterministicCustomHandlerContractPassed: true,
      }, null, 2)}\n`,
      "utf8",
    );
    exitCode = 0;
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        electron: process.versions.electron,
        packagedAssets,
        evidenceClass: "dependency_electron_deterministic_only",
        passed: false,
        error: detail,
      }, null, 2)}\n`,
      "utf8",
    );
    process.stderr.write(`${detail}\n`);
  } finally {
    session.defaultSession.setPermissionCheckHandler(null);
    session.defaultSession.setPermissionRequestHandler(null);
    session.defaultSession.setDisplayMediaRequestHandler(null);
    browser?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    process.exit(exitCode);
  }
}

void run();
