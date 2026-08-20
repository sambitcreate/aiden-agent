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
  ArrowLeft,
  BoxSelect,
  ChevronRight,
  Copy,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  Images,
  ListTree,
  Map as MapIcon,
  Plus,
  Redo2,
  Search,
  Sparkles,
  TextCursorInput,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button, Input, Text, toast, useSplitViewState } from "../components/ui";
import { createImagesApi } from "../lib/ipc";
import type {
  CreateImagesAssetGrantView,
  CreateImagesRunRecoveryView,
  CreateImagesRunView,
} from "../shared/create-images/ipc";
import {
  planWorkflowExecution,
  WorkflowPlanError,
  type WorkflowRunScope,
} from "../shared/create-images/execution";
import {
  CREATE_IMAGES_NODE_DEFINITIONS,
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
  boundedCanvasPosition,
  commitEditorHistory,
  createEditorHistory,
  decideCanvasConnection,
  decideCanvasMutationCapacity,
  redoEditorHistory,
  resolveCreateImagesGraphShortcut,
  undoEditorHistory,
  type EditorHistory,
} from "./editor-core";
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

const EMPTY_ASSET_PREVIEWS: Readonly<Record<string, CreateImagesAssetGrantView>> = Object.freeze(
  {},
);
const EMPTY_MISSING_ASSET_IDS: readonly string[] = Object.freeze([]);
const EMPTY_ASSET_PREVIEW_RETAINER = (): (() => void) => () => undefined;
const EMPTY_RUN_HISTORY: readonly CreateImagesTerminalRunHistoryItem[] = Object.freeze([]);
const EMPTY_RUN_RECOVERIES: readonly CreateImagesRunRecoveryView[] = Object.freeze([]);
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
  "generate-image": WorkflowNode,
  output: WorkflowNode,
  "output-gallery": WorkflowNode,
};

const CREATE_IMAGES_NODE_WIDTH = 288;
const CREATE_IMAGES_NODE_ESTIMATED_HEIGHT = 300;

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
  "generate-image": Sparkles,
  output: Images,
  "output-gallery": GalleryHorizontalEnd,
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
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourcePort,
      target: edge.target,
      targetHandle: edge.targetPort,
      type: "smoothstep",
      className: "create-images-edge",
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

function SelectionInspector({
  surfaceRef,
  nodes,
  document,
  selectedNode,
  onSelect,
  onConnect,
  onDisconnect,
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
  onDuplicate(): void;
  onDelete(): void;
  onClose(): void;
}) {
  const [connectionToolsOpen, setConnectionToolsOpen] = React.useState(false);
  const sourceOptions = React.useMemo(() => {
    const options: Array<{
      value: string;
      nodeId: string;
      portId: string;
      kind: CreateImagesPortKind;
      label: string;
    }> = [];
    for (const node of document.nodes) {
      const definition = CREATE_IMAGES_NODE_DEFINITIONS[node.type];
      for (const port of definition.outputs) {
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
      const definition = CREATE_IMAGES_NODE_DEFINITIONS[node.type];
      for (const port of definition.inputs) {
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
            <Button size="small" variant="filled" onClick={onDuplicate}>
              <Copy /> Duplicate
            </Button>
            <Button size="small" variant="transparent" onClick={onDelete}>
              <Trash2 /> Delete
            </Button>
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
                      <span className="block truncate">{definition.title}</span>
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
  onRunRequest,
  onStopRun,
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
  onDownloadRunAsset,
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
  onRunRequest?(
    scope: WorkflowRunScope,
    document: WorkflowDocumentV1,
    trigger: HTMLButtonElement,
  ): void;
  onStopRun?(trigger: HTMLButtonElement): void;
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
  onDownloadRunAsset?(runId: string, assetId: string): void;
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
  const [paletteSearch, setPaletteSearch] = React.useState("");
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [miniMapVisible, setMiniMapVisible] = React.useState(true);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [dropState, setDropState] = React.useState<CreateImagesDropState>(
    INITIAL_CREATE_IMAGES_DROP_STATE,
  );
  const [dropImportPending, setDropImportPending] = React.useState(false);
  const [runPanelChoice, setRunPanelChoice] = React.useState<{
    runId?: string;
    surface?: "details" | "history";
  }>({});
  const [pendingImageNodeId, setPendingImageNodeId] = React.useState<string>();
  const [viewport, setViewport] = React.useState(document.viewport);
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
  } | null>(null);
  const rejectedConnectionMessage = React.useRef<string | null>(null);
  const dropImportPendingRef = React.useRef(false);
  const dropImportRequestRef = React.useRef(0);
  const pasteImportPendingRef = React.useRef(false);
  const paletteTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const inspectorTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const issuesTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const inspectorSurfaceRef = React.useRef<HTMLElement | null>(null);
  const idSequence = React.useRef(0);
  const snapshot = history.present;
  const selectedNodes = snapshot.nodes.filter((node) => node.selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  const currentDocument = React.useMemo(
    () => ({
      ...toWorkflowDocument(snapshot, document),
      ...(viewport ? { viewport } : {}),
    }),
    [document, snapshot, viewport],
  );
  React.useEffect(() => onDocumentChange?.(currentDocument), [currentDocument, onDocumentChange]);
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

  const beginNodeEdit = React.useCallback(
    (nodeId: string) => {
      if (!nodeEditStartSnapshot.current) {
        nodeEditStartSnapshot.current = { nodeId, snapshot };
      }
    },
    [snapshot],
  );

  const updateNodeDraft = React.useCallback(
    (nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1) => {
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

  const onNodesChange = React.useCallback(
    (changes: NodeChange<CreateImagesCanvasNode>[]) => {
      const removes = new Set<string>();
      for (const change of changes) {
        if (change.type === "remove") removes.add(change.id);
      }
      const apply = (current: CanvasSnapshot): CanvasSnapshot => ({
        nodes: applyNodeChanges(changes, current.nodes).map((node) => ({
          ...node,
          position: boundedCanvasPosition(node.position),
        })),
        edges:
          removes.size > 0
            ? current.edges.filter((edge) => !removes.has(edge.source) && !removes.has(edge.target))
            : current.edges,
      });
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

  const addNode = React.useCallback(
    (type: CreateImagesNodeType) => {
      const capacity = decideCanvasMutationCapacity(
        snapshot.nodes.length,
        snapshot.edges.length,
        1,
        0,
      );
      if (!capacity.allowed) {
        announce(capacity.message!);
        toast.info(capacity.message!);
        return;
      }
      idSequence.current += 1;
      const id = `${type}-${Date.now()}-${idSequence.current}`;
      const bounds = instanceRef.current?.getViewport();
      const currentZoom = bounds?.zoom ?? 1;
      const workbenchBounds = workbenchRef.current?.getBoundingClientRect();
      const position = instanceRef.current
        ? instanceRef.current.screenToFlowPosition({
            x: workbenchBounds
              ? workbenchBounds.left +
                workbenchBounds.width / 2 -
                (CREATE_IMAGES_NODE_WIDTH * currentZoom) / 2
              : window.innerWidth / 2,
            y: workbenchBounds
              ? workbenchBounds.top +
                workbenchBounds.height / 2 -
                (CREATE_IMAGES_NODE_ESTIMATED_HEIGHT * currentZoom) / 2
              : window.innerHeight / 2,
          })
        : { x: -(bounds?.x ?? 0) + 240, y: -(bounds?.y ?? 0) + 180 };
      const boundedPosition = boundedCanvasPosition(position);
      const workflowNode = newWorkflowNode(type, id, boundedPosition);
      commitSnapshot((current) => ({
        ...current,
        edges: current.edges.map((edge) => ({ ...edge, selected: false })),
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
      setInspectorOpen(!narrowCanvas);
      announce(`${CREATE_IMAGES_NODE_DEFINITIONS[type].title} added.`);
      requestAnimationFrame(() => {
        paletteTriggerRef.current?.focus();
        void instanceRef.current?.fitView({
          nodes: [{ id }],
          duration: createImagesMotionDuration(250),
          padding: 0.2,
          maxZoom: 1,
        });
      });
    },
    [commitSnapshot, narrowCanvas, snapshot.edges.length, snapshot.nodes.length],
  );

  const deleteSelected = React.useCallback(() => {
    const selected = new Set<string>();
    for (const node of snapshot.nodes) {
      if (node.selected) selected.add(node.id);
    }
    if (selected.size === 0) return;
    commitSnapshot((current) => ({
      nodes: current.nodes.filter((node) => !selected.has(node.id)),
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

  const setDropStateForDrag = React.useCallback(
    (action: Parameters<typeof reduceCreateImagesDropState>[1]) =>
      setDropState((current) => reduceCreateImagesDropState(current, action)),
    [],
  );

  const handleCanvasDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
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
    [commitSnapshot, onImportDroppedImages, snapshot.edges.length, snapshot.nodes, setDropState],
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
    const onPaste = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        paletteOpen ||
        !(event.target instanceof Node) ||
        !workbenchRef.current?.contains(event.target) ||
        (event.target instanceof Element &&
          Boolean(event.target.closest("#create-images-validation-issues"))) ||
        isEditableTarget(event.target) ||
        !hasCreateImagesClipboardImage(event)
      ) {
        return;
      }
      event.preventDefault();
      void pasteImageIntoCanvas();
    };
    window.addEventListener("paste", onPaste, { capture: true });
    return () => window.removeEventListener("paste", onPaste, { capture: true });
  }, [paletteOpen, pasteImageIntoCanvas]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        paletteOpen ||
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
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [duplicateSelected, paletteOpen, redo, undo]);

  const paletteTypes = (
    Object.keys(CREATE_IMAGES_NODE_DEFINITIONS) as CreateImagesNodeType[]
  ).filter((type) =>
    CREATE_IMAGES_NODE_DEFINITIONS[type].title
      .toLowerCase()
      .includes(paletteSearch.trim().toLowerCase()),
  );
  const missingAssetIdSet = React.useMemo(() => new Set(missingAssetIds), [missingAssetIds]);

  const canvasActions = React.useMemo(
    () => ({
      providerStatus,
      executionMode,
      updateNode,
      beginNodeEdit,
      updateNodeDraft,
      commitNodeEdit,
      selectNode,
      chooseImage: (nodeId: string) => void chooseImage(nodeId),
      removeImage,
      imageChoicePending: (nodeId: string) => pendingImageNodeId === nodeId,
      retainAssetPreview: onAssetPreviewMount ?? EMPTY_ASSET_PREVIEW_RETAINER,
      assetPreview: (assetId: string) => assetPreviews[assetId],
      assetPreviewStatus: (assetId: string) => onAssetPreviewStatus?.(assetId),
      assetPreviewMissing: (assetId: string) => missingAssetIdSet.has(assetId),
      assetPreviewLoaded: (assetId: string, token: string) => onAssetPreviewLoad?.(assetId, token),
      assetPreviewFailed: (assetId: string, token: string) => onAssetPreviewError?.(assetId, token),
      nodeRunState: (nodeId: string) => runProjection?.nodes[nodeId],
      retainRunAssetPreview: onRunAssetPreviewMount ?? EMPTY_ASSET_PREVIEW_RETAINER,
      runAssetPreview: (assetId: string) => runAssetPreviews[assetId],
      runAssetPreviewLoaded: (assetId: string, token: string) =>
        onRunAssetPreviewLoad?.(assetId, token),
      runAssetPreviewFailed: (assetId: string, token: string) =>
        onRunAssetPreviewError?.(assetId, token),
    }),
    [
      assetPreviews,
      beginNodeEdit,
      chooseImage,
      commitNodeEdit,
      missingAssetIdSet,
      onAssetPreviewLoad,
      pendingImageNodeId,
      removeImage,
      onAssetPreviewError,
      onAssetPreviewMount,
      onAssetPreviewStatus,
      onRunAssetPreviewError,
      onRunAssetPreviewLoad,
      onRunAssetPreviewMount,
      runAssetPreviews,
      runProjection,
      selectNode,
      updateNode,
      updateNodeDraft,
      providerStatus,
      executionMode,
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
        >
          <ReactFlow<CreateImagesCanvasNode, Edge>
            nodes={snapshot.nodes}
            edges={snapshot.edges}
            nodeTypes={NODE_TYPES}
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
            onConnectEnd={(_event, state) => {
              const validatedMessage = rejectedConnectionMessage.current;
              rejectedConnectionMessage.current = null;
              if (state.isValid !== false || !state.fromHandle || !state.toHandle) return;
              const directionMismatch =
                state.fromHandle.type !== "source" || state.toHandle.type !== "target";
              const message =
                validatedMessage ??
                (directionMismatch
                  ? "Connections must run from an output port to an input port."
                  : "That connection is not allowed. Use Manage connections for compatible ports.");
              announce(message);
              toast.info(message);
            }}
            onNodeDragStart={() => {
              dragStartSnapshot.current = snapshot;
            }}
            onNodeDragStop={() => {
              const before = dragStartSnapshot.current;
              dragStartSnapshot.current = null;
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
            panOnScroll
            selectionOnDrag
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
                  onClick={() => setPaletteOpen((open) => !open)}
                >
                  <Plus />
                </Button>
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
            if (!open) setPaletteSearch("");
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
                paletteTriggerRef.current?.focus();
              }}
              className="fixed bottom-16 left-1/2 z-40 w-72 -translate-x-1/2 rounded-card border border-field bg-popover/98 p-2 text-primary shadow-popover outline-none backdrop-blur-xl"
            >
              <DialogPrimitive.Title className="sr-only">Add workflow node</DialogPrimitive.Title>
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
                {paletteTypes.map((type) => {
                  const definition = CREATE_IMAGES_NODE_DEFINITIONS[type];
                  const Icon = NODE_ICONS[type];
                  return (
                    <button
                      type="button"
                      key={type}
                      className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left outline-none hover:bg-list-hover focus-visible:bg-list-selection"
                      onClick={() => addNode(type)}
                    >
                      <span className="flex size-7 items-center justify-center rounded-[8px] bg-control text-secondary">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-small-strong font-medium">
                          {definition.title}
                        </span>
                        <span className="block text-mini text-tertiary">{definition.category}</span>
                      </span>
                    </button>
                  );
                })}
                {paletteTypes.length === 0 ? (
                  <p className="px-2.5 py-5 text-center text-small text-secondary">
                    No nodes match that search.
                  </p>
                ) : null}
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
      </section>
    </CreateImagesCanvasActionsContext.Provider>
  );
}
