/**
 * Adapted from t3code apps/web/src/components/device/deviceHubApi.ts @ a6ec88f7 (MIT)
 *
 * The simulator's accessibility tree for the element-frame overlay. serve-sim's
 * helper answers `GET /vendor/serve-sim/helper/<udid>/ax` with the native
 * nested tree; it is read through main's token proxy like the stream. T3
 * normalizes frames to the root application frame; Aiden additionally maps
 * them into the displayed stream when the tree and the stream disagree about
 * rotation, so frames follow the device as it turns. Android emulators read
 * serve-emu's `/api/accessibility` (a `uiautomator dump`), normalized to the
 * same frames by `flattenAndroidAxSnapshot`.
 */
import type { DevicePlatform, DeviceStreamGrant } from "../shared/devices";
import { deviceHubUrl, type DeviceOrientation } from "./device-stream";

export interface DeviceAxRect {
  /** Normalized 0..1 on both axes. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeviceAxElement extends DeviceAxRect {
  id: string;
  label: string;
  role: string;
}

export interface DeviceAxTree {
  elements: DeviceAxElement[];
  /** The root application frame, in the tree's own points. */
  root: { width: number; height: number } | null;
  errors: string[];
}

export const DEVICE_AX_ELEMENT_LIMIT = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Flattens serve-sim's nested tree the way its own overlay does: skips nodes
 * with the root's frame (they would tint the whole screen) and caps the count.
 */
export function flattenIosAxTree(roots: readonly unknown[]): Omit<DeviceAxTree, "errors"> {
  const first = roots[0];
  const rootFrame = isRecord(first) && isRecord(first.frame) ? first.frame : null;
  const screenWidth = Math.max(1, numberOr(rootFrame?.width, 1));
  const screenHeight = Math.max(1, numberOr(rootFrame?.height, 1));
  const elements: DeviceAxElement[] = [];
  const visit = (node: unknown, path: string, depth: number) => {
    if (elements.length >= DEVICE_AX_ELEMENT_LIMIT || depth > 64 || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    const width = numberOr(frame.width, 0);
    const height = numberOr(frame.height, 0);
    const coversScreen = Math.abs(width - screenWidth) < 0.5 && Math.abs(height - screenHeight) < 0.5;
    if (!coversScreen && width > 0 && height > 0) {
      elements.push({
        id: typeof node.AXUniqueId === "string" && node.AXUniqueId ? node.AXUniqueId : path,
        label: typeof node.AXLabel === "string" ? node.AXLabel : "",
        role: typeof node.type === "string" ? node.type : "",
        x: numberOr(frame.x, 0) / screenWidth,
        y: numberOr(frame.y, 0) / screenHeight,
        width: width / screenWidth,
        height: height / screenHeight,
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, index) => visit(child, `${path}.${index}`, depth + 1));
  };
  roots.forEach((root, index) => visit(root, String(index), 0));
  // Ids must be unique for keyed rendering; a repeated AXUniqueId falls back to its path.
  const seen = new Set<string>();
  for (const [index, element] of elements.entries()) {
    if (seen.has(element.id)) elements[index] = { ...element, id: `${element.id}#${index}` };
    seen.add(elements[index]!.id);
  }
  return { elements, root: rootFrame ? { width: screenWidth, height: screenHeight } : null };
}

/** The last dotted part of an Android class name: `android.widget.Button` reads as `Button`. */
const shortClassName = (name: string) => name.slice(name.lastIndexOf(".") + 1);

/**
 * Normalizes serve-emu's `/api/accessibility` snapshot, a flattened
 * `uiautomator dump`, to the same element frames the iOS tree gives. Bounds
 * are pixels in the dump's own rotation; `screen` is that rotated size (when
 * serve-emu could not read it, the furthest bound stands in). Nodes covering
 * the whole screen are skipped as on iOS, and the label is the text, then the
 * content description, then the resource id's name.
 */
export function flattenAndroidAxSnapshot(snapshot: unknown): Omit<DeviceAxTree, "errors"> {
  const nodes = isRecord(snapshot) && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const bounds = (node: unknown) => {
    const box = isRecord(node) && isRecord(node.bounds) ? node.bounds : null;
    if (!box) return null;
    const left = numberOr(box.left, Number.NaN);
    const top = numberOr(box.top, Number.NaN);
    const right = numberOr(box.right, Number.NaN);
    const bottom = numberOr(box.bottom, Number.NaN);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  };
  const screenRecord = isRecord(snapshot) && isRecord(snapshot.screen) ? snapshot.screen : null;
  let width = numberOr(screenRecord?.width, 0);
  let height = numberOr(screenRecord?.height, 0);
  if (width <= 0 || height <= 0) {
    for (const node of nodes) {
      const box = bounds(node);
      if (!box) continue;
      width = Math.max(width, box.right);
      height = Math.max(height, box.bottom);
    }
  }
  if (width <= 0 || height <= 0) return { elements: [], root: null };
  const elements: DeviceAxElement[] = [];
  for (const [index, node] of nodes.entries()) {
    if (elements.length >= DEVICE_AX_ELEMENT_LIMIT) break;
    const box = bounds(node);
    if (!box || !isRecord(node)) continue;
    const coversScreen = box.left <= 0 && box.top <= 0 && box.right >= width && box.bottom >= height;
    if (coversScreen) continue;
    const resource = typeof node.resourceId === "string" ? node.resourceId.slice(node.resourceId.indexOf("/") + 1) : "";
    const label =
      (typeof node.text === "string" && node.text) ||
      (typeof node.contentDescription === "string" && node.contentDescription) ||
      resource;
    const x = Math.max(0, box.left) / width;
    const y = Math.max(0, box.top) / height;
    elements.push({
      id: typeof node.id === "string" && node.id ? `${node.id}` : String(index),
      label: label.slice(0, 512),
      role: typeof node.className === "string" ? shortClassName(node.className) : "",
      x,
      y,
      width: Math.min(1, box.right / width) - x,
      height: Math.min(1, box.bottom / height) - y,
    });
  }
  return { elements, root: { width, height } };
}

type Mapping = (point: { x: number; y: number }) => { x: number; y: number };

const IDENTITY: Mapping = (point) => point;
/** Interface (rotated) coordinates to the raw portrait framebuffer: the same mapping touches use. */
const UI_TO_RAW: Partial<Record<DeviceOrientation, Mapping>> = {
  landscape_left: ({ x, y }) => ({ x: y, y: 1 - x }),
  landscape_right: ({ x, y }) => ({ x: 1 - y, y: x }),
  portrait_upside_down: ({ x, y }) => ({ x: 1 - x, y: 1 - y }),
};
const RAW_TO_UI: Partial<Record<DeviceOrientation, Mapping>> = {
  landscape_left: ({ x, y }) => ({ x: 1 - y, y: x }),
  landscape_right: ({ x, y }) => ({ x: y, y: 1 - x }),
  portrait_upside_down: ({ x, y }) => ({ x: 1 - x, y: 1 - y }),
};

const landscape = (orientation: DeviceOrientation) =>
  orientation === "landscape_left" || orientation === "landscape_right";

/**
 * Maps a tree-normalized rect into the displayed stream.
 *
 * The stream shows the framebuffer as it arrives. Current serve-sim sends a
 * rotated framebuffer (landscape-shaped for a landscape device) and the tree
 * in the same interface space, so nothing moves. When the stream stays
 * portrait-shaped while the device is turned, the display is the raw portrait
 * framebuffer and interface frames are turned into it; a tree that reports
 * portrait frames for a landscape device is turned the other way.
 */
export function axRectToDisplay(
  rect: DeviceAxRect,
  root: { width: number; height: number } | null,
  screen: { width: number; height: number; orientation: DeviceOrientation } | null,
): DeviceAxRect {
  if (!screen || screen.orientation === "portrait") return rect;
  const displayRaw = screen.width <= screen.height;
  // Upside down cannot be told apart by shape; the tree is taken to be in interface space.
  const treeRaw = Boolean(root && landscape(screen.orientation) && root.width <= root.height);
  let map = IDENTITY;
  if (displayRaw && !treeRaw) map = UI_TO_RAW[screen.orientation] ?? IDENTITY;
  else if (!displayRaw && treeRaw) map = RAW_TO_UI[screen.orientation] ?? IDENTITY;
  if (map === IDENTITY) return rect;
  const a = map({ x: rect.x, y: rect.y });
  const b = map({ x: rect.x + rect.width, y: rect.y + rect.height });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** The smallest element under a displayed point, which is the one a tap there most likely hits. */
export function hitTestAxElements<T extends DeviceAxRect>(elements: readonly T[], point: { x: number; y: number }): T | null {
  let best: T | null = null;
  for (const element of elements) {
    const inside =
      point.x >= element.x &&
      point.x <= element.x + element.width &&
      point.y >= element.y &&
      point.y <= element.y + element.height;
    if (inside && (!best || element.width * element.height < best.width * best.height)) best = element;
  }
  return best;
}

export interface DeviceAxRuntime {
  fetch(url: string, init: { signal: AbortSignal; credentials: "omit"; cache: "no-store" }): Promise<Response>;
}

/** Reads the tree once through the token proxy. A helper error is reported, not thrown. */
export async function fetchDeviceAxTree(
  target: { hostId: string; deviceId: string; grant: DeviceStreamGrant; platform?: DevicePlatform },
  signal: AbortSignal,
  runtime: DeviceAxRuntime = { fetch: (url, init) => fetch(url, init) },
): Promise<DeviceAxTree> {
  const android = target.platform === "android";
  const path = android
    ? `/vendor/serve-emu/api/accessibility?${new URLSearchParams({ device: target.deviceId }).toString()}`
    : `/vendor/serve-sim/helper/${encodeURIComponent(target.deviceId)}/ax`;
  const response = await runtime.fetch(deviceHubUrl(target, path, "http"), { signal, credentials: "omit", cache: "no-store" });
  if (response.status === 401) throw new DeviceAxUnauthorizedError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { elements: [], root: null, errors: ["The accessibility tree could not be read."] };
  }
  if (android) {
    // serve-emu answers `{ ok: false, error }` when `uiautomator dump` fails (an animation or a secure window).
    if (!isRecord(payload) || payload.ok !== true) {
      const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
      return { elements: [], root: null, errors: [error ?? "The accessibility tree is unavailable."] };
    }
    return { ...flattenAndroidAxSnapshot(payload), errors: [] };
  }
  if (!Array.isArray(payload)) {
    const error = isRecord(payload) && typeof payload.message === "string" ? payload.message : null;
    return { elements: [], root: null, errors: [error ?? "The accessibility tree is unavailable."] };
  }
  return { ...flattenIosAxTree(payload), errors: [] };
}

/** The grant expired; the caller should mint a new one. */
export class DeviceAxUnauthorizedError extends Error {
  constructor() {
    super("The simulator grant expired.");
    this.name = "DeviceAxUnauthorizedError";
  }
}
