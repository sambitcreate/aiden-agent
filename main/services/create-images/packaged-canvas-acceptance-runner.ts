import { app } from "../../platform.js";
import type { BrowserWindow } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { ONBOARDING_COMPLETE_STORAGE_KEY } from "../../../renderer/shared/onboarding.js";
import { createStarterWorkflow } from "../../../renderer/shared/create-images/schema.js";
import {
  countCreateImagesProductFileMutations,
  createImagesPhaseTwoProductFileEvidence,
  isCreateImagesDurableWorkflowPublication,
  snapshotCreateImagesProductFiles,
  writeCreateImagesPackagedAcceptanceReceipt,
  type CreateImagesPackagedAssetRequestEvidence,
  type CreateImagesPackagedAcceptanceSession,
} from "./packaged-canvas-acceptance-core.js";
import { createImagesService } from "./create-images-service.js";
import { observeCreateImagesRequestPolicy } from "./asset-protocol.js";

const CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROUTE = "/create-images/stress-100" as const;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_WAIT_MS = 30_000;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_POLL_MS = 25;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_BASELINE_STABLE_SAMPLES = 80;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_WIDTH = 4_000;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_HEIGHT = 4_000;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_METADATA_BYTES = 20 * 1024 * 1024;
const CREATE_IMAGES_PACKAGED_ACCEPTANCE_EGRESS_PROBE =
  "https://create-images-acceptance.invalid/blocked";

function createImagesAcceptanceCrc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function createImagesAcceptanceU32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function createImagesAcceptancePngChunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const checksum = Buffer.concat([typeBytes, payload]);
  return Buffer.concat([
    createImagesAcceptanceU32(payload.byteLength),
    checksum,
    createImagesAcceptanceU32(createImagesAcceptanceCrc32(checksum)),
  ]);
}

/** Same deterministic near-limit static PNG exercised by the decoder memory canary. */
function createImagesAcceptanceLargePng(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_WIDTH, 0);
  header.writeUInt32BE(CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_WIDTH * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_HEIGHT);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createImagesAcceptancePngChunk("IHDR", header),
    createImagesAcceptancePngChunk(
      "tEXt",
      Buffer.alloc(CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_METADATA_BYTES),
    ),
    createImagesAcceptancePngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    createImagesAcceptancePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Packaged acceptance uses only fixed, build-time scripts and native key events.
// The control file cannot provide routes, selectors, JavaScript, or workflow data.
const CREATE_IMAGES_ACCEPTANCE_COMPLETE_ONBOARDING_SCRIPT = `(() => {
  localStorage.setItem("${ONBOARDING_COMPLETE_STORAGE_KEY}", "true");
  localStorage.setItem("aiden-agent.sidebar-collapsed", "0");
  localStorage.setItem("aiden-agent.sidebar-width", "340");
  return true;
})()`;
const CREATE_IMAGES_ACCEPTANCE_READY_SCRIPT = `(() => {
  const workbench = document.querySelector(".create-images-workbench");
  return workbench instanceof HTMLElement && workbench.dataset.nodeCount === "100";
})()`;
const CREATE_IMAGES_ACCEPTANCE_INSTALL_ERROR_COUNTER_SCRIPT = `(() => {
  globalThis.__AIDEN_CREATE_IMAGES_ACCEPTANCE_ERRORS__ = 0;
  window.addEventListener("error", () => { globalThis.__AIDEN_CREATE_IMAGES_ACCEPTANCE_ERRORS__ += 1; });
  window.addEventListener("unhandledrejection", () => { globalThis.__AIDEN_CREATE_IMAGES_ACCEPTANCE_ERRORS__ += 1; });
  window.addEventListener("securitypolicyviolation", () => { globalThis.__AIDEN_CREATE_IMAGES_ACCEPTANCE_ERRORS__ += 1; });
  return true;
})()`;
const CREATE_IMAGES_ACCEPTANCE_NODE_COUNT_SCRIPT = `(() => {
  const value = document.querySelector(".create-images-workbench")?.getAttribute("data-node-count");
  return value && /^\\d+$/u.test(value) ? Number(value) : -1;
})()`;
const CREATE_IMAGES_PHASE_TWO_READY_SCRIPT = `(() => {
  const workbench = document.querySelector(".create-images-workbench");
  const preview = document.querySelector('.create-images-node img[src^="aiden-asset://asset/"]');
  const prompt = document.querySelector('textarea[aria-label^="Prompt text · "]');
  return {
    workbenchPresent: workbench instanceof HTMLElement,
    nodeCount: workbench instanceof HTMLElement ? workbench.dataset.nodeCount ?? null : null,
    previewPresent: preview instanceof HTMLImageElement,
    previewComplete: preview instanceof HTMLImageElement ? preview.complete : false,
    previewWidth: preview instanceof HTMLImageElement ? preview.naturalWidth : 0,
    promptPresent: prompt instanceof HTMLTextAreaElement,
  };
})()`;
const CREATE_IMAGES_PHASE_TWO_EDIT_SCRIPT = `(() => {
  const prompt = document.querySelector('textarea[aria-label^="Prompt text · "]');
  if (!(prompt instanceof HTMLTextAreaElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(prompt, "Packaged durable prompt edit");
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  prompt.focus();
  prompt.blur();
  return true;
})()`;
const CREATE_IMAGES_PHASE_TWO_REOPENED_SCRIPT = `(() => {
  const preview = document.querySelector('.create-images-node img[src^="aiden-asset://asset/"]');
  const prompt = document.querySelector('textarea[aria-label^="Prompt text · "]');
  return preview instanceof HTMLImageElement && preview.complete && preview.naturalWidth > 0 &&
    prompt instanceof HTMLTextAreaElement && prompt.value === "Packaged durable prompt edit";
})()`;
const CREATE_IMAGES_ACCEPTANCE_EDGE_COUNT_SCRIPT = `(() => {
  const value = document.querySelector(".create-images-workbench")?.getAttribute("data-edge-count");
  return value && /^\\d+$/u.test(value) ? Number(value) : -1;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_INSPECTOR_SCRIPT = `(() => {
  const button = document.querySelector('button[aria-label="Toggle node inspector"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_INSPECTOR_OPEN_SCRIPT =
  'document.querySelector(".create-images-inspector") instanceof HTMLElement';
const CREATE_IMAGES_ACCEPTANCE_FOCUS_ZOOM_IN_SCRIPT = `(() => {
  const button = document.querySelector('button[aria-label="Zoom In"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_FIT_WORKFLOW_SCRIPT = `(() => {
  const button = document.querySelector('button[aria-label="Fit workflow"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_NODE_LABELS_SCRIPT = `(() => {
  const buttons = Array.from(document.querySelectorAll('ul[aria-label="Workflow nodes"] button'));
  return buttons.map((button) => button.textContent?.replace(/\\s+/gu, " ").trim() ?? "");
})()`;
const CREATE_IMAGES_ACCEPTANCE_NO_REDUNDANT_NODE_SEMANTICS_SCRIPT = `(() => {
  const promptLabels = Array.from(
    document.querySelectorAll('textarea[aria-label^="Prompt text · "]'),
    (element) => element.getAttribute("aria-label") ?? "",
  );
  return document.querySelectorAll("article.create-images-node, .create-images-node[aria-label]").length === 0 &&
    promptLabels.length > 0 && new Set(promptLabels).size === promptLabels.length;
})()`;
const CREATE_IMAGES_ACCEPTANCE_PREPARE_SPATIAL_EDGE_SCRIPT = `(() => {
  const workbench = document.querySelector(".create-images-workbench");
  const inspector = document.querySelector(".create-images-inspector");
  if (!(workbench instanceof HTMLElement)) return false;
  const workbenchBounds = workbench.getBoundingClientRect();
  const inspectorBounds = inspector instanceof HTMLElement ? inspector.getBoundingClientRect() : null;
  const sources = Array.from(document.querySelectorAll('.react-flow__handle.source[data-handleid="text"]'));
  for (const source of sources) {
    if (!(source instanceof HTMLElement)) continue;
    const sourceNodeId = source.dataset.nodeid ?? "";
    const match = /^stress-prompt-(\\d+)$/u.exec(sourceNodeId);
    if (!match) continue;
    const targetNodeId = "stress-generate-" + match[1];
    const target = Array.from(document.querySelectorAll('.react-flow__handle.target[data-handleid="prompt"]')).find(
      (candidate) => candidate instanceof HTMLElement && candidate.dataset.nodeid === targetNodeId,
    );
    if (!(target instanceof HTMLElement)) continue;
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const inside = [sourceBounds, targetBounds].every((bounds) =>
      bounds.width > 0 && bounds.height > 0 && bounds.left >= workbenchBounds.left &&
      bounds.right <= workbenchBounds.right && bounds.top >= workbenchBounds.top &&
      bounds.bottom <= workbenchBounds.bottom && (!inspectorBounds || bounds.right < inspectorBounds.left)
    );
    if (!inside) continue;
    globalThis.__AIDEN_CREATE_IMAGES_SPATIAL_EDGE__ = {
      sourceNodeId,
      targetNodeId,
      edgeId: "stress-edge-prompt-" + match[1],
    };
    return true;
  }
  return false;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_MANAGE_CONNECTIONS_SCRIPT = `(() => {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes("Manage connections"),
  );
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_SPATIAL_DISCONNECT_SCRIPT = `(() => {
  const edge = globalThis.__AIDEN_CREATE_IMAGES_SPATIAL_EDGE__;
  if (!edge || typeof edge.edgeId !== "string") return false;
  const button = Array.from(document.querySelectorAll("button[data-disconnect-edge]")).find(
    (candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.disconnectEdge === edge.edgeId,
  );
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_KEYBOARD_DISCONNECT_SCRIPT = `(() => {
  const button = Array.from(document.querySelectorAll("button[data-disconnect-edge]")).find(
    (candidate) => {
      const text = candidate.closest("li")?.textContent ?? "";
      return text.includes("stress-prompt-0") && text.includes("stress-generate-0");
    },
  );
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_CONNECT_NODES_SCRIPT = `(() => {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Connect nodes",
  );
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_SPATIAL_POINTS_SCRIPT = `(() => {
  const edge = globalThis.__AIDEN_CREATE_IMAGES_SPATIAL_EDGE__;
  if (!edge) return null;
  const source = Array.from(document.querySelectorAll('.react-flow__handle.source[data-handleid="text"]')).find(
    (candidate) => candidate instanceof HTMLElement && candidate.dataset.nodeid === edge.sourceNodeId,
  );
  const target = Array.from(document.querySelectorAll('.react-flow__handle.target[data-handleid="prompt"]')).find(
    (candidate) => candidate instanceof HTMLElement && candidate.dataset.nodeid === edge.targetNodeId,
  );
  if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return null;
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  return {
    fromX: Math.round(from.left + from.width / 2),
    fromY: Math.round(from.top + from.height / 2),
    toX: Math.round(to.left + to.width / 2),
    toY: Math.round(to.top + to.height / 2),
  };
})()`;
const CREATE_IMAGES_ACCEPTANCE_INSTALL_LIVE_MUTATION_COUNTER_SCRIPT = `(() => {
  const liveRegion = document.querySelector("[data-create-images-action-status]");
  if (!(liveRegion instanceof HTMLElement)) return false;
  globalThis.__AIDEN_CREATE_IMAGES_LIVE_MUTATIONS__ = 0;
  const previous = globalThis.__AIDEN_CREATE_IMAGES_LIVE_OBSERVER__;
  if (previous instanceof MutationObserver) previous.disconnect();
  const observer = new MutationObserver((records) => {
    globalThis.__AIDEN_CREATE_IMAGES_LIVE_MUTATIONS__ += records.length;
  });
  observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });
  globalThis.__AIDEN_CREATE_IMAGES_LIVE_OBSERVER__ = observer;
  return true;
})()`;
const CREATE_IMAGES_ACCEPTANCE_LIVE_MUTATION_COUNT_SCRIPT =
  "Number(globalThis.__AIDEN_CREATE_IMAGES_LIVE_MUTATIONS__ ?? 0)";
const CREATE_IMAGES_ACCEPTANCE_FOCUS_ADD_SCRIPT = `(() => {
  const button = document.querySelector('button[aria-label="Add node"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_OUTPUT_GALLERY_SCRIPT = `(() => {
  const dialog = document.querySelector("[data-create-images-node-palette]");
  if (!(dialog instanceof HTMLElement)) return false;
  const button = Array.from(dialog.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Output Gallery")
  );
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_PALETTE_FOCUS_INSIDE_SCRIPT = `(() => {
  const dialog = document.querySelector("[data-create-images-node-palette]");
  const search = dialog?.querySelector("input");
  return dialog instanceof HTMLElement && dialog.contains(document.activeElement) && document.activeElement !== search;
})()`;
const CREATE_IMAGES_ACCEPTANCE_PALETTE_FOCUS_SEARCH_SCRIPT = `(() => {
  const dialog = document.querySelector("[data-create-images-node-palette]");
  const search = dialog?.querySelector("input");
  return search instanceof HTMLInputElement && document.activeElement === search;
})()`;
const CREATE_IMAGES_ACCEPTANCE_PALETTE_CLOSED_SCRIPT = `(() => {
  const add = document.querySelector('button[aria-label="Add node"]');
  return !document.querySelector("[data-create-images-node-palette]") && document.activeElement === add;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_CONNECTED_CANVAS_NODE_SCRIPT = `(() => {
  const edge = globalThis.__AIDEN_CREATE_IMAGES_SPATIAL_EDGE__;
  if (!edge || typeof edge.sourceNodeId !== "string") return false;
  const node = Array.from(document.querySelectorAll(".react-flow__node[data-id]")).find(
    (candidate) => candidate instanceof HTMLElement && candidate.dataset.id === edge.sourceNodeId,
  );
  if (!(node instanceof HTMLElement)) return false;
  node.focus();
  return document.activeElement === node;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_CONNECTED_INSPECTOR_NODE_SCRIPT = `(() => {
  const edge = globalThis.__AIDEN_CREATE_IMAGES_SPATIAL_EDGE__;
  if (!edge || typeof edge.sourceNodeId !== "string") return false;
  const button = Array.from(document.querySelectorAll("button[data-workflow-node-id]")).find(
    (candidate) => candidate instanceof HTMLButtonElement &&
      candidate.dataset.workflowNodeId === edge.sourceNodeId,
  );
  if (!(button instanceof HTMLButtonElement)) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_BACK_TO_NODES_SCRIPT = `(() => {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Back to nodes",
  );
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_CONNECTION_TOOLS_OPEN_SCRIPT = `(() =>
  Array.from(document.querySelectorAll("button")).some(
    (candidate) => candidate.textContent?.trim() === "Back to nodes",
  )
)()`;
const CREATE_IMAGES_ACCEPTANCE_CONNECTED_CANVAS_NODE_SELECTED_SCRIPT = `(() => {
  const edge = globalThis.__AIDEN_CREATE_IMAGES_SPATIAL_EDGE__;
  const node = document.querySelector(".react-flow__node.selected");
  return node instanceof HTMLElement && node.dataset.id === edge?.sourceNodeId;
})()`;
const CREATE_IMAGES_ACCEPTANCE_SELECTED_CANVAS_NODE_FOCUSED_SCRIPT = `(() => {
  const node = document.querySelector(".react-flow__node.selected");
  return node instanceof HTMLElement && document.activeElement === node;
})()`;
const CREATE_IMAGES_ACCEPTANCE_CAPTURE_SELECTED_NODE_X_SCRIPT = `(() => {
  const node = document.querySelector(".react-flow__node.selected");
  if (!(node instanceof HTMLElement) || document.activeElement !== node) return null;
  const transform = node.style.transform;
  globalThis.__AIDEN_CREATE_IMAGES_SELECTED_NODE_TRANSFORM__ = transform;
  return transform;
})()`;
const CREATE_IMAGES_ACCEPTANCE_SELECTED_NODE_MOVED_SCRIPT = `(() => {
  const node = document.querySelector(".react-flow__node.selected");
  const before = globalThis.__AIDEN_CREATE_IMAGES_SELECTED_NODE_TRANSFORM__;
  return node instanceof HTMLElement && typeof before === "string" &&
    node.style.transform !== before;
})()`;
const CREATE_IMAGES_ACCEPTANCE_SELECTED_NODE_POSITION_RESTORED_SCRIPT = `(() => {
  const node = document.querySelector(".react-flow__node.selected");
  const before = globalThis.__AIDEN_CREATE_IMAGES_SELECTED_NODE_TRANSFORM__;
  return node instanceof HTMLElement && typeof before === "string" &&
    node.style.transform === before;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_EDGE_SCRIPT = `(() => {
  const edge = Array.from(document.querySelectorAll(".react-flow__edge")).find(
    (candidate) => candidate instanceof SVGElement && candidate.getAttribute("tabindex") === "0",
  );
  if (!(edge instanceof SVGElement)) return false;
  edge.focus();
  return document.activeElement === edge;
})()`;
const CREATE_IMAGES_ACCEPTANCE_EDGE_SELECTED_SCRIPT =
  "Boolean(document.querySelector('.react-flow__edge.selected'))";
const CREATE_IMAGES_ACCEPTANCE_INSPECTOR_FOCUSED_SCRIPT = `(() => {
  const button = document.querySelector('button[aria-label="Toggle node inspector"]');
  return button instanceof HTMLButtonElement && document.activeElement === button;
})()`;
const createImagesAcceptanceFocusButtonScript = (
  label: "Undo" | "Redo" | "Delete selected nodes",
) => `(() => {
  const button = document.querySelector('button[aria-label="${label}"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_ANNOUNCEMENT_SCRIPT = `(() =>
  document.querySelector("[data-create-images-action-status]")?.textContent?.trim() ?? ""
)()`;
const CREATE_IMAGES_ACCEPTANCE_RENDERER_ERRORS_SCRIPT =
  "Number(globalThis.__AIDEN_CREATE_IMAGES_ACCEPTANCE_ERRORS__ ?? 0)";
const CREATE_IMAGES_ACCEPTANCE_ASSISTANT_HIDDEN_SCRIPT = `(() => {
  const dock = document.querySelector('[data-environment-modal-background="assistant"]');
  return dock instanceof HTMLElement && dock.inert && dock.getAttribute("aria-hidden") === "true" && getComputedStyle(dock).visibility === "hidden";
})()`;
const CREATE_IMAGES_ACCEPTANCE_ENABLE_REDUCED_MOTION_SCRIPT = `(() => {
  document.documentElement.dataset.reduceMotion = "true";
  const button = document.querySelector('button[aria-label="Fit workflow"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_REDUCED_MOTION_SCRIPT = `(() => {
  const node = document.querySelector(".create-images-node");
  const handle = document.querySelector(".create-images-handle");
  if (!(node instanceof HTMLElement) || !(handle instanceof HTMLElement)) return false;
  const nodeStyle = getComputedStyle(node);
  const handleStyle = getComputedStyle(handle);
  const durations = [
    nodeStyle.animationDuration,
    nodeStyle.transitionDuration,
    handleStyle.animationDuration,
    handleStyle.transitionDuration,
  ].flatMap((value) => value.split(",")).map((value) => Number.parseFloat(value));
  return document.documentElement.dataset.reduceMotion === "true" &&
    durations.length > 0 && durations.every((value) => Number.isFinite(value) && value <= 0.001);
})()`;
const CREATE_IMAGES_ACCEPTANCE_RESPONSIVE_SCRIPT = `(() => ({
  width: window.innerWidth,
  workbenchWidth: document.querySelector(".create-images-workbench")?.getBoundingClientRect().width ?? -1,
  sidebarWidth: Number(document.querySelector('[role="separator"][aria-label="Resize sidebar"]')?.getAttribute("aria-valuenow") ?? -1),
  overflowFree: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1,
  minimapVisible: Boolean(document.querySelector(".react-flow__minimap")),
  minimapToggleVisible: Boolean(document.querySelector('button[aria-label="Toggle minimap"]')),
  validationIssueTriggerVisible: (() => {
    const trigger = document.querySelector('button[aria-controls="create-images-validation-issues"]');
    return trigger instanceof HTMLButtonElement && getComputedStyle(trigger).display !== "none";
  })(),
}))()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_VALIDATION_TRIGGER_SCRIPT = `(() => {
  const trigger = document.querySelector('button[aria-controls="create-images-validation-issues"]');
  if (!(trigger instanceof HTMLButtonElement) || getComputedStyle(trigger).display === "none") return false;
  trigger.focus();
  return document.activeElement === trigger;
})()`;
const CREATE_IMAGES_ACCEPTANCE_FOCUS_FIRST_VALIDATION_ISSUE_SCRIPT = `(() => {
  const button = document.querySelector('#create-images-validation-issues li button:not(:disabled)');
  if (!(button instanceof HTMLButtonElement)) return false;
  button.focus();
  return document.activeElement === button;
})()`;
const CREATE_IMAGES_ACCEPTANCE_VALIDATION_ISSUE_FOCUSED_SCRIPT = `(() => {
  const panel = document.querySelector("#create-images-validation-issues");
  return panel instanceof HTMLElement && panel.contains(document.activeElement) &&
    document.activeElement?.matches("li button:not(:disabled)") === true;
})()`;
const CREATE_IMAGES_ACCEPTANCE_VALIDATION_TARGET_FOCUSED_SCRIPT = `(() => {
  const active = document.activeElement;
  return active instanceof Element && (
    active.matches(".react-flow__node, .react-flow__edge, button[data-workflow-node-id]") ||
    active.matches('.create-images-inspector[aria-label="Workflow node inspector"]')
  );
})()`;
const CREATE_IMAGES_ACCEPTANCE_SELECTED_NODE_VISIBLE_SCRIPT = `(() => {
  const workbench = document.querySelector(".create-images-workbench");
  const node = document.querySelector(".react-flow__node.selected");
  if (!(workbench instanceof HTMLElement) || !(node instanceof HTMLElement)) return false;
  const outer = workbench.getBoundingClientRect();
  const inner = node.getBoundingClientRect();
  return inner.width > 0 && inner.height > 0 &&
    inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
    inner.top >= outer.top + 51 && inner.bottom <= outer.bottom + 1 &&
    !document.querySelector(".create-images-inspector");
})()`;

export interface RunPackagedCreateImagesAcceptanceOptions {
  window: BrowserWindow;
  reloadRenderer(): Promise<void>;
  navigate(path: string): Promise<void>;
  runtimeProfile: { configDir: string; userDataPath: string };
}

interface PhaseTwoReadyObservation {
  workbenchPresent: boolean;
  nodeCount: string | null;
  previewPresent: boolean;
  previewComplete: boolean;
  previewWidth: number;
  promptPresent: boolean;
  grantCount: number;
  assetProtocolRequests: number;
  assetProtocolAuthorizations: number;
  lastAssetRequest: {
    method: string;
    resourceType: string;
    webContentsIdPresent: boolean;
    framePresent: boolean;
    frameIsMain: boolean;
    frameDetached: boolean;
  } | null;
}

function isAcceptedAssetRequestEvidence(
  value: PhaseTwoReadyObservation["lastAssetRequest"],
): value is CreateImagesPackagedAssetRequestEvidence {
  return (
    value?.method === "GET" &&
    value.resourceType === "image" &&
    value.webContentsIdPresent &&
    value.framePresent &&
    value.frameIsMain &&
    !value.frameDetached
  );
}

let mainWindow: BrowserWindow | null = null;
let createImagesAcceptanceKeyboardActions = 0;

function pauseForCreateImagesPackagedAcceptance(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CREATE_IMAGES_PACKAGED_ACCEPTANCE_POLL_MS));
}

async function waitForCreateImagesPackagedAcceptance<T>(
  step: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + CREATE_IMAGES_PACKAGED_ACCEPTANCE_WAIT_MS;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    const value = await read();
    lastValue = value;
    if (accept(value)) return value;
    await pauseForCreateImagesPackagedAcceptance();
  }
  let observation = "unavailable";
  try {
    observation = JSON.stringify(lastValue);
  } catch {
    observation = "unserializable";
  }
  throw new Error(
    `Packaged Create Images acceptance did not reach ${step}. Last observation: ${observation}.`,
  );
}

async function readCreateImagesAcceptanceScript<T>(script: string): Promise<T> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged Create Images acceptance lost its main window.");
  }
  return (await window.webContents.executeJavaScript(script, true)) as T;
}

async function focusCreateImagesAcceptanceWindow(window: BrowserWindow): Promise<void> {
  app.focus({ steal: true });
  window.show();
  window.focus();
  window.webContents.focus();
  await pauseForCreateImagesPackagedAcceptance();
}

async function activateCreateImagesAcceptanceControl(focusScript: string): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged Create Images acceptance lost its main window.");
  }
  await focusCreateImagesAcceptanceWindow(window);
  const focused = await readCreateImagesAcceptanceScript<boolean>(focusScript);
  if (!focused) throw new Error("Packaged Create Images acceptance could not focus a control.");
  createImagesAcceptanceKeyboardActions += 1;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  await pauseForCreateImagesPackagedAcceptance();
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await pauseForCreateImagesPackagedAcceptance();
}

async function sendCreateImagesAcceptanceDuplicateShortcut(): Promise<void> {
  await sendCreateImagesAcceptanceKey("D", ["meta"]);
}

async function sendCreateImagesAcceptanceKey(
  keyCode: string,
  modifiers: Electron.KeyboardInputEvent["modifiers"] = [],
): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged Create Images acceptance lost its main window.");
  }
  await focusCreateImagesAcceptanceWindow(window);
  createImagesAcceptanceKeyboardActions += 1;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  await pauseForCreateImagesPackagedAcceptance();
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await pauseForCreateImagesPackagedAcceptance();
}

async function sendCreateImagesAcceptanceTab(shift = false): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged Create Images acceptance lost its main window.");
  }
  await focusCreateImagesAcceptanceWindow(window);
  createImagesAcceptanceKeyboardActions += 1;
  const modifiers: Electron.KeyboardInputEvent["modifiers"] = shift ? ["shift"] : [];
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers });
  await pauseForCreateImagesPackagedAcceptance();
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers });
  await pauseForCreateImagesPackagedAcceptance();
}

async function waitForCreateImagesNodeCount(expected: number): Promise<number> {
  return waitForCreateImagesPackagedAcceptance(
    `${expected} nodes`,
    () => readCreateImagesAcceptanceScript<number>(CREATE_IMAGES_ACCEPTANCE_NODE_COUNT_SCRIPT),
    (count) => count === expected,
  );
}

async function waitForCreateImagesEdgeCount(expected: number): Promise<number> {
  return waitForCreateImagesPackagedAcceptance(
    `${expected} edges`,
    () => readCreateImagesAcceptanceScript<number>(CREATE_IMAGES_ACCEPTANCE_EDGE_COUNT_SCRIPT),
    (count) => count === expected,
  );
}

async function waitForCreateImagesProductFilesToSettle(input: {
  configDir: string;
  userDataDir: string;
}): Promise<Awaited<ReturnType<typeof snapshotCreateImagesProductFiles>>> {
  const deadline = Date.now() + CREATE_IMAGES_PACKAGED_ACCEPTANCE_WAIT_MS;
  let previous = await snapshotCreateImagesProductFiles(input);
  let stableSamples = 0;
  while (Date.now() < deadline) {
    await pauseForCreateImagesPackagedAcceptance();
    const current = await snapshotCreateImagesProductFiles(input);
    if (countCreateImagesProductFileMutations(previous, current) === 0) {
      stableSamples += 1;
      if (stableSamples >= CREATE_IMAGES_PACKAGED_ACCEPTANCE_BASELINE_STABLE_SAMPLES)
        return current;
    } else {
      stableSamples = 0;
    }
    previous = current;
  }
  throw new Error("Packaged Create Images product files did not reach a stable baseline.");
}

async function dragCreateImagesAcceptanceConnection(): Promise<void> {
  const points = await readCreateImagesAcceptanceScript<{
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null>(CREATE_IMAGES_ACCEPTANCE_SPATIAL_POINTS_SCRIPT);
  const window = mainWindow;
  if (!points || !window || window.isDestroyed()) {
    throw new Error("Packaged Create Images acceptance lost its spatial connection handles.");
  }
  await focusCreateImagesAcceptanceWindow(window);
  window.webContents.sendInputEvent({
    type: "mouseMove",
    x: points.fromX,
    y: points.fromY,
  });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: points.fromX,
    y: points.fromY,
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 6; step += 1) {
    const progress = step / 6;
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(points.fromX + (points.toX - points.fromX) * progress),
      y: Math.round(points.fromY + (points.toY - points.fromY) * progress),
      button: "left",
    });
    await pauseForCreateImagesPackagedAcceptance();
  }
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: points.toX,
    y: points.toY,
    button: "left",
    clickCount: 1,
  });
}

async function observeCreateImagesAnnouncement(expected: RegExp): Promise<void> {
  await waitForCreateImagesPackagedAcceptance(
    `announcement ${expected.source}`,
    () => readCreateImagesAcceptanceScript<string>(CREATE_IMAGES_ACCEPTANCE_ANNOUNCEMENT_SCRIPT),
    (announcement) => expected.test(announcement),
  );
}

export async function runPackagedCreateImagesAcceptance(
  acceptance: CreateImagesPackagedAcceptanceSession,
  options: RunPackagedCreateImagesAcceptanceOptions,
): Promise<void> {
  mainWindow = options.window;
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged Create Images acceptance requires a live main window.");
  }
  const startedAt = performance.now();
  createImagesAcceptanceKeyboardActions = 0;
  await readCreateImagesAcceptanceScript<boolean>(
    CREATE_IMAGES_ACCEPTANCE_COMPLETE_ONBOARDING_SCRIPT,
  );
  await options.reloadRenderer();

  const runtimeProfile = options.runtimeProfile;
  const persistenceInput = {
    configDir: runtimeProfile.configDir,
    userDataDir: runtimeProfile.userDataPath,
  };
  // A fresh acceptance profile creates ordinary app bootstrap records asynchronously. Establish
  // the baseline only after those writes settle, before navigating to the side-effect-free canvas.
  const filesBefore = await waitForCreateImagesProductFilesToSettle(persistenceInput);
  let networkRequests = 0;
  let rendererEgressProbeRequests = 0;
  let rendererEgressProbeBlocked = 0;
  let rendererEgressProbeWebContentsPresent = false;
  let assetProtocolRequests = 0;
  let assetProtocolAuthorizations = 0;
  let lastAssetRequest: PhaseTwoReadyObservation["lastAssetRequest"] = null;
  let mainObservedRendererErrors = 0;
  const onConsoleMessage = (
    event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    legacyLevel: number,
    legacyMessage: string,
  ) => {
    const level = event.level ?? legacyLevel;
    const message = event.message ?? legacyMessage ?? "";
    if (
      level === "error" ||
      (typeof level === "number" && level >= 3) ||
      /content security policy|securitypolicyviolation/iu.test(message)
    ) {
      mainObservedRendererErrors += 1;
    }
  };
  const onRenderProcessGone = () => {
    mainObservedRendererErrors += 1;
  };
  const onDidFailLoad = (
    _event: Electron.Event,
    _errorCode: number,
    _errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) mainObservedRendererErrors += 1;
  };
  window.webContents.on("console-message", onConsoleMessage);
  window.webContents.on("render-process-gone", onRenderProcessGone);
  window.webContents.on("did-fail-load", onDidFailLoad);
  const stopRequestPolicyObservation = observeCreateImagesRequestPolicy((observation) => {
    if (observation.kind === "renderer-egress") {
      if (observation.url === CREATE_IMAGES_PACKAGED_ACCEPTANCE_EGRESS_PROBE) {
        rendererEgressProbeRequests += 1;
        if (!observation.allowed) rendererEgressProbeBlocked += 1;
        rendererEgressProbeWebContentsPresent ||= observation.webContentsIdPresent;
        return;
      }
      networkRequests += 1;
      return;
    }
    assetProtocolRequests += 1;
    if (observation.allowed) assetProtocolAuthorizations += 1;
    lastAssetRequest = {
      method: observation.method,
      resourceType: observation.resourceType,
      webContentsIdPresent: observation.webContentsIdPresent,
      framePresent: observation.framePresent,
      frameIsMain: observation.frameIsMain,
      frameDetached: observation.frameDetached,
    };
  });
  try {
    // Use Electron's download entry point so the production webRequest policy
    // sees a request owned by the real main WebContents. A renderer fetch/image
    // is correctly stopped by CSP before webRequest and cannot prove this layer.
    window.webContents.downloadURL(CREATE_IMAGES_PACKAGED_ACCEPTANCE_EGRESS_PROBE);
    const rendererEgressProbePassed = await waitForCreateImagesPackagedAcceptance(
      "the production renderer-egress denial",
      async () => ({
        requests: rendererEgressProbeRequests,
        blocked: rendererEgressProbeBlocked,
        webContentsPresent: rendererEgressProbeWebContentsPresent,
      }),
      (value) =>
        value.requests >= 1 && value.blocked === value.requests && value.webContentsPresent,
    ).then(() => true);
    await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_INSTALL_ERROR_COUNTER_SCRIPT,
    );
    await options.navigate(CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROUTE);
    await waitForCreateImagesPackagedAcceptance(
      "the production canvas route",
      () => readCreateImagesAcceptanceScript<boolean>(CREATE_IMAGES_ACCEPTANCE_READY_SCRIPT),
      Boolean,
    );
    const initialNodeCount = await waitForCreateImagesNodeCount(100);
    const assistantHidden = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_ASSISTANT_HIDDEN_SCRIPT,
    );
    if (!assistantHidden) {
      throw new Error("Packaged Create Images acceptance found the assistant dock interactive.");
    }

    await activateCreateImagesAcceptanceControl(CREATE_IMAGES_ACCEPTANCE_FOCUS_INSPECTOR_SCRIPT);
    const labels = await waitForCreateImagesPackagedAcceptance(
      "the non-spatial node list",
      () => readCreateImagesAcceptanceScript<string[]>(CREATE_IMAGES_ACCEPTANCE_NODE_LABELS_SCRIPT),
      (value) => value.length === 100,
    );
    const uniqueAccessibleNodeLabels = new Set(labels).size === labels.length;
    const noRedundantNodeSemantics = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_NO_REDUNDANT_NODE_SEMANTICS_SCRIPT,
    );
    if (!uniqueAccessibleNodeLabels || !noRedundantNodeSemantics) {
      throw new Error("Packaged Create Images acceptance found duplicate accessible node labels.");
    }

    await activateCreateImagesAcceptanceControl(CREATE_IMAGES_ACCEPTANCE_FOCUS_FIT_WORKFLOW_SCRIPT);
    for (let index = 0; index < 16; index += 1) {
      await pauseForCreateImagesPackagedAcceptance();
    }
    for (let index = 0; index < 6; index += 1) {
      await activateCreateImagesAcceptanceControl(CREATE_IMAGES_ACCEPTANCE_FOCUS_ZOOM_IN_SCRIPT);
    }
    const spatialEdgePrepared = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_PREPARE_SPATIAL_EDGE_SCRIPT,
    );
    if (!spatialEdgePrepared) {
      throw new Error("Packaged Create Images acceptance found no visible spatial edge pair.");
    }
    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_MANAGE_CONNECTIONS_SCRIPT,
    );
    await waitForCreateImagesPackagedAcceptance(
      "the spatial edge disconnect control",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_FOCUS_SPATIAL_DISCONNECT_SCRIPT,
        ),
      Boolean,
    );
    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_SPATIAL_DISCONNECT_SCRIPT,
    );
    await waitForCreateImagesEdgeCount(74);
    await observeCreateImagesAnnouncement(/Nodes disconnected\./u);
    await dragCreateImagesAcceptanceConnection();
    await waitForCreateImagesEdgeCount(75);
    await observeCreateImagesAnnouncement(/Nodes connected\./u);
    const spatialConnectionPassed = true;
    const liveMutationCounterInstalled = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_INSTALL_LIVE_MUTATION_COUNTER_SCRIPT,
    );
    if (!liveMutationCounterInstalled) {
      throw new Error("Packaged Create Images acceptance could not observe its live region.");
    }
    await dragCreateImagesAcceptanceConnection();
    const firstInvalidMutationCount = await waitForCreateImagesPackagedAcceptance(
      "the first invalid spatial-drop announcement",
      () =>
        readCreateImagesAcceptanceScript<number>(
          CREATE_IMAGES_ACCEPTANCE_LIVE_MUTATION_COUNT_SCRIPT,
        ),
      (count) => count > 0,
    );
    await observeCreateImagesAnnouncement(/This connection already exists\./u);
    await dragCreateImagesAcceptanceConnection();
    await waitForCreateImagesPackagedAcceptance(
      "the repeated invalid spatial-drop announcement",
      () =>
        readCreateImagesAcceptanceScript<number>(
          CREATE_IMAGES_ACCEPTANCE_LIVE_MUTATION_COUNT_SCRIPT,
        ),
      (count) => count > firstInvalidMutationCount,
    );
    const repeatedAnnouncementPassed = true;
    const spatialInvalidDropPassed = (await waitForCreateImagesEdgeCount(75)) === 75;

    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_KEYBOARD_DISCONNECT_SCRIPT,
    );
    await waitForCreateImagesEdgeCount(74);
    await observeCreateImagesAnnouncement(/Nodes disconnected\./u);
    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_CONNECT_NODES_SCRIPT,
    );
    await waitForCreateImagesEdgeCount(75);
    await observeCreateImagesAnnouncement(/Nodes connected\./u);
    const keyboardConnectionPassed = true;

    const focusedEdge = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_EDGE_SCRIPT,
    );
    if (!focusedEdge) {
      throw new Error("Packaged Create Images acceptance could not focus a spatial edge.");
    }
    await sendCreateImagesAcceptanceKey("Enter");
    await waitForCreateImagesPackagedAcceptance(
      "keyboard selection of the spatial edge",
      () =>
        readCreateImagesAcceptanceScript<boolean>(CREATE_IMAGES_ACCEPTANCE_EDGE_SELECTED_SCRIPT),
      Boolean,
    );
    await sendCreateImagesAcceptanceKey("Delete");
    await waitForCreateImagesEdgeCount(74);
    await observeCreateImagesAnnouncement(/1 connection deleted\./u);
    await waitForCreateImagesPackagedAcceptance(
      "focus restoration after native edge deletion",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_INSPECTOR_FOCUSED_SCRIPT,
        ),
      Boolean,
    );
    await sendCreateImagesAcceptanceKey("Z", ["meta"]);
    await waitForCreateImagesEdgeCount(75);
    await observeCreateImagesAnnouncement(/Undid the last graph edit\./u);
    await sendCreateImagesAcceptanceKey("Z", ["meta", "shift"]);
    await waitForCreateImagesEdgeCount(74);
    await observeCreateImagesAnnouncement(/Redid the graph edit\./u);
    await sendCreateImagesAcceptanceKey("Z", ["meta"]);
    await waitForCreateImagesEdgeCount(75);
    await observeCreateImagesAnnouncement(/Undid the last graph edit\./u);
    const nativeEdgeDeletePassed = true;

    await activateCreateImagesAcceptanceControl(CREATE_IMAGES_ACCEPTANCE_FOCUS_ADD_SCRIPT);
    await waitForCreateImagesPackagedAcceptance(
      "the node palette",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_PALETTE_FOCUS_SEARCH_SCRIPT,
        ),
      Boolean,
    );
    await sendCreateImagesAcceptanceTab(true);
    await waitForCreateImagesPackagedAcceptance(
      "focus to remain trapped in the node palette",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_PALETTE_FOCUS_INSIDE_SCRIPT,
        ),
      Boolean,
    );
    await sendCreateImagesAcceptanceTab();
    await waitForCreateImagesPackagedAcceptance(
      "focus to wrap to the node search",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_PALETTE_FOCUS_SEARCH_SCRIPT,
        ),
      Boolean,
    );
    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_OUTPUT_GALLERY_SCRIPT,
    );
    const addedNodeCount = await waitForCreateImagesNodeCount(101);
    await observeCreateImagesAnnouncement(/Output Gallery added\./u);
    const focusRestoredAfterPalette = await waitForCreateImagesPackagedAcceptance(
      "palette focus restoration",
      () =>
        readCreateImagesAcceptanceScript<boolean>(CREATE_IMAGES_ACCEPTANCE_PALETTE_CLOSED_SCRIPT),
      Boolean,
    );

    await sendCreateImagesAcceptanceDuplicateShortcut();
    const duplicatedNodeCount = await waitForCreateImagesNodeCount(102);
    await observeCreateImagesAnnouncement(/duplicated\./u);
    await waitForCreateImagesPackagedAcceptance(
      "focus on the duplicated canvas node",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_SELECTED_CANVAS_NODE_FOCUSED_SCRIPT,
        ),
      Boolean,
    );
    const selectedNodeX = await readCreateImagesAcceptanceScript<string | null>(
      CREATE_IMAGES_ACCEPTANCE_CAPTURE_SELECTED_NODE_X_SCRIPT,
    );
    if (selectedNodeX === null) {
      throw new Error("Packaged Create Images acceptance could not capture duplicate position.");
    }
    await sendCreateImagesAcceptanceKey("Right");
    await waitForCreateImagesPackagedAcceptance(
      "the duplicated node keyboard move",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_SELECTED_NODE_MOVED_SCRIPT,
        ),
      Boolean,
    );
    await observeCreateImagesAnnouncement(/Node moved\./u);
    await sendCreateImagesAcceptanceKey("Z", ["meta"]);
    await waitForCreateImagesPackagedAcceptance(
      "the keyboard-move undo",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_SELECTED_NODE_POSITION_RESTORED_SCRIPT,
        ),
      Boolean,
    );
    await observeCreateImagesAnnouncement(/Undid the last graph edit\./u);
    const keyboardMoveUndoPassed = true;
    await activateCreateImagesAcceptanceControl(createImagesAcceptanceFocusButtonScript("Undo"));
    const undoNodeCount = await waitForCreateImagesNodeCount(101);
    await observeCreateImagesAnnouncement(/Undid the last graph edit\./u);
    await activateCreateImagesAcceptanceControl(createImagesAcceptanceFocusButtonScript("Redo"));
    const redoNodeCount = await waitForCreateImagesNodeCount(102);
    await observeCreateImagesAnnouncement(/Redid the graph edit\./u);
    const inspectorOpen = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_INSPECTOR_OPEN_SCRIPT,
    );
    if (!inspectorOpen) {
      await activateCreateImagesAcceptanceControl(CREATE_IMAGES_ACCEPTANCE_FOCUS_INSPECTOR_SCRIPT);
    }
    const connectionToolsOpen = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_CONNECTION_TOOLS_OPEN_SCRIPT,
    );
    if (connectionToolsOpen) {
      await activateCreateImagesAcceptanceControl(
        CREATE_IMAGES_ACCEPTANCE_FOCUS_BACK_TO_NODES_SCRIPT,
      );
    }
    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_FOCUS_CONNECTED_INSPECTOR_NODE_SCRIPT,
    );
    await waitForCreateImagesPackagedAcceptance(
      "the selected connected canvas node",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_FOCUS_CONNECTED_CANVAS_NODE_SCRIPT,
        ),
      Boolean,
    );
    await sendCreateImagesAcceptanceKey("Enter");
    await waitForCreateImagesPackagedAcceptance(
      "keyboard selection of a connected canvas node",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_CONNECTED_CANVAS_NODE_SELECTED_SCRIPT,
        ),
      Boolean,
    );
    await waitForCreateImagesEdgeCount(75);
    await sendCreateImagesAcceptanceKey("Delete");
    const deletedNodeCount = await waitForCreateImagesNodeCount(101);
    await waitForCreateImagesEdgeCount(74);
    await observeCreateImagesAnnouncement(/deleted\./u);
    const focusRestoredAfterNativeDelete = await waitForCreateImagesPackagedAcceptance(
      "focus restoration after native node deletion",
      () =>
        readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_INSPECTOR_FOCUSED_SCRIPT,
        ),
      Boolean,
    );
    await sendCreateImagesAcceptanceKey("Z", ["meta"]);
    const nativeDeleteUndoNodeCount = await waitForCreateImagesNodeCount(102);
    await waitForCreateImagesEdgeCount(75);
    await observeCreateImagesAnnouncement(/Undid the last graph edit\./u);
    await sendCreateImagesAcceptanceKey("Z", ["meta", "shift"]);
    const nativeDeleteRedoNodeCount = await waitForCreateImagesNodeCount(101);
    await waitForCreateImagesEdgeCount(74);
    await observeCreateImagesAnnouncement(/Redid the graph edit\./u);
    const nativeNodeDeleteGraphPassed = true;

    await activateCreateImagesAcceptanceControl(
      CREATE_IMAGES_ACCEPTANCE_ENABLE_REDUCED_MOTION_SCRIPT,
    );
    const reducedMotionPassed = await waitForCreateImagesPackagedAcceptance(
      "the reduced-motion canvas state",
      () =>
        readCreateImagesAcceptanceScript<boolean>(CREATE_IMAGES_ACCEPTANCE_REDUCED_MOTION_SCRIPT),
      Boolean,
    );

    let responsiveWidthsPassed = true;
    let narrowValidationPassed = false;
    let narrowAddPlacementPassed = false;
    for (const width of [1280, 1000, 700, 390]) {
      window.setContentSize(width, 650, false);
      const narrowExpected = width !== 1280;
      const responsive = await waitForCreateImagesPackagedAcceptance(
        `the ${width}px canvas layout`,
        () =>
          readCreateImagesAcceptanceScript<{
            width: number;
            workbenchWidth: number;
            sidebarWidth: number;
            overflowFree: boolean;
            minimapVisible: boolean;
            minimapToggleVisible: boolean;
            validationIssueTriggerVisible: boolean;
          }>(CREATE_IMAGES_ACCEPTANCE_RESPONSIVE_SCRIPT),
        (value) =>
          Math.abs(value.width - width) <= 1 &&
          value.workbenchWidth > 0 &&
          (narrowExpected ? value.workbenchWidth <= 760 : value.workbenchWidth > 760) &&
          value.sidebarWidth === 340 &&
          value.overflowFree &&
          value.minimapVisible === !narrowExpected &&
          value.minimapToggleVisible === !narrowExpected &&
          value.validationIssueTriggerVisible,
      );
      responsiveWidthsPassed &&=
        responsive.overflowFree &&
        responsive.minimapVisible === !narrowExpected &&
        responsive.minimapToggleVisible === !narrowExpected &&
        responsive.validationIssueTriggerVisible;

      if (width === 390) {
        await activateCreateImagesAcceptanceControl(
          CREATE_IMAGES_ACCEPTANCE_FOCUS_VALIDATION_TRIGGER_SCRIPT,
        );
        const validationIssueFocused = await readCreateImagesAcceptanceScript<boolean>(
          CREATE_IMAGES_ACCEPTANCE_FOCUS_FIRST_VALIDATION_ISSUE_SCRIPT,
        );
        if (!validationIssueFocused) {
          throw new Error("Packaged Create Images could not focus a narrow validation issue.");
        }
        await sendCreateImagesAcceptanceKey("Z", ["meta"]);
        await waitForCreateImagesNodeCount(101);
        await waitForCreateImagesPackagedAcceptance(
          "validation-panel shortcut isolation",
          () =>
            readCreateImagesAcceptanceScript<boolean>(
              CREATE_IMAGES_ACCEPTANCE_VALIDATION_ISSUE_FOCUSED_SCRIPT,
            ),
          Boolean,
        );
        await activateCreateImagesAcceptanceControl(
          CREATE_IMAGES_ACCEPTANCE_FOCUS_FIRST_VALIDATION_ISSUE_SCRIPT,
        );
        narrowValidationPassed = await waitForCreateImagesPackagedAcceptance(
          "validation issue focus at 390px",
          () =>
            readCreateImagesAcceptanceScript<boolean>(
              CREATE_IMAGES_ACCEPTANCE_VALIDATION_TARGET_FOCUSED_SCRIPT,
            ),
          Boolean,
        );

        await activateCreateImagesAcceptanceControl(CREATE_IMAGES_ACCEPTANCE_FOCUS_ADD_SCRIPT);
        await activateCreateImagesAcceptanceControl(
          CREATE_IMAGES_ACCEPTANCE_FOCUS_OUTPUT_GALLERY_SCRIPT,
        );
        await waitForCreateImagesNodeCount(102);
        narrowAddPlacementPassed = await waitForCreateImagesPackagedAcceptance(
          "a fully visible newly added node at 390px",
          () =>
            readCreateImagesAcceptanceScript<boolean>(
              CREATE_IMAGES_ACCEPTANCE_SELECTED_NODE_VISIBLE_SCRIPT,
            ),
          Boolean,
        );
        await sendCreateImagesAcceptanceKey("Z", ["meta"]);
        await waitForCreateImagesNodeCount(101);
      }
    }
    window.setContentSize(1000, 700, false);

    const [rendererEventErrors, liveRegionMutations, filesAfter] = await Promise.all([
      readCreateImagesAcceptanceScript<number>(CREATE_IMAGES_ACCEPTANCE_RENDERER_ERRORS_SCRIPT),
      readCreateImagesAcceptanceScript<number>(CREATE_IMAGES_ACCEPTANCE_LIVE_MUTATION_COUNT_SCRIPT),
      snapshotCreateImagesProductFiles(persistenceInput),
    ]);
    const runtimePreferences = (
      window.webContents as unknown as {
        getLastWebPreferences(): {
          sandbox?: boolean;
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
        };
      }
    ).getLastWebPreferences();
    const productFileMutations = countCreateImagesProductFileMutations(filesBefore, filesAfter);

    const service = createImagesService();
    const sourceBytes = createImagesAcceptanceLargePng();
    async function* sourceChunks(): AsyncGenerator<Uint8Array> {
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < sourceBytes.byteLength; offset += chunkSize) {
        yield sourceBytes.subarray(offset, Math.min(offset + chunkSize, sourceBytes.byteLength));
      }
    }
    const imported = await service.assets.ingest(sourceChunks(), {
      origin: { kind: "import" },
      declaredMimeType: "image/png",
      displayName: "packaged-large-reference.png",
    });
    if (
      imported.asset.byteLength <= CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_METADATA_BYTES ||
      imported.asset.width !== CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_WIDTH ||
      imported.asset.height !== CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_HEIGHT
    ) {
      throw new Error("Packaged Create Images did not import the bounded large-image fixture.");
    }
    const now = new Date().toISOString();
    const workflow = createStarterWorkflow({
      workflowId: "packaged-phase-two",
      promptNodeId: "packaged-prompt",
      generationNodeId: "packaged-generate",
      outputNodeId: "packaged-output",
      promptEdgeId: "packaged-edge-prompt",
      outputEdgeId: "packaged-edge-output",
      now,
    });
    workflow.nodes.push({
      id: "packaged-image",
      type: "image-input",
      position: { x: 40, y: 360 },
      data: { assetId: imported.asset.assetId, label: "Packaged reference" },
    });
    workflow.assetRefs = [imported.asset.assetId];
    await service.mutateWorkflow(workflow.id, workflow.assetRefs, () =>
      service.workflows.create(workflow),
    );
    await options.navigate(`/create-images/${workflow.id}`);
    const phaseTwoReady = await waitForCreateImagesPackagedAcceptance(
      "the durable workflow and protocol image preview",
      async () => ({
        ...(await readCreateImagesAcceptanceScript<
          Omit<
            PhaseTwoReadyObservation,
            | "grantCount"
            | "assetProtocolRequests"
            | "assetProtocolAuthorizations"
            | "lastAssetRequest"
          >
        >(CREATE_IMAGES_PHASE_TWO_READY_SCRIPT)),
        grantCount: service.grants.size(),
        assetProtocolRequests,
        assetProtocolAuthorizations,
        lastAssetRequest,
      }),
      (value) =>
        value.workbenchPresent &&
        value.nodeCount === "4" &&
        value.previewPresent &&
        value.previewComplete &&
        value.previewWidth > 0 &&
        value.promptPresent &&
        value.grantCount >= 1 &&
        value.assetProtocolRequests >= 1 &&
        value.assetProtocolAuthorizations >= 1 &&
        value.assetProtocolAuthorizations === value.assetProtocolRequests &&
        isAcceptedAssetRequestEvidence(value.lastAssetRequest),
    );
    const assetProtocolPreviewPassed =
      phaseTwoReady.previewWidth > 0 &&
      phaseTwoReady.grantCount >= 1 &&
      phaseTwoReady.assetProtocolRequests >= 1 &&
      phaseTwoReady.assetProtocolAuthorizations >= 1 &&
      phaseTwoReady.assetProtocolAuthorizations === phaseTwoReady.assetProtocolRequests &&
      isAcceptedAssetRequestEvidence(phaseTwoReady.lastAssetRequest);
    const preEditWorkflow = await service.workflows.get(workflow.id);
    if (!preEditWorkflow) {
      throw new Error("Packaged Create Images lost its durable workflow before editing.");
    }
    const editDispatched = await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_PHASE_TWO_EDIT_SCRIPT,
    );
    if (!editDispatched)
      throw new Error("Packaged Create Images could not edit the durable prompt.");
    const savedWorkflow = await waitForCreateImagesPackagedAcceptance(
      "the durable autosave publication",
      () => service.workflows.get(workflow.id),
      (value) =>
        isCreateImagesDurableWorkflowPublication(
          value,
          preEditWorkflow.revision,
          "Packaged durable prompt edit",
        ),
    );
    if (!savedWorkflow) {
      throw new Error("Packaged Create Images lost its workflow after the durable edit.");
    }
    const durableWorkflowPassed = isCreateImagesDurableWorkflowPublication(
      savedWorkflow,
      preEditWorkflow.revision,
      "Packaged durable prompt edit",
    );
    await options.reloadRenderer();
    await readCreateImagesAcceptanceScript<boolean>(
      CREATE_IMAGES_ACCEPTANCE_INSTALL_ERROR_COUNTER_SCRIPT,
    );
    await options.navigate(`/create-images/${workflow.id}`);
    const rendererReloadPersistencePassed = await waitForCreateImagesPackagedAcceptance(
      "the durable workflow after a renderer restart",
      () => readCreateImagesAcceptanceScript<boolean>(CREATE_IMAGES_PHASE_TWO_REOPENED_SCRIPT),
      Boolean,
    );
    const graphText = await fs.readFile(
      path.join(
        app.getPath("userData"),
        "create-images",
        "workflows",
        workflow.id,
        "workflow.json",
      ),
      "utf8",
    );
    const noGraphBase64Passed =
      Buffer.byteLength(graphText) < 4 * 1024 * 1024 &&
      !/data:image|;base64,/u.test(graphText) &&
      graphText.includes(imported.asset.assetId);
    const [phaseTwoRendererEventErrors, filesAfterPhaseTwo] = await Promise.all([
      readCreateImagesAcceptanceScript<number>(CREATE_IMAGES_ACCEPTANCE_RENDERER_ERRORS_SCRIPT),
      snapshotCreateImagesProductFiles(persistenceInput),
    ]);
    const phaseTwoProductFileMutations = countCreateImagesProductFileMutations(
      filesAfter,
      filesAfterPhaseTwo,
    );
    const phaseTwoProductFiles = createImagesPhaseTwoProductFileEvidence(
      filesAfter,
      filesAfterPhaseTwo,
      {
        workflowId: workflow.id,
        assetId: imported.asset.assetId,
        assetExtension: imported.asset.mediaType === "image/png" ? "png" : "jpg",
      },
    );
    const createImagesRoot = path.join(app.getPath("userData"), "create-images");
    const workflowRoot = path.join(createImagesRoot, "workflows", workflow.id);
    const [lastKnownGoodText, workflowIndexText, assetIndexText, runIndexText] = await Promise.all([
      fs.readFile(path.join(workflowRoot, "workflow.last-known-good.json"), "utf8"),
      fs.readFile(path.join(createImagesRoot, "index.json"), "utf8"),
      fs.readFile(path.join(createImagesRoot, "asset-index.json"), "utf8"),
      fs.readFile(path.join(createImagesRoot, "run-index.json"), "utf8"),
    ]);
    const workflowRecord = JSON.parse(graphText) as {
      id?: unknown;
      revision?: unknown;
      assetRefs?: unknown;
    };
    const workflowIndexRecord = JSON.parse(workflowIndexText) as {
      workflows?: Array<{ id?: unknown; revision?: unknown; assetCount?: unknown }>;
    };
    const assetIndexRecord = JSON.parse(assetIndexText) as {
      assets?: Record<
        string,
        {
          assetId?: unknown;
          byteLength?: unknown;
          width?: unknown;
          height?: unknown;
          referenceOwners?: unknown;
          thumbnails?: Record<string, { byteLength?: unknown }>;
        }
      >;
    };
    const runIndexRecord = JSON.parse(runIndexText) as {
      version?: unknown;
      revision?: unknown;
      entries?: unknown;
      degraded?: unknown;
    };
    const storedAsset = assetIndexRecord.assets?.[imported.asset.assetId];
    const assetFile = phaseTwoProductFiles.find((entry) =>
      entry.path.includes(`/assets/sha256/${imported.asset.assetId.slice(0, 2)}/`),
    );
    const thumbnailFile = phaseTwoProductFiles.find((entry) =>
      entry.path.includes(`/thumbnails/${imported.asset.assetId}/512.png`),
    );
    const phaseTwoStorageRelationshipsPassed =
      graphText === lastKnownGoodText &&
      workflowRecord.id === workflow.id &&
      workflowRecord.revision === savedWorkflow.revision &&
      Array.isArray(workflowRecord.assetRefs) &&
      workflowRecord.assetRefs.length === 1 &&
      workflowRecord.assetRefs[0] === imported.asset.assetId &&
      Array.isArray(workflowIndexRecord.workflows) &&
      workflowIndexRecord.workflows.length === 1 &&
      workflowIndexRecord.workflows[0]?.id === workflow.id &&
      workflowIndexRecord.workflows[0]?.revision === savedWorkflow.revision &&
      workflowIndexRecord.workflows[0]?.assetCount === 1 &&
      Object.keys(assetIndexRecord.assets ?? {}).length === 1 &&
      storedAsset?.assetId === imported.asset.assetId &&
      storedAsset.byteLength === assetFile?.bytes &&
      storedAsset.width === CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_WIDTH &&
      storedAsset.height === CREATE_IMAGES_PACKAGED_ACCEPTANCE_IMAGE_HEIGHT &&
      runIndexRecord.version === 1 &&
      Number.isSafeInteger(runIndexRecord.revision) &&
      (runIndexRecord.revision as number) >= 1 &&
      Array.isArray(runIndexRecord.entries) &&
      runIndexRecord.entries.length === 0 &&
      Array.isArray(runIndexRecord.degraded) &&
      runIndexRecord.degraded.length === 0 &&
      Array.isArray(storedAsset.referenceOwners) &&
      storedAsset.referenceOwners.length === 1 &&
      storedAsset.referenceOwners[0] === `workflow:${workflow.id}` &&
      storedAsset.thumbnails?.["512"]?.byteLength === thumbnailFile?.bytes;
    if (!phaseTwoStorageRelationshipsPassed) {
      throw new Error(
        "Packaged Create Images durable workflow, index, and asset relationships are inconsistent.",
      );
    }
    if (!isAcceptedAssetRequestEvidence(lastAssetRequest)) {
      throw new Error(
        "Packaged Create Images did not observe an accepted production asset request.",
      );
    }
    const rendererErrors =
      rendererEventErrors + phaseTwoRendererEventErrors + mainObservedRendererErrors;
    await writeCreateImagesPackagedAcceptanceReceipt(acceptance, {
      version: 1,
      nonce: acceptance.control.nonce,
      route: CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROUTE,
      initialNodeCount: initialNodeCount as 100,
      addedNodeCount: addedNodeCount as 101,
      duplicatedNodeCount: duplicatedNodeCount as 102,
      undoNodeCount: undoNodeCount as 101,
      redoNodeCount: redoNodeCount as 102,
      deletedNodeCount: deletedNodeCount as 101,
      nativeDeleteUndoNodeCount: nativeDeleteUndoNodeCount as 102,
      nativeDeleteRedoNodeCount: nativeDeleteRedoNodeCount as 101,
      spatialConnectionPassed,
      spatialInvalidDropPassed,
      nativeEdgeDeletePassed,
      keyboardConnectionPassed,
      keyboardMoveUndoPassed,
      repeatedAnnouncementPassed,
      uniqueAccessibleNodeLabels,
      narrowValidationPassed,
      narrowAddPlacementPassed,
      focusRestoredAfterPalette,
      focusRestoredAfterNativeDelete,
      nativeNodeDeleteGraphPassed,
      reducedMotionPassed,
      liveRegionMutations,
      keyboardActions: createImagesAcceptanceKeyboardActions,
      rendererErrors,
      networkRequests,
      rendererEgressProbePassed,
      rendererEgressProbeRequests,
      rendererEgressProbeBlocked,
      productFileMutations,
      durableWorkflowPassed,
      assetProtocolPreviewPassed,
      assetProtocolGrantCount: phaseTwoReady.grantCount,
      assetProtocolRequests,
      assetProtocolAuthorizations,
      assetProtocolLastRequest: lastAssetRequest,
      rendererReloadPersistencePassed,
      noGraphBase64Passed,
      phaseTwoProductFileMutations,
      phaseTwoProductFiles,
      phaseTwoStorageRelationshipsPassed,
      phaseTwoWorkflowRevision: savedWorkflow.revision,
      phaseTwoAssetBytes: imported.asset.byteLength,
      phaseTwoAssetWidth: imported.asset.width,
      phaseTwoAssetHeight: imported.asset.height,
      responsiveWidthsPassed,
      sandboxed: runtimePreferences.sandbox === true,
      contextIsolation: runtimePreferences.contextIsolation === true,
      nodeIntegration: runtimePreferences.nodeIntegration === true,
      durationMs: performance.now() - startedAt,
    });
  } finally {
    stopRequestPolicyObservation();
    window.webContents.off("console-message", onConsoleMessage);
    window.webContents.off("render-process-gone", onRenderProcessGone);
    window.webContents.off("did-fail-load", onDidFailLoad);
  }
}
