import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  ArrowLeft,
  BoxSelect,
  Boxes,
  Columns2,
  ChevronRight,
  Copy,
  GalleryHorizontalEnd,
  Grid3X3,
  History,
  Image as ImageIcon,
  Images,
  Keyboard,
  ListTree,
  ListOrdered,
  Map as MapIcon,
  MessageSquare,
  PenTool,
  Plus,
  Play,
  Redo2,
  Save,
  Search,
  Sparkles,
  TextCursorInput,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button, Input, Text, Textarea, toast, useSplitViewState } from "../components/ui";
import { createImagesApi } from "../lib/ipc";
import { readModelSelection } from "../lib/use-model-selection";
import type {
  CreateImagesAssetGrantView,
  CreateImagesRecentOutputView,
  CreateImagesRunRecoveryView,
  CreateImagesRunView,
} from "../shared/create-images/ipc";
import type { CreateImagesWorkflowProposal } from "../shared/create-images/workflow-proposal";
import { createImagesAdaptiveAssetGrantUrl } from "../shared/create-images/ipc";
import { fitCreateImagesNodeToMediaAspect } from "./node-dimensions-core";
import {
  planWorkflowExecution,
  WorkflowPlanError,
  type WorkflowRunScope,
} from "../shared/create-images/execution";
import {
  CREATE_IMAGES_NODE_DEFINITIONS,
  createImagesNodePorts,
  isCreateImagesPortCompatible,
  type CreateImagesPortKind,
  validateWorkflowGraph,
  type WorkflowGraphIssue,
} from "../shared/create-images/ports";
import type {
  CreateImagesNodeType,
  WorkflowDocumentV1,
  WorkflowEdgeV1,
  WorkflowNodeV1,
} from "../shared/create-images/schema";
import { CREATE_IMAGES_ASSET_ID_PATTERN } from "../shared/create-images/schema";
import {
  disconnectedCreateImagesProviderStatus,
  evaluateCreateImagesProviderBinding,
  type CreateImagesExecutionMode,
  type CreateImagesProviderStatus,
} from "../shared/create-images/providers";
import {
  CREATE_IMAGES_MAX_ZOOM,
  CREATE_IMAGES_MIN_ZOOM,
  CREATE_IMAGES_POSITION_LIMIT,
} from "../shared/create-images/schema";
import { CreateImagesCanvasActionsContext } from "./canvas-context";
import type { AssetPreviewLifecycleStatus } from "./asset-preview-lifecycle-core";
import {
  arrangeCreateImagesSelection,
  boundedCanvasPosition,
  boundedPromptText,
  commitEditorHistory,
  compatibleCreateImagesNodeOptions,
  createEditorHistory,
  decideCanvasConnection,
  decideCanvasMutationCapacity,
  redoEditorHistory,
  resolveCreateImagesGraphShortcut,
  undoEditorHistory,
  type CreateImagesArrangement,
  type CreateImagesDanglingConnectionOrigin,
  type EditorHistory,
} from "./editor-core";
import {
  CREATE_IMAGES_GRAPH_FRAGMENT_KIND,
  CREATE_IMAGES_GRAPH_FRAGMENT_MIME,
  createCreateImagesGraphFragment,
  instantiateCreateImagesGraphFragment,
  parseCreateImagesGraphFragment,
  serializeCreateImagesGraphFragment,
  type CreateImagesGraphFragmentV1,
} from "./graph-fragment-core";
import {
  CREATE_IMAGES_RECENT_OUTPUT_DRAG_MIME,
  createCreateImagesRecentOutputDrag,
  parseCreateImagesRecentOutputDrag,
  serializeCreateImagesRecentOutputDrag,
} from "./recent-output-core";
import {
  readCreateImagesRecentOutputCutoff,
  visibleCreateImagesRecentOutputs,
  writeCreateImagesRecentOutputCutoff,
} from "./recent-output-presentation-core";
import {
  CREATE_IMAGES_DROP_NODE_HEIGHT,
  CREATE_IMAGES_DROP_NODE_WIDTH,
  filterSupportedCreateImagesFiles,
  hasPotentialCreateImagesFileDrag,
  INITIAL_CREATE_IMAGES_DROP_STATE,
  planCreateImagesDrop,
  reduceCreateImagesDropState,
  sanitizeCreateImagesImageLabel,
  type CreateImagesDropState,
} from "./image-drop-core";
import {
  CreateImagesRunControls,
  CreateImagesRunProgressPanel,
  CreateImagesTerminalRunHistory,
  type CreateImagesRunHistoryDetailState,
} from "./run-ui";
import type {
  CreateImagesRunErrorAction,
  CreateImagesRunUiProjection,
  CreateImagesTerminalRunHistoryItem,
} from "./run-ui-core";
import {
  WorkflowNode,
  type CreateImagesCanvasNode,
  type CreateImagesCanvasNodeData,
} from "./workflow-node";
import { CreateImagesProviderConnectionControl } from "./provider-connection";
import { createImagesBindingIssueLabel } from "./provider-connection-core";
import { CreateImagesImageLightbox } from "./image-lightbox";
import {
  readCreateImagesPowerFeatures,
  writeCreateImagesPowerFeatures,
} from "./power-features-core";
import {
  createImagesCanvasNavigationProps,
  readCreateImagesCanvasNavigationPreferences,
  writeCreateImagesCanvasNavigationPreferences,
} from "./canvas-navigation-preferences-core";

const EMPTY_ASSET_PREVIEWS: Readonly<Record<string, CreateImagesAssetGrantView>> = Object.freeze(
  {},
);

interface CreateImagesInspectedAsset {
  assetId: string;
  source: "workflow" | "run" | "recent";
  label: string;
  runId?: string;
}
const EMPTY_MISSING_ASSET_IDS: readonly string[] = Object.freeze([]);
const EMPTY_ASSET_PREVIEW_RETAINER = (): (() => void) => () => undefined;
const EMPTY_RUN_HISTORY: readonly CreateImagesTerminalRunHistoryItem[] = Object.freeze([]);
const EMPTY_RUN_RECOVERIES: readonly CreateImagesRunRecoveryView[] = Object.freeze([]);
const EMPTY_RECENT_OUTPUTS: readonly CreateImagesRecentOutputView[] = Object.freeze([]);
const EMPTY_PROVIDER_STATUS = Object.freeze(disconnectedCreateImagesProviderStatus());
const NOOP_OPEN_PROVIDER_SETTINGS = () => undefined;
const EMPTY_RUN_HISTORY_DETAIL: CreateImagesRunHistoryDetailState = Object.freeze({
  status: "idle",
});

interface CanvasSnapshot {
  nodes: CreateImagesCanvasNode[];
  edges: Edge[];
}

const NODE_TYPES = {
  "image-input": WorkflowNode,
  prompt: WorkflowNode,
  "prompt-list": WorkflowNode,
  "generate-image": WorkflowNode,
  output: WorkflowNode,
  "output-gallery": WorkflowNode,
  "image-compare": WorkflowNode,
  annotation: WorkflowNode,
  group: WorkflowNode,
};

const CREATE_IMAGES_NODE_WIDTH = 288;
const CREATE_IMAGES_NODE_ESTIMATED_HEIGHT = 300;
const CREATE_IMAGES_NODE_DRAG_MIME = "application/x-aiden-create-images-node-type";

export interface CreateImagesDroppedImage {
  assetId: string;
  label?: string;
}

export interface CreateImagesDroppedImageImportResult {
  imported: readonly CreateImagesDroppedImage[];
  failures?: readonly string[];
}

export type CreateImagesDroppedImageImporter = (
  files: readonly File[],
) => Promise<CreateImagesDroppedImageImportResult | undefined>;

const NODE_ICONS = {
  "image-input": ImageIcon,
  prompt: TextCursorInput,
  "prompt-list": ListOrdered,
  "generate-image": Sparkles,
  output: Images,
  "output-gallery": GalleryHorizontalEnd,
  "image-compare": Columns2,
  annotation: PenTool,
  group: Boxes,
} satisfies Record<CreateImagesNodeType, React.ComponentType<{ className?: string }>>;

function workflowNodeLabel(node: WorkflowNodeV1): string {
  return `${CREATE_IMAGES_NODE_DEFINITIONS[node.type].title} · ${node.id}`;
}

function canvasPositionsEqual(left: CanvasSnapshot, right: CanvasSnapshot): boolean {
  if (left.nodes.length !== right.nodes.length) return false;
  const rightPositions = new Map(right.nodes.map((node) => [node.id, node.position]));
  return left.nodes.every((node) => {
    const position = rightPositions.get(node.id);
    return position?.x === node.position.x && position.y === node.position.y;
  });
}

function createImagesMotionDuration(milliseconds: number): number {
  return document.documentElement.dataset.reduceMotion === "true" ? 0 : milliseconds;
}

function readAidenAppearanceScheme(): "light" | "dark" {
  return document.documentElement.dataset.appearanceScheme === "dark" ||
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function useAidenAppearanceScheme(): "light" | "dark" {
  const [scheme, setScheme] = React.useState<"light" | "dark">(readAidenAppearanceScheme);
  React.useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setScheme(readAidenAppearanceScheme()));
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-appearance-scheme"],
    });
    return () => observer.disconnect();
  }, []);
  return scheme;
}

function useNarrowCreateImagesCanvas(workbenchRef: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench) return;
    const update = (width: number) => setNarrow(width <= 760);
    update(workbench.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(workbench);
    return () => observer.disconnect();
  }, [workbenchRef]);
  return narrow;
}

function toCanvasSnapshot(document: WorkflowDocumentV1): CanvasSnapshot {
  return {
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { workflowNode: structuredClone(node) },
      ariaLabel: workflowNodeLabel(node),
      zIndex: node.type === "group" ? -1 : 0,
      ...(node.dimensions
        ? { style: { width: node.dimensions.width, height: node.dimensions.height } }
        : {}),
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourcePort,
      target: edge.target,
      targetHandle: edge.targetPort,
      type: "smoothstep",
      className: "create-images-edge",
      data: { breakpoint: edge.breakpoint === true },
    })),
  };
}

function toWorkflowDocument(
  snapshot: CanvasSnapshot,
  source: WorkflowDocumentV1,
): WorkflowDocumentV1 {
  const nodes = snapshot.nodes.map((node) => ({
    ...node.data.workflowNode,
    position: boundedCanvasPosition(node.position),
  })) as WorkflowNodeV1[];
  const edges: WorkflowEdgeV1[] = snapshot.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourcePort: edge.sourceHandle ?? "",
    target: edge.target,
    targetPort: edge.targetHandle ?? "",
    ...((edge.data as { breakpoint?: boolean } | undefined)?.breakpoint === true
      ? { breakpoint: true }
      : {}),
  }));
  const assetRefs: string[] = [];
  for (const node of nodes) {
    if (node.type === "image-input" && node.data.assetId) assetRefs.push(node.data.assetId);
  }
  return { ...source, nodes, edges, assetRefs: [...new Set(assetRefs)] };
}

function newWorkflowNode(
  type: CreateImagesNodeType,
  id: string,
  position: { x: number; y: number },
): WorkflowNodeV1 {
  if (type === "prompt") return { id, type, position, data: { text: "" } };
  if (type === "prompt-list") return { id, type, position, data: { source: "", format: "lines" } };
  if (type === "image-input") return { id, type, position, data: {} };
  if (type === "generate-image") {
    return {
      id,
      type,
      position,
      data: {
        providerId: "gemini",
        modelId: "gemini-3.1-flash-image",
        aspectRatio: "1:1",
        imageSize: "1K",
        outputMime: "image/png",
        count: 1,
      },
    };
  }
  if (type === "image-compare") return { id, type, position, data: { divider: 0.5 } };
  if (type === "annotation") return { id, type, position, data: { shapes: [] } };
  if (type === "group") {
    return {
      id,
      type,
      position,
      dimensions: { width: 520, height: 360 },
      data: { memberNodeIds: [], color: "gray", locked: false },
    };
  }
  return { id, type, position, data: {} };
}

function imageInputNodeWithAsset(
  id: string,
  position: { x: number; y: number },
  image: CreateImagesDroppedImage,
): WorkflowNodeV1 {
  const node = newWorkflowNode("image-input", id, position);
  if (node.type !== "image-input") return node;
  return {
    ...node,
    data: {
      assetId: image.assetId,
      ...(image.label ? { label: image.label } : {}),
    },
  };
}

function imageInputNodeIdAtTarget(
  target: EventTarget | null,
  nodes: readonly CreateImagesCanvasNode[],
): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const nodeElement = target.closest<HTMLElement>(".react-flow__node[data-id]");
  const nodeId = nodeElement?.dataset.id;
  if (!nodeId) return undefined;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.data.workflowNode.type === "image-input" ? node.id : undefined;
}

function normalizeDroppedImage(
  image: CreateImagesDroppedImage,
): CreateImagesDroppedImage | undefined {
  if (!CREATE_IMAGES_ASSET_ID_PATTERN.test(image.assetId)) return undefined;
  const label = sanitizeCreateImagesImageLabel(image.label);
  return { assetId: image.assetId, ...(label ? { label } : {}) };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
  );
}

function hasCreateImagesClipboardImage(event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  if (Array.from(data.types).some((type) => type.trim().toLowerCase().startsWith("image/"))) {
    return true;
  }
  return Array.from(data.items).some(
    (item) => item.kind === "file" && item.type.trim().toLowerCase().startsWith("image/"),
  );
}

function isCreateImagesNodeType(value: string): value is CreateImagesNodeType {
  return Object.prototype.hasOwnProperty.call(CREATE_IMAGES_NODE_DEFINITIONS, value);
}

function SelectionInspector({
  surfaceRef,
  nodes,
  document,
  selectedNode,
  onSelect,
  onConnect,
  onDisconnect,
  onRun,
  runDisabledReason,
  onUpdateNode,
  onFitImageToMedia,
  onDuplicate,
  onDelete,
  onClose,
}: {
  surfaceRef: React.RefObject<HTMLElement | null>;
  nodes: readonly CreateImagesCanvasNode[];
  document: WorkflowDocumentV1;
  selectedNode: CreateImagesCanvasNode | undefined;
  onSelect(nodeId: string): void;
  onConnect(connection: Connection): void;
  onDisconnect(edgeId: string): void;
  onRun?(trigger: HTMLButtonElement): void;
  runDisabledReason?: string;
  onUpdateNode(nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1): void;
  onFitImageToMedia(nodeId: string): void;
  onDuplicate(): void;
  onDelete(): void;
  onClose(): void;
}) {
  const [connectionToolsOpen, setConnectionToolsOpen] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [commentDraft, setCommentDraft] = React.useState("");
  React.useEffect(() => {
    setTitleDraft(selectedNode?.data.workflowNode.title ?? "");
    setCommentDraft(selectedNode?.data.workflowNode.comment?.text ?? "");
  }, [
    selectedNode?.id,
    selectedNode?.data.workflowNode.comment?.text,
    selectedNode?.data.workflowNode.title,
  ]);
  const sourceOptions = React.useMemo(() => {
    const options: Array<{
      value: string;
      nodeId: string;
      portId: string;
      kind: CreateImagesPortKind;
      label: string;
    }> = [];
    for (const node of document.nodes) {
      for (const port of createImagesNodePorts(node, "outputs")) {
        options.push({
          value: `${node.id}\u0000${port.id}`,
          nodeId: node.id,
          portId: port.id,
          kind: port.kind,
          label: `${workflowNodeLabel(node)} · ${port.label}`,
        });
      }
    }
    return options;
  }, [document.nodes]);
  const [sourceValue, setSourceValue] = React.useState(sourceOptions[0]?.value ?? "");
  const source = sourceOptions.find((option) => option.value === sourceValue) ?? sourceOptions[0];
  const targetOptions = React.useMemo(() => {
    const options: Array<{
      value: string;
      nodeId: string;
      portId: string;
      label: string;
    }> = [];
    if (!source) return options;
    for (const node of document.nodes) {
      if (node.id === source.nodeId) continue;
      for (const port of createImagesNodePorts(node, "inputs")) {
        if (!isCreateImagesPortCompatible(source.kind, port.kind)) continue;
        options.push({
          value: `${node.id}\u0000${port.id}`,
          nodeId: node.id,
          portId: port.id,
          label: `${workflowNodeLabel(node)} · ${port.label}`,
        });
      }
    }
    return options;
  }, [document.nodes, source]);
  const [targetValue, setTargetValue] = React.useState("");
  const target = targetOptions.find((option) => option.value === targetValue) ?? targetOptions[0];

  return (
    <aside
      ref={surfaceRef}
      tabIndex={-1}
      aria-label="Workflow node inspector"
      className="create-images-inspector absolute bottom-3 right-3 top-16 z-20 flex w-72 flex-col overflow-hidden rounded-card border border-field bg-popover/95 shadow-popover backdrop-blur-xl"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
        <ListTree className="size-4 text-secondary" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-small-strong font-medium">
          {selectedNode
            ? CREATE_IMAGES_NODE_DEFINITIONS[selectedNode.data.workflowNode.type].title
            : "Workflow nodes"}
        </h2>
        <Button
          iconOnly
          size="small"
          variant="transparent"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {selectedNode ? (
        <div className="border-b border-separator p-3">
          <Text as="p" variant="small" color="secondary">
            ID · {selectedNode.id}
          </Text>
          <div className="mt-3 flex gap-1.5">
            <Button
              size="small"
              variant="filled"
              disabled={!onRun || Boolean(runDisabledReason)}
              title={runDisabledReason ?? "Run this node"}
              onClick={(event) => onRun?.(event.currentTarget)}
            >
              <Play /> Run this node
            </Button>
            <Button size="small" variant="filled" onClick={onDuplicate}>
              <Copy /> Duplicate
            </Button>
            <Button size="small" variant="transparent" onClick={onDelete}>
              <Trash2 /> Delete
            </Button>
          </div>
          {selectedNode.data.workflowNode.type === "image-input" &&
          selectedNode.data.workflowNode.data.assetId ? (
            <Button
              className="mt-2"
              size="small"
              variant="transparent"
              onClick={() => onFitImageToMedia(selectedNode.id)}
            >
              Fit node to image aspect
            </Button>
          ) : null}
          <div className="mt-3 grid gap-2 border-t border-separator pt-3">
            <label className="grid gap-1 text-mini text-secondary">
              Custom title
              <Input
                value={titleDraft}
                maxLength={120}
                placeholder={
                  CREATE_IMAGES_NODE_DEFINITIONS[selectedNode.data.workflowNode.type].title
                }
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() =>
                  onUpdateNode(selectedNode.id, (node) => ({
                    ...node,
                    ...(titleDraft.trim() ? { title: titleDraft.trim().slice(0, 120) } : {}),
                    ...(!titleDraft.trim() ? { title: undefined } : {}),
                  }))
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["width", "height"] as const).map((dimension) => (
                <label key={dimension} className="grid gap-1 text-mini capitalize text-secondary">
                  {dimension}
                  <Input
                    type="number"
                    min={dimension === "width" ? 180 : 120}
                    max={dimension === "width" ? 1_200 : 1_600}
                    value={
                      selectedNode.data.workflowNode.dimensions?.[dimension] ??
                      (dimension === "width" ? 288 : 300)
                    }
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) return;
                      onUpdateNode(selectedNode.id, (node) => ({
                        ...node,
                        dimensions: {
                          width:
                            dimension === "width"
                              ? Math.min(1_200, Math.max(180, value))
                              : (node.dimensions?.width ?? 288),
                          height:
                            dimension === "height"
                              ? Math.min(1_600, Math.max(120, value))
                              : (node.dimensions?.height ?? 300),
                        },
                      }));
                    }}
                  />
                </label>
              ))}
            </div>
            <label className="grid gap-1 text-mini text-secondary">
              Comment
              <Textarea
                value={commentDraft}
                maxLength={2_000}
                rows={3}
                placeholder="Add a note for this node"
                onChange={(event) => setCommentDraft(event.target.value)}
                onBlur={() =>
                  onUpdateNode(selectedNode.id, (node) => ({
                    ...node,
                    ...(commentDraft.trim()
                      ? {
                          comment: {
                            text: commentDraft.trim().slice(0, 2_000),
                            ...(node.comment?.unread ? { unread: true } : {}),
                          },
                        }
                      : { comment: undefined }),
                  }))
                }
              />
            </label>
            {selectedNode.data.workflowNode.comment?.unread ? (
              <Button
                size="small"
                variant="transparent"
                onClick={() =>
                  onUpdateNode(selectedNode.id, (node) => ({
                    ...node,
                    comment: node.comment ? { text: node.comment.text } : undefined,
                  }))
                }
              >
                Mark comment read
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="border-b border-separator p-3 text-small text-secondary">
          Select a node on the canvas or from this keyboard-accessible list.
        </div>
      )}
      {connectionToolsOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <button
            type="button"
            className="mb-3 text-small font-medium text-accent outline-none hover:underline focus-visible:underline"
            onClick={() => setConnectionToolsOpen(false)}
          >
            Back to nodes
          </button>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-small-strong font-medium">Add a typed connection</legend>
            <label className="flex flex-col gap-1 text-mini text-secondary">
              Source output
              <select
                className="h-8 rounded-control border border-field bg-input px-2 text-small text-primary outline-none focus:border-focus-ring"
                value={source?.value ?? ""}
                disabled={sourceOptions.length === 0}
                onChange={(event) => setSourceValue(event.target.value)}
              >
                {sourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-mini text-secondary">
              Destination input
              <select
                className="h-8 rounded-control border border-field bg-input px-2 text-small text-primary outline-none focus:border-focus-ring"
                value={target?.value ?? ""}
                disabled={targetOptions.length === 0}
                onChange={(event) => setTargetValue(event.target.value)}
              >
                {targetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="small"
              variant="filled"
              disabled={!source || !target}
              onClick={() => {
                if (!source || !target) return;
                onConnect({
                  source: source.nodeId,
                  sourceHandle: source.portId,
                  target: target.nodeId,
                  targetHandle: target.portId,
                });
              }}
            >
              Connect nodes
            </Button>
          </fieldset>
          <div className="my-3 h-px bg-separator" />
          <h3 className="text-small-strong font-medium">Connections</h3>
          {document.edges.length === 0 ? (
            <p className="mt-2 text-small text-secondary">No connections yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1" aria-label="Workflow connections">
              {document.edges.map((edge, index) => {
                const sourceNode = document.nodes.find((node) => node.id === edge.source);
                const targetNode = document.nodes.find((node) => node.id === edge.target);
                const label = `${sourceNode ? workflowNodeLabel(sourceNode) : edge.source} · ${edge.sourcePort} → ${targetNode ? workflowNodeLabel(targetNode) : edge.target} · ${edge.targetPort}`;
                return (
                  <li key={edge.id} className="flex items-center gap-2 rounded-control bg-well p-2">
                    <span className="min-w-0 flex-1 truncate text-mini text-secondary">
                      {label}
                    </span>
                    <Button
                      iconOnly
                      size="small"
                      variant="transparent"
                      aria-label={`Disconnect ${label}`}
                      data-disconnect-edge={edge.id}
                      onClick={() => {
                        onDisconnect(edge.id);
                        requestAnimationFrame(() => {
                          const surface = surfaceRef.current;
                          const buttons = surface?.querySelectorAll<HTMLButtonElement>(
                            "button[data-disconnect-edge]",
                          );
                          const successor =
                            buttons?.[Math.min(index, Math.max(0, buttons.length - 1))];
                          if (successor) successor.focus();
                          else surface?.querySelector<HTMLSelectElement>("select")?.focus();
                        });
                      }}
                    >
                      <X />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <>
          <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Workflow nodes">
            {nodes.map((node) => {
              const definition = CREATE_IMAGES_NODE_DEFINITIONS[node.data.workflowNode.type];
              const Icon = NODE_ICONS[node.data.workflowNode.type];
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    data-workflow-node-id={node.id}
                    aria-pressed={node.selected}
                    className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-small outline-none hover:bg-list-hover focus-visible:bg-list-selection aria-pressed:bg-list-selection"
                    onClick={() => onSelect(node.id)}
                  >
                    <Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {node.data.workflowNode.title || definition.title}
                      </span>
                      <span className="block truncate text-mini text-tertiary">{node.id}</span>
                    </span>
                    <ChevronRight className="size-3.5 text-quaternary" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-separator p-2">
            <Button
              className="w-full justify-center"
              size="small"
              variant="transparent"
              onClick={() => setConnectionToolsOpen(true)}
            >
              Manage connections
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}

function RecentImagePreview({
  item,
  preview,
  onMount,
  onLoad,
  onError,
  className,
  style,
}: {
  item: CreateImagesRecentOutputView;
  preview?: CreateImagesAssetGrantView;
  onMount?(assetId: string): () => void;
  onLoad?(assetId: string, token: string): void;
  onError?(assetId: string, token: string): void;
  className: string;
  style?: React.CSSProperties;
}) {
  React.useEffect(
    () => (onMount ?? EMPTY_ASSET_PREVIEW_RETAINER)(item.assetId),
    [item.assetId, onMount],
  );
  return preview ? (
    <img
      className={className}
      style={style}
      src={createImagesAdaptiveAssetGrantUrl(preview.token, 128)}
      alt=""
      draggable={false}
      onLoad={() => onLoad?.(item.assetId, preview.token)}
      onError={() => onError?.(item.assetId, preview.token)}
    />
  ) : (
    <span className={`${className} grid place-items-center bg-well text-quaternary`} style={style}>
      <ImageIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

function RecentImagesShelf({
  items,
  previews,
  onPreviewMount,
  onPreviewLoad,
  onPreviewError,
  onInspect,
}: {
  items: readonly CreateImagesRecentOutputView[];
  previews: Readonly<Record<string, CreateImagesAssetGrantView>>;
  onPreviewMount?(assetId: string): () => void;
  onPreviewLoad?(assetId: string, token: string): void;
  onPreviewError?(assetId: string, token: string): void;
  onInspect(item: CreateImagesRecentOutputView, trigger: HTMLButtonElement): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [cutoff, setCutoff] = React.useState(() =>
    readCreateImagesRecentOutputCutoff(window.localStorage),
  );
  const visibleItems = visibleCreateImagesRecentOutputs(items, cutoff);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  if (items.length === 0) return null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="create-images-recent-trigger group flex items-center gap-2 rounded-pill border border-field bg-popover/92 px-2 py-1.5 text-left shadow-popover outline-none backdrop-blur-xl hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-label={`Open ${visibleItems.length} recent generated image${visibleItems.length === 1 ? "" : "s"}`}
        >
          <span className="relative h-8 w-12 shrink-0" aria-hidden="true">
            {visibleItems.slice(0, 3).map((item, index) => (
              <RecentImagePreview
                key={`${item.runId}:${item.assetId}`}
                item={item}
                preview={previews[item.assetId]}
                onMount={onPreviewMount}
                onLoad={onPreviewLoad}
                onError={onPreviewError}
                className="absolute left-0 top-0 size-8 rounded-[7px] border border-field object-cover shadow-control"
                style={{ transform: `translateX(${index * 7}px) rotate(${(index - 1) * 3}deg)` }}
              />
            ))}
          </span>
          <span className="pr-1">
            <span className="block text-mini font-medium text-primary">Recent images</span>
            <span className="block text-mini text-tertiary">
              {visibleItems.length > 0 ? `${visibleItems.length} retained` : "History hidden"}
            </span>
          </span>
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-transparent" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          aria-describedby="create-images-recent-description"
          className="create-images-recent-drawer fixed bottom-16 left-4 z-40 flex max-h-[min(36rem,calc(100vh-6rem))] w-[min(38rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-dialog border border-field bg-popover/98 text-primary shadow-dialog outline-none backdrop-blur-xl"
          onCloseAutoFocus={(event) => {
            if (!triggerRef.current?.isConnected) return;
            event.preventDefault();
            triggerRef.current.focus();
          }}
        >
          <header className="flex items-start gap-3 border-b border-separator px-4 py-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-control text-secondary">
              <History className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-small-strong font-medium">
                Recent images
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                id="create-images-recent-description"
                className="mt-0.5 text-mini text-secondary"
              >
                Retained outputs from this device. Drag one onto the canvas to reuse it.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button iconOnly size="small" variant="transparent" aria-label="Close recent images">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="flex items-center justify-end gap-1 border-b border-separator px-3 py-2">
            {cutoff !== undefined ? (
              <Button
                size="small"
                variant="transparent"
                onClick={() => {
                  setCutoff(undefined);
                  writeCreateImagesRecentOutputCutoff(window.localStorage, undefined);
                }}
              >
                <Undo2 /> Restore hidden history
              </Button>
            ) : (
              <Button
                size="small"
                variant="transparent"
                disabled={visibleItems.length === 0}
                onClick={() => {
                  const next = Date.now();
                  setCutoff(next);
                  writeCreateImagesRecentOutputCutoff(window.localStorage, next);
                }}
              >
                <Trash2 /> Clear presentation
              </Button>
            )}
          </div>
          <div className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto p-3 sm:grid-cols-3 md:grid-cols-4">
            {visibleItems.map((item) => {
              const payload = serializeCreateImagesRecentOutputDrag(
                createCreateImagesRecentOutputDrag(item),
              );
              return (
                <button
                  key={`${item.runId}:${item.nodeId}:${item.assetId}`}
                  type="button"
                  draggable={Boolean(payload)}
                  className="group/recent min-w-0 rounded-card border border-field bg-card p-1.5 text-left outline-none hover:border-field-strong hover:shadow-control focus-visible:ring-2 focus-visible:ring-focus-ring"
                  aria-label={`Inspect recent image${item.prompt ? `: ${item.prompt}` : ""}`}
                  title="Open image inspector · drag to reuse"
                  onDragStart={(event) => {
                    if (!payload) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(CREATE_IMAGES_RECENT_OUTPUT_DRAG_MIME, payload);
                  }}
                  onClick={(event) => onInspect(item, event.currentTarget)}
                >
                  <RecentImagePreview
                    item={item}
                    preview={previews[item.assetId]}
                    onMount={onPreviewMount}
                    onLoad={onPreviewLoad}
                    onError={onPreviewError}
                    className="aspect-square w-full rounded-[8px] object-cover"
                  />
                  <span className="mt-1.5 block truncate px-0.5 text-mini font-medium text-primary">
                    {item.prompt || "Generated image"}
                  </span>
                  <span className="block truncate px-0.5 pb-0.5 text-mini text-tertiary">
                    {item.modelLabel} · {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </button>
              );
            })}
            {visibleItems.length === 0 ? (
              <p className="col-span-full px-3 py-8 text-center text-small text-secondary">
                Recent history is hidden on this device. Restore it above; no run or image was
                deleted.
              </p>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function WorkflowCanvas({
  document,
  onBack,
  onCanvasReady,
  onDocumentChange,
  onChooseImage,
  onImportDroppedImages,
  onAssetPreviewLoad,
  onAssetPreviewError,
  onAssetPreviewMount,
  onAssetPreviewStatus,
  assetPreviews = EMPTY_ASSET_PREVIEWS,
  missingAssetIds = EMPTY_MISSING_ASSET_IDS,
  runProjection,
  runHistory = EMPTY_RUN_HISTORY,
  runRecoveries = EMPTY_RUN_RECOVERIES,
  selectedHistoryRunId,
  runHistoryDetail = EMPTY_RUN_HISTORY_DETAIL,
  recoveringRunId,
  acknowledgingRunId,
  degradedRunDiscardBusy,
  runBusy = false,
  runAssetPreviews = EMPTY_ASSET_PREVIEWS,
  statusLabel = "Fixture",
  autosaveEnabled = true,
  saveState = "saved",
  onSaveWorkflow,
  onRunRequest,
  onStopRun,
  onResumeRun,
  onRunErrorAction,
  onSelectHistoryRun,
  onRecoverRun,
  onDiscardDegradedRun,
  onAcknowledgeRunAmbiguity,
  onManageRunHistory,
  runHistoryManagementBusy = false,
  onRunAssetPreviewLoad,
  onRunAssetPreviewError,
  onRunAssetPreviewMount,
  recentOutputs = EMPTY_RECENT_OUTPUTS,
  recentOutputPreviews = EMPTY_ASSET_PREVIEWS,
  onRecentOutputPreviewMount,
  onRecentOutputPreviewLoad,
  onRecentOutputPreviewError,
  onDownloadWorkflowAsset,
  onDownloadRunAsset,
  onDownloadRunAssetsZip,
  providerStatus = EMPTY_PROVIDER_STATUS,
  executionMode = "local-mock",
  onExecutionModeChange,
  onOpenProviderSettings = NOOP_OPEN_PROVIDER_SETTINGS,
}: {
  document: WorkflowDocumentV1;
  onBack(): void;
  onCanvasReady?(instance: ReactFlowInstance<CreateImagesCanvasNode, Edge>): void;
  onDocumentChange?(document: WorkflowDocumentV1): void;
  onChooseImage?(nodeId: string): Promise<{ assetId: string; label?: string } | undefined>;
  onImportDroppedImages?: CreateImagesDroppedImageImporter;
  onAssetPreviewLoad?(assetId: string, token: string): void;
  onAssetPreviewError?(assetId: string, token: string): void;
  onAssetPreviewMount?(assetId: string): () => void;
  onAssetPreviewStatus?(assetId: string): AssetPreviewLifecycleStatus | undefined;
  assetPreviews?: Readonly<Record<string, CreateImagesAssetGrantView>>;
  missingAssetIds?: readonly string[];
  runProjection?: CreateImagesRunUiProjection;
  runHistory?: readonly CreateImagesTerminalRunHistoryItem[];
  runRecoveries?: readonly CreateImagesRunRecoveryView[];
  selectedHistoryRunId?: string;
  runHistoryDetail?: CreateImagesRunHistoryDetailState;
  recoveringRunId?: string;
  acknowledgingRunId?: string;
  degradedRunDiscardBusy?: boolean;
  runBusy?: boolean;
  runAssetPreviews?: Readonly<Record<string, CreateImagesAssetGrantView>>;
  statusLabel?: string;
  autosaveEnabled?: boolean;
  saveState?: "saved" | "dirty" | "saving" | "conflict" | "error";
  onSaveWorkflow?(): void;
  onRunRequest?(
    scope: WorkflowRunScope,
    document: WorkflowDocumentV1,
    trigger: HTMLButtonElement,
  ): void;
  onStopRun?(trigger: HTMLButtonElement): void;
  onResumeRun?(trigger: HTMLButtonElement): void;
  onRunErrorAction?(action: CreateImagesRunErrorAction): void;
  onSelectHistoryRun?(runId: string, trigger: HTMLButtonElement): void;
  onRecoverRun?(recovery: CreateImagesRunRecoveryView, trigger: HTMLButtonElement): void;
  onDiscardDegradedRun?(runId: string, trigger: HTMLButtonElement): void;
  onAcknowledgeRunAmbiguity?(run: CreateImagesRunView, trigger: HTMLButtonElement): void;
  onManageRunHistory?(trigger: HTMLButtonElement): void;
  runHistoryManagementBusy?: boolean;
  onRunAssetPreviewLoad?(assetId: string, token: string): void;
  onRunAssetPreviewError?(assetId: string, token: string): void;
  onRunAssetPreviewMount?(assetId: string): () => void;
  recentOutputs?: readonly CreateImagesRecentOutputView[];
  recentOutputPreviews?: Readonly<Record<string, CreateImagesAssetGrantView>>;
  onRecentOutputPreviewMount?(assetId: string): () => void;
  onRecentOutputPreviewLoad?(assetId: string, token: string): void;
  onRecentOutputPreviewError?(assetId: string, token: string): void;
  onDownloadWorkflowAsset?(assetId: string): void;
  onDownloadRunAsset?(runId: string, assetId: string): void;
  onDownloadRunAssetsZip?(runId: string, assetIds: readonly string[]): void;
  providerStatus?: CreateImagesProviderStatus;
  executionMode?: CreateImagesExecutionMode;
  onExecutionModeChange?(mode: CreateImagesExecutionMode): void;
  onOpenProviderSettings?(): void;
}) {
  const split = useSplitViewState();
  const workbenchRef = React.useRef<HTMLElement | null>(null);
  const narrowCanvas = useNarrowCreateImagesCanvas(workbenchRef);
  const appearanceScheme = useAidenAppearanceScheme();
  const [history, setHistory] = React.useState<EditorHistory<CanvasSnapshot>>(() =>
    createEditorHistory(toCanvasSnapshot(document)),
  );
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [powerFeatures, setPowerFeatures] = React.useState(() =>
    readCreateImagesPowerFeatures(window.localStorage),
  );
  const [navigationPreferences, setNavigationPreferences] = React.useState(() =>
    readCreateImagesCanvasNavigationPreferences(window.localStorage),
  );
  const navigationProps = createImagesCanvasNavigationProps(navigationPreferences);
  const [paletteSearch, setPaletteSearch] = React.useState("");
  const [palettePlacement, setPalettePlacement] = React.useState<{
    flow: { x: number; y: number };
    screen?: { x: number; y: number };
  }>();
  const [paletteConnection, setPaletteConnection] =
    React.useState<CreateImagesDanglingConnectionOrigin>();
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [proposalOpen, setProposalOpen] = React.useState(false);
  const [proposalRequest, setProposalRequest] = React.useState("");
  const [proposalBusy, setProposalBusy] = React.useState(false);
  const [workflowProposal, setWorkflowProposal] = React.useState<CreateImagesWorkflowProposal>();
  const [hiddenRunAssetIds, setHiddenRunAssetIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [miniMapVisible, setMiniMapVisible] = React.useState(true);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [dropState, setDropState] = React.useState<CreateImagesDropState>(
    INITIAL_CREATE_IMAGES_DROP_STATE,
  );
  const [dropImportPending, setDropImportPending] = React.useState(false);
  const [inspectedAsset, setInspectedAsset] = React.useState<CreateImagesInspectedAsset>();
  const imageInspectorReturnFocusRef = React.useRef<HTMLButtonElement | null>(null);
  const [runPanelChoice, setRunPanelChoice] = React.useState<{
    runId?: string;
    surface?: "details" | "history";
  }>({});
  const [pendingImageNodeId, setPendingImageNodeId] = React.useState<string>();
  const [viewport, setViewport] = React.useState(document.viewport);
  const [canvasEditInProgress, setCanvasEditInProgress] = React.useState(false);

  React.useEffect(() => {
    let current = true;
    setHiddenRunAssetIds(new Set());
    void createImagesApi.getPresentation({ workflowId: document.id }).then((result) => {
      if (current && result.status === "ready") {
        setHiddenRunAssetIds(new Set(result.hiddenAssetIds));
      }
    });
    return () => {
      current = false;
    };
  }, [document.id]);
  const [announcement, announce] = React.useReducer(
    (current: { text: string; sequence: number }, text: string) => ({
      text,
      sequence: current.sequence + 1,
    }),
    { text: "Canvas ready.", sequence: 0 },
  );
  const instanceRef = React.useRef<ReactFlowInstance<CreateImagesCanvasNode, Edge> | null>(null);
  const dragStartSnapshot = React.useRef<CanvasSnapshot | null>(null);
  const cascadeDeleteStartSnapshot = React.useRef<CanvasSnapshot | null>(null);
  const nodeEditStartSnapshot = React.useRef<{
    nodeId: string;
    snapshot: CanvasSnapshot;
    deferPublication: boolean;
  } | null>(null);
  const rejectedConnectionMessage = React.useRef<string | null>(null);
  const dropImportPendingRef = React.useRef(false);
  const dropImportRequestRef = React.useRef(0);
  const pasteImportPendingRef = React.useRef(false);
  const paletteTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const paletteReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const shortcutsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const shortcutsReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const proposalTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const inspectorTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const issuesTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const inspectorSurfaceRef = React.useRef<HTMLElement | null>(null);
  const idSequence = React.useRef(0);
  const snapshot = history.present;
  const selectedNodes = snapshot.nodes.filter((node) => node.selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  const unreadCommentNodes = snapshot.nodes.filter(
    (node) => node.data.workflowNode.comment?.unread === true,
  );
  const currentDocument = React.useMemo(
    () => ({
      ...toWorkflowDocument(snapshot, document),
      ...(viewport ? { viewport } : {}),
    }),
    [document, snapshot, viewport],
  );
  React.useEffect(() => {
    if (!canvasEditInProgress) onDocumentChange?.(currentDocument);
  }, [canvasEditInProgress, currentDocument, onDocumentChange]);
  const graphIssues = React.useMemo(
    () => validateWorkflowGraph(currentDocument, { forRun: true }),
    [currentDocument],
  );
  const graphIssueSignature = graphIssues
    .map((issue) => [issue.code, issue.nodeId, issue.edgeId, issue.portId].join(":"))
    .join("|");
  const selectedNodeLabel = selectedNode
    ? CREATE_IMAGES_NODE_DEFINITIONS[selectedNode.data.workflowNode.type].title
    : undefined;
  const runFromHereScope: WorkflowRunScope | undefined = selectedNode
    ? { kind: "from-node", nodeId: selectedNode.id }
    : undefined;
  const ambiguityBlocksNewRun =
    runProjection?.status === "retry" &&
    !runProjection.ambiguityAcknowledged &&
    Object.values(runProjection.nodes).some(
      (node) => node.status === "retry" && node.retryMode === "manual-review",
    );
  const providerIssueForScope = React.useCallback(
    (scope: WorkflowRunScope): string | undefined => {
      if (executionMode !== "gemini") return undefined;
      try {
        const plan = planWorkflowExecution(currentDocument, scope);
        const included = new Set(plan.orderedNodeIds);
        for (const node of plan.snapshot.nodes) {
          if (node.type !== "generate-image" || !included.has(node.id)) continue;
          const binding = evaluateCreateImagesProviderBinding(node, providerStatus);
          if (binding.status === "blocked") {
            return `${CREATE_IMAGES_NODE_DEFINITIONS[node.type].title} · ${node.id}: ${createImagesBindingIssueLabel(binding.issue)}`;
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    [currentDocument, executionMode, providerStatus],
  );
  const runAllProviderIssue = providerIssueForScope({ kind: "all" });
  const runAllDisabledReason = !onRunRequest
    ? "Workflow execution is unavailable"
    : runBusy
      ? "A run request is already being reviewed"
      : ambiguityBlocksNewRun
        ? "Resolve the ambiguous run record before starting another run"
        : snapshot.nodes.length === 0
          ? "Add at least one node before running"
          : (graphIssues[0]?.message ?? runAllProviderIssue);
  let runFromHereDisabledReason: string | undefined;
  if (runFromHereScope) {
    if (!onRunRequest) runFromHereDisabledReason = "Workflow execution is unavailable";
    else if (runBusy) runFromHereDisabledReason = "A run request is already being reviewed";
    else if (ambiguityBlocksNewRun) {
      runFromHereDisabledReason = "Resolve the ambiguous run record before starting another run";
    } else {
      try {
        planWorkflowExecution(currentDocument, runFromHereScope);
        runFromHereDisabledReason = providerIssueForScope(runFromHereScope);
      } catch (error) {
        runFromHereDisabledReason =
          error instanceof WorkflowPlanError
            ? error.issues[0]?.message
            : "This selected scope cannot run";
      }
    }
  }
  const currentRunId = runProjection?.runId;
  const runSurface =
    currentRunId && runPanelChoice.runId !== currentRunId ? "details" : runPanelChoice.surface;

  const toggleRunHistory = React.useCallback(() => {
    setInspectorOpen(false);
    setRunPanelChoice((current) => {
      const effective =
        runProjection?.runId && current.runId !== runProjection.runId ? "details" : current.surface;
      return {
        ...(runProjection?.runId ? { runId: runProjection.runId } : {}),
        surface: effective === "history" ? (runProjection ? "details" : undefined) : "history",
      };
    });
  }, [runProjection]);

  const commitSnapshot = React.useCallback(
    (update: (current: CanvasSnapshot) => CanvasSnapshot) => {
      setHistory((current) => commitEditorHistory(current, update(current.present)));
    },
    [],
  );

  const requestWorkflowProposal = React.useCallback(async () => {
    if (proposalBusy) return;
    const request = proposalRequest.trim();
    if (!request) {
      toast.error("Describe the workflow you want Aiden to propose.");
      return;
    }
    const selection = readModelSelection();
    if (!selection.providerId || !selection.model) {
      toast.error("Choose a connected chat model before requesting a workflow proposal.");
      return;
    }
    setProposalBusy(true);
    setWorkflowProposal(undefined);
    try {
      const result = await createImagesApi.proposeWorkflow({
        workflowId: currentDocument.id,
        expectedRevision: currentDocument.revision,
        workflow: currentDocument,
        providerId: selection.providerId,
        model: selection.model,
        request,
      });
      if (result.status === "conflict") {
        toast.error(
          "The workflow changed while the proposal was being prepared. Review the latest version and try again.",
        );
        return;
      }
      if (result.status !== "ready") {
        toast.error(result.message);
        return;
      }
      setWorkflowProposal(result.proposal);
      announce(
        `Workflow proposal ready from ${result.model}. Review the complete graph diff before applying.`,
      );
    } catch {
      toast.error("Aiden could not prepare the workflow proposal.");
    } finally {
      setProposalBusy(false);
    }
  }, [announce, currentDocument, proposalBusy, proposalRequest]);

  const applyWorkflowProposal = React.useCallback(() => {
    if (!workflowProposal) return;
    if (workflowProposal.workflow.revision !== currentDocument.revision + 1) {
      toast.error(
        "The proposal no longer matches this workflow revision. Request a fresh proposal.",
      );
      setWorkflowProposal(undefined);
      return;
    }
    commitSnapshot(() => toCanvasSnapshot(workflowProposal.workflow));
    setProposalOpen(false);
    setWorkflowProposal(undefined);
    setProposalRequest("");
    announce("Workflow proposal applied as one undoable edit. It has not been run.");
    requestAnimationFrame(() => {
      void instanceRef.current?.fitView({
        duration: createImagesMotionDuration(300),
        padding: 0.2,
      });
      proposalTriggerRef.current?.focus();
    });
  }, [announce, commitSnapshot, currentDocument.revision, workflowProposal]);

  const updatePresent = React.useCallback((update: (current: CanvasSnapshot) => CanvasSnapshot) => {
    setHistory((current) => ({
      ...current,
      present: update(current.present),
    }));
  }, []);

  const selectNode = React.useCallback(
    (nodeId: string) => {
      setRunPanelChoice({ ...(currentRunId ? { runId: currentRunId } : {}) });
      setInspectorOpen(true);
      updatePresent((current) => ({
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          selected: node.id === nodeId,
        })),
        edges: current.edges.map((edge) => ({ ...edge, selected: false })),
      }));
      requestAnimationFrame(() =>
        instanceRef.current?.fitView({
          nodes: [{ id: nodeId }],
          duration: createImagesMotionDuration(250),
          padding: 0.8,
        }),
      );
    },
    [currentRunId, updatePresent],
  );

  const activateValidationIssue = React.useCallback(
    async (issue: WorkflowGraphIssue) => {
      const relatedEdge = issue.edgeId
        ? currentDocument.edges.find((edge) => edge.id === issue.edgeId)
        : undefined;
      const fitNodeIds = issue.nodeId
        ? [issue.nodeId]
        : relatedEdge
          ? [relatedEdge.source, relatedEdge.target]
          : [];

      if (issue.nodeId) setInspectorOpen(true);
      updatePresent((current) => ({
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          selected: Boolean(issue.nodeId) && node.id === issue.nodeId,
        })),
        edges: current.edges.map((edge) => ({
          ...edge,
          selected: Boolean(issue.edgeId) && edge.id === issue.edgeId,
        })),
      }));

      const instance = instanceRef.current;
      if (instance && fitNodeIds.length > 0) {
        await instance.fitView({
          nodes: fitNodeIds.map((id) => ({ id })),
          duration: createImagesMotionDuration(250),
          padding: 0.8,
        });
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const target = issue.nodeId
        ? Array.from(
            workbenchRef.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? [],
          ).find((element) => element.dataset.id === issue.nodeId)
        : Array.from(
            workbenchRef.current?.querySelectorAll<SVGElement>(".react-flow__edge[data-id]") ?? [],
          ).find((element) => element.dataset.id === issue.edgeId);
      const fallbackNodeId = issue.nodeId ?? relatedEdge?.target ?? relatedEdge?.source;
      const inspectorRow = Array.from(
        inspectorSurfaceRef.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-workflow-node-id]",
        ) ?? [],
      ).find((element) => element.dataset.workflowNodeId === fallbackNodeId);

      setIssuesOpen(false);
      requestAnimationFrame(() => {
        (
          target ??
          inspectorRow ??
          inspectorSurfaceRef.current ??
          inspectorTriggerRef.current
        )?.focus();
      });
    },
    [currentDocument.edges, updatePresent],
  );

  const updateNode = React.useCallback(
    (nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1) => {
      commitSnapshot((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  workflowNode: update(node.data.workflowNode),
                } as CreateImagesCanvasNodeData,
              }
            : node,
        ),
      }));
      announce("Node updated.");
    },
    [commitSnapshot],
  );

  const fitImageToMedia = React.useCallback(
    (nodeId: string) => {
      const canvasNode = snapshot.nodes.find((node) => node.id === nodeId);
      const workflowNode = canvasNode?.data.workflowNode;
      if (workflowNode?.type !== "image-input" || !workflowNode.data.assetId) return;
      const asset = assetPreviews[workflowNode.data.assetId]?.asset;
      const dimensions = asset
        ? fitCreateImagesNodeToMediaAspect(workflowNode.dimensions, asset.width, asset.height)
        : undefined;
      if (!dimensions) {
        announce("Image dimensions are not available yet.");
        return;
      }
      updateNode(nodeId, (node) => ({ ...node, dimensions }));
      announce("Fitted node to the image aspect.");
    },
    [announce, assetPreviews, snapshot.nodes, updateNode],
  );

  const beginNodeEdit = React.useCallback(
    (nodeId: string, deferPublication = false) => {
      if (!nodeEditStartSnapshot.current) {
        nodeEditStartSnapshot.current = { nodeId, snapshot, deferPublication };
        if (deferPublication) setCanvasEditInProgress(true);
      }
    },
    [snapshot],
  );

  const updateNodeDraft = React.useCallback(
    (nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1) => {
      if (nodeEditStartSnapshot.current?.nodeId !== nodeId) return;
      updatePresent((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  workflowNode: update(node.data.workflowNode),
                } as CreateImagesCanvasNodeData,
              }
            : node,
        ),
      }));
    },
    [updatePresent],
  );

  const commitNodeEdit = React.useCallback((nodeId: string) => {
    const editStart = nodeEditStartSnapshot.current;
    nodeEditStartSnapshot.current = null;
    if (editStart?.deferPublication) setCanvasEditInProgress(false);
    if (!editStart || editStart.nodeId !== nodeId) return;
    setHistory((current) => {
      const before = editStart.snapshot.nodes.find((node) => node.id === nodeId)?.data.workflowNode;
      const after = current.present.nodes.find((node) => node.id === nodeId)?.data.workflowNode;
      if (JSON.stringify(before) === JSON.stringify(after)) return current;
      return {
        past: [...current.past, editStart.snapshot].slice(-50),
        present: current.present,
        future: [],
      };
    });
    announce("Node updated.");
  }, []);

  const chooseImage = React.useCallback(
    async (nodeId: string) => {
      if (!onChooseImage || pendingImageNodeId) return;
      setPendingImageNodeId(nodeId);
      try {
        const result = await onChooseImage(nodeId);
        if (!result) return;
        updateNode(nodeId, (node) =>
          node.type === "image-input"
            ? {
                ...node,
                data: {
                  assetId: result.assetId,
                  ...(result.label ? { label: result.label } : {}),
                },
              }
            : node,
        );
      } catch {
        announce("Image import failed.");
        toast.error("The selected image could not be imported.");
      } finally {
        setPendingImageNodeId(undefined);
      }
    },
    [onChooseImage, pendingImageNodeId, updateNode],
  );

  const removeImage = React.useCallback(
    (nodeId: string) =>
      updateNode(nodeId, (node) => (node.type === "image-input" ? { ...node, data: {} } : node)),
    [updateNode],
  );
  const removePromptVariable = React.useCallback(
    (nodeId: string, variableId: string) => {
      commitSnapshot((current) => ({
        nodes: current.nodes.map((canvasNode) => {
          const node = canvasNode.data.workflowNode;
          if (node.id !== nodeId || node.type !== "prompt") return canvasNode;
          return {
            ...canvasNode,
            data: {
              workflowNode: {
                ...node,
                data: {
                  ...node.data,
                  variables: (node.data.variables ?? []).filter(
                    (variable) => variable.id !== variableId,
                  ),
                },
              },
            },
          };
        }),
        edges: current.edges.filter(
          (edge) => !(edge.target === nodeId && edge.targetHandle === `variable-${variableId}`),
        ),
      }));
      announce("Removed the prompt variable and its connection.");
    },
    [announce, commitSnapshot],
  );

  const onNodesChange = React.useCallback(
    (changes: NodeChange<CreateImagesCanvasNode>[]) => {
      const removes = new Set<string>();
      for (const change of changes) {
        if (change.type === "remove") removes.add(change.id);
      }
      const apply = (current: CanvasSnapshot): CanvasSnapshot => {
        const lockedMemberIds = new Set(
          current.nodes.flatMap((candidate) => {
            const node = candidate.data.workflowNode;
            return node.type === "group" && node.data.locked ? node.data.memberNodeIds : [];
          }),
        );
        const allowedChanges = changes.filter(
          (change) => change.type !== "position" || !lockedMemberIds.has(change.id),
        );
        const nodes = applyNodeChanges(allowedChanges, current.nodes)
          .map((node) => ({ ...node, position: boundedCanvasPosition(node.position) }))
          .map((canvasNode) => {
            const node = canvasNode.data.workflowNode;
            if (node.type !== "group") return canvasNode;
            return {
              ...canvasNode,
              data: {
                workflowNode: {
                  ...node,
                  data: {
                    ...node.data,
                    memberNodeIds: node.data.memberNodeIds.filter((id) => !removes.has(id)),
                  },
                },
              },
            };
          });
        return {
          nodes,
          edges:
            removes.size > 0
              ? current.edges.filter(
                  (edge) => !removes.has(edge.source) && !removes.has(edge.target),
                )
              : current.edges,
        };
      };
      if (removes.size > 0) {
        if (cascadeDeleteStartSnapshot.current) updatePresent(apply);
        else commitSnapshot(apply);
        announce(`${removes.size} node${removes.size === 1 ? "" : "s"} deleted.`);
      } else if (
        changes.some((change) => change.type === "position") &&
        dragStartSnapshot.current === null
      ) {
        commitSnapshot(apply);
        announce("Node moved.");
      } else {
        updatePresent(apply);
      }
    },
    [commitSnapshot, updatePresent],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const apply = (current: CanvasSnapshot): CanvasSnapshot => ({
        ...current,
        edges: applyEdgeChanges(changes, current.edges),
      });
      const removedIds = new Set(
        changes.filter((change) => change.type === "remove").map((change) => change.id),
      );
      if (removedIds.size === 0) {
        updatePresent(apply);
        return;
      }
      if (cascadeDeleteStartSnapshot.current) updatePresent(apply);
      else commitSnapshot(apply);
    },
    [commitSnapshot, updatePresent],
  );

  const connectionDecision = React.useCallback(
    (connection: Connection | Edge, edgeId: string) =>
      decideCanvasConnection(
        currentDocument,
        {
          source: connection.source,
          sourcePort: connection.sourceHandle ?? null,
          target: connection.target,
          targetPort: connection.targetHandle ?? null,
        },
        edgeId,
      ),
    [currentDocument],
  );

  const onConnect = React.useCallback(
    (connection: Connection) => {
      idSequence.current += 1;
      const decision = connectionDecision(connection, `edge-canvas-${idSequence.current}`);
      if (!decision.allowed) {
        announce(decision.message);
        toast.info(decision.message);
        return;
      }
      commitSnapshot((current) => ({
        ...current,
        edges: [
          ...current.edges,
          {
            id: decision.edge.id,
            source: decision.edge.source,
            sourceHandle: decision.edge.sourcePort,
            target: decision.edge.target,
            targetHandle: decision.edge.targetPort,
            type: "smoothstep",
            className: "create-images-edge",
          },
        ],
      }));
      announce("Nodes connected.");
    },
    [commitSnapshot, connectionDecision],
  );

  const disconnectEdge = React.useCallback(
    (edgeId: string) => {
      commitSnapshot((current) => ({
        ...current,
        edges: current.edges.filter((edge) => edge.id !== edgeId),
      }));
      announce("Nodes disconnected.");
    },
    [commitSnapshot],
  );

  const canvasPositionForScreenPoint = React.useCallback(
    (screenPoint?: { x: number; y: number }) => {
      const bounds = instanceRef.current?.getViewport();
      const currentZoom = bounds?.zoom ?? 1;
      const workbenchBounds = workbenchRef.current?.getBoundingClientRect();
      const point = screenPoint ?? {
        x: workbenchBounds
          ? workbenchBounds.left + workbenchBounds.width / 2
          : window.innerWidth / 2,
        y: workbenchBounds
          ? workbenchBounds.top + workbenchBounds.height / 2
          : window.innerHeight / 2,
      };
      return boundedCanvasPosition(
        instanceRef.current
          ? instanceRef.current.screenToFlowPosition({
              x: point.x - (CREATE_IMAGES_NODE_WIDTH * currentZoom) / 2,
              y: point.y - (CREATE_IMAGES_NODE_ESTIMATED_HEIGHT * currentZoom) / 2,
            })
          : { x: -(bounds?.x ?? 0) + 240, y: -(bounds?.y ?? 0) + 180 },
      );
    },
    [],
  );

  const openNodePalette = React.useCallback(
    (input?: {
      screen?: { x: number; y: number };
      connection?: CreateImagesDanglingConnectionOrigin;
      returnFocus?: HTMLElement | null;
    }) => {
      paletteReturnFocusRef.current = input?.returnFocus ?? paletteTriggerRef.current;
      setPalettePlacement(
        input?.screen
          ? { flow: canvasPositionForScreenPoint(input.screen), screen: input.screen }
          : undefined,
      );
      setPaletteConnection(input?.connection);
      setPaletteSearch("");
      setPaletteOpen(true);
    },
    [canvasPositionForScreenPoint],
  );

  const addNode = React.useCallback(
    (
      type: CreateImagesNodeType,
      options: {
        position?: { x: number; y: number };
        compatiblePortId?: string;
        connectionOrigin?: CreateImagesDanglingConnectionOrigin | null;
        promptText?: string;
        image?: { assetId: string; label: string };
      } = {},
    ) => {
      const connectionOrigin =
        options.connectionOrigin === null
          ? undefined
          : (options.connectionOrigin ?? paletteConnection);
      const createsConnection = Boolean(connectionOrigin && options.compatiblePortId);
      const capacity = decideCanvasMutationCapacity(
        snapshot.nodes.length,
        snapshot.edges.length,
        1,
        createsConnection ? 1 : 0,
      );
      if (!capacity.allowed) {
        announce(capacity.message!);
        toast.info(capacity.message!);
        return;
      }
      idSequence.current += 1;
      const id = `${type}-${Date.now()}-${idSequence.current}`;
      const boundedPosition = boundedCanvasPosition(
        options.position ?? palettePlacement?.flow ?? canvasPositionForScreenPoint(),
      );
      let workflowNode = newWorkflowNode(type, id, boundedPosition);
      if (workflowNode.type === "prompt" && options.promptText !== undefined) {
        workflowNode = {
          ...workflowNode,
          data: { text: boundedPromptText(options.promptText) },
        };
      }
      if (workflowNode.type === "image-input" && options.image) {
        workflowNode = {
          ...workflowNode,
          data: { assetId: options.image.assetId, label: options.image.label },
        };
      }
      let createdEdge: Edge | undefined;
      if (connectionOrigin && options.compatiblePortId) {
        idSequence.current += 1;
        const intent =
          connectionOrigin.direction === "source"
            ? {
                source: connectionOrigin.nodeId,
                sourcePort: connectionOrigin.portId,
                target: id,
                targetPort: options.compatiblePortId,
              }
            : {
                source: id,
                sourcePort: options.compatiblePortId,
                target: connectionOrigin.nodeId,
                targetPort: connectionOrigin.portId,
              };
        const decision = decideCanvasConnection(
          { ...currentDocument, nodes: [...currentDocument.nodes, workflowNode] },
          intent,
          `edge-created-${Date.now()}-${idSequence.current}`,
        );
        if (!decision.allowed) {
          announce(decision.message);
          toast.info(decision.message);
          return;
        }
        createdEdge = {
          id: decision.edge.id,
          source: decision.edge.source,
          sourceHandle: decision.edge.sourcePort,
          target: decision.edge.target,
          targetHandle: decision.edge.targetPort,
          type: "smoothstep",
          className: "create-images-edge",
        };
      }
      commitSnapshot((current) => ({
        ...current,
        edges: [
          ...current.edges.map((edge) => ({ ...edge, selected: false })),
          ...(createdEdge ? [createdEdge] : []),
        ],
        nodes: [
          ...current.nodes.map((node) => ({ ...node, selected: false })),
          {
            id,
            type,
            position: boundedPosition,
            selected: true,
            data: { workflowNode },
            ariaLabel: workflowNodeLabel(workflowNode),
          },
        ],
      }));
      setPaletteOpen(false);
      setPaletteSearch("");
      setPalettePlacement(undefined);
      setPaletteConnection(undefined);
      setInspectorOpen(!narrowCanvas);
      announce(
        createdEdge
          ? `${CREATE_IMAGES_NODE_DEFINITIONS[type].title} added and connected.`
          : `${CREATE_IMAGES_NODE_DEFINITIONS[type].title} added.`,
      );
      requestAnimationFrame(() => {
        const nodeElement = Array.from(
          workbenchRef.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? [],
        ).find((element) => element.dataset.id === id);
        nodeElement?.focus();
        if (!options.position && !palettePlacement) {
          void instanceRef.current?.fitView({
            nodes: [{ id }],
            duration: createImagesMotionDuration(250),
            padding: 0.2,
            maxZoom: 1,
          });
        }
      });
    },
    [
      canvasPositionForScreenPoint,
      commitSnapshot,
      currentDocument,
      narrowCanvas,
      paletteConnection,
      palettePlacement,
      snapshot.edges.length,
      snapshot.nodes.length,
    ],
  );

  const deleteSelected = React.useCallback(() => {
    const selected = new Set<string>();
    for (const node of snapshot.nodes) {
      if (node.selected) selected.add(node.id);
    }
    if (selected.size === 0) return;
    commitSnapshot((current) => ({
      nodes: current.nodes
        .filter((node) => !selected.has(node.id))
        .map((canvasNode) => {
          const node = canvasNode.data.workflowNode;
          if (node.type !== "group") return canvasNode;
          return {
            ...canvasNode,
            data: {
              workflowNode: {
                ...node,
                data: {
                  ...node.data,
                  memberNodeIds: node.data.memberNodeIds.filter((id) => !selected.has(id)),
                },
              },
            },
          };
        }),
      edges: current.edges.filter(
        (edge) => !selected.has(edge.source) && !selected.has(edge.target),
      ),
    }));
    announce(`${selected.size} node${selected.size === 1 ? "" : "s"} deleted.`);
  }, [commitSnapshot, snapshot.nodes]);

  const duplicateSelected = React.useCallback(() => {
    const selected = snapshot.nodes.filter((node) => node.selected);
    if (selected.length === 0) return;
    const selectedIds = new Set(selected.map((node) => node.id));
    let copiedEdgeCount = 0;
    for (const edge of snapshot.edges) {
      if (selectedIds.has(edge.source) && selectedIds.has(edge.target)) copiedEdgeCount += 1;
    }
    const capacity = decideCanvasMutationCapacity(
      snapshot.nodes.length,
      snapshot.edges.length,
      selected.length,
      copiedEdgeCount,
    );
    if (!capacity.allowed) {
      announce(capacity.message!);
      toast.info(capacity.message!);
      return;
    }
    const idMap = new Map<string, string>();
    const copies = selected.map((node) => {
      idSequence.current += 1;
      const id = `${node.type}-copy-${Date.now()}-${idSequence.current}`;
      idMap.set(node.id, id);
      const workflowNode = structuredClone(node.data.workflowNode);
      workflowNode.id = id;
      workflowNode.position = boundedCanvasPosition({
        x: node.position.x + 48,
        y: node.position.y + 48,
      });
      return {
        ...node,
        id,
        position: workflowNode.position,
        selected: true,
        data: { workflowNode },
        ariaLabel: workflowNodeLabel(workflowNode),
      } as CreateImagesCanvasNode;
    });
    for (const copy of copies) {
      const workflowNode = copy.data.workflowNode;
      if (workflowNode.type !== "group") continue;
      workflowNode.data.memberNodeIds = workflowNode.data.memberNodeIds.flatMap((memberId) => {
        const mapped = idMap.get(memberId);
        return mapped ? [mapped] : [];
      });
    }
    const copiedEdges = snapshot.edges.flatMap((edge) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return [];
      idSequence.current += 1;
      return [
        {
          ...edge,
          id: `edge-copy-${idSequence.current}`,
          source,
          target,
          selected: false,
        },
      ];
    });
    commitSnapshot((current) => ({
      nodes: [...current.nodes.map((node) => ({ ...node, selected: false })), ...copies],
      edges: [...current.edges.map((edge) => ({ ...edge, selected: false })), ...copiedEdges],
    }));
    announce(`${copies.length} node${copies.length === 1 ? "" : "s"} duplicated.`);
    requestAnimationFrame(() => {
      const firstCopyId = copies[0]?.id;
      if (!firstCopyId) return;
      const duplicate = Array.from(
        window.document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]"),
      ).find((element) => element.dataset.id === firstCopyId);
      duplicate?.focus();
    });
  }, [commitSnapshot, snapshot.edges, snapshot.nodes]);

  const arrangeSelected = React.useCallback(
    (mode: CreateImagesArrangement) => {
      if (selectedNodes.length < 2) return;
      const positions = arrangeCreateImagesSelection(
        selectedNodes.map((node) => ({
          id: node.id,
          position: node.position,
          width: node.measured?.width,
          height: node.measured?.height,
        })),
        mode,
      );
      const byId = new Map(positions.map((item) => [item.id, item.position]));
      commitSnapshot((current) => ({
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          position: byId.get(node.id) ?? node.position,
        })),
      }));
      announce(
        mode === "grid"
          ? "Arranged selected nodes in a grid."
          : `Arranged selected nodes ${mode === "horizontal" ? "horizontally" : "vertically"}.`,
      );
    },
    [commitSnapshot, selectedNodes],
  );

  const groupSelected = React.useCallback(() => {
    const members = selectedNodes.filter((node) => node.data.workflowNode.type !== "group");
    if (members.length < 2) return;
    const capacity = decideCanvasMutationCapacity(
      snapshot.nodes.length,
      snapshot.edges.length,
      1,
      0,
    );
    if (!capacity.allowed) {
      announce(capacity.message!);
      return;
    }
    const left = Math.min(...members.map((node) => node.position.x)) - 36;
    const top = Math.min(...members.map((node) => node.position.y)) - 64;
    const right =
      Math.max(
        ...members.map(
          (node) => node.position.x + (node.measured?.width ?? CREATE_IMAGES_NODE_WIDTH),
        ),
      ) + 36;
    const bottom =
      Math.max(
        ...members.map(
          (node) =>
            node.position.y + (node.measured?.height ?? CREATE_IMAGES_NODE_ESTIMATED_HEIGHT),
        ),
      ) + 36;
    const id = `group-${Date.now()}-${++idSequence.current}`;
    const workflowNode: WorkflowNodeV1 = {
      id,
      type: "group",
      position: boundedCanvasPosition({ x: left, y: top }),
      title: "Group",
      dimensions: {
        width: Math.min(1_200, Math.max(240, right - left)),
        height: Math.min(1_600, Math.max(180, bottom - top)),
      },
      data: {
        memberNodeIds: members.map((node) => node.id),
        color: "blue",
        locked: false,
      },
    };
    commitSnapshot((current) => ({
      ...current,
      nodes: [
        ...current.nodes.map((node) => ({ ...node, selected: false })),
        {
          id,
          type: "group",
          position: workflowNode.position,
          selected: true,
          zIndex: -1,
          style: { width: workflowNode.dimensions!.width, height: workflowNode.dimensions!.height },
          data: { workflowNode },
          ariaLabel: workflowNodeLabel(workflowNode),
        },
      ],
    }));
    announce(`Grouped ${members.length} nodes.`);
  }, [announce, commitSnapshot, selectedNodes, snapshot.edges.length, snapshot.nodes.length]);

  const ungroupSelected = React.useCallback(() => {
    const groupIds = new Set(
      selectedNodes
        .filter((node) => node.data.workflowNode.type === "group")
        .map((node) => node.id),
    );
    if (groupIds.size === 0) return;
    commitSnapshot((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !groupIds.has(node.id)),
    }));
    announce(`Ungrouped ${groupIds.size} group${groupIds.size === 1 ? "" : "s"}.`);
  }, [announce, commitSnapshot, selectedNodes]);

  const setDropStateForDrag = React.useCallback(
    (action: Parameters<typeof reduceCreateImagesDropState>[1]) =>
      setDropState((current) => reduceCreateImagesDropState(current, action)),
    [],
  );

  const handleCanvasDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (
        Array.from(event.dataTransfer.types).some(
          (type) =>
            type === CREATE_IMAGES_NODE_DRAG_MIME || type === CREATE_IMAGES_RECENT_OUTPUT_DRAG_MIME,
        )
      ) {
        event.preventDefault();
        return;
      }
      const valid = hasPotentialCreateImagesFileDrag(event.dataTransfer);
      if (!valid) return;
      event.preventDefault();
      setDropStateForDrag({
        type: "enter",
        valid: true,
        targetNodeId: imageInputNodeIdAtTarget(event.target, snapshot.nodes),
      });
    },
    [setDropStateForDrag, snapshot.nodes],
  );

  const handleCanvasDragOver = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (
        Array.from(event.dataTransfer.types).some(
          (type) =>
            type === CREATE_IMAGES_NODE_DRAG_MIME || type === CREATE_IMAGES_RECENT_OUTPUT_DRAG_MIME,
        )
      ) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        return;
      }
      const valid = hasPotentialCreateImagesFileDrag(event.dataTransfer);
      if (!valid) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropStateForDrag({
        type: "over",
        valid: true,
        targetNodeId: imageInputNodeIdAtTarget(event.target, snapshot.nodes),
      });
    },
    [setDropStateForDrag, snapshot.nodes],
  );

  const handleCanvasDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const relatedTarget = event.relatedTarget;
      const inside = relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget);
      setDropStateForDrag({ type: "leave", inside });
    },
    [setDropStateForDrag],
  );

  const handleCanvasDrop = React.useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDropState(INITIAL_CREATE_IMAGES_DROP_STATE);
      const draggedNodeType = event.dataTransfer.getData(CREATE_IMAGES_NODE_DRAG_MIME);
      if (isCreateImagesNodeType(draggedNodeType)) {
        addNode(draggedNodeType, {
          position: canvasPositionForScreenPoint({ x: event.clientX, y: event.clientY }),
          connectionOrigin: null,
        });
        return;
      }
      const recentOutput = parseCreateImagesRecentOutputDrag(
        event.dataTransfer.getData(CREATE_IMAGES_RECENT_OUTPUT_DRAG_MIME),
      );
      if (recentOutput) {
        addNode("image-input", {
          position: canvasPositionForScreenPoint({ x: event.clientX, y: event.clientY }),
          connectionOrigin: null,
          image: { assetId: recentOutput.assetId, label: recentOutput.label },
        });
        announce("Added a recent image as a durable Image Input.");
        return;
      }
      if (!onImportDroppedImages || dropImportPendingRef.current) return;

      const files = filterSupportedCreateImagesFiles(Array.from(event.dataTransfer.files));
      if (files.length === 0) return;

      const targetNodeId = imageInputNodeIdAtTarget(event.target, snapshot.nodes);
      const targetIsImageInput = Boolean(targetNodeId);
      const requestedNewNodes = Math.max(0, files.length - (targetIsImageInput ? 1 : 0));
      const capacity = decideCanvasMutationCapacity(
        snapshot.nodes.length,
        snapshot.edges.length,
        requestedNewNodes,
        0,
      );
      if (!capacity.allowed) {
        announce(capacity.message!);
        toast.info(capacity.message!);
        return;
      }

      const dropPoint = boundedCanvasPosition(
        instanceRef.current
          ? instanceRef.current.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            })
          : { x: 0, y: 0 },
      );
      const requestId = dropImportRequestRef.current + 1;
      dropImportRequestRef.current = requestId;
      dropImportPendingRef.current = true;
      setDropImportPending(true);
      let result: CreateImagesDroppedImageImportResult | undefined;
      try {
        result = await onImportDroppedImages(files);
      } catch {
        announce("Image import failed.");
        toast.error("The dropped images could not be imported.");
        return;
      } finally {
        if (dropImportRequestRef.current === requestId) {
          dropImportPendingRef.current = false;
          setDropImportPending(false);
        }
      }
      if (!result) return;

      const imported = result.imported
        .slice(0, files.length)
        .map(normalizeDroppedImage)
        .filter((image): image is CreateImagesDroppedImage => image !== undefined);
      const failureCount = result.failures?.length ?? Math.max(0, files.length - imported.length);
      if (imported.length === 0) {
        announce("No images were imported.");
        if (failureCount > 0) toast.error("The dropped images could not be imported.");
        return;
      }

      const plan = planCreateImagesDrop({
        dropPoint,
        existingNodes: snapshot.nodes.map((node) => ({
          id: node.id,
          type: node.data.workflowNode.type,
          position: node.position,
          width: CREATE_IMAGES_DROP_NODE_WIDTH,
          height: CREATE_IMAGES_DROP_NODE_HEIGHT,
        })),
        fileCount: imported.length,
        targetNodeId,
      });
      const capacityAfterImport = decideCanvasMutationCapacity(
        snapshot.nodes.length,
        snapshot.edges.length,
        plan.positions.length,
        0,
      );
      if (!capacityAfterImport.allowed) {
        announce(capacityAfterImport.message!);
        toast.info(capacityAfterImport.message!);
        return;
      }

      const replacement = plan.replacementNodeId ? imported[0] : undefined;
      const addedImages = replacement ? imported.slice(1) : imported;
      const addedNodeIds: string[] = [];
      const addedNodes = addedImages.map((image, index) => {
        idSequence.current += 1;
        const id = `image-input-drop-${Date.now()}-${idSequence.current}`;
        addedNodeIds.push(id);
        const position = plan.positions[index] ?? dropPoint;
        const workflowNode = imageInputNodeWithAsset(id, position, image);
        return {
          id,
          type: "image-input" as const,
          position,
          selected: true,
          data: { workflowNode },
          ariaLabel: workflowNodeLabel(workflowNode),
        } satisfies CreateImagesCanvasNode;
      });
      const focusedNodeId = plan.replacementNodeId ?? addedNodeIds[0];
      commitSnapshot((current) => ({
        ...current,
        edges: current.edges.map((edge) => ({ ...edge, selected: false })),
        nodes: [
          ...current.nodes
            .filter((node) => node.id !== plan.replacementNodeId)
            .map((node) => ({
              ...node,
              selected: addedNodeIds.includes(node.id),
            })),
          ...(replacement
            ? current.nodes
                .filter((node) => node.id === plan.replacementNodeId)
                .map((node) =>
                  node.data.workflowNode.type === "image-input"
                    ? {
                        ...node,
                        selected: addedNodeIds.length === 0,
                        data: {
                          workflowNode: {
                            ...node.data.workflowNode,
                            data: {
                              assetId: replacement.assetId,
                              ...(replacement.label ? { label: replacement.label } : {}),
                            },
                          },
                        } as CreateImagesCanvasNodeData,
                      }
                    : node,
                )
            : []),
          ...addedNodes,
        ],
      }));

      const replacedMessage = replacement ? "Replaced the image input" : "Added image input";
      const addedMessage =
        addedNodes.length > 0
          ? `${addedNodes.length} image input${addedNodes.length === 1 ? "" : "s"}`
          : "";
      const message = replacement
        ? addedMessage
          ? `${replacedMessage} and added ${addedMessage}.`
          : `${replacedMessage}.`
        : `${addedMessage}.`;
      announce(
        failureCount > 0
          ? `${message} ${failureCount} file${failureCount === 1 ? "" : "s"} could not be imported.`
          : message,
      );
      if (failureCount > 0)
        toast.info(
          `${failureCount} image file${failureCount === 1 ? "" : "s"} could not be imported.`,
        );
      requestAnimationFrame(() => {
        if (!focusedNodeId) return;
        const nodeElement = Array.from(
          workbenchRef.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? [],
        ).find((element) => element.dataset.id === focusedNodeId);
        nodeElement?.focus();
      });
    },
    [
      addNode,
      canvasPositionForScreenPoint,
      commitSnapshot,
      onImportDroppedImages,
      snapshot.edges.length,
      snapshot.nodes,
      setDropState,
    ],
  );

  const copySelectedGraph = React.useCallback(
    (event: ClipboardEvent) => {
      const selectedIds = new Set(
        snapshot.nodes.filter((node) => node.selected).map((node) => node.id),
      );
      const fragment = createCreateImagesGraphFragment(currentDocument, selectedIds);
      if (!fragment || !event.clipboardData) return false;
      const serialized = serializeCreateImagesGraphFragment(fragment);
      if (!serialized) {
        announce("The selected graph fragment is too large to copy.");
        toast.info("The selected graph fragment is too large to copy.");
        return false;
      }
      event.preventDefault();
      event.clipboardData.setData(CREATE_IMAGES_GRAPH_FRAGMENT_MIME, serialized);
      event.clipboardData.setData("text/plain", serialized);
      announce(`Copied ${fragment.nodes.length} node${fragment.nodes.length === 1 ? "" : "s"}.`);
      return true;
    },
    [currentDocument, snapshot.nodes],
  );

  const pasteGraphFragment = React.useCallback(
    (fragment: CreateImagesGraphFragmentV1) => {
      const capacity = decideCanvasMutationCapacity(
        snapshot.nodes.length,
        snapshot.edges.length,
        fragment.nodes.length,
        fragment.edges.length,
      );
      if (!capacity.allowed) {
        announce(capacity.message!);
        toast.info(capacity.message!);
        return;
      }
      const instantiated = instantiateCreateImagesGraphFragment(fragment, {
        anchor: canvasPositionForScreenPoint(),
        uniqueToken: Date.now().toString(36),
        startSequence: idSequence.current,
      });
      idSequence.current = instantiated.nextSequence;
      const pastedIds = new Set(instantiated.nodes.map((node) => node.id));
      const pastedNodes = instantiated.nodes.map(
        (workflowNode) =>
          ({
            id: workflowNode.id,
            type: workflowNode.type,
            position: workflowNode.position,
            selected: true,
            data: { workflowNode },
            ariaLabel: workflowNodeLabel(workflowNode),
          }) satisfies CreateImagesCanvasNode,
      );
      const pastedEdges = instantiated.edges.map(
        (edge) =>
          ({
            id: edge.id,
            source: edge.source,
            sourceHandle: edge.sourcePort,
            target: edge.target,
            targetHandle: edge.targetPort,
            type: "smoothstep",
            className: "create-images-edge",
            selected: false,
          }) satisfies Edge,
      );
      commitSnapshot((current) => ({
        nodes: [
          ...current.nodes.map((node) => ({ ...node, selected: pastedIds.has(node.id) })),
          ...pastedNodes,
        ],
        edges: [...current.edges.map((edge) => ({ ...edge, selected: false })), ...pastedEdges],
      }));
      announce(`Pasted ${pastedNodes.length} node${pastedNodes.length === 1 ? "" : "s"}.`);
      requestAnimationFrame(() => {
        const firstId = pastedNodes[0]?.id;
        if (!firstId) return;
        const nodeElement = Array.from(
          workbenchRef.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? [],
        ).find((element) => element.dataset.id === firstId);
        nodeElement?.focus();
      });
    },
    [canvasPositionForScreenPoint, commitSnapshot, snapshot.edges.length, snapshot.nodes.length],
  );

  const pasteImageIntoCanvas = React.useCallback(async () => {
    if (pasteImportPendingRef.current) return;
    const replacementNodeId =
      selectedNode?.data.workflowNode.type === "image-input" ? selectedNode.id : undefined;
    const requestedNewNodes = replacementNodeId ? 0 : 1;
    const capacity = decideCanvasMutationCapacity(
      snapshot.nodes.length,
      snapshot.edges.length,
      requestedNewNodes,
      0,
    );
    if (!capacity.allowed) {
      announce(capacity.message!);
      toast.info(capacity.message!);
      return;
    }

    const viewportBounds = instanceRef.current?.getViewport();
    const workbenchBounds = workbenchRef.current?.getBoundingClientRect();
    const pastePoint = boundedCanvasPosition(
      instanceRef.current
        ? instanceRef.current.screenToFlowPosition({
            x: workbenchBounds
              ? workbenchBounds.left + workbenchBounds.width / 2
              : window.innerWidth / 2,
            y: workbenchBounds
              ? workbenchBounds.top + workbenchBounds.height / 2
              : window.innerHeight / 2,
          })
        : { x: -(viewportBounds?.x ?? 0) + 240, y: -(viewportBounds?.y ?? 0) + 180 },
    );

    pasteImportPendingRef.current = true;
    let result;
    try {
      result = await createImagesApi.pasteImage({ workflowId: document.id });
    } catch {
      announce("Image paste failed.");
      toast.error("The clipboard image could not be imported.");
      return;
    } finally {
      pasteImportPendingRef.current = false;
    }
    if (result.status === "no-image") return;
    if (result.status !== "imported") {
      announce("Image paste failed.");
      toast.error(result.message);
      return;
    }

    const imported = normalizeDroppedImage({
      assetId: result.grant.asset.assetId,
      ...(result.grant.asset.originalName ? { label: result.grant.asset.originalName } : {}),
    });
    if (!imported) {
      announce("Image paste failed.");
      toast.error("The clipboard image could not be imported.");
      return;
    }
    const plan = planCreateImagesDrop({
      dropPoint: pastePoint,
      existingNodes: snapshot.nodes.map((node) => ({
        id: node.id,
        type: node.data.workflowNode.type,
        position: node.position,
        width: CREATE_IMAGES_DROP_NODE_WIDTH,
        height: CREATE_IMAGES_DROP_NODE_HEIGHT,
      })),
      fileCount: 1,
      targetNodeId: replacementNodeId,
    });
    const capacityAfterImport = decideCanvasMutationCapacity(
      snapshot.nodes.length,
      snapshot.edges.length,
      plan.positions.length,
      0,
    );
    if (!capacityAfterImport.allowed) {
      announce(capacityAfterImport.message!);
      toast.info(capacityAfterImport.message!);
      return;
    }

    const pasteNodeId = `image-input-paste-${Date.now()}-${++idSequence.current}`;
    const position = plan.positions[0] ?? pastePoint;
    const pastedNode = {
      id: pasteNodeId,
      type: "image-input" as const,
      position,
      selected: true,
      data: { workflowNode: imageInputNodeWithAsset(pasteNodeId, position, imported) },
      ariaLabel: workflowNodeLabel(imageInputNodeWithAsset(pasteNodeId, position, imported)),
    } satisfies CreateImagesCanvasNode;
    commitSnapshot((current) => ({
      ...current,
      edges: current.edges.map((edge) => ({ ...edge, selected: false })),
      nodes: [
        ...current.nodes
          .filter((node) => node.id !== plan.replacementNodeId)
          .map((node) => ({ ...node, selected: false })),
        ...(plan.replacementNodeId
          ? current.nodes
              .filter((node) => node.id === plan.replacementNodeId)
              .map((node) =>
                node.data.workflowNode.type === "image-input"
                  ? {
                      ...node,
                      selected: true,
                      data: {
                        workflowNode: {
                          ...node.data.workflowNode,
                          data: {
                            assetId: imported.assetId,
                            ...(imported.label ? { label: imported.label } : {}),
                          },
                        },
                      } as CreateImagesCanvasNodeData,
                    }
                  : node,
              )
          : []),
        ...(plan.replacementNodeId ? [] : [pastedNode]),
      ],
    }));
    announce(plan.replacementNodeId ? "Replaced the image input." : "Added image input.");
    const focusedNodeId = plan.replacementNodeId ?? pasteNodeId;
    requestAnimationFrame(() => {
      const nodeElement = Array.from(
        workbenchRef.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? [],
      ).find((element) => element.dataset.id === focusedNodeId);
      nodeElement?.focus();
    });
  }, [commitSnapshot, document.id, selectedNode, snapshot.edges.length, snapshot.nodes]);

  const undo = React.useCallback(() => {
    if (history.past.length === 0) return;
    setHistory((current) => undoEditorHistory(current));
    announce("Undid the last graph edit.");
  }, [history.past.length]);
  const redo = React.useCallback(() => {
    if (history.future.length === 0) return;
    setHistory((current) => redoEditorHistory(current));
    announce("Redid the graph edit.");
  }, [history.future.length]);

  React.useEffect(() => {
    const acceptsClipboardEvent = (event: ClipboardEvent) =>
      !event.defaultPrevented &&
      !paletteOpen &&
      !shortcutsOpen &&
      event.target instanceof Node &&
      Boolean(workbenchRef.current?.contains(event.target)) &&
      !(
        event.target instanceof Element &&
        Boolean(event.target.closest("#create-images-validation-issues"))
      ) &&
      !isEditableTarget(event.target);
    const onCopy = (event: ClipboardEvent) => {
      if (!acceptsClipboardEvent(event)) return;
      copySelectedGraph(event);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!acceptsClipboardEvent(event) || !event.clipboardData) return;
      const customFragment = event.clipboardData.getData(CREATE_IMAGES_GRAPH_FRAGMENT_MIME);
      const plainText = event.clipboardData.getData("text/plain");
      const looksLikeFragment = plainText.includes(`"kind":"${CREATE_IMAGES_GRAPH_FRAGMENT_KIND}"`);
      const fragmentText = customFragment || (looksLikeFragment ? plainText : "");
      if (fragmentText) {
        event.preventDefault();
        const parsed = parseCreateImagesGraphFragment(fragmentText);
        if (parsed.status === "valid") pasteGraphFragment(parsed.fragment);
        else {
          announce(parsed.message);
          toast.error(parsed.message);
        }
        return;
      }
      if (hasCreateImagesClipboardImage(event)) {
        event.preventDefault();
        void pasteImageIntoCanvas();
        return;
      }
      if (plainText.trim().length > 0) {
        event.preventDefault();
        addNode("prompt", {
          position: canvasPositionForScreenPoint(),
          connectionOrigin: null,
          promptText: plainText,
        });
      }
    };
    window.addEventListener("copy", onCopy, { capture: true });
    window.addEventListener("paste", onPaste, { capture: true });
    return () => {
      window.removeEventListener("copy", onCopy, { capture: true });
      window.removeEventListener("paste", onPaste, { capture: true });
    };
  }, [
    addNode,
    canvasPositionForScreenPoint,
    copySelectedGraph,
    paletteOpen,
    pasteGraphFragment,
    pasteImageIntoCanvas,
    shortcutsOpen,
  ]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        paletteOpen ||
        shortcutsOpen ||
        !(event.target instanceof Node) ||
        !workbenchRef.current?.contains(event.target) ||
        (event.target instanceof Element &&
          Boolean(event.target.closest("#create-images-validation-issues"))) ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      const shortcut = resolveCreateImagesGraphShortcut(event);
      if (shortcut === "undo" || shortcut === "redo") {
        event.preventDefault();
        if (shortcut === "redo") redo();
        else undo();
      } else if (shortcut === "duplicate") {
        event.preventDefault();
        duplicateSelected();
      } else if (shortcut === "open-search") {
        event.preventDefault();
        openNodePalette({
          returnFocus: event.target instanceof HTMLElement ? event.target : undefined,
        });
      } else if (shortcut === "shortcuts") {
        event.preventDefault();
        shortcutsReturnFocusRef.current = event.target instanceof HTMLElement ? event.target : null;
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [duplicateSelected, openNodePalette, paletteOpen, redo, shortcutsOpen, undo]);

  const paletteOptions = (
    paletteConnection
      ? compatibleCreateImagesNodeOptions(currentDocument, paletteConnection)
      : (Object.keys(CREATE_IMAGES_NODE_DEFINITIONS) as CreateImagesNodeType[]).map((type) => ({
          type,
          portId: undefined,
          portLabel: undefined,
        }))
  )
    .filter(
      (option) =>
        powerFeatures ||
        !["annotation", "group", "prompt-list"].includes(option.type) ||
        currentDocument.nodes.some((node) => node.type === option.type),
    )
    .filter((option) => {
      const query = paletteSearch.trim().toLowerCase();
      return (
        query.length === 0 ||
        CREATE_IMAGES_NODE_DEFINITIONS[option.type].title.toLowerCase().includes(query) ||
        option.portLabel?.toLowerCase().includes(query)
      );
    });
  const selectedEdge =
    snapshot.edges.filter((edge) => edge.selected).length === 1
      ? snapshot.edges.find((edge) => edge.selected)
      : undefined;
  const missingAssetIdSet = React.useMemo(() => new Set(missingAssetIds), [missingAssetIds]);
  const inspectAsset = React.useCallback(
    (
      assetId: string,
      source: "workflow" | "run" | "recent",
      label: string,
      trigger: HTMLButtonElement,
      runId?: string,
    ) => {
      imageInspectorReturnFocusRef.current = trigger;
      setInspectedAsset({
        assetId,
        source,
        label,
        ...((source === "run" || source === "recent") && (runId ?? runProjection?.runId)
          ? { runId: runId ?? runProjection?.runId }
          : {}),
      });
    },
    [runProjection?.runId],
  );
  const saveAsset = React.useCallback(
    (assetId: string, source: "workflow" | "run") => {
      if (source === "run") {
        if (runProjection?.runId) onDownloadRunAsset?.(runProjection.runId, assetId);
        return;
      }
      onDownloadWorkflowAsset?.(assetId);
    },
    [onDownloadRunAsset, onDownloadWorkflowAsset, runProjection?.runId],
  );
  const exportRunAssetsZip = React.useCallback(
    (assetIds: readonly string[]) => {
      if (runProjection?.runId) onDownloadRunAssetsZip?.(runProjection.runId, assetIds);
    },
    [onDownloadRunAssetsZip, runProjection?.runId],
  );
  const extractRunAssets = React.useCallback(
    (sourceNodeId: string, assetIds: readonly string[]) => {
      const unique = [...new Set(assetIds)].filter((assetId) =>
        CREATE_IMAGES_ASSET_ID_PATTERN.test(assetId),
      );
      if (unique.length === 0) return;
      const capacity = decideCanvasMutationCapacity(
        snapshot.nodes.length,
        snapshot.edges.length,
        unique.length,
        0,
      );
      if (!capacity.allowed) {
        announce(capacity.message!);
        toast.info(capacity.message!);
        return;
      }
      const source = snapshot.nodes.find((node) => node.id === sourceNodeId);
      const origin = source?.position ?? canvasPositionForScreenPoint();
      const extracted = unique.map((assetId, index) => {
        idSequence.current += 1;
        const id = `image-input-extract-${Date.now()}-${idSequence.current}`;
        const position = boundedCanvasPosition({
          x: origin.x + 340 + (index % 3) * 276,
          y: origin.y + Math.floor(index / 3) * 340,
        });
        const workflowNode = imageInputNodeWithAsset(id, position, {
          assetId,
          label: `Generated image ${assetId.slice(0, 8)}`,
        });
        return {
          id,
          type: "image-input" as const,
          position,
          selected: true,
          data: { workflowNode },
          ariaLabel: workflowNodeLabel(workflowNode),
        } satisfies CreateImagesCanvasNode;
      });
      commitSnapshot((current) => ({
        nodes: [...current.nodes.map((node) => ({ ...node, selected: false })), ...extracted],
        edges: current.edges.map((edge) => ({ ...edge, selected: false })),
      }));
      announce(
        `Extracted ${extracted.length} image${extracted.length === 1 ? "" : "s"} as Image Input nodes.`,
      );
    },
    [canvasPositionForScreenPoint, commitSnapshot, snapshot.edges.length, snapshot.nodes],
  );
  const inspectedAssetGrant = inspectedAsset
    ? inspectedAsset.source === "recent"
      ? recentOutputPreviews[inspectedAsset.assetId]
      : inspectedAsset.source === "run"
        ? runAssetPreviews[inspectedAsset.assetId]
        : assetPreviews[inspectedAsset.assetId]
    : undefined;

  React.useEffect(() => {
    if (!inspectedAsset) return;
    const retain =
      inspectedAsset.source === "recent"
        ? onRecentOutputPreviewMount
        : inspectedAsset.source === "run"
          ? onRunAssetPreviewMount
          : onAssetPreviewMount;
    return (retain ?? EMPTY_ASSET_PREVIEW_RETAINER)(inspectedAsset.assetId);
  }, [inspectedAsset, onAssetPreviewMount, onRecentOutputPreviewMount, onRunAssetPreviewMount]);

  const canvasActions = React.useMemo(
    () => ({
      providerStatus,
      executionMode,
      updateNode,
      beginNodeEdit,
      updateNodeDraft,
      commitNodeEdit,
      selectNode,
      nodeLayoutLocked: (nodeId: string) =>
        snapshot.nodes.some((candidate) => {
          const node = candidate.data.workflowNode;
          return (
            node.type === "group" && node.data.locked && node.data.memberNodeIds.includes(nodeId)
          );
        }),
      chooseImage: (nodeId: string) => void chooseImage(nodeId),
      fitImageToMedia,
      removeImage,
      removePromptVariable,
      imageChoicePending: (nodeId: string) => pendingImageNodeId === nodeId,
      retainAssetPreview: onAssetPreviewMount ?? EMPTY_ASSET_PREVIEW_RETAINER,
      assetPreview: (assetId: string) => assetPreviews[assetId],
      assetPreviewStatus: (assetId: string) => onAssetPreviewStatus?.(assetId),
      assetPreviewMissing: (assetId: string) => missingAssetIdSet.has(assetId),
      assetPreviewLoaded: (assetId: string, token: string) => onAssetPreviewLoad?.(assetId, token),
      assetPreviewFailed: (assetId: string, token: string) => onAssetPreviewError?.(assetId, token),
      nodeRunState: (nodeId: string) => runProjection?.nodes[nodeId],
      inputRunAssetIds: (nodeId: string, portId: string) => {
        const edge = snapshot.edges.find(
          (candidate) => candidate.target === nodeId && candidate.targetHandle === portId,
        );
        return edge ? (runProjection?.nodes[edge.source]?.outputAssetIds ?? []) : [];
      },
      inputImageAuthority: (nodeId: string, portId: string) => {
        const edge = snapshot.edges.find(
          (candidate) => candidate.target === nodeId && candidate.targetHandle === portId,
        );
        if (!edge) return undefined;
        const source = snapshot.nodes.find((candidate) => candidate.id === edge.source)?.data
          .workflowNode;
        if (source?.type === "image-input" && source.data.assetId) {
          return { source: "workflow" as const, assetIds: [source.data.assetId] };
        }
        const assetIds = runProjection?.nodes[edge.source]?.outputAssetIds ?? [];
        return assetIds.length > 0 ? { source: "run" as const, assetIds } : undefined;
      },
      retainRunAssetPreview: onRunAssetPreviewMount ?? EMPTY_ASSET_PREVIEW_RETAINER,
      runAssetPreview: (assetId: string) => runAssetPreviews[assetId],
      runAssetPreviewLoaded: (assetId: string, token: string) =>
        onRunAssetPreviewLoad?.(assetId, token),
      runAssetPreviewFailed: (assetId: string, token: string) =>
        onRunAssetPreviewError?.(assetId, token),
      recentNodeOutputs: (nodeId: string) =>
        recentOutputs.filter(
          (item) => item.workflowId === currentDocument.id && item.nodeId === nodeId,
        ),
      retainRecentAssetPreview: onRecentOutputPreviewMount ?? EMPTY_ASSET_PREVIEW_RETAINER,
      recentAssetPreview: (assetId: string) => recentOutputPreviews[assetId],
      recentAssetPreviewLoaded: (assetId: string, token: string) =>
        onRecentOutputPreviewLoad?.(assetId, token),
      recentAssetPreviewFailed: (assetId: string, token: string) =>
        onRecentOutputPreviewError?.(assetId, token),
      inspectAsset,
      saveAsset,
      exportRunAssetsZip,
      runAssetHidden: (assetId: string) => hiddenRunAssetIds.has(assetId),
      setRunAssetHidden: (assetId: string, hidden: boolean) => {
        const runId = runProjection?.runId;
        if (!runId) return;
        setHiddenRunAssetIds((current) => {
          const next = new Set(current);
          if (hidden) next.add(assetId);
          else next.delete(assetId);
          return next;
        });
        void createImagesApi
          .setAssetHidden({ workflowId: currentDocument.id, runId, assetId, hidden })
          .then((result) => {
            if (result.status === "ready") {
              setHiddenRunAssetIds(new Set(result.hiddenAssetIds));
              return;
            }
            setHiddenRunAssetIds((current) => {
              const next = new Set(current);
              if (hidden) next.delete(assetId);
              else next.add(assetId);
              return next;
            });
            toast.error(
              result.status === "unavailable"
                ? result.message
                : "That retained image is no longer available.",
            );
          });
      },
      extractRunAssets,
    }),
    [
      assetPreviews,
      beginNodeEdit,
      chooseImage,
      fitImageToMedia,
      commitNodeEdit,
      missingAssetIdSet,
      onAssetPreviewLoad,
      pendingImageNodeId,
      removeImage,
      removePromptVariable,
      onAssetPreviewError,
      onAssetPreviewMount,
      onAssetPreviewStatus,
      onRunAssetPreviewError,
      onRunAssetPreviewLoad,
      onRunAssetPreviewMount,
      onRecentOutputPreviewError,
      onRecentOutputPreviewLoad,
      onRecentOutputPreviewMount,
      recentOutputPreviews,
      recentOutputs,
      runAssetPreviews,
      runProjection,
      currentDocument.id,
      snapshot.edges,
      snapshot.nodes,
      selectNode,
      updateNode,
      updateNodeDraft,
      providerStatus,
      executionMode,
      inspectAsset,
      saveAsset,
      exportRunAssetsZip,
      hiddenRunAssetIds,
      extractRunAssets,
    ],
  );

  return (
    <CreateImagesCanvasActionsContext.Provider value={canvasActions}>
      <section
        ref={workbenchRef}
        className="create-images-workbench relative h-full min-h-0 overflow-hidden bg-background"
        aria-label={`${document.title} image workflow editor`}
        data-node-count={snapshot.nodes.length}
        data-edge-count={snapshot.edges.length}
      >
        <header
          className="create-images-toolbar drag-region absolute inset-x-0 top-0 z-30 flex h-13 items-center gap-2 border-b border-separator bg-background/88 px-3 backdrop-blur-xl transition-[padding] duration-300 motion-reduce:transition-none"
          style={{ paddingLeft: split?.collapsed ? 142 : undefined }}
        >
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label="Back to image workflows"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-small-strong font-medium">{document.title}</h1>
            <p className="truncate text-mini text-tertiary">
              {statusLabel} · {snapshot.nodes.length} nodes · {snapshot.edges.length} connections
            </p>
          </div>
          {!autosaveEnabled ? (
            <Button
              size="small"
              variant={saveState === "dirty" || saveState === "error" ? "accent" : "filled"}
              disabled={saveState === "saved" || saveState === "saving" || saveState === "conflict"}
              onClick={onSaveWorkflow}
              aria-label={saveState === "saving" ? "Saving workflow" : "Save workflow"}
            >
              <Save aria-hidden="true" />
              {saveState === "saving" ? "Saving…" : "Save"}
            </Button>
          ) : null}
          {snapshot.nodes.length === 0 ? (
            <span className="create-images-validity rounded-pill bg-control px-2 py-1 text-mini font-medium text-secondary">
              Empty workflow
            </span>
          ) : graphIssues.length > 0 ? (
            <button
              ref={issuesTriggerRef}
              type="button"
              className="create-images-validity rounded-pill bg-red/10 px-2 py-1 text-mini font-medium text-red outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-expanded={issuesOpen}
              aria-controls="create-images-validation-issues"
              onClick={() => setIssuesOpen((open) => !open)}
            >
              {graphIssues.length} issue{graphIssues.length === 1 ? "" : "s"}
            </button>
          ) : (
            <span className="create-images-validity rounded-pill bg-green/10 px-2 py-1 text-mini font-medium text-green">
              Graph valid
            </span>
          )}
          <CreateImagesProviderConnectionControl
            status={providerStatus}
            executionMode={executionMode}
            onExecutionModeChange={onExecutionModeChange}
            onOpenProviderSettings={onOpenProviderSettings}
          />
          <CreateImagesRunControls
            status={runProjection?.status}
            selectedNodeLabel={selectedNodeLabel}
            runAllDisabledReason={runAllDisabledReason}
            runFromHereDisabledReason={runFromHereDisabledReason}
            historyOpen={runSurface === "history"}
            onRunAll={(trigger) => onRunRequest?.({ kind: "all" }, currentDocument, trigger)}
            onRunFromHere={
              runFromHereScope
                ? (trigger) => onRunRequest?.(runFromHereScope, currentDocument, trigger)
                : undefined
            }
            onStop={onStopRun}
            onResume={onResumeRun}
            onOpenHistory={toggleRunHistory}
          />
        </header>

        <div
          className="create-images-canvas-drop-zone absolute inset-0 pt-13"
          aria-busy={dropImportPending}
          data-create-images-drop-active={dropState.active ? "true" : "false"}
          data-create-images-drop-target={dropState.targetNodeId ? "replace" : "create"}
          onDragEnter={handleCanvasDragEnter}
          onDragOver={handleCanvasDragOver}
          onDragLeave={handleCanvasDragLeave}
          onDrop={(event) => void handleCanvasDrop(event)}
          onDoubleClick={(event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest(".react-flow__pane")) return;
            event.preventDefault();
            openNodePalette({
              screen: { x: event.clientX, y: event.clientY },
              returnFocus: event.currentTarget,
            });
          }}
        >
          <ReactFlow<CreateImagesCanvasNode, Edge>
            nodes={snapshot.nodes}
            edges={snapshot.edges}
            nodeTypes={NODE_TYPES}
            panOnDrag={navigationProps.panOnDrag}
            panOnScroll={navigationProps.panOnScroll}
            selectionOnDrag={navigationProps.selectionOnDrag}
            zoomOnScroll={navigationProps.zoomOnScroll}
            zoomOnPinch={navigationProps.zoomOnPinch}
            zoomOnDoubleClick={navigationProps.zoomOnDoubleClick}
            onInit={(instance) => {
              instanceRef.current = instance;
              onCanvasReady?.(instance);
            }}
            defaultViewport={document.viewport}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onMoveEnd={(_event, nextViewport) => {
              const position = boundedCanvasPosition(nextViewport);
              setViewport({
                ...position,
                zoom: Math.min(
                  CREATE_IMAGES_MAX_ZOOM,
                  Math.max(CREATE_IMAGES_MIN_ZOOM, nextViewport.zoom),
                ),
              });
            }}
            onConnectStart={() => {
              rejectedConnectionMessage.current = null;
            }}
            onConnectEnd={(event, state) => {
              const validatedMessage = rejectedConnectionMessage.current;
              rejectedConnectionMessage.current = null;
              const fromHandle = state.fromHandle;
              if (!state.toHandle && fromHandle?.id) {
                const origin = {
                  nodeId: fromHandle.nodeId,
                  portId: fromHandle.id,
                  direction: fromHandle.type,
                } satisfies CreateImagesDanglingConnectionOrigin;
                const options = compatibleCreateImagesNodeOptions(currentDocument, origin);
                if (options.length === 0) {
                  const message = "No compatible node can be added from this port.";
                  announce(message);
                  toast.info(message);
                  return;
                }
                const point =
                  event instanceof TouchEvent
                    ? event.changedTouches.item(0)
                    : { clientX: event.clientX, clientY: event.clientY };
                if (!point) return;
                openNodePalette({
                  screen: { x: point.clientX, y: point.clientY },
                  connection: origin,
                  returnFocus: event.target instanceof HTMLElement ? event.target : undefined,
                });
                return;
              }
              if (state.isValid !== false || !state.toHandle || !fromHandle) return;
              const directionMismatch =
                fromHandle.type !== "source" || state.toHandle.type !== "target";
              const message =
                validatedMessage ??
                (directionMismatch
                  ? "Connections must run from an output port to an input port."
                  : "That connection is not allowed. Use Manage connections for compatible ports.");
              announce(message);
              toast.info(message);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              openNodePalette({
                screen: { x: event.clientX, y: event.clientY },
                returnFocus: event.target instanceof HTMLElement ? event.target : undefined,
              });
            }}
            onNodeDragStart={() => {
              dragStartSnapshot.current = snapshot;
              setCanvasEditInProgress(true);
            }}
            onNodeDragStop={() => {
              const before = dragStartSnapshot.current;
              dragStartSnapshot.current = null;
              setCanvasEditInProgress(false);
              if (!before) return;
              setHistory((current) =>
                canvasPositionsEqual(before, current.present)
                  ? current
                  : {
                      past: [...current.past, before].slice(-50),
                      present: current.present,
                      future: [],
                    },
              );
              announce("Node moved.");
            }}
            onBeforeDelete={() => {
              cascadeDeleteStartSnapshot.current = snapshot;
              return Promise.resolve(true);
            }}
            onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
              const deleteStart = cascadeDeleteStartSnapshot.current;
              cascadeDeleteStartSnapshot.current = null;
              if (deleteStart) {
                setHistory((current) => ({
                  past: [...current.past, deleteStart].slice(-50),
                  present: current.present,
                  future: [],
                }));
              }
              if (deletedNodes.length === 0 && deletedEdges.length > 0) {
                announce(
                  `${deletedEdges.length} connection${deletedEdges.length === 1 ? "" : "s"} deleted.`,
                );
              }
              requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
            }}
            connectOnClick={false}
            isValidConnection={(connection) => {
              const decision = connectionDecision(connection, "edge-validation");
              rejectedConnectionMessage.current = decision.allowed ? null : decision.message;
              return decision.allowed;
            }}
            minZoom={CREATE_IMAGES_MIN_ZOOM}
            maxZoom={CREATE_IMAGES_MAX_ZOOM}
            snapToGrid
            snapGrid={[12, 12]}
            nodeExtent={[
              [-CREATE_IMAGES_POSITION_LIMIT, -CREATE_IMAGES_POSITION_LIMIT],
              [CREATE_IMAGES_POSITION_LIMIT, CREATE_IMAGES_POSITION_LIMIT],
            ]}
            onlyRenderVisibleElements
            multiSelectionKeyCode="Meta"
            deleteKeyCode={["Backspace", "Delete"]}
            selectionKeyCode="Shift"
            nodesFocusable
            edgesFocusable
            defaultEdgeOptions={{
              type: "smoothstep",
              className: "create-images-edge",
            }}
            aria-label="Visual node workflow canvas. Use the node list for a non-spatial alternative."
            colorMode={appearanceScheme}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="var(--border-field)"
            />
            <Controls position="bottom-left" showInteractive={false} />
            {miniMapVisible && !narrowCanvas ? (
              <MiniMap
                position="bottom-left"
                pannable
                zoomable
                className="create-images-minimap"
                nodeColor="var(--surface-control-active)"
                maskColor="color-mix(in srgb, var(--surface-background) 76%, transparent)"
              />
            ) : null}
            {selectedEdge ? (
              <Panel position="top-center" className="create-images-edge-toolbar mt-2">
                <div
                  className="flex items-center gap-1 rounded-pill border border-field bg-popover/94 p-1 shadow-popover backdrop-blur-xl"
                  role="toolbar"
                  aria-label={`Selected connection from ${selectedEdge.source} to ${selectedEdge.target}`}
                >
                  <span className="max-w-56 truncate px-2 text-mini text-secondary">
                    {selectedEdge.source} → {selectedEdge.target}
                  </span>
                  {powerFeatures ||
                  (selectedEdge.data as { breakpoint?: boolean } | undefined)?.breakpoint ? (
                    <Button
                      size="small"
                      variant={
                        (selectedEdge.data as { breakpoint?: boolean } | undefined)?.breakpoint
                          ? "filled"
                          : "transparent"
                      }
                      aria-pressed={
                        (selectedEdge.data as { breakpoint?: boolean } | undefined)?.breakpoint ===
                        true
                      }
                      title="Pause after upstream work is durable and before the downstream node"
                      onClick={() => {
                        const enabled =
                          (selectedEdge.data as { breakpoint?: boolean } | undefined)
                            ?.breakpoint !== true;
                        commitSnapshot((current) => ({
                          ...current,
                          edges: current.edges.map((edge) =>
                            edge.id === selectedEdge.id
                              ? { ...edge, data: { ...(edge.data ?? {}), breakpoint: enabled } }
                              : edge,
                          ),
                        }));
                        announce(
                          enabled ? "Pause checkpoint enabled." : "Pause checkpoint removed.",
                        );
                      }}
                    >
                      {((selectedEdge.data as { breakpoint?: boolean } | undefined)?.breakpoint ??
                      false)
                        ? "Pause on"
                        : "Add pause"}
                    </Button>
                  ) : null}
                  <Button
                    iconOnly
                    size="small"
                    variant="transparent"
                    aria-label="Delete selected connection"
                    title="Delete connection"
                    onClick={() => disconnectEdge(selectedEdge.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </Panel>
            ) : null}
            {recentOutputs.length > 0 ? (
              <Panel position="top-left" className="create-images-recent-shelf ml-2 mt-2">
                <RecentImagesShelf
                  items={recentOutputs}
                  previews={recentOutputPreviews}
                  onPreviewMount={onRecentOutputPreviewMount}
                  onPreviewLoad={onRecentOutputPreviewLoad}
                  onPreviewError={onRecentOutputPreviewError}
                  onInspect={(item, trigger) =>
                    inspectAsset(
                      item.assetId,
                      "recent",
                      item.prompt || "Recent generated image",
                      trigger,
                      item.runId,
                    )
                  }
                />
              </Panel>
            ) : null}
            <Panel position="bottom-center" className="create-images-action-bar mb-2">
              <div className="flex items-center gap-1 rounded-pill border border-field bg-popover/92 p-1 shadow-popover backdrop-blur-xl">
                <Button
                  ref={paletteTriggerRef}
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Add node"
                  aria-haspopup="dialog"
                  aria-expanded={paletteOpen}
                  onClick={(event) => {
                    if (paletteOpen) setPaletteOpen(false);
                    else openNodePalette({ returnFocus: event.currentTarget });
                  }}
                >
                  <Plus />
                </Button>
                {powerFeatures ? (
                  <Button
                    ref={proposalTriggerRef}
                    iconOnly
                    size="small"
                    variant="transparent"
                    aria-label="Propose workflow with selected chat model"
                    aria-haspopup="dialog"
                    aria-expanded={proposalOpen}
                    title="Propose workflow"
                    onClick={() => setProposalOpen(true)}
                  >
                    <Sparkles />
                  </Button>
                ) : null}
                <span className="mx-0.5 h-4 w-px bg-separator" aria-hidden="true" />
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Undo"
                  disabled={history.past.length === 0}
                  onClick={undo}
                >
                  <Undo2 />
                </Button>
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Redo"
                  disabled={history.future.length === 0}
                  onClick={redo}
                >
                  <Redo2 />
                </Button>
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Duplicate selected nodes"
                  disabled={selectedNodes.length === 0}
                  onClick={duplicateSelected}
                >
                  <Copy />
                </Button>
                {selectedNodes.length > 1 ? (
                  <>
                    <span className="mx-0.5 h-4 w-px bg-separator" aria-hidden="true" />
                    {powerFeatures ? (
                      <Button
                        iconOnly
                        size="small"
                        variant="transparent"
                        aria-label="Group selected nodes"
                        title="Group selection"
                        onClick={groupSelected}
                      >
                        <Boxes />
                      </Button>
                    ) : null}
                    <Button
                      iconOnly
                      size="small"
                      variant="transparent"
                      aria-label="Arrange selected nodes horizontally"
                      title="Arrange horizontally"
                      onClick={() => arrangeSelected("horizontal")}
                    >
                      <AlignHorizontalSpaceAround />
                    </Button>
                    <Button
                      iconOnly
                      size="small"
                      variant="transparent"
                      aria-label="Arrange selected nodes vertically"
                      title="Arrange vertically"
                      onClick={() => arrangeSelected("vertical")}
                    >
                      <AlignVerticalSpaceAround />
                    </Button>
                    <Button
                      iconOnly
                      size="small"
                      variant="transparent"
                      aria-label="Arrange selected nodes in a grid"
                      title="Arrange as grid"
                      onClick={() => arrangeSelected("grid")}
                    >
                      <Grid3X3 />
                    </Button>
                  </>
                ) : null}
                {selectedNodes.some((node) => node.data.workflowNode.type === "group") ? (
                  <Button
                    iconOnly
                    size="small"
                    variant="transparent"
                    aria-label="Ungroup selected group"
                    title="Ungroup"
                    onClick={ungroupSelected}
                  >
                    <BoxSelect />
                  </Button>
                ) : null}
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Delete selected nodes"
                  disabled={selectedNodes.length === 0}
                  onClick={deleteSelected}
                >
                  <Trash2 />
                </Button>
                <span className="mx-0.5 h-4 w-px bg-separator" aria-hidden="true" />
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Fit workflow"
                  onClick={() =>
                    void instanceRef.current?.fitView({
                      duration: createImagesMotionDuration(300),
                      padding: 0.2,
                    })
                  }
                >
                  <BoxSelect />
                </Button>
                <Button
                  ref={inspectorTriggerRef}
                  iconOnly
                  size="small"
                  variant={inspectorOpen ? "filled" : "transparent"}
                  aria-label="Toggle node inspector"
                  aria-pressed={inspectorOpen}
                  onClick={() => {
                    setRunPanelChoice({
                      ...(currentRunId ? { runId: currentRunId } : {}),
                    });
                    setInspectorOpen((open) => !open);
                  }}
                >
                  <ListTree />
                </Button>
                {unreadCommentNodes.length > 0 ? (
                  <Button
                    iconOnly
                    size="small"
                    variant="transparent"
                    aria-label={`Go to next unread comment · ${unreadCommentNodes.length} unread`}
                    title={`${unreadCommentNodes.length} unread comment${unreadCommentNodes.length === 1 ? "" : "s"}`}
                    onClick={() => {
                      const currentIndex = unreadCommentNodes.findIndex(
                        (node) => node.id === selectedNode?.id,
                      );
                      const next =
                        unreadCommentNodes[(currentIndex + 1) % unreadCommentNodes.length];
                      if (!next) return;
                      selectNode(next.id);
                      setInspectorOpen(true);
                      requestAnimationFrame(() => inspectorSurfaceRef.current?.focus());
                    }}
                  >
                    <MessageSquare />
                  </Button>
                ) : null}
                {narrowCanvas ? null : (
                  <Button
                    iconOnly
                    size="small"
                    variant={miniMapVisible ? "filled" : "transparent"}
                    aria-label="Toggle minimap"
                    aria-pressed={miniMapVisible}
                    onClick={() => setMiniMapVisible((visible) => !visible)}
                  >
                    <MapIcon />
                  </Button>
                )}
                <Button
                  ref={shortcutsTriggerRef}
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Canvas shortcuts"
                  aria-haspopup="dialog"
                  aria-expanded={shortcutsOpen}
                  onClick={(event) => {
                    shortcutsReturnFocusRef.current = event.currentTarget;
                    setShortcutsOpen(true);
                  }}
                >
                  <Keyboard />
                </Button>
              </div>
            </Panel>
          </ReactFlow>
          {dropState.active ? (
            <div
              className="create-images-drop-overlay"
              data-target={dropState.targetNodeId ? "replace" : "create"}
              role="status"
              aria-live="polite"
              aria-label={
                dropState.targetNodeId
                  ? "Drop image files to replace this Image Input"
                  : "Drop image files to add Image Input nodes"
              }
            >
              <div className="create-images-drop-overlay-card">
                <span className="create-images-drop-overlay-icon" aria-hidden="true">
                  <ImageIcon />
                </span>
                <span className="create-images-drop-overlay-title">
                  {dropState.targetNodeId ? "Replace Image Input" : "Add Image Input"}
                </span>
                <span className="create-images-drop-overlay-copy">
                  {dropState.targetNodeId
                    ? "Release to replace its reference image"
                    : "Release one or more image files here"}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <DialogPrimitive.Root
          open={proposalOpen}
          onOpenChange={(open) => {
            if (proposalBusy && !open) return;
            setProposalOpen(open);
            if (!open) setWorkflowProposal(undefined);
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="create-images-run-dialog-overlay" />
            <DialogPrimitive.Content
              aria-describedby="create-images-proposal-description"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                proposalTriggerRef.current?.focus();
              }}
              className="fixed left-1/2 top-1/2 z-[71] flex max-h-[min(42rem,calc(100vh-2rem))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-dialog border border-field bg-popover text-primary shadow-dialog outline-none"
            >
              <div className="flex items-start gap-3 border-b border-separator p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-control bg-control text-secondary">
                  <Sparkles className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="text-body font-semibold">
                    Propose a workflow
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description
                    id="create-images-proposal-description"
                    className="mt-1 text-small text-secondary"
                  >
                    Your selected chat model proposes an inert graph. Aiden validates it, shows the
                    full diff, and never runs it automatically.
                  </DialogPrimitive.Description>
                </div>
                <DialogPrimitive.Close asChild>
                  <Button
                    iconOnly
                    size="small"
                    variant="transparent"
                    aria-label="Close workflow proposal"
                  >
                    <X />
                  </Button>
                </DialogPrimitive.Close>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <label
                  className="text-small-strong font-medium"
                  htmlFor="create-images-proposal-request"
                >
                  What should the workflow create?
                </label>
                <Textarea
                  id="create-images-proposal-request"
                  autoFocus
                  rows={5}
                  maxLength={4_000}
                  value={proposalRequest}
                  disabled={proposalBusy}
                  onChange={(event) => {
                    setProposalRequest(event.target.value);
                    setWorkflowProposal(undefined);
                  }}
                  placeholder="For example: Create three coordinated product concepts, collect them in a gallery, and make the prompts easy to edit."
                  className="mt-2"
                />
                <div className="mt-2 flex items-center justify-between gap-3 text-mini text-tertiary">
                  <span>
                    No files, image bytes, credentials, tools, or provider requests are shared.
                  </span>
                  <span className="shrink-0 tabular-nums">{proposalRequest.length}/4,000</span>
                </div>
                {workflowProposal ? (
                  <section
                    className="mt-4 rounded-card border border-field bg-well p-3"
                    aria-label="Workflow proposal diff"
                  >
                    <h3 className="text-small-strong font-medium">Complete graph diff</h3>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-small text-secondary">
                      <span>Nodes</span>
                      <span className="text-right tabular-nums">
                        +{workflowProposal.diff.nodesAdded} · −{workflowProposal.diff.nodesRemoved}{" "}
                        · {workflowProposal.diff.nodesChanged} changed
                      </span>
                      <span>Connections</span>
                      <span className="text-right tabular-nums">
                        +{workflowProposal.diff.edgesAdded} · −{workflowProposal.diff.edgesRemoved}{" "}
                        · {workflowProposal.diff.edgesChanged} changed
                      </span>
                      <span>Maximum image requests</span>
                      <span className="text-right tabular-nums">
                        {workflowProposal.diff.maximumImageRequests}
                      </span>
                      <span>Estimated image cost</span>
                      <span className="text-right">Unknown</span>
                    </div>
                    <p className="mt-3 border-t border-separator pt-3 text-mini text-secondary">
                      Apply replaces the current graph as one undoable edit. Image inputs remain
                      empty; applying does not contact Gemini or start a run.
                    </p>
                  </section>
                ) : null}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-separator p-4">
                <DialogPrimitive.Close asChild>
                  <Button variant="muted" disabled={proposalBusy}>
                    Cancel
                  </Button>
                </DialogPrimitive.Close>
                {workflowProposal ? (
                  <Button onClick={applyWorkflowProposal}>Apply proposal</Button>
                ) : (
                  <Button
                    disabled={proposalBusy || proposalRequest.trim().length === 0}
                    onClick={() => void requestWorkflowProposal()}
                  >
                    {proposalBusy ? "Proposing…" : "Review proposal"}
                  </Button>
                )}
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        {issuesOpen ? (
          <aside
            id="create-images-validation-issues"
            className="create-images-validation-panel absolute left-3 top-16 z-20 max-h-[min(26rem,calc(100%-5rem))] w-80 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-card border border-field bg-popover/95 p-3 shadow-popover backdrop-blur-xl"
            aria-label="Workflow validation issues"
          >
            <div className="mb-2 flex items-center gap-2">
              <h2 className="min-w-0 flex-1 text-small-strong font-medium">Workflow issues</h2>
              <Button
                iconOnly
                size="small"
                variant="transparent"
                aria-label="Close workflow issues"
                onClick={() => {
                  setIssuesOpen(false);
                  requestAnimationFrame(() =>
                    (issuesTriggerRef.current ?? inspectorTriggerRef.current)?.focus(),
                  );
                }}
              >
                <X />
              </Button>
            </div>
            {graphIssues.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {graphIssues.map((issue) => (
                  <li
                    key={`${issue.code}-${issue.edgeId ?? ""}-${issue.nodeId ?? ""}-${issue.portId ?? ""}-${issue.message}`}
                  >
                    <button
                      type="button"
                      disabled={!issue.nodeId && !issue.edgeId}
                      className="w-full rounded-control bg-well px-2.5 py-2 text-left text-small text-secondary outline-none enabled:hover:bg-list-hover enabled:focus-visible:bg-list-selection disabled:cursor-default"
                      onClick={() => void activateValidationIssue(issue)}
                    >
                      <span className="block text-mini font-medium text-primary">
                        {issue.nodeId ?? issue.edgeId ?? issue.code}
                      </span>
                      <span className="mt-0.5 block">{issue.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-control bg-well px-2.5 py-3 text-small text-secondary">
                No remaining workflow issues.
              </p>
            )}
          </aside>
        ) : null}

        {runSurface === "details" && runProjection ? (
          <aside
            className="create-images-run-surface absolute bottom-3 right-3 top-16 z-20 flex w-[min(24rem,calc(100%-1.5rem))] min-w-0 flex-col"
            aria-label="Workflow run details"
          >
            <CreateImagesRunProgressPanel
              status={runProjection.status}
              nodes={Object.values(runProjection.nodes)}
              announcement={runProjection.announcement}
              stopping={runBusy}
              onStop={onStopRun}
              onResume={onResumeRun}
              onOpenHistory={toggleRunHistory}
              onRetryNode={(nodeId, _error, trigger) =>
                onRunRequest?.({ kind: "from-node", nodeId }, currentDocument, trigger)
              }
              onNodeErrorAction={(_nodeId, action) => {
                if (action === "view-history") toggleRunHistory();
                else onRunErrorAction?.(action);
              }}
            />
          </aside>
        ) : null}

        {runSurface === "history" ? (
          <aside
            className="create-images-run-surface absolute bottom-3 right-3 top-16 z-20 flex w-[min(29rem,calc(100%-1.5rem))] min-w-0 flex-col"
            aria-label="Workflow run history"
          >
            <CreateImagesTerminalRunHistory
              items={runHistory}
              recoveries={runRecoveries}
              selectedRunId={selectedHistoryRunId}
              detail={runHistoryDetail}
              previews={runAssetPreviews}
              recoveringRunId={recoveringRunId}
              acknowledgingRunId={acknowledgingRunId}
              discardPlanning={degradedRunDiscardBusy}
              onSelectRun={onSelectHistoryRun}
              onRecover={onRecoverRun}
              onDiscard={onDiscardDegradedRun}
              onAcknowledgeAmbiguity={onAcknowledgeRunAmbiguity}
              onManageHistory={onManageRunHistory}
              historyManagementBusy={runHistoryManagementBusy}
              onAssetPreviewMount={onRunAssetPreviewMount}
              onAssetPreviewLoad={onRunAssetPreviewLoad}
              onAssetPreviewError={onRunAssetPreviewError}
              onDownloadAsset={onDownloadRunAsset}
            />
          </aside>
        ) : null}

        <DialogPrimitive.Root
          open={paletteOpen}
          onOpenChange={(open) => {
            setPaletteOpen(open);
            if (!open) {
              setPaletteSearch("");
              setPalettePlacement(undefined);
              setPaletteConnection(undefined);
            }
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-transparent" />
            <DialogPrimitive.Content
              data-create-images-node-palette
              data-slot="dialog-content"
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                paletteReturnFocusRef.current?.focus();
              }}
              className={
                palettePlacement?.screen
                  ? "create-images-context-palette fixed z-40 w-72 rounded-card border border-field bg-popover/98 p-2 text-primary shadow-popover outline-none backdrop-blur-xl"
                  : "fixed bottom-16 left-1/2 z-40 w-72 -translate-x-1/2 rounded-card border border-field bg-popover/98 p-2 text-primary shadow-popover outline-none backdrop-blur-xl"
              }
              style={
                palettePlacement?.screen
                  ? {
                      left: Math.max(
                        8,
                        Math.min(window.innerWidth - 296, palettePlacement.screen.x + 8),
                      ),
                      top: Math.max(
                        60,
                        Math.min(window.innerHeight - 392, palettePlacement.screen.y + 8),
                      ),
                    }
                  : undefined
              }
            >
              <DialogPrimitive.Title className="sr-only">
                {paletteConnection ? "Connect a compatible workflow node" : "Add workflow node"}
              </DialogPrimitive.Title>
              <div className="relative mb-2">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary"
                  aria-hidden="true"
                />
                <Input
                  autoFocus
                  value={paletteSearch}
                  onChange={(event) => setPaletteSearch(event.target.value)}
                  placeholder="Search nodes"
                  className="pl-8"
                />
              </div>
              <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                {paletteOptions.map((option) => {
                  const definition = CREATE_IMAGES_NODE_DEFINITIONS[option.type];
                  const Icon = NODE_ICONS[option.type];
                  return (
                    <button
                      type="button"
                      key={`${option.type}-${option.portId ?? "add"}`}
                      draggable={!paletteConnection}
                      className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left outline-none hover:bg-list-hover focus-visible:bg-list-selection"
                      title={
                        paletteConnection
                          ? `Connect ${definition.title}`
                          : "Click to add or drag to place"
                      }
                      onDragStart={(event) => {
                        if (paletteConnection) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.effectAllowed = "copy";
                        event.dataTransfer.setData(CREATE_IMAGES_NODE_DRAG_MIME, option.type);
                        setPaletteOpen(false);
                      }}
                      onClick={() =>
                        addNode(option.type, {
                          compatiblePortId: option.portId,
                        })
                      }
                    >
                      <span className="flex size-7 items-center justify-center rounded-[8px] bg-control text-secondary">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-small-strong font-medium">
                          {definition.title}
                        </span>
                        <span className="block text-mini text-tertiary">
                          {option.portLabel
                            ? `Connect to ${option.portLabel}`
                            : definition.category}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {paletteOptions.length === 0 ? (
                  <p className="px-2.5 py-5 text-center text-small text-secondary">
                    {paletteConnection
                      ? "No compatible nodes match that search."
                      : "No nodes match that search."}
                  </p>
                ) : null}
              </div>
              <div className="mt-2 border-t border-separator pt-2">
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-control px-2.5 py-2 text-left text-mini text-secondary outline-none hover:bg-list-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                  aria-pressed={powerFeatures}
                  onClick={() => {
                    const next = !powerFeatures;
                    setPowerFeatures(next);
                    writeCreateImagesPowerFeatures(window.localStorage, next);
                  }}
                >
                  <span>Power features</span>
                  <span className="text-tertiary">{powerFeatures ? "On" : "Off"}</span>
                </button>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <DialogPrimitive.Root open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[1px]" />
            <DialogPrimitive.Content
              data-slot="dialog-content"
              aria-describedby="create-images-shortcuts-description"
              className="fixed left-1/2 top-1/2 z-40 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-dialog border border-field bg-popover p-4 text-primary shadow-dialog outline-none"
              onCloseAutoFocus={(event) => {
                const target = shortcutsReturnFocusRef.current ?? shortcutsTriggerRef.current;
                if (!target?.isConnected) return;
                event.preventDefault();
                target.focus();
              }}
            >
              <div className="mb-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="text-small-strong font-medium">
                    Canvas shortcuts
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description
                    id="create-images-shortcuts-description"
                    className="mt-1 text-small text-secondary"
                  >
                    Shortcuts work while focus is on the canvas and never override text editing.
                  </DialogPrimitive.Description>
                </div>
                <DialogPrimitive.Close asChild>
                  <Button iconOnly size="small" variant="transparent" aria-label="Close shortcuts">
                    <X />
                  </Button>
                </DialogPrimitive.Close>
              </div>
              <dl className="create-images-shortcut-list">
                {[
                  ["Add or search nodes", "⌘⇧K or double-click"],
                  ["Copy / paste graph", "⌘C / ⌘V"],
                  ["Duplicate selection", "⌘D"],
                  ["Undo / redo", "⌘Z / ⌘⇧Z"],
                  ["Select multiple", "⌘ click"],
                  ["Box select", "Shift drag"],
                  ["Delete selection", "Delete"],
                  ["Open this help", "⌘⇧/"],
                ].map(([label, keys]) => (
                  <div key={label} className="flex items-center justify-between gap-4 py-2">
                    <dt className="text-small text-secondary">{label}</dt>
                    <dd className="text-mini font-medium text-primary">{keys}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 grid gap-2 border-t border-separator pt-3">
                <label className="grid gap-1 text-mini text-secondary">
                  Canvas navigation
                  <select
                    className="h-8 rounded-control border border-field bg-input px-2 text-small text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    value={navigationPreferences.mode}
                    onChange={(event) => {
                      const next = {
                        ...navigationPreferences,
                        mode: event.target.value as typeof navigationPreferences.mode,
                      };
                      setNavigationPreferences(next);
                      writeCreateImagesCanvasNavigationPreferences(window.localStorage, next);
                    }}
                  >
                    <option value="classic">Classic · drag to pan, wheel to zoom</option>
                    <option value="trackpad">Trackpad · scroll to pan, pinch to zoom</option>
                    <option value="selection">Selection · drag select, middle-drag pan</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-3 text-small text-secondary">
                  Double-click canvas to zoom
                  <input
                    type="checkbox"
                    checked={navigationPreferences.zoomOnDoubleClick}
                    onChange={(event) => {
                      const next = {
                        ...navigationPreferences,
                        zoomOnDoubleClick: event.target.checked,
                      };
                      setNavigationPreferences(next);
                      writeCreateImagesCanvasNavigationPreferences(window.localStorage, next);
                    }}
                  />
                </label>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        {inspectorOpen && !runSurface ? (
          <SelectionInspector
            surfaceRef={inspectorSurfaceRef}
            nodes={snapshot.nodes}
            document={currentDocument}
            selectedNode={selectedNode}
            onSelect={selectNode}
            onConnect={onConnect}
            onDisconnect={disconnectEdge}
            onRun={
              runFromHereScope
                ? (trigger) => onRunRequest?.(runFromHereScope, currentDocument, trigger)
                : undefined
            }
            runDisabledReason={runFromHereDisabledReason}
            onUpdateNode={updateNode}
            onFitImageToMedia={fitImageToMedia}
            onDuplicate={duplicateSelected}
            onDelete={() => {
              deleteSelected();
              requestAnimationFrame(() => {
                const successor = inspectorSurfaceRef.current?.querySelector<HTMLButtonElement>(
                  'ul[aria-label="Workflow nodes"] button',
                );
                (successor ?? inspectorTriggerRef.current)?.focus();
              });
            }}
            onClose={() => {
              setInspectorOpen(false);
              requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
            }}
          />
        ) : null}

        <div className="sr-only" role="status" aria-live="polite" data-create-images-action-status>
          <span key={announcement.sequence}>{announcement.text}</span>
        </div>
        <div className="sr-only" role="status" aria-live="polite" aria-label="Validation status">
          <span key={graphIssueSignature}>
            {graphIssues.length === 0
              ? "Workflow graph is valid."
              : `${graphIssues.length} workflow issue${graphIssues.length === 1 ? "" : "s"} found.`}
          </span>
        </div>
        <CreateImagesImageLightbox
          open={Boolean(inspectedAsset)}
          asset={inspectedAssetGrant}
          label={inspectedAsset?.label ?? "Image"}
          onOpenChange={(open) => {
            if (!open) setInspectedAsset(undefined);
          }}
          onImageLoad={(assetId, token) => {
            if (inspectedAsset?.source === "recent") {
              onRecentOutputPreviewLoad?.(assetId, token);
            } else if (inspectedAsset?.source === "run") onRunAssetPreviewLoad?.(assetId, token);
            else onAssetPreviewLoad?.(assetId, token);
          }}
          onImageError={(assetId, token) => {
            if (inspectedAsset?.source === "recent") {
              onRecentOutputPreviewError?.(assetId, token);
            } else if (inspectedAsset?.source === "run") onRunAssetPreviewError?.(assetId, token);
            else onAssetPreviewError?.(assetId, token);
          }}
          onSave={
            inspectedAsset
              ? () => {
                  if (inspectedAsset.source === "run" || inspectedAsset.source === "recent") {
                    if (inspectedAsset.runId) {
                      onDownloadRunAsset?.(inspectedAsset.runId, inspectedAsset.assetId);
                    }
                  } else {
                    onDownloadWorkflowAsset?.(inspectedAsset.assetId);
                  }
                }
              : undefined
          }
          returnFocus={() => imageInspectorReturnFocusRef.current}
        />
      </section>
    </CreateImagesCanvasActionsContext.Provider>
  );
}
