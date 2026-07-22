import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { CuaDriverError, type CuaDriverToolInfo } from "./contract.js";
import type { CuaDriverCallOptions } from "./session.js";
import type { ComputerUseArgs, ComputerUseMode } from "./schema.js";
import {
  ComputerUseGrantLedger,
  ComputerUseSafetyError,
  computerUseNeedsApproval,
  normalizeComputerUseArgs,
  parseComputerUseKeyChord,
  summarizeComputerUseApproval,
} from "./safety.js";

const ACTION_TIMEOUT_MS = 30_000;
export const COMPUTER_USE_DISCOVERY_TIMEOUT_MS = 120_000;
const CAPTURE_TIMEOUT_MS = 60_000;
const MAX_DRIVER_TEXT_CHARS = 96_000;
const MAX_IMAGE_BASE64_CHARS = 60 * 1024 * 1024;
const DESKTOP_NAMES = new Set(["screen", "desktop"]);

export interface CuaDriverSessionLike {
  readonly ready: boolean;
  readonly toolCatalog: ReadonlyMap<string, CuaDriverToolInfo>;
  supports(tool: string, capability: string): boolean;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: CuaDriverCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface CuaDriverHostLike {
  createSession(signal?: AbortSignal): Promise<CuaDriverSessionLike>;
  shutdown(): Promise<void>;
}

export type CuaDriverHostFactory = (signal: AbortSignal) => Promise<CuaDriverHostLike>;

export interface ComputerUseTargetDetails {
  pid: number;
  windowId: number;
  app?: string;
  title?: string;
}

export interface ComputerUseResultDetails {
  action: ComputerUseArgs["action"];
  mode?: ComputerUseMode;
  requestedMode?: ComputerUseMode;
  target?: ComputerUseTargetDetails;
  width?: number;
  height?: number;
  elementCount?: number;
  degradedToAccessibility?: boolean;
  driverEffect?: string;
  verified?: boolean;
  path?: string;
  code?: string;
  degraded?: boolean;
  escalation?: { recommended?: string; reason?: string };
  capturedAfter?: boolean;
}

export interface ComputerUseApprovalDescriptor {
  toolName: "computer_use";
  summary: string;
  target: ComputerUseTargetDetails;
  grant: { targetRevision: number; fingerprint: string };
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowRecord {
  pid: number;
  windowId: number;
  appName: string;
  title: string;
  bounds?: Bounds;
  zIndex: number;
  isOnScreen: boolean;
}

interface AppRecord {
  pid?: number;
  name?: string;
  bundleId?: string;
  running?: boolean;
  active?: boolean;
}

interface ElementRecord {
  index: number;
  token?: string;
  role?: string;
  label?: string;
  value?: string;
  frame?: Bounds;
  parentIndex?: number;
  depth?: number;
}

interface ActiveTarget extends WindowRecord {
  screenshotWidth?: number;
  screenshotHeight?: number;
  elements: Map<number, ElementRecord>;
}

interface DriverImage {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

interface ParsedDriverResult {
  text: string;
  image?: DriverImage;
  structured: Record<string, unknown> | null;
}

interface DriverVerdict {
  verified?: boolean;
  effect?: string;
  path?: string;
  code?: string;
  degraded?: boolean;
  escalation?: { recommended?: string; reason?: string };
}

class ComputerUseDriverActionError extends Error {
  constructor(
    message: string,
    readonly poisonsSession = false,
  ) {
    super(message);
    this.name = "ComputerUseDriverActionError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(value: unknown, maximum = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\0/gu, "").slice(0, maximum);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown, minimum = 0): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : undefined;
}

function parseBounds(value: unknown): Bounds | undefined {
  const bounds = asRecord(value);
  if (!bounds) return undefined;
  const x = safeNumber(bounds.x);
  const y = safeNumber(bounds.y);
  const width = safeNumber(bounds.width ?? bounds.w);
  const height = safeNumber(bounds.height ?? bounds.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return;
  if (width <= 0 || height <= 0) return;
  return { x, y, width, height };
}

function desktopShellPriority(window: WindowRecord): number | null {
  const app = window.appName.trim().toLowerCase();
  const title = window.title.trim().toLowerCase();
  if (app === "finder" && (title === "desktop" || title === "")) return 0;
  if (["progman", "workerw", "program manager"].includes(app)) return 0;
  if (
    ["explorer", "explorer.exe"].includes(app) &&
    ["desktop", "program manager", "taskbar", "shell_traywnd", ""].includes(title)
  ) {
    return title === "taskbar" || title === "shell_traywnd" ? 1 : 0;
  }
  if (
    ["gnome-shell", "plasmashell", "xfdesktop"].includes(app) &&
    (title === "desktop" || title === "")
  ) {
    return 0;
  }
  if (app === "dock" && (title === "dock" || title === "")) return 1;
  return null;
}

function parsePngDimensions(bytes: Buffer): [number, number] | null {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? [width, height] : null;
}

function parseJpegDimensions(bytes: Buffer): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda || offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? [width, height] : null;
    }
    offset += length;
  }
  return null;
}

function parseDriverImage(data: string, mimeType: string): DriverImage {
  if (
    data.length === 0 ||
    data.length > MAX_IMAGE_BASE64_CHARS ||
    data.startsWith("data:") ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  ) {
    throw new ComputerUseDriverActionError("Computer Use returned an invalid screenshot.", true);
  }
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new ComputerUseDriverActionError(
      "Computer Use returned an unsupported screenshot type.",
      true,
    );
  }
  const bytes = Buffer.from(data, "base64");
  const dimensions =
    mimeType === "image/png" ? parsePngDimensions(bytes) : parseJpegDimensions(bytes);
  if (!dimensions || dimensions[0] < 8 || dimensions[1] < 8) {
    throw new ComputerUseDriverActionError("Computer Use returned an unusable screenshot.", true);
  }
  return { data, mimeType, width: dimensions[0], height: dimensions[1] };
}

function parseDriverResult(raw: unknown): ParsedDriverResult {
  let parsed: ReturnType<typeof CallToolResultSchema.parse>;
  try {
    parsed = CallToolResultSchema.parse(raw);
  } catch {
    throw new ComputerUseDriverActionError("Computer Use returned a malformed tool result.", true);
  }
  const textParts: string[] = [];
  let image: DriverImage | undefined;
  for (const part of parsed.content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else if (part.type === "image") {
      if (image)
        throw new ComputerUseDriverActionError("Computer Use returned multiple screenshots.", true);
      image = parseDriverImage(part.data, part.mimeType);
    } else {
      throw new ComputerUseDriverActionError(
        "Computer Use returned unsupported result content.",
        true,
      );
    }
  }
  const text = textParts
    .join("\n")
    .replace(/\0/gu, "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, "[screenshot omitted]")
    .replace(/[a-z0-9+/]{256,}={0,2}/giu, "[encoded data omitted]")
    .slice(0, MAX_DRIVER_TEXT_CHARS);
  if (parsed.isError === true) {
    throw new ComputerUseDriverActionError(
      text.trim()
        ? `cua-driver rejected the action: ${text.trim().slice(0, 2_000)}`
        : "cua-driver rejected the action.",
    );
  }
  return { text, image, structured: asRecord(parsed.structuredContent) };
}

function parseDriverVerdict(structured: Record<string, unknown> | null): DriverVerdict {
  if (!structured) return {};
  const escalationRecord = asRecord(structured.escalation);
  const recommended = safeString(escalationRecord?.recommended, 64);
  const reason = safeString(escalationRecord?.reason, 1_000);
  const escalation =
    recommended || reason
      ? { ...(recommended ? { recommended } : {}), ...(reason ? { reason } : {}) }
      : undefined;
  const code = safeString(structured.code ?? structured.reason_code, 256);
  return {
    ...(typeof structured.verified === "boolean" ? { verified: structured.verified } : {}),
    ...(safeString(structured.effect, 256) ? { effect: safeString(structured.effect, 256) } : {}),
    ...(safeString(structured.path, 256) ? { path: safeString(structured.path, 256) } : {}),
    ...(code ? { code } : {}),
    ...(typeof structured.degraded === "boolean" ? { degraded: structured.degraded } : {}),
    ...(escalation ? { escalation } : {}),
  };
}

function normalizeWindows(result: ParsedDriverResult): WindowRecord[] {
  const raw = result.structured?.windows;
  if (!Array.isArray(raw)) return [];
  const windows: WindowRecord[] = [];
  for (const value of raw.slice(0, 2_000)) {
    const window = asRecord(value);
    if (!window) continue;
    const pid = safeInteger(window.pid, 1);
    const windowId = safeInteger(window.window_id ?? window.windowId, 1);
    if (pid === undefined || windowId === undefined) continue;
    windows.push({
      pid,
      windowId,
      appName: safeString(window.app_name ?? window.appName, 512) ?? "",
      title: safeString(window.title, 1_000) ?? "",
      bounds: parseBounds(window.bounds),
      zIndex: safeNumber(window.z_index ?? window.zIndex) ?? 0,
      isOnScreen:
        typeof window.is_on_screen === "boolean"
          ? window.is_on_screen
          : typeof window.on_screen === "boolean"
            ? window.on_screen
            : window.off_screen !== true,
    });
  }
  return windows.sort((left, right) => {
    if (left.isOnScreen !== right.isOnScreen) return left.isOnScreen ? -1 : 1;
    return right.zIndex - left.zIndex;
  });
}

function normalizeApps(result: ParsedDriverResult): AppRecord[] {
  const raw = result.structured?.apps;
  if (!Array.isArray(raw)) return [];
  const apps: AppRecord[] = [];
  for (const value of raw.slice(0, 2_000)) {
    const app = asRecord(value);
    if (!app) continue;
    const normalized: AppRecord = {
      pid: safeInteger(app.pid, 1),
      name: safeString(app.name ?? app.app_name ?? app.display_name, 512),
      bundleId: safeString(app.bundle_id ?? app.bundleId, 512),
      running: typeof app.running === "boolean" ? app.running : undefined,
      active: typeof app.active === "boolean" ? app.active : undefined,
    };
    if (normalized.pid !== undefined || normalized.name || normalized.bundleId)
      apps.push(normalized);
  }
  return apps;
}

function normalizeElements(result: ParsedDriverResult, maximum: number): ElementRecord[] {
  const raw = result.structured?.elements;
  if (!Array.isArray(raw)) return [];
  const elements: ElementRecord[] = [];
  for (const value of raw.slice(0, maximum)) {
    const element = asRecord(value);
    if (!element) continue;
    const index = safeInteger(element.element_index ?? element.index, 0);
    if (index === undefined) continue;
    const normalized: ElementRecord = {
      index,
      token: safeString(element.element_token, 512),
      role: safeString(element.role, 256),
      label: safeString(element.label, 1_000),
      value: safeString(element.value, 1_000),
      frame: parseBounds(element.frame),
      parentIndex: safeInteger(element.parent_index, 0),
      depth: safeInteger(element.depth, 0),
    };
    elements.push(normalized);
  }
  return elements;
}

function publicWindow(window: WindowRecord): Record<string, unknown> {
  return {
    pid: window.pid,
    window_id: window.windowId,
    app_name: window.appName,
    title: window.title,
    ...(window.bounds ? { bounds: window.bounds } : {}),
    z_index: window.zIndex,
    is_on_screen: window.isOnScreen,
  };
}

function publicApp(app: AppRecord): Record<string, unknown> {
  return {
    ...(app.pid !== undefined ? { pid: app.pid } : {}),
    ...(app.name ? { name: app.name } : {}),
    ...(app.bundleId ? { bundle_id: app.bundleId } : {}),
    ...(app.running !== undefined ? { running: app.running } : {}),
    ...(app.active !== undefined ? { active: app.active } : {}),
  };
}

function publicElement(element: ElementRecord): Record<string, unknown> {
  return {
    element_index: element.index,
    ...(element.role ? { role: element.role } : {}),
    ...(element.label ? { label: element.label } : {}),
    ...(element.value ? { value: element.value } : {}),
    ...(element.frame ? { frame: element.frame } : {}),
    ...(element.parentIndex !== undefined ? { parent_index: element.parentIndex } : {}),
    ...(element.depth !== undefined ? { depth: element.depth } : {}),
  };
}

function textResult(
  payload: Record<string, unknown>,
  details: ComputerUseResultDetails,
  image?: DriverImage,
): AgentToolResult<ComputerUseResultDetails> {
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: JSON.stringify(payload) }];
  if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return { content, details };
}

function abortError(signal?: AbortSignal): ComputerUseSafetyError {
  return signal?.reason instanceof ComputerUseSafetyError
    ? signal.reason
    : new ComputerUseSafetyError("cancelled", "Computer Use was cancelled.");
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(abortError(signal));
    const timer = setTimeout(() => finish(), milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function schemaDeclaresProperty(tool: CuaDriverToolInfo | undefined, property: string): boolean {
  const schema = asRecord(tool?.inputSchema);
  const properties = asRecord(schema?.properties);
  return properties ? Object.prototype.hasOwnProperty.call(properties, property) : false;
}

export class ComputerUseController {
  private state: "new" | "starting" | "ready" | "poisoned" | "closed" = "new";
  private host: CuaDriverHostLike | null = null;
  private session: CuaDriverSessionLike | null = null;
  private startup: Promise<CuaDriverSessionLike> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly lifecycle = new AbortController();
  private target: ActiveTarget | null = null;
  private revision = 0;
  private readonly grants: ComputerUseGrantLedger;

  constructor(
    readonly generationId: string,
    private readonly supportsImages: boolean,
    private readonly hostFactory: CuaDriverHostFactory,
  ) {
    this.grants = new ComputerUseGrantLedger(generationId, () => this.revision);
  }

  get lifecycleState(): "new" | "starting" | "ready" | "poisoned" | "closed" {
    return this.state;
  }

  get targetRevision(): number {
    return this.revision;
  }

  async approvalFor(
    args: ComputerUseArgs,
    callerSignal?: AbortSignal,
  ): Promise<ComputerUseApprovalDescriptor | null> {
    const normalized = normalizeComputerUseArgs(args);
    if (!computerUseNeedsApproval(normalized)) return null;
    const signal = this.signalFor(callerSignal);
    let target: ActiveTarget;
    if (normalized.action === "focus_app") {
      this.clearTarget();
      try {
        target = this.setTarget(await this.resolveTarget({ app: normalized.app }, signal));
      } catch (error) {
        this.clearTarget();
        throw error;
      }
    } else {
      target = this.requireTarget();
    }
    this.validateApprovalTarget(normalized, target);
    return {
      toolName: "computer_use",
      summary: `${summarizeComputerUseApproval(normalized)} — ${this.approvalTargetSummary(target)}`,
      target: this.targetDetails(target)!,
      grant: this.grants.prepare(normalized),
    };
  }

  authorize(
    toolCallId: string,
    args: ComputerUseArgs,
    approval: ComputerUseApprovalDescriptor,
  ): void {
    this.assertUsable();
    this.grants.authorize(toolCallId, args, approval.grant);
  }

  async execute(
    toolCallId: string,
    rawArgs: ComputerUseArgs,
    callerSignal?: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    this.assertUsable();
    const args = normalizeComputerUseArgs(rawArgs);
    this.grants.consume(toolCallId, args);
    const signal = this.signalFor(callerSignal);
    try {
      switch (args.action) {
        case "capture":
          return await this.capture(args, signal);
        case "wait":
          await waitFor((args.seconds ?? 1) * 1_000, signal);
          return textResult(
            { ok: true, action: "wait", seconds: args.seconds ?? 1 },
            { action: "wait" },
          );
        case "list_apps":
          return await this.listAppsResult(signal);
        case "list_windows":
          return await this.listWindowsResult(signal);
        case "focus_app":
          return await this.focusApp(args, signal);
        default:
          return await this.mutate(args, signal);
      }
    } catch (error) {
      if (signal.aborted) this.poison();
      throw error;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private assertUsable(): void {
    if (this.state === "closed")
      throw new ComputerUseSafetyError("controller_closed", "Computer Use has closed.");
    if (this.state === "poisoned")
      throw new ComputerUseSafetyError(
        "controller_poisoned",
        "Computer Use stopped after an earlier failure and will not restart in this response.",
      );
  }

  private signalFor(caller?: AbortSignal): AbortSignal {
    return caller ? AbortSignal.any([caller, this.lifecycle.signal]) : this.lifecycle.signal;
  }

  private async getSession(signal: AbortSignal): Promise<CuaDriverSessionLike> {
    this.assertUsable();
    if (signal.aborted) throw abortError(signal);
    if (this.session?.ready && this.state === "ready") return this.session;
    if (!this.startup) {
      this.state = "starting";
      this.startup = (async () => {
        const host = await this.hostFactory(signal);
        this.host = host;
        const session = await host.createSession(signal);
        if (this.state === "closed" || signal.aborted) {
          await session.close().catch(() => {});
          throw abortError(signal);
        }
        this.session = session;
        this.state = "ready";
        return session;
      })().catch(async (error: unknown) => {
        if (this.state !== "closed") this.state = "poisoned";
        await this.host?.shutdown().catch(() => {});
        throw error;
      });
    }
    return this.startup;
  }

  private async callDriver(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = ACTION_TIMEOUT_MS,
  ): Promise<ParsedDriverResult> {
    try {
      const session = await this.getSession(signal);
      return parseDriverResult(await session.callTool(name, args, { signal, timeoutMs }));
    } catch (error) {
      if (error instanceof ComputerUseDriverActionError) {
        if (error.poisonsSession) this.poison();
        throw error;
      }
      if (error instanceof CuaDriverError && error.code === "request_too_large") throw error;
      this.poison();
      throw error;
    }
  }

  private poison(): void {
    if (this.state === "closed" || this.state === "poisoned") return;
    this.state = "poisoned";
    this.grants.clear();
    this.clearTarget();
    void this.session?.close().catch(() => {});
  }

  private clearTarget(): void {
    this.target = null;
    this.revision += 1;
  }

  private setTarget(window: WindowRecord, elements: ElementRecord[] = []): ActiveTarget {
    this.revision += 1;
    const target: ActiveTarget = {
      ...window,
      elements: new Map(elements.map((element) => [element.index, element])),
    };
    this.target = target;
    return target;
  }

  private targetDetails(target = this.target): ComputerUseTargetDetails | undefined {
    return target
      ? {
          pid: target.pid,
          windowId: target.windowId,
          ...(target.appName ? { app: target.appName } : {}),
          ...(target.title ? { title: target.title } : {}),
        }
      : undefined;
  }

  private approvalTargetSummary(target: ActiveTarget): string {
    const app = target.appName || "Unknown app";
    const title = target.title ? `, title ${JSON.stringify(target.title)}` : "";
    return `${JSON.stringify(app)}${title}, pid ${target.pid}, window ${target.windowId}`;
  }

  private invalidateTargetSnapshot(target: ActiveTarget): void {
    target.elements.clear();
    target.screenshotWidth = undefined;
    target.screenshotHeight = undefined;
    this.revision += 1;
  }

  private async loadWindows(signal: AbortSignal): Promise<WindowRecord[]> {
    return normalizeWindows(
      await this.callDriver("list_windows", {}, signal, COMPUTER_USE_DISCOVERY_TIMEOUT_MS),
    );
  }

  private async loadApps(signal: AbortSignal): Promise<AppRecord[]> {
    return normalizeApps(
      await this.callDriver("list_apps", {}, signal, COMPUTER_USE_DISCOVERY_TIMEOUT_MS),
    );
  }

  private async resolveTarget(
    input: { app?: string; pid?: number; window_id?: number },
    signal: AbortSignal,
  ): Promise<WindowRecord> {
    const windows = await this.loadWindows(signal);
    if (input.pid !== undefined && input.window_id !== undefined) {
      const exact = windows.find(
        (window) => window.pid === input.pid && window.windowId === input.window_id,
      );
      if (!exact)
        throw new ComputerUseDriverActionError("The requested window is no longer available.");
      return exact;
    }
    if (!input.app) {
      const first = windows[0];
      if (!first) throw new ComputerUseDriverActionError("No desktop windows are available.");
      return first;
    }
    const query = input.app.trim().toLowerCase();
    const directExact = windows.filter((window) => window.appName.trim().toLowerCase() === query);
    if (directExact.length) return directExact[0];

    const apps = await this.loadApps(signal);
    const exactPids = new Set(
      apps
        .filter(
          (app) =>
            app.running !== false &&
            [app.name, app.bundleId].some((value) => value?.trim().toLowerCase() === query),
        )
        .map((app) => app.pid)
        .filter((pid): pid is number => pid !== undefined),
    );
    const metadataExact = windows.find((window) => exactPids.has(window.pid));
    if (metadataExact) return metadataExact;

    const directPartial = windows.filter((window) => window.appName.toLowerCase().includes(query));
    const partialPids = new Set(
      apps
        .filter(
          (app) =>
            app.running !== false &&
            [app.name, app.bundleId].some((value) => value?.toLowerCase().includes(query)),
        )
        .map((app) => app.pid)
        .filter((pid): pid is number => pid !== undefined),
    );
    const metadataPartial = windows.filter((window) => partialPids.has(window.pid));
    const titleFallback = windows.filter(
      (window) => !window.appName.trim() && window.title.toLowerCase().includes(query),
    );
    const partialMatches = new Map<string, WindowRecord>();
    for (const window of [...directPartial, ...metadataPartial, ...titleFallback]) {
      partialMatches.set(`${window.pid}:${window.windowId}`, window);
    }
    if (partialMatches.size === 1) return partialMatches.values().next().value as WindowRecord;
    if (partialMatches.size > 1) {
      throw new ComputerUseDriverActionError(
        `${JSON.stringify(input.app)} matched multiple windows. Call list_windows, then capture the intended pid and window_id exactly.`,
      );
    }
    throw new ComputerUseDriverActionError(`No window matched app ${JSON.stringify(input.app)}.`);
  }

  private async resolveDesktopWindow(signal: AbortSignal): Promise<WindowRecord> {
    const windows = await this.loadWindows(signal);
    const matches = windows
      .map((window) => ({ window, priority: desktopShellPriority(window) }))
      .filter(
        (candidate): candidate is { window: WindowRecord; priority: number } =>
          candidate.priority !== null && candidate.window.isOnScreen,
      );
    if (!matches.length) {
      throw new ComputerUseDriverActionError(
        "No exact desktop or OS shell window is available. Capture a specific app window instead.",
      );
    }
    matches.sort((left, right) => left.priority - right.priority);
    return matches[0].window;
  }

  private async capture(
    args: Extract<ComputerUseArgs, { action: "capture" }> | ComputerUseArgs,
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const requestedMode = args.mode ?? "som";
    this.clearTarget();
    try {
      const target =
        args.app && DESKTOP_NAMES.has(args.app.trim().toLowerCase())
          ? await this.resolveDesktopWindow(signal)
          : await this.resolveTarget(args, signal);
      return await this.captureWindow(target, requestedMode, args.max_elements ?? 100, signal);
    } catch (error) {
      this.clearTarget();
      throw error;
    }
  }

  private async captureWindow(
    window: WindowRecord,
    requestedMode: ComputerUseMode,
    maximumElements: number,
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    // A new snapshot invalidates every prior index/token even if the driver
    // subsequently reports an error.
    this.setTarget(window, []);
    const degraded = requestedMode === "vision" && !this.supportsImages;
    const effectiveMode: ComputerUseMode = degraded ? "ax" : requestedMode;
    const includeScreenshot = this.supportsImages && effectiveMode !== "ax";
    const driverArgs: Record<string, unknown> = {
      pid: window.pid,
      window_id: window.windowId,
      include_screenshot: includeScreenshot,
      max_elements: effectiveMode === "vision" ? 1 : maximumElements,
    };
    // `som` is Aiden's response-shaping mode, not a value in the pinned
    // driver's advertised enum. The current driver always returns the AX tree;
    // include_screenshot controls whether pixels are included.
    if (effectiveMode !== "som") driverArgs.capture_mode = effectiveMode;
    const result = await this.callDriver(
      "get_window_state",
      driverArgs,
      signal,
      CAPTURE_TIMEOUT_MS,
    );
    if (includeScreenshot && !result.image) {
      throw new ComputerUseDriverActionError("Window capture returned no screenshot.");
    }
    const elements = effectiveMode === "vision" ? [] : normalizeElements(result, maximumElements);
    const target = this.setTarget(window, elements);
    const width = result.image?.width ?? safeInteger(result.structured?.width, 1);
    const height = result.image?.height ?? safeInteger(result.structured?.height, 1);
    // Only exact dimensions parsed from this capture's image can translate AX
    // point frames into the driver's screenshot-pixel coordinate space.
    target.screenshotWidth = result.image?.width;
    target.screenshotHeight = result.image?.height;
    const payload = {
      ok: true,
      action: "capture",
      mode: effectiveMode,
      requested_mode: requestedMode,
      target: this.targetDetails(target),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      elements: elements.map(publicElement),
      total_elements: safeInteger(result.structured?.element_count, 0) ?? elements.length,
      ...(degraded
        ? { note: "Vision capture degraded to accessibility text for this model." }
        : {}),
    };
    return textResult(
      payload,
      {
        action: "capture",
        mode: effectiveMode,
        requestedMode,
        target: this.targetDetails(target),
        width,
        height,
        elementCount: elements.length,
        degradedToAccessibility: degraded,
      },
      includeScreenshot ? result.image : undefined,
    );
  }

  private async listAppsResult(
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const apps = await this.loadApps(signal);
    return textResult(
      { ok: true, action: "list_apps", count: apps.length, apps: apps.map(publicApp) },
      { action: "list_apps" },
    );
  }

  private async listWindowsResult(
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const windows = await this.loadWindows(signal);
    return textResult(
      {
        ok: true,
        action: "list_windows",
        count: windows.length,
        windows: windows.map(publicWindow),
      },
      { action: "list_windows" },
    );
  }

  private async focusApp(
    args: ComputerUseArgs,
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const target = this.requireTarget();
    let effect = "targeted_background_window";
    let verdict: DriverVerdict = {};
    try {
      if (args.raise_window === true) {
        const result = await this.callDriver(
          "bring_to_front",
          { pid: target.pid, window_id: target.windowId },
          signal,
        );
        verdict = parseDriverVerdict(result.structured);
        effect = "brought_to_front";
      }
    } catch (error) {
      this.clearTarget();
      throw error;
    }
    this.invalidateTargetSnapshot(target);
    const actionPayload: Record<string, unknown> = {
      ok: true,
      action: "focus_app",
      effect,
      target: this.targetDetails(target),
      ...verdict,
    };
    if (args.capture_after === true) {
      try {
        const capture = await this.captureWindow(target, "som", 100, signal);
        capture.details.action = "focus_app";
        capture.details.driverEffect = verdict.effect ?? effect;
        Object.assign(capture.details, verdict);
        capture.details.capturedAfter = true;
        capture.content[0] = {
          type: "text",
          text: JSON.stringify({
            ...actionPayload,
            capture: JSON.parse((capture.content[0] as TextContent).text),
          }),
        };
        return capture;
      } catch (error) {
        if (signal.aborted) throw error;
        return textResult(
          {
            ...actionPayload,
            capture_warning:
              "The focus action completed, but the follow-up capture failed. Do not repeat the action blindly.",
          },
          {
            action: "focus_app",
            target: this.targetDetails(target),
            driverEffect: verdict.effect ?? effect,
            ...verdict,
          },
        );
      }
    }
    return textResult(actionPayload, {
      action: "focus_app",
      target: this.targetDetails(target),
      driverEffect: verdict.effect ?? effect,
      ...verdict,
    });
  }

  private requireTarget(): ActiveTarget {
    if (!this.target) {
      throw new ComputerUseSafetyError(
        "target_required",
        "No active window. Capture or focus an app before this action.",
      );
    }
    return this.target;
  }

  private requireCapturedElement(target: ActiveTarget, index: number): ElementRecord {
    const element = target.elements.get(index);
    if (!element) {
      throw new ComputerUseSafetyError(
        "stale_element",
        `Element ${index} is not present in the latest capture. Capture again before acting.`,
      );
    }
    return element;
  }

  private validateApprovalTarget(args: ComputerUseArgs, target: ActiveTarget): void {
    switch (args.action) {
      case "click":
      case "double_click":
      case "right_click":
      case "middle_click":
        if (args.element !== undefined) this.requireCapturedElement(target, args.element);
        else if (args.coordinate) this.pointArgs(target, args.coordinate);
        break;
      case "drag":
        if (args.from_element !== undefined) this.elementCenter(target, args.from_element);
        else if (args.from_coordinate) this.pointArgs(target, args.from_coordinate);
        if (args.to_element !== undefined) this.elementCenter(target, args.to_element);
        else if (args.to_coordinate) this.pointArgs(target, args.to_coordinate);
        break;
      case "scroll":
        if (args.element !== undefined) this.requireCapturedElement(target, args.element);
        else if (args.coordinate) this.pointArgs(target, args.coordinate);
        break;
      case "set_value":
        this.requireCapturedElement(target, args.element!);
        break;
      default:
        break;
    }
  }

  private elementArgs(
    session: CuaDriverSessionLike,
    tool: string,
    target: ActiveTarget,
    index: number,
  ): Record<string, unknown> {
    const element = this.requireCapturedElement(target, index);
    return {
      element_index: index,
      ...(element.token && session.supports(tool, "accessibility.element_tokens")
        ? { element_token: element.token }
        : {}),
    };
  }

  private pointArgs(target: ActiveTarget, coordinate: readonly number[]): Record<string, unknown> {
    const [x, y] = coordinate;
    if (target.screenshotWidth === undefined || target.screenshotHeight === undefined) {
      throw new ComputerUseSafetyError(
        "snapshot_required",
        "Pixel coordinates require a fresh screenshot of this exact window.",
      );
    }
    if (x >= target.screenshotWidth || y >= target.screenshotHeight) {
      throw new ComputerUseSafetyError(
        "coordinate_out_of_bounds",
        "The coordinate falls outside the latest captured window.",
      );
    }
    return { x, y };
  }

  private elementCenter(target: ActiveTarget, index: number): [number, number] {
    const element = target.elements.get(index);
    if (!element?.frame || !target.bounds) {
      throw new ComputerUseSafetyError(
        "drag_frame_unavailable",
        `Element ${index} has no safe frame for a drag. Use pixel coordinates instead.`,
      );
    }
    const centerX = element.frame.x + element.frame.width / 2;
    const centerY = element.frame.y + element.frame.height / 2;
    const localX =
      centerX >= target.bounds.x && centerX <= target.bounds.x + target.bounds.width
        ? centerX - target.bounds.x
        : centerX >= 0 && centerX <= target.bounds.width
          ? centerX
          : Number.NaN;
    const localY =
      centerY >= target.bounds.y && centerY <= target.bounds.y + target.bounds.height
        ? centerY - target.bounds.y
        : centerY >= 0 && centerY <= target.bounds.height
          ? centerY
          : Number.NaN;
    const width = target.screenshotWidth;
    const height = target.screenshotHeight;
    if (
      width === undefined ||
      height === undefined ||
      !Number.isFinite(localX) ||
      !Number.isFinite(localY) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new ComputerUseSafetyError(
        "drag_frame_unavailable",
        `Element ${index} could not be mapped into screenshot coordinates.`,
      );
    }
    return [
      Math.max(0, Math.min(width - 1, (localX * width) / target.bounds.width)),
      Math.max(0, Math.min(height - 1, (localY * height) / target.bounds.height)),
    ];
  }

  private async applyDelivery(
    tool: string,
    args: ComputerUseArgs,
    driverArgs: Record<string, unknown>,
    target: ActiveTarget,
    session: CuaDriverSessionLike,
    signal: AbortSignal,
  ): Promise<void> {
    if (args.delivery_mode !== "foreground") return;
    if (!schemaDeclaresProperty(session.toolCatalog.get(tool), "delivery_mode")) {
      throw new ComputerUseSafetyError(
        "foreground_unsupported",
        `The pinned cua-driver does not support foreground delivery for ${tool}.`,
      );
    }
    if (args.bring_to_front === true) {
      await this.callDriver(
        "bring_to_front",
        { pid: target.pid, window_id: target.windowId },
        signal,
      );
    }
    driverArgs.delivery_mode = "foreground";
  }

  private async mutate(
    args: ComputerUseArgs,
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const target = this.requireTarget();
    const session = await this.getSession(signal);
    let tool: string;
    let driverArgs: Record<string, unknown> = {
      pid: target.pid,
      window_id: target.windowId,
    };

    switch (args.action) {
      case "click":
      case "double_click":
      case "right_click":
      case "middle_click": {
        tool =
          args.action === "double_click"
            ? "double_click"
            : args.action === "right_click"
              ? "right_click"
              : "click";
        if (args.element !== undefined) {
          driverArgs = { ...driverArgs, ...this.elementArgs(session, tool, target, args.element) };
        } else if (args.coordinate) {
          driverArgs = { ...driverArgs, ...this.pointArgs(target, args.coordinate) };
        }
        if (tool === "click") driverArgs.button = args.button ?? "left";
        if (args.modifiers?.length) driverArgs.modifier = args.modifiers;
        break;
      }
      case "drag": {
        tool = "drag";
        const from =
          args.from_element !== undefined
            ? this.elementCenter(target, args.from_element)
            : args.from_coordinate!;
        const to =
          args.to_element !== undefined
            ? this.elementCenter(target, args.to_element)
            : args.to_coordinate!;
        this.pointArgs(target, from);
        this.pointArgs(target, to);
        driverArgs = {
          ...driverArgs,
          from_x: from[0],
          from_y: from[1],
          to_x: to[0],
          to_y: to[1],
          button: args.button ?? "left",
          ...(args.modifiers?.length ? { modifier: args.modifiers } : {}),
        };
        break;
      }
      case "scroll":
        tool = "scroll";
        driverArgs.direction = args.direction;
        driverArgs.amount = args.amount ?? 3;
        if (args.element !== undefined) {
          driverArgs = { ...driverArgs, ...this.elementArgs(session, tool, target, args.element) };
        } else if (args.coordinate) {
          driverArgs = { ...driverArgs, ...this.pointArgs(target, args.coordinate) };
        }
        break;
      case "type":
        tool = "type_text";
        driverArgs.text = args.text;
        break;
      case "key": {
        const chord = parseComputerUseKeyChord(args.keys);
        tool = chord.modifiers.length ? "hotkey" : "press_key";
        if (tool === "hotkey") driverArgs.keys = [...chord.modifiers, chord.key];
        else driverArgs.key = chord.key;
        break;
      }
      case "set_value":
        tool = "set_value";
        driverArgs = {
          ...driverArgs,
          ...this.elementArgs(session, tool, target, args.element!),
          value: args.value,
        };
        break;
      default:
        throw new ComputerUseSafetyError("invalid_action", `Unsupported mutation ${args.action}.`);
    }

    await this.applyDelivery(tool, args, driverArgs, target, session, signal);
    const result = await this.callDriver(tool, driverArgs, signal);
    const verdict = parseDriverVerdict(result.structured);
    const effect = verdict.effect ?? verdict.path;
    // Driver indices/tokens and screenshot coordinates describe the UI before
    // this mutation. Keep the immutable window identity, but make every later
    // element/pixel action acquire a fresh snapshot and a fresh approval.
    this.invalidateTargetSnapshot(target);
    const actionPayload: Record<string, unknown> = {
      ok: true,
      action: args.action,
      target: this.targetDetails(target),
      ...(result.text ? { message: result.text.slice(0, 8_000) } : {}),
      ...verdict,
      ...(args.delivery_mode ? { delivery_mode: args.delivery_mode } : {}),
    };

    if (args.capture_after === true) {
      try {
        const capture = await this.captureWindow(target, "som", 100, signal);
        const captureText = capture.content[0] as TextContent;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...actionPayload, capture: JSON.parse(captureText.text) }),
            },
            ...capture.content.slice(1),
          ],
          details: {
            ...capture.details,
            action: args.action,
            driverEffect: effect,
            ...verdict,
            capturedAfter: true,
          },
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return textResult(
          {
            ...actionPayload,
            capture_warning:
              "The action completed, but the follow-up capture failed. Do not repeat the action blindly.",
          },
          {
            action: args.action,
            target: this.targetDetails(target),
            driverEffect: effect,
            ...verdict,
          },
        );
      }
    }
    return textResult(actionPayload, {
      action: args.action,
      target: this.targetDetails(target),
      driverEffect: effect,
      ...verdict,
    });
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.lifecycle.abort(new ComputerUseSafetyError("cancelled", "Computer Use closed."));
    this.grants.clear();
    this.clearTarget();
    await this.startup?.catch(() => {});
    await this.session?.close().catch(() => {});
    await this.host?.shutdown().catch(() => {});
    this.session = null;
    this.host = null;
  }
}
