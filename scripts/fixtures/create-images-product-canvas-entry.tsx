import * as React from "react";
import { createRoot } from "react-dom/client";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { createImagesFixture } from "../../renderer/create-images/fixtures";
import { WorkflowCanvas } from "../../renderer/create-images/workflow-canvas";
import type { CreateImagesCanvasNode } from "../../renderer/create-images/workflow-node";
import "./create-images-canvas-spike.css";

interface ProductCanvasResult {
  cases: Array<{
    nodeCount: number;
    edgeCount: number;
    initialRenderMs: number;
    viewportOperationsMs: number;
    averageViewportOperationMs: number;
    selectionOperationsMs: number;
    averageSelectionOperationMs: number;
    medianSelectionMutationMs: number;
    medianSelectionCommitPaintMs: number;
    medianEmptyFrameMs: number;
    medianAdjustedSelectionMs: number;
    longTaskCount: number;
    longTaskDurationMs: number;
    usedJsHeapBytes?: number;
    hostWidth: number;
    hostHeight: number;
    renderedNodeCount: number;
    instanceNodeCount: number;
    layoutNodesMeasured: number;
    overlappingVisibleNodePairs: number;
    longPromptEditorScrollable: boolean;
    editOperationsPassed: boolean;
    repeatedAnnouncementPassed: boolean;
    resolvedThemeSurface: string;
  }>;
  heapGrowthBytes?: number;
  error?: string;
}

declare global {
  interface Window {
    __AIDEN_CREATE_IMAGES_SPIKE__?: ProductCanvasResult;
  }
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await animationFrame();
}

function usedJsHeapBytes(): number | undefined {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }
  ).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[middle - 1]! + sorted[middle]!) / 2;
  return sorted[middle]!;
}

function button(label: string): HTMLButtonElement {
  const element = document.querySelector(`button[aria-label="${label}"]`);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing ${label} button.`);
  return element;
}

async function verifyGraphEdits(
  instance: ReactFlowInstance<CreateImagesCanvasNode, Edge>,
  nodeCount: number,
): Promise<{ editOperationsPassed: boolean; repeatedAnnouncementPassed: boolean }> {
  button("Toggle node inspector").click();
  await settleFrames(2);
  const listItem = document.querySelector('ul[aria-label="Workflow nodes"] button');
  if (!(listItem instanceof HTMLButtonElement)) throw new Error("Missing accessible node list.");
  listItem.click();
  await settleFrames(20);
  button("Duplicate selected nodes").click();
  await settleFrames(3);
  if (instance.getNodes().length !== nodeCount + 1) {
    return { editOperationsPassed: false, repeatedAnnouncementPassed: false };
  }
  button("Undo").click();
  await settleFrames(3);
  if (instance.getNodes().length !== nodeCount) {
    return { editOperationsPassed: false, repeatedAnnouncementPassed: false };
  }
  button("Redo").click();
  await settleFrames(3);
  if (instance.getNodes().length !== nodeCount + 1) {
    return { editOperationsPassed: false, repeatedAnnouncementPassed: false };
  }
  button("Delete selected nodes").click();
  await settleFrames(3);
  if (instance.getNodes().length !== nodeCount) {
    return { editOperationsPassed: false, repeatedAnnouncementPassed: false };
  }

  const liveRegion = document.querySelector("[data-create-images-action-status]");
  if (!(liveRegion instanceof HTMLElement)) {
    return { editOperationsPassed: true, repeatedAnnouncementPassed: false };
  }
  let liveRegionMutations = 0;
  const observer = new MutationObserver((records) => {
    liveRegionMutations += records.length;
  });
  observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });
  button("Undo").click();
  await settleFrames(3);
  const firstMutationCount = liveRegionMutations;
  button("Undo").click();
  await settleFrames(3);
  const repeatedAnnouncementPassed =
    firstMutationCount > 0 && liveRegionMutations > firstMutationCount;
  observer.disconnect();
  button("Redo").click();
  await settleFrames(3);
  button("Redo").click();
  await settleFrames(3);
  return {
    editOperationsPassed: instance.getNodes().length === nodeCount,
    repeatedAnnouncementPassed,
  };
}

async function renderProductFixture(workflowId: string, retain = false): Promise<void> {
  const fixture = createImagesFixture(workflowId);
  if (!fixture) throw new Error(`Missing ${workflowId} product fixture.`);
  const host = document.createElement("div");
  host.className = "spike-host";
  document.body.append(host);
  const root = createRoot(host);
  let resolveInstance!: () => void;
  const instanceReady = new Promise<void>((resolve) => {
    resolveInstance = resolve;
  });
  root.render(
    <WorkflowCanvas
      document={fixture}
      onBack={() => undefined}
      onCanvasReady={() => resolveInstance()}
    />,
  );
  await instanceReady;
  await settleFrames(4);
  if (!retain) {
    root.unmount();
    host.remove();
    await settleFrames(2);
  }
}

async function measure(nodeCount: 100 | 250): Promise<ProductCanvasResult["cases"][number]> {
  document.documentElement.classList.toggle("dark", nodeCount === 250);
  const host = document.createElement("div");
  host.className = "spike-host";
  document.body.append(host);
  const root = createRoot(host);
  const fixture = createImagesFixture(`stress-${nodeCount}`);
  if (!fixture) throw new Error(`Missing ${nodeCount}-node product fixture.`);
  const boundaryPrompt = fixture.nodes.find((node) => node.type === "prompt");
  if (boundaryPrompt?.type === "prompt") boundaryPrompt.data.text = "x".repeat(32_000);
  let instance: ReactFlowInstance<CreateImagesCanvasNode, Edge> | undefined;
  let resolveInstance!: () => void;
  const instanceReady = new Promise<void>((resolve) => {
    resolveInstance = resolve;
  });
  const longTasks: PerformanceEntry[] = [];
  const observer =
    typeof PerformanceObserver === "undefined"
      ? undefined
      : new PerformanceObserver((list) => longTasks.push(...list.getEntries()));
  try {
    observer?.observe({ entryTypes: ["longtask"] });
  } catch {
    observer?.disconnect();
  }

  const startedAt = performance.now();
  root.render(
    <WorkflowCanvas
      document={fixture}
      onBack={() => undefined}
      onCanvasReady={(next) => {
        instance = next;
        resolveInstance();
      }}
    />,
  );
  await instanceReady;
  await settleFrames(4);
  const initialRenderMs = performance.now() - startedAt;
  if (!instance) throw new Error("Product React Flow canvas did not initialize.");

  await instance.setViewport({ x: 0, y: 0, zoom: 0.7 }, { duration: 0 });
  await settleFrames(2);
  const layoutBounds = Array.from(
    host.querySelectorAll<HTMLElement>(".react-flow__node"),
    (node) => node.getBoundingClientRect(),
  );
  const promptEditor = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label^="Prompt text · "]',
  );
  const longPromptEditorScrollable = Boolean(
    promptEditor &&
      promptEditor.value.length === 32_000 &&
      promptEditor.scrollHeight > promptEditor.clientHeight &&
      promptEditor.clientHeight <= 160,
  );
  let overlappingVisibleNodePairs = 0;
  for (let leftIndex = 0; leftIndex < layoutBounds.length; leftIndex += 1) {
    const left = layoutBounds[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < layoutBounds.length; rightIndex += 1) {
      const right = layoutBounds[rightIndex]!;
      if (
        left.right > right.left + 1 &&
        right.right > left.left + 1 &&
        left.bottom > right.top + 1 &&
        right.bottom > left.top + 1
      ) {
        overlappingVisibleNodePairs += 1;
      }
    }
  }

  const viewportStartedAt = performance.now();
  for (let index = 0; index < 40; index += 1) {
    await instance.setViewport(
      { x: -(index % 10) * 25, y: -(index % 8) * 18, zoom: 0.45 + (index % 5) * 0.08 },
      { duration: 0 },
    );
  }
  await settleFrames(2);
  const viewportOperationsMs = performance.now() - viewportStartedAt;

  // Warm React Flow's selection path, then compare mutation+paint frames with
  // empty frames sampled immediately beside them. Three batch medians prevent
  // one OS scheduling pause from becoming a false regression.
  for (let index = 0; index < 5; index += 1) {
    const selectedNodeId = fixture.nodes[index]?.id;
    instance.setNodes((nodes) =>
      nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId })),
    );
    await animationFrame();
  }
  const selectionStartedAt = performance.now();
  const mutationBatchMedians: number[] = [];
  const commitPaintBatchMedians: number[] = [];
  const emptyFrameBatchMedians: number[] = [];
  const adjustedBatchMedians: number[] = [];
  for (let batch = 0; batch < 3; batch += 1) {
    const mutations: number[] = [];
    const commitPaint: number[] = [];
    const emptyFrames: number[] = [];
    const adjusted: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const emptyStartedAt = performance.now();
      await animationFrame();
      const emptyDuration = performance.now() - emptyStartedAt;
      const selectedNodeId = fixture.nodes[(batch * 12 + index) % fixture.nodes.length]?.id;
      const paintStartedAt = performance.now();
      const mutationStartedAt = performance.now();
      instance.setNodes((nodes) =>
        nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId })),
      );
      mutations.push(performance.now() - mutationStartedAt);
      await animationFrame();
      const paintDuration = performance.now() - paintStartedAt;
      emptyFrames.push(emptyDuration);
      commitPaint.push(paintDuration);
      adjusted.push(Math.max(0, paintDuration - emptyDuration));
    }
    mutationBatchMedians.push(median(mutations));
    commitPaintBatchMedians.push(median(commitPaint));
    emptyFrameBatchMedians.push(median(emptyFrames));
    adjustedBatchMedians.push(median(adjusted));
  }
  const selectionOperationsMs = performance.now() - selectionStartedAt;
  const editChecks = await verifyGraphEdits(instance, nodeCount);
  observer?.disconnect();
  const hostBounds = host.getBoundingClientRect();
  const productNode = host.querySelector(".create-images-node");
  const result = {
    nodeCount,
    edgeCount: fixture.edges.length,
    initialRenderMs,
    viewportOperationsMs,
    averageViewportOperationMs: viewportOperationsMs / 40,
    selectionOperationsMs,
    averageSelectionOperationMs: selectionOperationsMs / 72,
    medianSelectionMutationMs: median(mutationBatchMedians),
    medianSelectionCommitPaintMs: median(commitPaintBatchMedians),
    medianEmptyFrameMs: median(emptyFrameBatchMedians),
    medianAdjustedSelectionMs: median(adjustedBatchMedians),
    longTaskCount: longTasks.length,
    longTaskDurationMs: longTasks.reduce((total, entry) => total + entry.duration, 0),
    usedJsHeapBytes: usedJsHeapBytes(),
    hostWidth: hostBounds.width,
    hostHeight: hostBounds.height,
    renderedNodeCount: host.querySelectorAll(".react-flow__node").length,
    instanceNodeCount: instance.getNodes().length,
    layoutNodesMeasured: layoutBounds.length,
    overlappingVisibleNodePairs,
    longPromptEditorScrollable,
    ...editChecks,
    resolvedThemeSurface:
      productNode instanceof HTMLElement ? getComputedStyle(productNode).backgroundColor : "",
  };
  root.unmount();
  host.remove();
  await settleFrames(2);
  return result;
}

void (async () => {
  try {
    await document.fonts.ready;
    await renderProductFixture("starter");
    const first = await measure(100);
    const second = await measure(250);
    document.documentElement.classList.remove("dark");
    await renderProductFixture("starter", true);
    window.__AIDEN_CREATE_IMAGES_SPIKE__ = {
      cases: [first, second],
      ...(first.usedJsHeapBytes !== undefined && second.usedJsHeapBytes !== undefined
        ? { heapGrowthBytes: second.usedJsHeapBytes - first.usedJsHeapBytes }
        : {}),
    };
  } catch (error) {
    window.__AIDEN_CREATE_IMAGES_SPIKE__ = {
      cases: [],
      error: error instanceof Error ? error.message : "Product canvas gate failed.",
    };
  }
})();
