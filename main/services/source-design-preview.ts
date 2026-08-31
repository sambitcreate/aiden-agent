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

interface PreviewSession {
  id: string;
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
  logs: string[];
  terminal?: { reason: string };
  stopping: boolean;
}

export interface SourcePreviewAuthority {
  root: string;
  sessionId: string;
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
  if (
    (await exists(path.join(root, "bun.lock"))) ||
    (await exists(path.join(root, "bun.lockb")))
  ) {
    return "bun";
  }
  return "npm";
}

export async function detectSourcePreviewScripts(root: string): Promise<SourcePreviewScriptV1[]> {
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
      id: name,
      label: name === "dev" ? "Development app" : name,
      command: `${manager} run ${name} -- --host 127.0.0.1 --port <port> --strictPort`,
    }));
}

function launchArguments(
  commandLabel: string,
  scriptId: string,
  port: number,
): { command: string; args: string[] } {
  const command = commandLabel.split(" ", 1)[0];
  if (!command || !new Set(["npm", "pnpm", "yarn", "bun"]).has(command)) {
    throw new Error("The preview package manager is unsupported.");
  }
  return {
    command,
    args: [
      "run",
      scriptId,
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
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
      lower === "set-cookie"
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers["cache-control"] = "no-store";
  headers["x-content-type-options"] = "nosniff";
  return headers;
}

async function createProxy(targetPort: number, capability: string): Promise<http.Server> {
  const reactGrab = await readGenerativeUiHostLibrary("react-grab-primitives.js");
  if (!reactGrab) throw new Error("React Grab preview support is unavailable.");
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${targetPort}`);
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
      const upstream = await fetch(requestUrl, {
        method: request.method,
        redirect: "follow",
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
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, headers);
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "The local preview is unavailable.");
    }
  });
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function waitUntilReady(port: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("The local preview was cancelled.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
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
    src: `http://127.0.0.1:${session.proxyPort}/`,
    capability: session.capability,
    logs: [...session.logs],
  };
}

export class SourceDesignPreviewService {
  private readonly sessions = new Map<string, PreviewSession>();

  private ownedSession(owner: RendererDocumentOwner, workspaceId: string): PreviewSession | undefined {
    return [...this.sessions.values()].find(
      (session) =>
        session.owner.documentId === owner.documentId && session.workspaceId === workspaceId,
    );
  }

  async state(
    owner: RendererDocumentOwner,
    workspaceId: string,
    root: string,
  ): Promise<SourcePreviewStateV1> {
    const session = this.ownedSession(owner, workspaceId);
    if (session) return publicState(session);
    const scripts = await detectSourcePreviewScripts(root);
    return scripts.length > 0
      ? { version: SOURCE_DESIGNER_VERSION, status: "ready", scripts }
      : {
          version: SOURCE_DESIGNER_VERSION,
          status: "unsupported",
          reason: "No supported Vite development script was found in package.json.",
        };
  }

  async start(input: {
    owner: RendererDocumentOwner;
    admission: WorkspaceOperationAdmission;
    workspaceId: string;
    root: string;
    scriptId: string;
  }): Promise<SourcePreviewStateV1> {
    const existing = this.ownedSession(input.owner, input.workspaceId);
    if (existing && !existing.terminal) {
      input.admission.release();
      return publicState(existing);
    }
    if (existing) await this.stopSession(existing);
    const scripts = await detectSourcePreviewScripts(input.root);
    const script = scripts.find((candidate) => candidate.id === input.scriptId);
    if (!script) {
      input.admission.release();
      throw new Error("That preview script is no longer available.");
    }
    const targetPort = await availablePort();
    const proxyPort = await availablePort();
    const capability = randomBytes(32).toString("base64url");
    const proxy = await createProxy(targetPort, capability);
    const launch = launchArguments(script.command, script.id, targetPort);
    const child = spawn(launch.command, launch.args, {
      cwd: input.root,
      env: { ...process.env, BROWSER: "none" },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const session: PreviewSession = {
      id: `preview_${randomUUID().replace(/-/gu, "")}`,
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
      session.terminal = { reason: error.message };
    });
    child.once("exit", (code, signal) => {
      if (!session.stopping) {
        session.terminal = {
          reason: `The local app stopped${signal ? ` (${signal})` : code === null ? "" : ` (${code})`}.`,
        };
        void new Promise<void>((resolve) => proxy.close(() => resolve()));
        input.admission.release();
        if (!input.owner.isDestroyed()) {
          input.owner.send("designer:preview-changed", {
            workspaceId: input.workspaceId,
            state: publicState(session),
          });
        }
      }
    });
    try {
      await listen(proxy, proxyPort);
      await waitUntilReady(targetPort, input.admission.signal);
      return publicState(session);
    } catch (error) {
      await this.stopSession(session);
      throw error;
    }
  }

  async stop(owner: RendererDocumentOwner, workspaceId: string): Promise<void> {
    const session = this.ownedSession(owner, workspaceId);
    if (session) await this.stopSession(session);
  }

  private async stopSession(session: PreviewSession): Promise<void> {
    if (session.stopping) return;
    session.stopping = true;
    this.sessions.delete(session.id);
    terminateOwnedProcess(session.child);
    await new Promise<void>((resolve) => session.proxy.close(() => resolve())).catch(
      () => undefined,
    );
    session.admission.release();
  }

  authority(
    ownerDocumentId: string,
    workspaceId: string,
    sessionId: string,
  ): SourcePreviewAuthority | undefined {
    const session = this.sessions.get(sessionId);
    return session &&
      !session.terminal &&
      session.owner.documentId === ownerDocumentId &&
      session.workspaceId === workspaceId
      ? {
          root: session.root,
          sessionId: session.id,
          workspaceId: session.workspaceId,
          ownerDocumentId: session.owner.documentId,
        }
      : undefined;
  }

  shutdown(): void {
    for (const session of [...this.sessions.values()]) void this.stopSession(session);
  }
}

export const sourceDesignPreviewService = new SourceDesignPreviewService();
