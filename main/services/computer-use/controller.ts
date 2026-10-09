import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  CUA_DRIVER_ELEMENT_TOKEN_PATTERN,
  CUA_DRIVER_TYPED_TARGET_TOOLS,
  CuaDriverError,
  type CuaDriverToolInfo,
} from "./contract.js";
import type { CuaDriverCallOptions } from "./session.js";
import type { ComputerUseArgs, ComputerUseMode } from "./schema.js";
import {
  ComputerUseGrantLedger,
  ComputerUseSafetyError,
  type ComputerUseBoundTarget,
  type ComputerUseGrantPrepared,
  computerUseNeedsApproval,
  normalizeComputerUseArgs,
  parseComputerUseKeyChord,
  summarizeComputerUseApproval,
} from "./safety.js";
import type { FormFillBatchPlan, FormFillBatchResult, FormFillRowResult } from "../form-fill/batch-core.js";
import { FORM_FILL_UNAVAILABLE_MESSAGE } from "../../../renderer/shared/form-fill-availability.js";

const ACTION_TIMEOUT_MS = 30_000;
export const COMPUTER_USE_DISCOVERY_TIMEOUT_MS = 120_000;
const CAPTURE_TIMEOUT_MS = 60_000;
const MAX_DRIVER_TEXT_CHARS = 96_000;
const MAX_IMAGE_BASE64_CHARS = 60 * 1024 * 1024;
const DESKTOP_NAMES = new Set(["screen", "desktop"]);
/** get_window_state's own default AX walk cap (`get_window_state.rs`). */
const AX_WALK_CEILING = 2_000;
const AX_WALK_FLOOR = 500;

/**
 * The driver's max_elements caps AX nodes walked, including the structural
 * rows it never returns, so the model's element budget alone would truncate
 * the tree early. Walk generously; the returned list is capped locally.
 */
function axWalkBudget(maximumElements: number): number {
  return Math.min(AX_WALK_CEILING, Math.max(AX_WALK_FLOOR, maximumElements * 5));
}

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
  /** cua-driver's account of the action (`ActionResult.effect`), never `refused`. */
  driverEffect?: ComputerUseDriverEffect;
  /** Route the driver used (`ActionResult.route`). */
  driverRoute?: string;
  /** Delivery the driver reports (`ActionResult.delivery.mode`). */
  deliveryMode?: string;
  /** Delivered unit count, present for a `partial` effect. */
  deliveredCount?: number;
  /** Evidence kinds behind a `confirmed` effect. */
  evidence?: string[];
  /** Driver advice for the next rung; the harness decides whether to follow it. */
  escalation?: { target: string; reason: string };
  capturedAfter?: boolean;
  /** verify only: the aggregate verify_state status. */
  verifyStatus?: ComputerUseVerifyStatus;
}

export type ComputerUseVerifyStatus = "satisfied" | "unsatisfied" | "unknown";

export type ComputerUseDriverEffect = "confirmed" | "partial" | "unverifiable" | "suspected_noop";

export interface ComputerUseApprovalDescriptor {
  toolName: "computer_use";
  summary: string;
  target: ComputerUseTargetDetails;
  grant: ComputerUseGrantPrepared;
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
  /** Known toggle state for checkbox-like controls (absent = unknown). */
  checked?: boolean;
  /** AXSelected (or a checkbox/radio value) when the driver reports it. */
  selected?: boolean;
  enabled?: boolean;
  /** Actions the control advertises (e.g. AXPress). */
  actions?: string[];
  /** Screen-point rectangle. */
  frame?: Bounds;
  /** The same rectangle in pixels of this capture's screenshot. */
  screenshotFrame?: Bounds;
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

/** The closed 0.34 `ActionResult` (`cua-driver-contract/src/outputs.rs`). */
interface DriverActionOutcome {
  effect: ComputerUseDriverEffect;
  route: string;
  delivery?: { mode: string; delivered_count?: number };
  evidence?: Array<{ kind: string; detail?: string }>;
  escalation?: { target: string; reason: string };
}

interface DriverCall {
  tool: string;
  args: Record<string, unknown>;
}

const ACTION_EFFECTS = new Set(["confirmed", "partial", "unverifiable", "suspected_noop", "refused"]);
const ACTION_ROUTES = new Set([
  "accessibility",
  "synthetic_events",
  "global_input",
  "system_api",
  "dom",
  "trusted_input",
]);
const DELIVERY_MODES = new Set(["background", "foreground", "not_applicable", "unknown"]);
const EVIDENCE_KINDS = new Set(["value_readback", "window_change"]);
const ESCALATION_TARGETS = new Set(["pixel", "foreground", "page", "session"]);
const ESCALATION_REASONS = new Set([
  "route_unavailable",
  "delivery_failed",
  "effect_unconfirmed",
  "suspected_noop",
  "permission_required",
]);
/** Refusal codes meaning the exact (pid, window_id) target no longer resolves. */
const WINDOW_TARGET_REFUSALS = new Set([
  "ambiguous_window_target",
  "window_target_not_found",
  "window_id_not_found",
  "window_owner_pid_mismatch",
]);

class ComputerUseDriverActionError extends Error {
  constructor(
    message: string,
    readonly poisonsSession = false,
    /** Machine-readable refusal code from the driver's error envelope. */
    readonly code?: string,
    /** The driver could not account for input it may already have delivered. */
    readonly executionUnknown = false,
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
      false,
      refusalCode(asRecord(parsed.structuredContent)),
      // tool.rs / mcp_result.rs: output-contract failures after dispatch.
      asRecord(parsed.structuredContent)?.execution_state === "unknown",
    );
  }
  return { text, image, structured: asRecord(parsed.structuredContent) };
}

/**
 * The refusal code from either 0.34 error envelope:
 * `{status:"refused", refusal:{code}}` (element-token and dispatch paths) or
 * `{code, effect:"refused"}` (window-target and delivery paths).
 */
function refusalCode(structured: Record<string, unknown> | null): string | undefined {
  if (!structured) return undefined;
  const code = structured.code ?? asRecord(structured.refusal)?.code ?? asRecord(structured.error)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : undefined;
}

function enumString(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

/**
 * Parse the closed 0.34 action result. A successful action tool always
 * answers with it, so anything else is contract drift and poisons the session.
 * A `refused` effect carries `error.code` and is raised as that refusal.
 */
function parseActionResult(structured: Record<string, unknown> | null): DriverActionOutcome {
  const effect = enumString(structured?.effect, ACTION_EFFECTS);
  const route = enumString(structured?.route, ACTION_ROUTES);
  if (!structured || !effect || !route) {
    throw new ComputerUseDriverActionError(
      "Computer Use returned an action result outside the pinned contract.",
      true,
    );
  }
  if (effect === "refused") {
    const error = asRecord(structured.error);
    const hint = safeString(error?.hint, 1_000);
    throw new ComputerUseDriverActionError(
      hint ? `cua-driver refused the action: ${hint}` : "cua-driver refused the action.",
      false,
      refusalCode(structured),
    );
  }
  const delivery = asRecord(structured.delivery);
  const deliveryMode = enumString(delivery?.mode, DELIVERY_MODES);
  const deliveredCount = safeInteger(delivery?.delivered_count, 0);
  const evidence = Array.isArray(structured.evidence)
    ? structured.evidence.slice(0, 16).flatMap((value) => {
        const item = asRecord(value);
        const kind = enumString(item?.kind, EVIDENCE_KINDS);
        if (!kind) return [];
        const detail = safeString(item?.detail, 1_000);
        return [{ kind, ...(detail ? { detail } : {}) }];
      })
    : undefined;
  const escalationRecord = asRecord(structured.escalation);
  const escalationTarget = enumString(escalationRecord?.target, ESCALATION_TARGETS);
  const escalationReason = enumString(escalationRecord?.reason, ESCALATION_REASONS);
  return {
    effect: effect as ComputerUseDriverEffect,
    route,
    ...(deliveryMode
      ? {
          delivery: {
            mode: deliveryMode,
            ...(deliveredCount !== undefined ? { delivered_count: deliveredCount } : {}),
          },
        }
      : {}),
    ...(evidence?.length ? { evidence } : {}),
    ...(escalationTarget && escalationReason
      ? { escalation: { target: escalationTarget, reason: escalationReason } }
      : {}),
  };
}

function outcomeDetails(outcome: DriverActionOutcome): Partial<ComputerUseResultDetails> {
  return {
    driverEffect: outcome.effect,
    driverRoute: outcome.route,
    ...(outcome.delivery ? { deliveryMode: outcome.delivery.mode } : {}),
    ...(outcome.delivery?.delivered_count !== undefined
      ? { deliveredCount: outcome.delivery.delivered_count }
      : {}),
    ...(outcome.evidence ? { evidence: outcome.evidence.map((item) => item.kind) } : {}),
    ...(outcome.escalation ? { escalation: outcome.escalation } : {}),
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
    const rawActions = Array.isArray(element.actions) ? element.actions : undefined;
    const role = safeString(element.role, 256);
    const selected = typeof element.selected === "boolean" ? element.selected : undefined;
    const toggle = role !== undefined && /checkbox|radiobutton/iu.test(role);
    const token = safeString(element.element_token, 512);
    const normalized: ElementRecord = {
      index,
      token: token && CUA_DRIVER_ELEMENT_TOKEN_PATTERN.test(token) ? token : undefined,
      role,
      label: safeString(element.label, 1_000),
      value: safeString(element.value, 1_000),
      checked: toggle ? selected : undefined,
      selected,
      enabled: typeof element.enabled === "boolean" ? element.enabled : undefined,
      actions: rawActions
        ?.map((action) => safeString(action, 128))
        .filter((action): action is string => action !== undefined)
        .slice(0, 32),
      frame: parseBounds(element.frame),
      screenshotFrame: parseBounds(element.screenshot_frame),
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
    ...(typeof element.selected === "boolean" ? { selected: element.selected } : {}),
    ...(element.enabled === false ? { enabled: false } : {}),
    ...(element.actions?.length ? { actions: element.actions } : {}),
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

const VERIFY_STATUSES = new Set(["satisfied", "unsatisfied", "unknown"]);
const UNKNOWN_REASONS = new Set([
  "invalid_predicate",
  "unsupported_predicate",
  "untrusted_source",
  "multi_match",
  "target_missing",
  "observation_unavailable",
  "stability_unproven",
]);

/** Aiden's flat element predicate becomes verify_state's `{selector, ...}` shape. */
function driverPredicate(
  predicate: NonNullable<ComputerUseArgs["expect"]>[number],
): Record<string, unknown> {
  if (predicate.window) return { window: { ...predicate.window } };
  const element = predicate.element ?? {};
  const { role, label_contains: labelContains, ...state } = element;
  return {
    element: {
      selector: {
        ...(role !== undefined ? { role } : {}),
        ...(labelContains !== undefined ? { label_contains: labelContains } : {}),
      },
      exists: true,
      ...state,
    },
  };
}

/** `VerifyStateOutput` (`cua-driver-contract/src/verification.rs`). */
function parseVerification(structured: Record<string, unknown> | null): {
  status: ComputerUseVerifyStatus;
  stable: boolean;
  samples?: number;
  elapsed_ms?: number;
  predicates: Array<{
    index: number;
    status: ComputerUseVerifyStatus;
    unknown_reason?: string;
    observed?: string;
  }>;
} {
  const status = enumString(structured?.status, VERIFY_STATUSES);
  if (!structured || !status || !Array.isArray(structured.predicates)) {
    throw new ComputerUseDriverActionError(
      "Computer Use returned a verification result outside the pinned contract.",
      true,
    );
  }
  return {
    status: status as ComputerUseVerifyStatus,
    stable: structured.stable === true,
    ...(safeInteger(structured.samples, 0) !== undefined
      ? { samples: safeInteger(structured.samples, 0) }
      : {}),
    ...(safeInteger(structured.elapsed_ms, 0) !== undefined
      ? { elapsed_ms: safeInteger(structured.elapsed_ms, 0) }
      : {}),
    predicates: structured.predicates.slice(0, 8).flatMap((value) => {
      const predicate = asRecord(value);
      const index = safeInteger(predicate?.index, 0);
      const predicateStatus = enumString(predicate?.status, VERIFY_STATUSES);
      if (index === undefined || !predicateStatus) return [];
      const reason = enumString(predicate?.unknown_reason, UNKNOWN_REASONS);
      // Matched application state is untrusted content; keep it bounded.
      const observed = safeString(predicate?.observed_json, 1_000);
      return [
        {
          index,
          status: predicateStatus as ComputerUseVerifyStatus,
          ...(reason ? { unknown_reason: reason } : {}),
          ...(observed ? { observed } : {}),
        },
      ];
    }),
  };
}

/**
 * The pinned schemas are closed: the driver refuses any undeclared argument
 * as invalid_arguments. Refuse locally first, before approval or dispatch.
 */
function assertSchemaAccepts(
  tool: CuaDriverToolInfo | undefined,
  name: string,
  args: Record<string, unknown>,
): void {
  const properties = asRecord(asRecord(tool?.inputSchema)?.properties);
  const undeclared = Object.keys(args).find(
    (key) => !properties || !Object.prototype.hasOwnProperty.call(properties, key),
  );
  if (undeclared !== undefined) {
    throw new ComputerUseSafetyError(
      "unsupported_arguments",
      `The pinned cua-driver ${name} schema does not accept ${undeclared}.`,
    );
  }
}

export class ComputerUseController {
  private state: "new" | "starting" | "ready" | "poisoned" | "closed" = "new";
  private host: CuaDriverHostLike | null = null;
  private session: CuaDriverSessionLike | null = null;
  private startup: Promise<CuaDriverSessionLike> | null = null;
  private closePromise: Promise<void> | null = null;
  private closeFailed = false;
  private readonly driverCalls = new Set<Promise<unknown>>();
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
    // focus_app only previews the resolved window. Committing setTarget here
    // would wipe a prior capture when the user denies the prompt.
    if (normalized.action === "focus_app") {
      const preview = await this.resolveTarget({ app: normalized.app }, signal);
      const boundTarget: ComputerUseBoundTarget = {
        pid: preview.pid,
        windowId: preview.windowId,
      };
      return {
        toolName: "computer_use",
        summary: `${summarizeComputerUseApproval(normalized)} — ${this.approvalTargetSummary(preview)}`,
        target: this.targetDetails(preview)!,
        grant: this.grants.prepare(normalized, boundTarget),
      };
    }
    const target = this.requireTarget();
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
    const { boundTarget: focusBinding } = this.grants.consume(toolCallId, args);
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
          return await this.focusApp(args, signal, focusBinding);
        case "verify":
          return await this.verify(args, signal);
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

  async closeAndSettle(): Promise<void> {
    await this.close();
    if (this.closeFailed) throw new Error("Computer Use teardown failed.");
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
      signal.throwIfAborted();
      const call = session.callTool(name, args, { signal, timeoutMs });
      this.driverCalls.add(call);
      try {
        return parseDriverResult(await call);
      } finally {
        this.driverCalls.delete(call);
      }
    } catch (error) {
      if (error instanceof ComputerUseDriverActionError) {
        if (error.poisonsSession) this.poison();
        throw this.refusalError(error);
      }
      if (error instanceof CuaDriverError && error.code === "request_too_large") throw error;
      this.poison();
      throw error;
    }
  }

  /**
   * Translate the driver's machine-readable refusals into Aiden's recovery
   * instructions, and drop local state the refusal proves stale. Nothing was
   * delivered for any of these, so the session stays usable.
   */
  private refusalError(error: ComputerUseDriverActionError): Error {
    const detail = error.message.slice(0, 1_000);
    if (error.executionUnknown) {
      // The UI may already have changed; nothing captured before can be trusted.
      if (this.target) this.invalidateTargetSnapshot(this.target);
      return new ComputerUseSafetyError(
        "execution_unknown",
        `cua-driver could not report whether this action ran${error.code ? ` (${error.code})` : ""}; it may already have taken effect. Capture the window again and check before any retry, and never repeat it blindly. (${detail})`,
      );
    }
    if (error.code === "stale_element_token") {
      if (this.target) this.invalidateTargetSnapshot(this.target);
      return new ComputerUseSafetyError(
        "stale_element",
        `The element token from the latest capture is no longer valid. Capture the window again before acting. (${detail})`,
      );
    }
    if (error.code === "screenshot_context_missing") {
      if (this.target) this.invalidateTargetSnapshot(this.target);
      return new ComputerUseSafetyError(
        "snapshot_required",
        `cua-driver holds no screenshot of this window from this session. Capture it again with a screenshot before using pixel coordinates. (${detail})`,
      );
    }
    if (error.code && WINDOW_TARGET_REFUSALS.has(error.code)) {
      this.clearTarget();
      return new ComputerUseSafetyError(
        "target_unavailable",
        `The captured window no longer resolves to one exact target (${error.code}). Call list_windows, then capture the intended pid and window_id again. (${detail})`,
      );
    }
    if (error.code === "background_unavailable") {
      return new ComputerUseSafetyError(
        "foreground_required",
        `cua-driver cannot deliver this action in the background. Retry it with delivery_mode "foreground", which visibly fronts the window and needs its own approval. (${detail})`,
      );
    }
    return error;
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

  private targetDetails(
    target: Pick<WindowRecord, "pid" | "windowId" | "appName" | "title"> | null = this.target,
  ): ComputerUseTargetDetails | undefined {
    return target
      ? {
          pid: target.pid,
          windowId: target.windowId,
          ...(target.appName ? { app: target.appName } : {}),
          ...(target.title ? { title: target.title } : {}),
        }
      : undefined;
  }

  private approvalTargetSummary(
    target: Pick<WindowRecord, "appName" | "title" | "pid" | "windowId">,
  ): string {
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
      throw new ComputerUseDriverActionError(
        "Capture requires app or exact pid and window_id. Call list_windows, then capture the intended target.",
      );
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
      return await this.captureWindow(
        target,
        requestedMode,
        args.max_elements ?? 100,
        signal,
        args.max_image_dimension,
      );
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
    maxImageDimension?: number,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    // A new snapshot invalidates every prior index/token even if the driver
    // subsequently reports an error.
    this.setTarget(window, []);
    const degraded = requestedMode === "vision" && !this.supportsImages;
    const effectiveMode: ComputerUseMode = degraded ? "ax" : requestedMode;
    const includeScreenshot = this.supportsImages && effectiveMode !== "ax";
    // 0.34 ignores the deprecated capture_mode; the two include_* switches
    // select the work. Vision skips the AX walk entirely (its snapshot still
    // anchors pixel actions); ax and text-only models skip the screenshot.
    const driverArgs: Record<string, unknown> =
      effectiveMode === "vision"
        ? {
            pid: window.pid,
            window_id: window.windowId,
            include_accessibility_tree: false,
            include_screenshot: true,
          }
        : {
            pid: window.pid,
            window_id: window.windowId,
            include_screenshot: includeScreenshot,
            max_elements: axWalkBudget(maximumElements),
          };
    if (maxImageDimension !== undefined && driverArgs.include_screenshot === true) {
      driverArgs.max_image_dimension = maxImageDimension;
    }
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
    const width = result.image?.width ?? safeInteger(result.structured?.screenshot_width, 1);
    const height = result.image?.height ?? safeInteger(result.structured?.screenshot_height, 1);
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
      total_elements:
        safeInteger(result.structured?.total_element_count, 0) ??
        safeInteger(result.structured?.element_count, 0) ??
        elements.length,
      ...(degraded
        ? { note: "Vision capture degraded to accessibility text for this model." }
        : {}),
      // e.g. ax_tree_empty: a non-AX surface the model should act on by pixels.
      ...(result.structured?.degraded === true && safeString(result.structured.degraded_reason)
        ? { capture_note: safeString(result.structured.degraded_reason, 1_000) }
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
    approvedTarget?: { pid: number; windowId: number },
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    // Bind the active target only after Allow-once consumed the grant.
    const resolved = await this.resolveTarget({ app: args.app }, signal);
    if (
      !approvedTarget ||
      resolved.pid !== approvedTarget.pid ||
      resolved.windowId !== approvedTarget.windowId
    ) {
      throw new ComputerUseSafetyError(
        "approval_expired",
        "The focus target changed after the approval prompt. Approve the exact window again.",
      );
    }
    const target = this.setTarget(resolved);
    let effect = "targeted_background_window";
    // bring_to_front keeps its own typed result (not an ActionResult): its
    // success already means the exact window was verified frontmost.
    let activated: boolean | undefined;
    try {
      if (args.raise_window === true) {
        const result = await this.callDriver(
          "bring_to_front",
          { pid: target.pid, window_id: target.windowId },
          signal,
        );
        if (typeof result.structured?.activated === "boolean") {
          activated = result.structured.activated;
        }
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
      ...(activated !== undefined ? { activated } : {}),
    };
    if (args.capture_after === true) {
      try {
        const capture = await this.captureWindow(target, "som", 100, signal);
        capture.details.action = "focus_app";
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
          { action: "focus_app", target: this.targetDetails(target) },
        );
      }
    }
    return textResult(actionPayload, { action: "focus_app", target: this.targetDetails(target) });
  }

  /** Read-only verify_state on the active exact window; it never replaces the capture. */
  private async verify(
    args: ComputerUseArgs,
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const target = this.requireTarget();
    const session = await this.getSession(signal);
    const includeScreenshot = args.include_screenshot === true && this.supportsImages;
    const driverArgs: Record<string, unknown> = {
      pid: target.pid,
      window_id: target.windowId,
      expect: (args.expect ?? []).map(driverPredicate),
      ...(args.stable_samples !== undefined ? { stable_samples: args.stable_samples } : {}),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
      ...(includeScreenshot ? { include_screenshot: true } : {}),
    };
    assertSchemaAccepts(session.toolCatalog.get("verify_state"), "verify_state", driverArgs);
    const result = await this.callDriver("verify_state", driverArgs, signal);
    let verification: ReturnType<typeof parseVerification>;
    try {
      verification = parseVerification(result.structured);
    } catch (error) {
      if (error instanceof ComputerUseDriverActionError && error.poisonsSession) this.poison();
      throw error;
    }
    return textResult(
      {
        ok: true,
        action: "verify",
        target: this.targetDetails(target),
        ...verification,
        ...(args.include_screenshot === true && !this.supportsImages
          ? { note: "This model cannot read images, so no screenshot was requested." }
          : {}),
      },
      { action: "verify", target: this.targetDetails(target), verifyStatus: verification.status },
      includeScreenshot ? result.image : undefined,
    );
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

  /** Approval rehearses the exact driver call so a doomed action is never prompted. */
  private validateApprovalTarget(args: ComputerUseArgs, target: ActiveTarget): void {
    this.buildDriverCall(args, target, this.session?.toolCatalog);
  }

  /**
   * Resolve one approved action into the single 0.34 driver call it makes.
   * Pure apart from validation: element indices resolve to the latest
   * capture's tokens, pixels are checked against its screenshot, and every
   * argument must be one the pinned closed schema declares.
   */
  private buildDriverCall(
    args: ComputerUseArgs,
    target: ActiveTarget,
    catalog: ReadonlyMap<string, CuaDriverToolInfo> | undefined,
  ): DriverCall {
    let tool: string;
    let driverArgs: Record<string, unknown>;
    const windowArgs = (name: string): Record<string, unknown> =>
      CUA_DRIVER_TYPED_TARGET_TOOLS.has(name)
        ? { target: { kind: "window", pid: target.pid, window_id: target.windowId } }
        : { pid: target.pid, window_id: target.windowId };

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
        driverArgs = windowArgs(tool);
        if (args.element !== undefined) {
          Object.assign(driverArgs, this.elementArgs(catalog, tool, target, args.element));
        } else if (args.coordinate) {
          Object.assign(driverArgs, this.pointArgs(target, args.coordinate));
        }
        if (tool === "click") driverArgs.button = args.button ?? "left";
        if (args.modifiers?.length) driverArgs.modifier = args.modifiers;
        break;
      }
      case "drag": {
        // macOS 0.34 drag has no element endpoints and is foreground-only.
        tool = "drag";
        const from =
          args.from_element !== undefined
            ? this.elementScreenshotCenter(target, args.from_element)
            : args.from_coordinate;
        const to =
          args.to_element !== undefined
            ? this.elementScreenshotCenter(target, args.to_element)
            : args.to_coordinate;
        if (!from || !to) {
          throw new ComputerUseSafetyError("invalid_drag", "drag requires a source and a target.");
        }
        const start = this.pointArgs(target, from);
        const end = this.pointArgs(target, to);
        driverArgs = {
          ...windowArgs(tool),
          from_x: start.x,
          from_y: start.y,
          to_x: end.x,
          to_y: end.y,
          button: args.button ?? "left",
          ...(args.modifiers?.length ? { modifier: args.modifiers } : {}),
        };
        break;
      }
      case "scroll":
        tool = "scroll";
        driverArgs = { ...windowArgs(tool), direction: args.direction, amount: args.amount ?? 3 };
        if (args.element !== undefined) {
          Object.assign(driverArgs, this.elementArgs(catalog, tool, target, args.element));
        } else if (args.coordinate) {
          Object.assign(driverArgs, this.pointArgs(target, args.coordinate));
        }
        break;
      case "type":
        tool = "type_text";
        driverArgs = { ...windowArgs(tool), text: args.text };
        break;
      case "key": {
        const chord = parseComputerUseKeyChord(args.keys);
        tool = chord.modifiers.length ? "hotkey" : "press_key";
        driverArgs = windowArgs(tool);
        if (tool === "hotkey") driverArgs.keys = [...chord.modifiers, chord.key];
        else driverArgs.key = chord.key;
        break;
      }
      case "set_value":
        tool = "set_value";
        driverArgs = {
          ...windowArgs(tool),
          ...this.elementArgs(catalog, tool, target, args.element!),
          value: args.value,
        };
        break;
      case "menu":
        // invoke_menu fronts the app itself; it takes no delivery_mode.
        tool = "invoke_menu";
        driverArgs = { ...windowArgs(tool), path: [...(args.menu_path ?? [])] };
        break;
      case "set_window_frame":
        tool = "set_window_frame";
        driverArgs = {
          ...windowArgs(tool),
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
        };
        break;
      default:
        throw new ComputerUseSafetyError("invalid_action", `Unsupported mutation ${args.action}.`);
    }
    if (args.delivery_mode === "foreground" && tool !== "invoke_menu") {
      driverArgs.delivery_mode = "foreground";
    }
    if (catalog) assertSchemaAccepts(catalog.get(tool), tool, driverArgs);
    return { tool, args: driverArgs };
  }

  private elementArgs(
    catalog: ReadonlyMap<string, CuaDriverToolInfo> | undefined,
    tool: string,
    target: ActiveTarget,
    index: number,
  ): Record<string, unknown> {
    const element = this.requireCapturedElement(target, index);
    if (catalog && !catalog.get(tool)?.capabilities.has("accessibility.element_tokens")) {
      throw new ComputerUseSafetyError(
        "element_unsupported",
        `The pinned cua-driver ${tool} tool does not accept element tokens. Use pixel coordinates instead.`,
      );
    }
    // 0.34 addresses elements only by the snapshot-bound token; Aiden's index
    // is a local handle into the latest capture.
    if (!element.token) {
      throw new ComputerUseSafetyError(
        "stale_element",
        `Element ${index} has no element token in the latest capture. Capture the window again before acting on it.`,
      );
    }
    return { element_token: element.token };
  }

  private pointArgs(target: ActiveTarget, coordinate: readonly number[]): { x: number; y: number } {
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

  /** Centre of an element in the latest capture's screenshot pixels. */
  private elementScreenshotCenter(target: ActiveTarget, index: number): [number, number] {
    const element = this.requireCapturedElement(target, index);
    const frame = element.screenshotFrame;
    const width = target.screenshotWidth;
    const height = target.screenshotHeight;
    if (!frame || width === undefined || height === undefined) {
      throw new ComputerUseSafetyError(
        "drag_frame_unavailable",
        `Element ${index} has no screenshot frame in the latest capture. Capture with a screenshot, or drag by pixel coordinates.`,
      );
    }
    // screenshot_frame is unclipped (element_frame.rs): an element scrolled
    // out of view or overflowing the window has no pixel in this screenshot,
    // and pinning it to an edge would drag something unrelated.
    const center: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    if (center[0] < 0 || center[1] < 0 || center[0] >= width || center[1] >= height) {
      throw new ComputerUseSafetyError(
        "drag_frame_unavailable",
        `Element ${index} lies outside the captured window. Scroll it into view and capture again, or drag by pixel coordinates.`,
      );
    }
    return center;
  }

  private async mutate(
    args: ComputerUseArgs,
    signal: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    const target = this.requireTarget();
    const session = await this.getSession(signal);
    const call = this.buildDriverCall(args, target, session.toolCatalog);
    if (args.delivery_mode === "foreground" && args.bring_to_front === true) {
      await this.callDriver(
        "bring_to_front",
        { pid: target.pid, window_id: target.windowId },
        signal,
      );
    }
    // invoke_menu focuses the app and presses earlier segments before it can
    // refuse a later one, and may leave a menu open, so a menu failure still
    // changes the UI the current snapshot describes.
    const invalidateAfterMenuFailure = () => {
      if (call.tool === "invoke_menu") this.invalidateTargetSnapshot(target);
    };
    let result: Awaited<ReturnType<typeof this.callDriver>>;
    try {
      result = await this.callDriver(call.tool, call.args, signal);
    } catch (error) {
      invalidateAfterMenuFailure();
      throw error;
    }
    let outcome: DriverActionOutcome;
    try {
      outcome = parseActionResult(result.structured);
    } catch (error) {
      invalidateAfterMenuFailure();
      if (!(error instanceof ComputerUseDriverActionError)) throw error;
      if (error.poisonsSession) this.poison();
      throw this.refusalError(error);
    }
    // Driver tokens and screenshot coordinates describe the UI before this
    // mutation. Keep the immutable window identity, but make every later
    // element/pixel action acquire a fresh snapshot and a fresh approval.
    this.invalidateTargetSnapshot(target);
    const details = outcomeDetails(outcome);
    const actionPayload: Record<string, unknown> = {
      ok: true,
      action: args.action,
      target: this.targetDetails(target),
      ...(result.text ? { message: result.text.slice(0, 8_000) } : {}),
      ...outcome,
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
            ...details,
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
          { action: args.action, target: this.targetDetails(target), ...details },
        );
      }
    }
    return textResult(actionPayload, {
      action: args.action,
      target: this.targetDetails(target),
      ...details,
    });
  }

  /**
   * No capture may mint approval until the pinned driver supplies document
   * lifetime identity AND atomically checks it when applying each write.
   * Window metadata, AX structure and snapshot tokens are not such authority.
   */
  async formFillCapture(
    _input: { pid: number; windowId: number },
    _signal?: AbortSignal,
  ): Promise<{
    window: { pid: number; windowId: number; appName: string; title: string };
    elements: readonly ElementRecord[];
    revision: number;
  }> {
    throw new ComputerUseSafetyError("form_fill_unavailable", FORM_FILL_UNAVAILABLE_MESSAGE);
  }

  /** Reject stale/direct approvals too; tool omission alone is not a safety boundary. */
  async executeFormFillBatch(
    _plan: FormFillBatchPlan,
    _options: {
      signal?: AbortSignal;
      onRow?: (row: FormFillRowResult, completed: number, total: number) => void;
    } = {},
  ): Promise<FormFillBatchResult> {
    throw new ComputerUseSafetyError("form_fill_unavailable", FORM_FILL_UNAVAILABLE_MESSAGE);
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.lifecycle.abort(new ComputerUseSafetyError("cancelled", "Computer Use closed."));
    this.grants.clear();
    this.clearTarget();
    await this.startup?.catch(() => {});
    await this.session?.close().catch(() => { this.closeFailed = true; });
    await this.host?.shutdown().catch(() => { this.closeFailed = true; });
    await Promise.allSettled([...this.driverCalls]);
    this.session = null;
    this.host = null;
  }
}
