import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./create-images-canvas-spike.css";

interface SpikeResult {
  cases: Array<{
    nodeCount: number;
    edgeCount: number;
    initialRenderMs: number;
    viewportOperationsMs: number;
    averageViewportOperationMs: number;
    selectionOperationsMs: number;
    averageSelectionOperationMs: number;
    longTaskCount: number;
    longTaskDurationMs: number;
    usedJsHeapBytes?: number;
    hostWidth: number;
    hostHeight: number;
    renderedNodeCount: number;
    instanceNodeCount: number;
  }>;
  heapGrowthBytes?: number;
  error?: string;
}

declare global {
  interface Window {
    __AIDEN_CREATE_IMAGES_SPIKE__?: SpikeResult;
  }
}

type SpikeNode = Node<{ label: string }, "spike">;

const SpikeNodeView = React.memo(function SpikeNodeView({ data }: NodeProps<SpikeNode>) {
  return (
    <div className="spike-node" aria-label={data.label}>
      <Handle type="target" position={Position.Left} />
      <span>{data.label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { spike: SpikeNodeView };

function graph(nodeCount: number): { nodes: SpikeNode[]; edges: Edge[] } {
  const columns = 20;
  const nodes: SpikeNode[] = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node-${index}`,
    type: "spike",
    position: { x: (index % columns) * 210, y: Math.floor(index / columns) * 130 },
    data: { label: `Image node ${index + 1}` },
  }));
  const edges: Edge[] = Array.from({ length: Math.max(0, nodeCount - 1) }, (_, index) => ({
    id: `edge-${index}`,
    source: `node-${index}`,
    target: `node-${index + 1}`,
  }));
  return { nodes, edges };
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

async function measure(nodeCount: number): Promise<SpikeResult["cases"][number]> {
  const host = document.createElement("div");
  host.className = "spike-host";
  document.body.append(host);
  const root = createRoot(host);
  const fixture = graph(nodeCount);
  let instance: ReactFlowInstance<SpikeNode, Edge> | undefined;
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
    <ReactFlow<SpikeNode, Edge>
      nodes={fixture.nodes}
      edges={fixture.edges}
      nodeTypes={nodeTypes}
      minZoom={0.1}
      maxZoom={2}
      fitView
      onlyRenderVisibleElements
      onInit={(next) => {
        instance = next;
        resolveInstance();
      }}
    >
      <Background gap={20} size={1} />
      <MiniMap pannable zoomable />
      <Controls />
    </ReactFlow>,
  );
  await instanceReady;
  await settleFrames(3);
  const initialRenderMs = performance.now() - startedAt;
  if (!instance) throw new Error("React Flow did not initialize.");

  const viewportStartedAt = performance.now();
  for (let index = 0; index < 40; index += 1) {
    await instance.setViewport(
      { x: -(index % 10) * 25, y: -(index % 8) * 18, zoom: 0.45 + (index % 5) * 0.08 },
      { duration: 0 },
    );
  }
  await settleFrames(2);
  const viewportOperationsMs = performance.now() - viewportStartedAt;

  const selectionStartedAt = performance.now();
  for (let index = 0; index < 20; index += 1) {
    const selectedNodeId = `node-${index % nodeCount}`;
    instance.setNodes((nodes) =>
      nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId })),
    );
    await animationFrame();
  }
  const selectionOperationsMs = performance.now() - selectionStartedAt;
  observer?.disconnect();
  const hostBounds = host.getBoundingClientRect();
  const result = {
    nodeCount,
    edgeCount: fixture.edges.length,
    initialRenderMs,
    viewportOperationsMs,
    averageViewportOperationMs: viewportOperationsMs / 40,
    selectionOperationsMs,
    averageSelectionOperationMs: selectionOperationsMs / 20,
    longTaskCount: longTasks.length,
    longTaskDurationMs: longTasks.reduce((total, entry) => total + entry.duration, 0),
    usedJsHeapBytes: usedJsHeapBytes(),
    hostWidth: hostBounds.width,
    hostHeight: hostBounds.height,
    renderedNodeCount: host.querySelectorAll(".react-flow__node").length,
    instanceNodeCount: instance.getNodes().length,
  };
  root.unmount();
  host.remove();
  await settleFrames(2);
  return result;
}

void (async () => {
  try {
    const first = await measure(100);
    const second = await measure(250);
    window.__AIDEN_CREATE_IMAGES_SPIKE__ = {
      cases: [first, second],
      ...(first.usedJsHeapBytes !== undefined && second.usedJsHeapBytes !== undefined
        ? { heapGrowthBytes: second.usedJsHeapBytes - first.usedJsHeapBytes }
        : {}),
    };
  } catch (error) {
    window.__AIDEN_CREATE_IMAGES_SPIKE__ = {
      cases: [],
      error: error instanceof Error ? error.message : "Canvas spike failed.",
    };
  }
})();
