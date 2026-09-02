import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import type { WorkspaceOperationAdmission } from "./workspace-operation-registry.js";
import { readGenerativeUiHostLibrary } from "./generative-ui-host-libraries.js";
import {
  authorizeSourcePreviewHttpRedirect,
  authorizeSourcePreviewHttpRequest,
  issueSourcePreviewTransportProof,
  type SourcePreviewTransportProofV1,
} from "./source-preview-transport-core.js";
import {
  detectNextPreviewRuntimeAdapters,
  nextPreviewLaunchArguments,
  type NextPreviewRuntimeAdapter,
} from "./source-preview-next-runtime-adapter.js";
import {
  attachSourcePreviewWebSocketProxy,
  type SourcePreviewWebSocketProxy,
} from "./source-preview-websocket-proxy.js";
import {
  SOURCE_DESIGNER_VERSION,
  SOURCE_DESIGN_PICKER_COMMAND,
  SOURCE_DESIGN_PICKER_SELECTION,
  type SourcePreviewScriptV1,
  type SourcePreviewStateV1,
} from "../../renderer/shared/source-designer.js";

const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_LOG_LINES = 80;
const MAX_LOG_LINE_CHARS = 600;
const START_TIMEOUT_MS = 25_000;
const SPECIAL_PREFIX = "/__aiden_design__/";
export const SOURCE_PREVIEW_MAX_REDIRECT_HOPS = 5;

const LOOPBACK_ADDRESS = "127.0.0.1";
const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const VITE_HTTP_QUERY_KEYS = [
  "direct",
  "html-proxy",
  "id",
  "import",
  "index",
  "inline",
  "lang",
  "raw",
  "sharedworker",
  "source",
  "t",
  "url",
  "used",
  "v",
  "worker",
];

interface PreviewSession {
  id: string;
  projectId: string;
  workspaceId: string;
  root: string;
  owner: RendererDocumentOwner;
  admission: WorkspaceOperationAdmission;
  script: SourcePreviewScriptV1;
  capability: string;
  targetPort: number;
  proxyPort: number;
  child: ChildProcess;
  proxy: http.Server;
  webSocketProxy: SourcePreviewWebSocketProxy;
  logs: string[];
  terminal?: { reason: string };
  stopping: boolean;
}

interface VitePreviewRuntimeAdapter {
  framework: "vite";
  script: SourcePreviewScriptV1;
}

type SourcePreviewRuntimeAdapter = VitePreviewRuntimeAdapter | NextPreviewRuntimeAdapter;

export interface SourcePreviewAuthority {
  root: string;
  sessionId: string;
  projectId: string;
  workspaceId: string;
  ownerDocumentId: string;
}

function safeScriptName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function packageManager(root: string): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if ((await exists(path.join(root, "bun.lock"))) || (await exists(path.join(root, "bun.lockb")))) {
    return "bun";
  }
  return "npm";
}

async function detectVitePreviewRuntimeAdapters(
  root: string,
): Promise<VitePreviewRuntimeAdapter[]> {
  const packagePath = path.join(root, "package.json");
  let contents: string;
  try {
    const stat = await fs.stat(packagePath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return [];
    contents = await fs.readFile(packagePath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const manager = await packageManager(root);
  return Object.entries(scripts as Record<string, unknown>)
    .filter(
      ([name, command]) =>
        safeScriptName(name) &&
        typeof command === "string" &&
        command.length <= 4_096 &&
        /(?:^|[\s;&])vite(?:[\s;&]|$)/u.test(command) &&
        !/(?:^|:)build$/u.test(name),
    )
    .sort(([left], [right]) => {
      const preferred = (name: string) => (name === "dev" ? 0 : name === "start" ? 1 : 2);
      return preferred(left) - preferred(right) || left.localeCompare(right);
    })
    .slice(0, 4)
    .map(([name]) => ({
      framework: "vite" as const,
      script: {
        id: name,
        label: name === "dev" ? "Development app" : name,
        command: `${manager} run ${name} -- --host 127.0.0.1 --port <port> --strictPort`,
      },
    }));
}

async function detectSourcePreviewRuntimeAdapters(
  root: string,
): Promise<SourcePreviewRuntimeAdapter[]> {
  const [vite, next] = await Promise.all([
    detectVitePreviewRuntimeAdapters(root),
    detectNextPreviewRuntimeAdapters(root, {
      sourceGraphState: "current",
      manifestFormatVersion: 1,
    }),
  ]);
  const adapters: SourcePreviewRuntimeAdapter[] = [];
  const scriptIds = new Set<string>();
  for (const adapter of [...next, ...vite]) {
    const scriptId = publicScript(adapter).id;
    if (scriptIds.has(scriptId)) continue;
    scriptIds.add(scriptId);
    adapters.push(adapter);
    if (adapters.length === 4) break;
  }
  return adapters;
}

function publicScript(adapter: SourcePreviewRuntimeAdapter): SourcePreviewScriptV1 {
  return adapter.framework === "vite"
    ? adapter.script
    : { id: adapter.scriptId, label: adapter.label, command: adapter.command };
}

export async function detectSourcePreviewScripts(root: string): Promise<SourcePreviewScriptV1[]> {
  return (await detectSourcePreviewRuntimeAdapters(root)).map(publicScript);
}

function launchArguments(
  adapter: SourcePreviewRuntimeAdapter,
  port: number,
): { command: string; args: string[] } {
  if (adapter.framework === "next") {
    return nextPreviewLaunchArguments(adapter.packageManager, adapter.scriptId, port);
  }
  const commandLabel = adapter.script.command;
  const scriptId = adapter.script.id;
  const command = commandLabel.split(" ", 1)[0];
  if (!command || !new Set(["npm", "pnpm", "yarn", "bun"]).has(command)) {
    throw new Error("The preview package manager is unsupported.");
  }
  return {
    command,
    args: ["run", scriptId, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function appendLog(session: PreviewSession, chunk: string): void {
  for (const rawLine of chunk.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    session.logs.push(line.slice(0, MAX_LOG_LINE_CHARS));
  }
  if (session.logs.length > MAX_LOG_LINES) {
    session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  }
}

function terminateOwnedProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}

function forceTerminateOwnedProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

function sourceBridge(capability: string): string {
  return `(() => {
  "use strict";
  const capability = ${JSON.stringify(capability)};
  const commandType = ${JSON.stringify(SOURCE_DESIGN_PICKER_COMMAND)};
  const selectionType = ${JSON.stringify(SOURCE_DESIGN_PICKER_SELECTION)};
  const primitives = globalThis.AidenReactGrabPrimitives;
  if (!primitives) return;
  let enabled = false;
  let selectedSelector = "";
  const overlay = document.createElement("div");
  overlay.setAttribute("data-react-grab-ignore", "");
  Object.assign(overlay.style, {
    position: "fixed", pointerEvents: "none", zIndex: "2147483647",
    border: "2px solid #0a84ff", borderRadius: "4px", display: "none",
    boxSizing: "border-box", background: "rgba(10,132,255,.07)"
  });
  document.documentElement.append(overlay);
  const show = (element) => {
    const bounds = primitives.getElementBounds(element);
    Object.assign(overlay.style, {
      display: "block", left: bounds.x + "px", top: bounds.y + "px",
      width: bounds.width + "px", height: bounds.height + "px"
    });
  };
  const label = (element) => {
    const named = element.getAttribute("aria-label") || element.getAttribute("title");
    const text = (element.textContent || "").replace(/\\s+/g, " ").trim();
    return (named || text || element.id || element.tagName.toLowerCase()).slice(0, 160);
  };
  const select = async (element, additive) => {
    if (!(element instanceof Element) || !primitives.isElementGrabbable(element)) return;
    show(element);
    const selector = primitives.getElementSelector(element);
    selectedSelector = selector;
    let selectorMatchCount = 0;
    try { selectorMatchCount = document.querySelectorAll(selector).length; } catch {}
    let context = null;
    try { context = await primitives.getElementContext(element); } catch {}
    const payload = {
      version: 1,
      selection: {
        version: 1,
        tagName: element.tagName.toLowerCase(),
        label: label(element),
        selector,
        ...(element.id ? { elementId: element.id.slice(0, 120) } : {}),
        ...(element.getAttribute("role") ? { role: element.getAttribute("role").slice(0, 64) } : {}),
        ...((element.textContent || "").trim() ? { text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240) } : {})
      },
      ...(context && context.filePath ? { filePath: String(context.filePath).slice(0, 4096) } : {}),
      ...(context && Number.isSafeInteger(context.lineNumber) ? { lineNumber: context.lineNumber } : {}),
      ...(context && Number.isSafeInteger(context.columnNumber) ? { columnNumber: context.columnNumber } : {}),
      ...(context && context.componentName ? { componentName: String(context.componentName).slice(0, 160) } : {})
      ,...(Number.isSafeInteger(selectorMatchCount) ? { selectorMatchCount } : {})
    };
    parent.postMessage({ type: selectionType, capability, descriptor: payload, additive }, "*");
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== commandType || data.capability !== capability) return;
    enabled = data.enabled === true;
    selectedSelector = typeof data.selectedSelector === "string" ? data.selectedSelector : "";
    overlay.style.display = "none";
    if (enabled && selectedSelector) {
      try { const element = document.querySelector(selectedSelector); if (element) show(element); } catch {}
    }
  });
  addEventListener("pointerdown", (event) => {
    if (!enabled) return;
    const exact = primitives.getElementAtPoint(event.clientX, event.clientY);
    if (!exact) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void select(exact, event.shiftKey === true);
  }, true);
  addEventListener("click", (event) => {
    if (!enabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") parent.postMessage("aiden:generative-ui:escape", "*");
    if (!enabled || event.key !== "Enter") return;
    const exact = document.activeElement;
    if (!(exact instanceof Element)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void select(exact, event.shiftKey === true);
  }, true);
})();`;
}

export function injectSourceDesignerScripts(html: string): string {
  const tags = `<script src="${SPECIAL_PREFIX}react-grab.js"></script><script src="${SPECIAL_PREFIX}bridge.js"></script>`;
  const bodyIndex = html.toLowerCase().lastIndexOf("</body>");
  if (bodyIndex >= 0) return `${html.slice(0, bodyIndex)}${tags}${html.slice(bodyIndex)}`;
  return `${html}${tags}`;
}

function responseHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of source.entries()) {
    const lower = name.toLowerCase();
    if (
      lower === "content-length" ||
      lower === "content-encoding" ||
      lower === "content-security-policy" ||
      lower === "content-security-policy-report-only" ||
      lower === "x-frame-options" ||
      lower === "set-cookie" ||
      lower === "location" ||
      lower === "refresh" ||
      lower.startsWith("access-control-") ||
      lower === "timing-allow-origin"
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers["cache-control"] = "no-store";
  headers["x-content-type-options"] = "nosniff";
  headers["cross-origin-resource-policy"] = "same-origin";
  return headers;
}

export function createVitePreviewTransportProof(
  targetPort: number,
  sessionId: string,
  hmrToken?: string,
): SourcePreviewTransportProofV1 {
  const proof = issueSourcePreviewTransportProof({
    version: 1,
    sessionId,
    targetOrigin: `http://${LOOPBACK_ADDRESS}:${targetPort}`,
    resolvedAddresses: [LOOPBACK_ADDRESS],
    allowedHttpPathPrefixes: ["/"],
    allowedWebSocketPathPrefixes: hmrToken ? ["/"] : ["/__aiden_hmr_pending__"],
    allowedHttpQueryKeys: VITE_HTTP_QUERY_KEYS,
    allowedWebSocketQueryParameters: hmrToken ? { token: hmrToken } : {},
    allowedWebSocketProtocols: hmrToken ? ["vite-hmr", "vite-ping"] : [],
  });
  if (!proof) throw new Error("The local preview target could not be proven safe.");
  return proof;
}

export function createNextPreviewTransportProof(
  targetPort: number,
  sessionId: string,
): SourcePreviewTransportProofV1 {
  const proof = issueSourcePreviewTransportProof({
    version: 1,
    sessionId,
    targetOrigin: `http://${LOOPBACK_ADDRESS}:${targetPort}`,
    resolvedAddresses: [LOOPBACK_ADDRESS],
    allowedHttpPathPrefixes: ["/"],
    allowedWebSocketPathPrefixes: ["/__aiden_next_hmr_disabled__"],
    allowedHttpQueryKeys: [...VITE_HTTP_QUERY_KEYS, "amp", "dpl", "page"],
    allowedWebSocketQueryParameters: {},
    allowedWebSocketProtocols: [],
  });
  if (!proof) throw new Error("The local Next.js preview target could not be proven safe.");
  return proof;
}

export function extractViteHmrToken(source: string): string | undefined {
  if (typeof source !== "string" || source.length > 2 * 1024 * 1024) return undefined;
  const match = source.match(/\bconst\s+wsToken\s*=\s*("(?:[^"\\]|\\.){1,2048}")\s*;/u);
  if (!match) return undefined;
  try {
    const token: unknown = JSON.parse(match[1]);
    return typeof token === "string" &&
      token.length > 0 &&
      token.length <= 1_024 &&
      !/[\r\n\0]/u.test(token)
      ? token
      : undefined;
  } catch {
    return undefined;
  }
}

class SourcePreviewTransportError extends Error {
  constructor(message: string) {
    super(`The local preview ${message}.`);
    this.name = "SourcePreviewTransportError";
  }
}

function previewTransportError(message: string): Error {
  return new SourcePreviewTransportError(message);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect and readiness bodies are intentionally discarded.
  }
}

export async function fetchProvenSourcePreview(input: {
  proof: SourcePreviewTransportProofV1;
  targetUrl: string;
  method: "GET" | "HEAD";
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const visited = new Set<string>();
  let currentUrl = input.targetUrl;
  let method = input.method;
  let redirectHops = 0;
  while (true) {
    const authorized = authorizeSourcePreviewHttpRequest({
      proof: input.proof,
      targetUrl: currentUrl,
      method,
      headers: {},
      credentialsMode: "omit",
      resolvedAddresses: [LOOPBACK_ADDRESS],
    });
    if (!authorized.allowed)
      throw previewTransportError("request was rejected by its safety proof");
    currentUrl = authorized.normalizedUrl;
    if (visited.has(currentUrl)) throw previewTransportError("entered a redirect loop");
    visited.add(currentUrl);
    const upstream = await fetchImpl(currentUrl, {
      method,
      redirect: "manual",
      credentials: "omit",
      signal: input.signal,
    });
    if (!HTTP_REDIRECT_STATUSES.has(upstream.status)) return upstream;
    const location = upstream.headers.get("location");
    if (!location) {
      await discardResponseBody(upstream);
      throw previewTransportError("returned a redirect without a location");
    }
    if (redirectHops >= SOURCE_PREVIEW_MAX_REDIRECT_HOPS) {
      await discardResponseBody(upstream);
      throw previewTransportError("exceeded its redirect limit");
    }
    let targetUrl: string;
    try {
      targetUrl = new URL(location, currentUrl).toString();
    } catch {
      await discardResponseBody(upstream);
      throw previewTransportError("returned an invalid redirect location");
    }
    const redirected = authorizeSourcePreviewHttpRedirect({
      proof: input.proof,
      fromUrl: currentUrl,
      targetUrl,
      status: upstream.status,
      method,
      headers: {},
      credentialsMode: "omit",
      fromResolvedAddresses: [LOOPBACK_ADDRESS],
      targetResolvedAddresses: [LOOPBACK_ADDRESS],
    });
    if (!redirected.allowed) {
      await discardResponseBody(upstream);
      throw previewTransportError("redirected outside its approved loopback target");
    }
    await discardResponseBody(upstream);
    currentUrl = redirected.normalizedUrl;
    if (upstream.status === 303) method = "GET";
    redirectHops += 1;
  }
}

async function createProxy(
  initialProof: SourcePreviewTransportProofV1,
  capability: string,
  proxyPort: number,
  framework: "vite" | "next",
): Promise<{ server: http.Server; webSocketProxy: SourcePreviewWebSocketProxy }> {
  const reactGrab = await readGenerativeUiHostLibrary("react-grab-primitives.js");
  if (!reactGrab) throw new Error("React Grab preview support is unavailable.");
  let proof = initialProof;
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
  const serviceWorkerPath = `${SPECIAL_PREFIX}capability-worker.js`;
  const server = http.createServer(async (request, response) => {
    try {
      const remoteAddress = request.socket.remoteAddress;
      const host = request.headers.host;
      const origin = request.headers.origin;
      if (!sourcePreviewIngressAuthorized({ remoteAddress, host, origin, proxyPort })) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Preview ingress was not authorized.");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", proxyOrigin);
      const suppliedToken = requestUrl.searchParams.get("__aiden_preview_token");
      if (suppliedToken === capability && requestUrl.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'",
        });
        response.end(`<!doctype html><meta charset="utf-8"><script>
          const target = ${JSON.stringify(`${serviceWorkerPath}?__aiden_preview_token=${encodeURIComponent(capability)}`)};
          navigator.serviceWorker.register(target, { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => {
            const open = () => location.replace("/");
            if (navigator.serviceWorker.controller) open();
            else navigator.serviceWorker.addEventListener("controllerchange", open, { once: true });
          });
        </script>`);
        return;
      }
      if (suppliedToken === capability && requestUrl.pathname === serviceWorkerPath) {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "service-worker-allowed": "/",
          "x-content-type-options": "nosniff",
        });
        response.end(`const capability = ${JSON.stringify(capability)};
          self.addEventListener("install", () => self.skipWaiting());
          self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
          self.addEventListener("fetch", (event) => {
            const url = new URL(event.request.url);
            if (url.origin !== self.location.origin) return;
            const headers = new Headers(event.request.headers);
            headers.set("x-aiden-preview-capability", capability);
            event.respondWith(fetch(event.request.url, {
              method: event.request.method,
              headers,
              credentials: "omit",
              cache: "no-store",
              redirect: "follow"
            }));
          });`);
        return;
      }
      if (
        suppliedToken !== null ||
        !sourcePreviewHeaderAuthorized(request.headers["x-aiden-preview-capability"], capability)
      ) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Preview capability is required.");
        return;
      }
      const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, proof.httpOrigin);
      if (requestUrl.pathname === `${SPECIAL_PREFIX}react-grab.js`) {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(Buffer.from(reactGrab.bytes));
        return;
      }
      if (requestUrl.pathname === `${SPECIAL_PREFIX}bridge.js`) {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(sourceBridge(capability));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Preview requests are read-only.");
        return;
      }
      const upstream = await fetchProvenSourcePreview({
        proof,
        targetUrl: upstreamUrl.toString(),
        method: request.method,
        signal: AbortSignal.timeout(15_000),
      });
      const headers = responseHeaders(upstream.headers);
      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      if (contentType.toLowerCase().includes("text/html")) {
        const body = injectSourceDesignerScripts(await upstream.text());
        response.writeHead(upstream.status, { ...headers, "content-type": contentType });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      if (framework === "vite" && requestUrl.pathname === "/@vite/client") {
        const body = await upstream.text();
        const token = extractViteHmrToken(body);
        if (!token) throw new Error("The Vite HMR client did not provide a bounded token.");
        proof = createVitePreviewTransportProof(initialProof.port, initialProof.sessionId, token);
        response.writeHead(upstream.status, { ...headers, "content-type": contentType });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, headers);
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "The local preview is unavailable.");
    }
  });
  const webSocketProxy = attachSourcePreviewWebSocketProxy(server, {
    proof: () => proof,
    proxyPort,
  });
  return { server, webSocketProxy };
}

export function sourcePreviewIngressAuthorized(input: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  proxyPort: number;
}): boolean {
  const proxyOrigin = `http://127.0.0.1:${input.proxyPort}`;
  return (
    (input.remoteAddress === "127.0.0.1" ||
      input.remoteAddress === "::ffff:127.0.0.1" ||
      input.remoteAddress === "::1") &&
    input.host === `127.0.0.1:${input.proxyPort}` &&
    (input.origin === undefined || input.origin === proxyOrigin)
  );
}

export function sourcePreviewHeaderAuthorized(
  header: string | string[] | undefined,
  capability: string,
): boolean {
  return (
    typeof header === "string" &&
    typeof capability === "string" &&
    capability.length >= 32 &&
    header === capability
  );
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function waitUntilReady(
  proof: SourcePreviewTransportProofV1,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("The local preview was cancelled.");
    try {
      const response = await fetchProvenSourcePreview({
        proof,
        targetUrl: `${proof.httpOrigin}/`,
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      const ready = response.status < 500;
      await discardResponseBody(response);
      if (ready) return;
    } catch (error) {
      if (error instanceof SourcePreviewTransportError) throw error;
      // Vite has not finished starting yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The local app did not become ready in time.");
}

function publicState(session: PreviewSession): SourcePreviewStateV1 {
  if (session.terminal) {
    return {
      version: SOURCE_DESIGNER_VERSION,
      status: "failed",
      reason: session.terminal.reason,
      logs: [...session.logs],
    };
  }
  return {
    version: SOURCE_DESIGNER_VERSION,
    status: "running",
    sessionId: session.id,
    script: session.script,
    src: `http://127.0.0.1:${session.proxyPort}/?__aiden_preview_token=${encodeURIComponent(session.capability)}`,
    capability: session.capability,
    logs: [...session.logs],
  };
}

export class SourceDesignPreviewService {
  private readonly sessions = new Map<string, PreviewSession>();

  private ownedSession(
    owner: RendererDocumentOwner,
    projectId: string,
  ): PreviewSession | undefined {
    return [...this.sessions.values()].find(
      (session) =>
        session.owner.documentId === owner.documentId && session.projectId === projectId,
    );
  }

  private markTerminal(session: PreviewSession, reason: string): void {
    if (session.stopping || session.terminal) return;
    session.terminal = { reason };
    session.webSocketProxy.close();
    session.proxy.closeAllConnections();
    void new Promise<void>((resolve) => session.proxy.close(() => resolve()));
    session.admission.release();
    if (!session.owner.isDestroyed()) {
      session.owner.send("designer:preview-changed", {
        projectId: session.projectId,
        workspaceId: session.workspaceId,
        state: publicState(session),
      });
    }
  }

  async state(
    owner: RendererDocumentOwner,
    projectId: string,
    root: string,
  ): Promise<SourcePreviewStateV1> {
    const session = this.ownedSession(owner, projectId);
    if (session) return publicState(session);
    const scripts = await detectSourcePreviewScripts(root);
    return scripts.length > 0
      ? { version: SOURCE_DESIGNER_VERSION, status: "ready", scripts }
      : {
          version: SOURCE_DESIGNER_VERSION,
          status: "unsupported",
          reason: "No supported Vite or Next.js development script was found in package.json.",
        };
  }

  async start(input: {
    owner: RendererDocumentOwner;
    admission: WorkspaceOperationAdmission;
    projectId: string;
    workspaceId: string;
    root: string;
    scriptId: string;
  }): Promise<SourcePreviewStateV1> {
    const existing = this.ownedSession(input.owner, input.projectId);
    if (existing && !existing.terminal) {
      input.admission.release();
      return publicState(existing);
    }
    if (existing) await this.stopSession(existing);
    const adapters = await detectSourcePreviewRuntimeAdapters(input.root);
    const adapter = adapters.find((candidate) => publicScript(candidate).id === input.scriptId);
    if (!adapter) {
      input.admission.release();
      throw new Error("That preview script is no longer available.");
    }
    const script = publicScript(adapter);
    const resources = await (async () => {
      const targetPort = await availablePort();
      let proxyPort = await availablePort();
      while (proxyPort === targetPort) proxyPort = await availablePort();
      const capability = randomBytes(32).toString("base64url");
      const transportProof =
        adapter.framework === "vite"
          ? createVitePreviewTransportProof(targetPort, `preview_${capability}`)
          : createNextPreviewTransportProof(targetPort, `preview_${capability}`);
      const proxyResources = await createProxy(
        transportProof,
        capability,
        proxyPort,
        adapter.framework,
      );
      const launch = launchArguments(adapter, targetPort);
      try {
        const child = spawn(launch.command, launch.args, {
          cwd: input.root,
          env: { ...process.env, BROWSER: "none" },
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { targetPort, proxyPort, capability, transportProof, proxyResources, child };
      } catch (error) {
        proxyResources.webSocketProxy.close();
        proxyResources.server.closeAllConnections();
        proxyResources.server.close();
        throw error;
      }
    })().catch((error: unknown) => {
      input.admission.release();
      throw error;
    });
    const { targetPort, proxyPort, capability, transportProof, proxyResources, child } = resources;
    const proxy = proxyResources.server;
    const session: PreviewSession = {
      id: `preview_${randomUUID().replace(/-/gu, "")}`,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      root: input.root,
      owner: input.owner,
      admission: input.admission,
      script,
      capability,
      targetPort,
      proxyPort,
      child,
      proxy,
      webSocketProxy: proxyResources.webSocketProxy,
      logs: [],
      stopping: false,
    };
    this.sessions.set(session.id, session);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => appendLog(session, chunk));
    child.stderr?.on("data", (chunk: string) => appendLog(session, chunk));
    const terminateFromAdmission = () => void this.stopSession(session);
    input.admission.signal.addEventListener("abort", terminateFromAdmission, { once: true });
    child.once("error", (error) => {
      this.markTerminal(session, error.message);
    });
    child.once("exit", (code, signal) => {
      this.markTerminal(
        session,
        `The local app stopped${signal ? ` (${signal})` : code === null ? "" : ` (${code})`}.`,
      );
    });
    try {
      await listen(proxy, proxyPort);
      await waitUntilReady(transportProof, input.admission.signal);
      return publicState(session);
    } catch (error) {
      await this.stopSession(session);
      throw error;
    }
  }

  async stop(owner: RendererDocumentOwner, projectId: string): Promise<void> {
    const session = this.ownedSession(owner, projectId);
    if (session) await this.stopSession(session);
  }

  async stopProject(projectId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.projectId === projectId)
        .map((session) => this.stopSession(session)),
    );
  }

  private async stopSession(session: PreviewSession): Promise<void> {
    if (session.stopping) return;
    session.stopping = true;
    this.sessions.delete(session.id);
    terminateOwnedProcess(session.child);
    session.webSocketProxy.close();
    const proxyClosed = new Promise<void>((resolve) => session.proxy.close(() => resolve()));
    session.proxy.closeAllConnections();
    await proxyClosed.catch(() => undefined);
    if (!(await waitForProcessExit(session.child, 2_000))) {
      forceTerminateOwnedProcess(session.child);
      await waitForProcessExit(session.child, 1_000);
    }
    session.admission.release();
  }

  authority(
    ownerDocumentId: string,
    projectId: string,
    workspaceId: string,
    sessionId: string,
  ): SourcePreviewAuthority | undefined {
    const session = this.sessions.get(sessionId);
    return session &&
      !session.terminal &&
      session.owner.documentId === ownerDocumentId &&
      session.projectId === projectId &&
      session.workspaceId === workspaceId
      ? {
          root: session.root,
          sessionId: session.id,
          projectId: session.projectId,
          workspaceId: session.workspaceId,
          ownerDocumentId: session.owner.documentId,
        }
      : undefined;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session)));
  }
}

export const sourceDesignPreviewService = new SourceDesignPreviewService();
