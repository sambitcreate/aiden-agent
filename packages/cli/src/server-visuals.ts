import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { inlineGenerativeUiHostLibraries, wrapGenerativeUiHtml } from "../../../main/services/generative-ui-html.js";
import { referencedLibrary } from "../../../main/services/visual-viewer-document.js";
import { snapshotAttachment, type CapturedImage } from "../../../main/services/visual-snapshot-core.js";
import type { Attachment, ChatMessage } from "../../../main/services/types.js";
import { GENERATIVE_UI_RESIZE_MESSAGE, MAX_INLINE_VISUAL_HEIGHT, MIN_INLINE_VISUAL_HEIGHT } from "../../../renderer/shared/generative-ui-bridge.js";
import { GENERATIVE_UI_EXPORT_CSP, GENERATIVE_UI_HOST_LIBS, GENERATIVE_UI_IFRAME_SANDBOX } from "../../../renderer/shared/generative-ui.js";
import { MAX_ATTACHMENT_INLINE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "../../../renderer/shared/attachment-contract.js";
import { AIDEN_UI_LIMITS, type ChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/types.js";
import type { ChatHtmlArtifactV1, HtmlArtifactPlacementV1 } from "../../../renderer/shared/chat-artifacts.js";
import type { VisualSnapshotRefV1 } from "../../../renderer/shared/visual-snapshots.js";

/**
 * Inline visuals for chats hosted by `aiden serve`. The server has no window
 * to draw a visual in, so a phone would otherwise get nothing while Aiden
 * believed it had shown something. An HTML visual is drawn once to a still
 * picture by a Chrome or Chromium already installed at a fixed path, and the
 * picture goes to the phone as the desktop's ordinary visual snapshot (an
 * image attachment on the reply). Without a browser it is not shown, and the
 * tool result says so. A native (render_ui) visual is sent as its text
 * rendering, with charts as tables.
 *
 * Nothing here runs at startup: the browser is looked for when a visual is
 * drawn. It runs headless with a throwaway profile, offline, with every
 * request refused, its normal sandbox on, and a bounded time and image size.
 */

// ---------------------------------------------------------------------------
// Finding a browser

/**
 * The only places a browser is looked for. No PATH lookup and no override, so
 * nothing in the server's environment can point it at another program. A
 * snap-packaged Chromium (`/snap/bin`) is not listed: its private `/tmp` would
 * keep each temporary profile after the render.
 */
export const SERVER_BROWSER_PATHS: Readonly<Record<"darwin" | "linux", readonly string[]>> = Object.freeze({
  darwin: Object.freeze([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]),
  linux: Object.freeze([
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]),
});

export interface ServerBrowserFs {
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
}

export const nodeServerBrowserFs: ServerBrowserFs = {
  isFile(path) {
    try { return statSync(path).isFile(); } catch { return false; }
  },
  isExecutable(path) {
    try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; }
  },
};

/** Why the server cannot draw HTML visuals, or the browser it would use. */
export type ServerBrowser = { kind: "found"; path: string } | { kind: "none" } | { kind: "root" };

/**
 * The first listed browser that is a regular, executable file. Chrome only
 * runs as root with its sandbox turned off, which the server never does, so a
 * server running as root draws no HTML visuals at all.
 */
export function findServerBrowser(options: { platform: NodeJS.Platform; isRoot: boolean; fs?: ServerBrowserFs }): ServerBrowser {
  if (options.platform !== "darwin" && options.platform !== "linux") return { kind: "none" };
  if (options.isRoot) return { kind: "root" };
  const fs = options.fs ?? nodeServerBrowserFs;
  const path = SERVER_BROWSER_PATHS[options.platform].find((candidate) => fs.isFile(candidate) && fs.isExecutable(candidate));
  return path ? { kind: "found", path } : { kind: "none" };
}

// ---------------------------------------------------------------------------
// The page that is drawn

const COLUMN_WIDTH = 720;
const WIDE_WIDTH = 1024;
const PADDING = 16;
const CANVAS = "#f6f7f9";
const SETTLE_MS = 400;
const DEVICE_SCALE = 2;
export const SERVER_VISUAL_MAX_PNG_BYTES = 2 * 1024 * 1024;
/** A JPEG larger than this is not sent at all. */
export const SERVER_VISUAL_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SERVER_VISUAL_TIMEOUT_MS = 15_000;
/** Largest single message the browser may send back (a screenshot is one). */
const MAX_PIPE_MESSAGE_BYTES = 24 * 1024 * 1024;

/** The desktop's still-image palette, so a server picture matches a desktop snapshot. */
const LIGHT_THEME = { colorScheme: "light" as const, canvas: CANVAS, foreground: "#181817", secondary: "#6b6b68", accent: "#0b7de5" };

/** The host page frames its one srcdoc guest; libraries are inline, so no custom scheme is needed. */
const HOST_PAGE_CSP = GENERATIVE_UI_EXPORT_CSP.replace("frame-src 'none'", "frame-src about:srcdoc");

export type HostLibraryName = (typeof GENERATIVE_UI_HOST_LIBS)[number];

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function serverVisualWidth(layout: "column" | "wide" | undefined): number {
  return layout === "wide" ? WIDE_WIDTH : COLUMN_WIDTH;
}

/**
 * The page the browser draws: the visual's guest document, wrapped exactly as
 * the desktop's still image (inline, animations off) with only the libraries
 * its source names inlined, inside a sandboxed srcdoc iframe that reports its
 * height. `library` returns a library's source; aiden-ui.css is built in.
 */
export function serverVisualHostPage(html: string, title: string, width: number, library: (name: HostLibraryName) => string): string {
  const include = referencedLibrary(html);
  const libraries: Record<string, string> = {};
  for (const name of GENERATIVE_UI_HOST_LIBS) if (include(name) && name !== "aiden-ui.css") libraries[name] = library(name);
  const guest = inlineGenerativeUiHostLibraries(wrapGenerativeUiHtml(html, title, LIGHT_THEME, { inline: true, stillImage: true }), libraries, include);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HOST_PAGE_CSP}"><style>
html,body{margin:0;background:${CANVAS};overflow:hidden;}
body{padding:${PADDING}px;}
iframe{border:0;display:block;width:${width}px;height:${MIN_INLINE_VISUAL_HEIGHT}px;}
</style></head><body><iframe sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" srcdoc="${escapeAttribute(guest)}"></iframe><script>
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

// ---------------------------------------------------------------------------
// Drawing it

/**
 * The browser's switches. Headless, a fresh profile, no background services,
 * and no network: every connection goes to a closed local port and every host
 * name fails to resolve, on top of the page's own CSP and the request
 * interception below. The browser's sandbox stays on.
 */
export function serverBrowserArguments(profileDir: string, platform: NodeJS.Platform): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    "--metrics-recording-only",
    "--no-pings",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    platform === "darwin" ? "--use-mock-keychain" : "--password-store=basic",
    "about:blank",
  ];
}

/** Only what a browser needs to start; none of the server's secrets. */
function browserEnvironment(profileDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: profileDir, TMPDIR: tmpdir(), XDG_CONFIG_HOME: join(profileDir, "config"), XDG_CACHE_HOME: join(profileDir, "cache") };
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

interface CdpMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string }

/** The DevTools protocol over the browser's own pipe (fd 3 in, fd 4 out): NUL-separated JSON. */
class PipeCdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private closed: Error | undefined;
  constructor(private readonly output: Writable, input: Readable, private readonly onEvent: (message: CdpMessage) => void, private readonly onOverflow: () => void) {
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.on("error", () => this.close(new Error("The browser closed its pipe.")));
    input.on("close", () => this.close(new Error("The browser closed its pipe.")));
    output.on("error", () => this.close(new Error("The browser closed its pipe.")));
  }

  private receive(chunk: Buffer): void {
    let start = 0;
    for (let index = chunk.indexOf(0); index !== -1; index = chunk.indexOf(0, start)) {
      this.buffered.push(chunk.subarray(start, index));
      const text = Buffer.concat(this.buffered).toString("utf8");
      this.buffered = []; this.bufferedBytes = 0; start = index + 1;
      let message: CdpMessage;
      try { message = JSON.parse(text) as CdpMessage; } catch { continue; }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message ?? "The browser refused a command."));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method) {
        this.onEvent(message);
      }
    }
    if (start < chunk.length) {
      this.buffered.push(chunk.subarray(start));
      this.bufferedBytes += chunk.length - start;
      if (this.bufferedBytes > MAX_PIPE_MESSAGE_BYTES) { this.close(new Error("The browser sent too much.")); this.onOverflow(); }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.buffered = [];
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Rendering was cancelled."));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("Rendering was cancelled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

/** One render at a time on the whole server: each one starts its own browser. */
let renderQueue: Promise<unknown> = Promise.resolve();

export interface RenderServerVisualOptions {
  browserPath: string;
  hostPage: string;
  width: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * Draws one host page to a PNG (or a JPEG when the PNG is over 2 MiB) and
 * returns null when the browser fails, the visual never reports a height, the
 * time runs out, or the picture is too large. Always ends the browser and
 * deletes its profile.
 */
export function renderServerVisualImage(options: RenderServerVisualOptions): Promise<CapturedImage | null> {
  const run = renderQueue.then(() => renderNow(options), () => renderNow(options));
  renderQueue = run.catch(() => undefined);
  return run;
}

async function renderNow(options: RenderServerVisualOptions): Promise<CapturedImage | null> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SERVER_VISUAL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  if (signal.aborted) return null;
  const platform = options.platform ?? process.platform;
  const profileDir = mkdtempSync(join(tmpdir(), "aiden-visual-"));
  let child: ChildProcess | undefined;
  let cdp: PipeCdp | undefined;
  const kill = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  signal.addEventListener("abort", kill, { once: true });
  try {
    child = spawn(options.browserPath, serverBrowserArguments(profileDir, platform), {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      env: browserEnvironment(profileDir),
      cwd: profileDir,
    });
    const started = child;
    const exited = new Promise<never>((_resolve, reject) => {
      started.once("error", () => reject(new Error("The browser could not start.")));
      started.once("exit", () => reject(new Error("The browser stopped.")));
    });
    exited.catch(() => undefined);
    const connection = new PipeCdp(started.stdio[3] as Writable, started.stdio[4] as Readable, (message) => {
      // Every request any frame makes is refused; frames in their own process
      // (a sandboxed iframe can be one) are held until the same rule covers them.
      if (message.method === "Fetch.requestPaused") {
        void connection.send("Fetch.failRequest", { requestId: message.params?.requestId, errorReason: "BlockedByClient" }, message.sessionId).catch(() => undefined);
      } else if (message.method === "Target.attachedToTarget") {
        const child = (message.params?.sessionId as string | undefined);
        if (!child) return;
        void connection.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child)
          .then(() => connection.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child))
          .catch(() => undefined)
          .finally(() => connection.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => undefined));
      }
    }, kill);
    cdp = connection;
    const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (signal.aborted) return Promise.reject(new Error("Rendering was cancelled."));
      return Promise.race([connection.send(method, params, sessionId), exited]);
    };
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await call("Network.enable", {}, sessionId);
    await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    await call("Page.enable", {}, sessionId);
    const fullWidth = options.width + PADDING * 2;
    await call("Emulation.setDeviceMetricsOverride", { width: fullWidth, height: 400, deviceScaleFactor: DEVICE_SCALE, mobile: false }, sessionId);
    const { frameTree } = await call("Page.getFrameTree", {}, sessionId) as { frameTree: { frame: { id: string } } };
    await call("Page.setDocumentContent", { frameId: frameTree.frame.id, html: options.hostPage }, sessionId);
    // Wait for the visual to report its height and then stop changing.
    let height = 0;
    while (!signal.aborted) {
      const evaluated = await call("Runtime.evaluate", { expression: "JSON.stringify(window.__snap || null)", returnByValue: true }, sessionId) as { result?: { value?: unknown } };
      const snap = typeof evaluated.result?.value === "string" ? JSON.parse(evaluated.result.value) as { height?: number; changedAt?: number } | null : null;
      if (snap && typeof snap.height === "number" && snap.height > 0 && typeof snap.changedAt === "number" && Date.now() - snap.changedAt >= SETTLE_MS) {
        height = snap.height;
        break;
      }
      await sleep(100, signal);
    }
    if (!height) return null;
    const fullHeight = Math.min(height, MAX_INLINE_VISUAL_HEIGHT) + PADDING * 2;
    await call("Emulation.setDeviceMetricsOverride", { width: fullWidth, height: fullHeight, deviceScaleFactor: DEVICE_SCALE, mobile: false }, sessionId);
    await call("Runtime.evaluate", { expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", awaitPromise: true, returnByValue: true }, sessionId);
    const png = Buffer.from(String((await call("Page.captureScreenshot", { format: "png" }, sessionId)).data ?? ""), "base64");
    if (png.length > 0 && png.length <= SERVER_VISUAL_MAX_PNG_BYTES) return { bytes: png, mimeType: "image/png" };
    const jpeg = Buffer.from(String((await call("Page.captureScreenshot", { format: "jpeg", quality: 88 }, sessionId)).data ?? ""), "base64");
    return jpeg.length > 0 && jpeg.length <= SERVER_VISUAL_MAX_IMAGE_BYTES ? { bytes: jpeg, mimeType: "image/jpeg" } : null;
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", kill);
    if (child) {
      if (cdp && child.exitCode === null) {
        await Promise.race([cdp.send("Browser.close").catch(() => undefined), sleep(1_000, AbortSignal.timeout(2_000)).catch(() => undefined)]);
        await waitForExit(child, 1_000);
      }
      kill();
      await waitForExit(child, 2_000);
      cdp?.close(new Error("Rendering finished."));
    }
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------------------
// What Aiden is told

export type HtmlVisualOutcome = "image" | "no-browser" | "root" | "failed" | "full";

/** The tool result for render_artifact: exactly what the person sees. */
export function htmlVisualResultText(title: string, outcome: HtmlVisualOutcome, path: string): string {
  const name = JSON.stringify(title);
  if (outcome === "image") {
    return `Shown as an image: the person sees a still picture of the visual ${name} in the chat. It was drawn once on this server, so nothing in it moves or responds to taps. The HTML is saved at ${path}.`;
  }
  const why = outcome === "no-browser"
    ? "this server has no Chrome or Chromium installed to draw it"
    : outcome === "root"
      ? "this server runs as root, where it does not draw visuals"
      : outcome === "full"
        ? "this reply already carries as many pictures as one message can"
        : "drawing it failed or took too long";
  return `Not shown: the person cannot see the visual ${name}, because ${why}. Give the key facts in your reply as text or a Markdown table. The HTML is saved at ${path}.`;
}

export type UiVisualOutcome = "text" | "full" | "failed";

/** The tool result for render_ui: the text the person's app shows in its place, or that it shows nothing. */
export function uiVisualResultText(title: string, fallbackText: string, outcome: UiVisualOutcome, repairs: readonly string[]): string {
  const name = JSON.stringify(title);
  const head = outcome === "text"
    ? `Shown as text: the person's app shows ${name} as the text below, not as a drawn visual (charts appear as tables).`
    : `Not shown: the person cannot see ${name}, because ${outcome === "full" ? "this reply or chat already has as many visuals as it can hold" : "Aiden could not store it"}. Give the key facts in your reply as text or a Markdown table. Its text would have been:`;
  return [head, "", fallbackText, ...(repairs.length ? ["", "Repairs:", ...repairs] : [])].join("\n");
}

// ---------------------------------------------------------------------------
// Keeping them with the reply

interface CollectedHtml { toolCallId: string; artifact: ChatHtmlArtifactV1; layout?: "wide"; image: CapturedImage }
interface CollectedUi { toolCallId: string; visual: ChatUiVisualV1 }

/** The visuals one turn produced, saved on its reply in the same write. */
export interface ServerVisualCollector {
  /** Whether one more picture of `bytes` still fits on the reply. */
  canHoldImage(bytes: number): boolean;
  addHtml(entry: CollectedHtml): boolean;
  canHoldUi(): boolean;
  addUi(entry: CollectedUi): boolean;
  /**
   * The reply's visual fields: artifacts, placements, native visuals, and
   * each picture as a reserved snapshot attachment. Raw tool call ids become
   * the timeline's public ones; a visual whose call has none keeps no placement.
   */
  messageFields(chatId: string, messageId: string, publicToolCallId: (raw: string) => string | undefined): Pick<ChatMessage, "htmlArtifacts" | "htmlArtifactPlacements" | "uiVisuals" | "attachments" | "visualSnapshots">;
}

export function createServerVisualCollector(options: { existingUiVisuals?: number } = {}): ServerVisualCollector {
  const html: CollectedHtml[] = [];
  const ui: CollectedUi[] = [];
  let imageBytes = 0;
  const canHoldImage = (bytes: number) => html.length < MAX_ATTACHMENTS_PER_MESSAGE && imageBytes + bytes <= MAX_ATTACHMENT_INLINE_BYTES;
  const canHoldUi = () => ui.length < AIDEN_UI_LIMITS.perResponse && (options.existingUiVisuals ?? 0) + ui.length < AIDEN_UI_LIMITS.perChat;
  return {
    canHoldImage,
    addHtml(entry) {
      if (!canHoldImage(entry.image.bytes.length)) return false;
      html.push(entry); imageBytes += entry.image.bytes.length;
      return true;
    },
    canHoldUi,
    addUi(entry) {
      if (!canHoldUi()) return false;
      ui.push(entry);
      return true;
    },
    messageFields(chatId, messageId, publicToolCallId) {
      if (!html.length && !ui.length) return {};
      const attachments: Attachment[] = [];
      const visualSnapshots: VisualSnapshotRefV1[] = [];
      const placements: HtmlArtifactPlacementV1[] = [];
      for (const entry of html) {
        const attachment = snapshotAttachment(chatId, messageId, { ...entry.image, visualId: entry.artifact.mediaId, title: entry.artifact.title });
        attachments.push(attachment);
        visualSnapshots.push({ visualId: entry.artifact.mediaId, attachmentId: attachment.id });
        const toolCallId = publicToolCallId(entry.toolCallId);
        if (toolCallId) placements.push({ mediaId: entry.artifact.mediaId, toolCallId, ...(entry.layout ? { layout: entry.layout } : {}) });
      }
      const uiVisuals = ui.map(({ toolCallId, visual }) => {
        const publicId = publicToolCallId(toolCallId);
        return publicId ? { ...visual, toolCallId: publicId } : visual;
      });
      return {
        ...(html.length ? { htmlArtifacts: html.map((entry) => entry.artifact), htmlArtifactPlacements: placements, attachments, visualSnapshots } : {}),
        ...(uiVisuals.length ? { uiVisuals } : {}),
      };
    },
  };
}

/** The opaque ids the desktop gives a visual, from the session and its tool call. */
export function serverVisualIds(sessionId: string, toolCallId: string): { mediaId: string; uiId: string } {
  const digest = createHash("sha256").update(sessionId).update("\0").update(toolCallId).digest("hex");
  return { mediaId: digest, uiId: `ui-${digest.slice(0, 40)}` };
}
