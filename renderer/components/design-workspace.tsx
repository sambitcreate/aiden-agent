import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  Controls,
  NodeToolbar,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
  Download,
  AppWindow,
  ArrowRight,
  Check,
  Code2,
  Hand,
  ImagePlus,
  Loader2,
  MessageSquareText,
  Monitor,
  MousePointer2,
  PanelsTopLeft,
  Palette,
  Play,
  Plus,
  ScanSearch,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  Undo2,
  X,
} from "lucide-react";
import type { Attachment, Workspace } from "../lib/types";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import {
  DesignConnectedDirectEditRetryState,
  DesignProjectPersistenceBarrier,
  DesignPrototypeDirectEditRetryState,
  durableDesignWorkspaceArtifactGroups,
  isDesignProjectMetadataOnlyUpdate,
  resolveDesignArtboardPosition,
  snapshotDesignTurnTargets,
  type DesignElementSelectionV1,
  type DesignProjectPersistenceSnapshotV1,
  type DesignTurnTargetV1,
  type DesignWorkspaceArtifactEntry,
  type DesignWorkspaceArtifactGroup,
} from "../shared/design-workspace";
import { chatsApi, designerApi, workspacesApi } from "../lib/ipc";
import { cn } from "../lib/ui-utils";
import {
  Button,
  Dialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Text,
  toast,
} from "./ui";
import { HtmlArtifactIframe } from "./html-artifact-frame";
import { htmlArtifactThemeTokensFromDocument } from "../lib/html-artifact-preview";
import {
  parseSourceElementDescriptor,
  SOURCE_DESIGN_PICKER_COMMAND,
  SOURCE_DESIGN_PICKER_SELECTION,
  type DesignerActionV1,
  type SourceElementDescriptorV1,
  type SourcePreviewStateV1,
  type SourceSelectionBindingV1,
  type SourceDesignerMultifileActionViewV1,
} from "../shared/source-designer";
import { GENERATIVE_UI_ESCAPE_MESSAGE } from "../shared/generative-ui";
import type {
  DesignProjectCanvasV1,
  DesignDirectEditV1,
  DesignProjectDesignerActionSummary,
  DesignProjectInspectorTab,
  DesignProjectRevisionSummary,
  DesignProjectSourceDocument,
  DesignProjectSnapshotV1,
  DesignSystemProjectionV1,
  DesignHandoffRecoveryViewV1,
  ManagedDesignHandoffPreviewV1,
  ExistingDesignHandoffPreviewV1,
} from "../shared/design-projects";
import { DesignProjectInspector } from "./design-project-inspector";
import { DesignCommentsPanel } from "./design-comments-panel";
import { DesignHandoffRecoveryPanel } from "./design-handoff-recovery";
import type {
  DesignCommentProjectViewV1,
  DesignCommentTargetV1,
  DesignCommentV1,
} from "../shared/design-comments";

type DesignViewport = "desktop" | "tablet" | "phone";
type CanvasMode = "select" | "inspect" | "preview" | "hand";

const VIEWPORT_SIZE: Record<DesignViewport, { width: number; height: number }> = {
  desktop: { width: 1200, height: 760 },
  tablet: { width: 768, height: 900 },
  phone: { width: 390, height: 844 },
};
const MAX_CANVAS_IMAGES = 6;
const MAX_CANVAS_IMAGE_BYTES = 8 * 1024 * 1024;

interface DesignArtboardData extends Record<string, unknown> {
  kind: "design";
  chatId: string;
  group: DesignWorkspaceArtifactGroup;
  artifact: ChatHtmlArtifactV1;
  livePreviewAuthority?: string;
  viewport: DesignViewport;
  mode: CanvasMode;
  target?: DesignTurnTargetV1;
  onElementSelect: (
    artifact: ChatHtmlArtifactV1,
    selection: DesignElementSelectionV1,
    additive: boolean,
  ) => void;
  onExitInspect: () => void;
  onVersionChange: (groupId: string, mediaId: string) => void;
  onExport: (artifact: ChatHtmlArtifactV1) => void;
}

interface ImageNodeData extends Record<string, unknown> {
  kind: "image";
  attachment: Attachment;
}

interface SourceArtboardData extends Record<string, unknown> {
  kind: "source";
  title: string;
  src: string;
  capability: string;
  viewport: DesignViewport;
  mode: CanvasMode;
  selectedSelector?: string;
  revision: number;
  onElementSelect: (descriptor: SourceElementDescriptorV1) => void;
  onExitInspect: () => void;
}

type DesignArtboardNode = Node<DesignArtboardData, "designArtboard">;
type DesignImageNode = Node<ImageNodeData, "designImage">;
type SourceArtboardNode = Node<SourceArtboardData, "sourceArtboard">;
type StudioNode = DesignArtboardNode | DesignImageNode | SourceArtboardNode;

function DesignArtboardNodeView({ data, selected }: NodeProps<DesignArtboardNode>) {
  const [preview, setPreview] = React.useState<{
    src: string;
    designCapability?: string;
  }>();
  const [error, setError] = React.useState<string>();
  const [exporting, setExporting] = React.useState(false);
  const size = VIEWPORT_SIZE[data.viewport];

  React.useEffect(() => {
    let cancelled = false;
    void chatsApi
      .htmlArtifactSrcdoc(
        data.chatId,
        data.artifact.mediaId,
        htmlArtifactThemeTokensFromDocument(),
        true,
        data.livePreviewAuthority,
      )
      .then((result) => {
        if (cancelled) return;
        if (!result?.src) {
          setError("This design version is no longer available.");
          return;
        }
        setPreview({
          src: result.src,
          designCapability: result.designCapability,
        });
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load this design.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [data.artifact.id, data.artifact.mediaId, data.chatId, data.livePreviewAuthority]);

  const exportArtifact = React.useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      data.onExport(data.artifact);
    } finally {
      setExporting(false);
    }
  }, [data, exporting]);

  const selectedSelector = data.target?.selection?.selector;
  const iframeInteractive = data.mode === "inspect" || data.mode === "preview";

  return (
    <article
      className={cn(
        "overflow-hidden rounded-card bg-popover shadow-popover transition-shadow duration-150",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-well",
      )}
      style={{ width: size.width, height: size.height + 38 }}
      aria-label={`${data.artifact.title} design artboard`}
      data-design-artboard={data.artifact.mediaId}
    >
      <NodeToolbar
        isVisible={selected}
        position={Position.Top}
        offset={12}
        className="flex items-center gap-1 rounded-popover bg-popover p-1.5 text-primary shadow-popover"
      >
        <span className="design-artboard-drag-handle flex h-8 min-w-0 cursor-grab items-center gap-2 rounded-control px-2 active:cursor-grabbing">
          {data.viewport === "desktop" ? (
            <Monitor className="size-4 text-secondary" aria-hidden="true" />
          ) : data.viewport === "tablet" ? (
            <Tablet className="size-4 text-secondary" aria-hidden="true" />
          ) : (
            <Smartphone className="size-4 text-secondary" aria-hidden="true" />
          )}
          <span className="max-w-56 truncate text-small-strong">{data.group.title}</span>
        </span>
        <span className="mx-1 h-5 w-px bg-separator" aria-hidden="true" />
        <label className="sr-only" htmlFor={`design-version-${data.group.id}`}>
          Version
        </label>
        <select
          id={`design-version-${data.group.id}`}
          value={data.artifact.mediaId}
          onChange={(event) => data.onVersionChange(data.group.id, event.target.value)}
          className="nodrag h-8 rounded-control bg-control px-2 text-small text-primary"
          aria-label={`${data.group.title} version`}
        >
          {data.group.revisions.map((revision, index) => (
            <option key={revision.artifact.mediaId} value={revision.artifact.mediaId}>
              v{index + 1}
              {index === data.group.revisions.length - 1 ? " · latest" : ""}
            </option>
          ))}
        </select>
        <Button
          iconOnly
          size="small"
          variant="transparent"
          aria-label={`Export ${data.artifact.title}`}
          disabled={exporting}
          onClick={() => void exportArtifact()}
          className="nodrag"
        >
          {exporting ? <Loader2 className="animate-spin" /> : <Download aria-hidden="true" />}
        </Button>
      </NodeToolbar>

      <header className="design-artboard-drag-handle flex h-[38px] cursor-grab items-center gap-2 border-b border-separator px-3 active:cursor-grabbing">
        <Text variant="small-strong" truncate className="min-w-0 flex-1">
          {data.group.title}
        </Text>
        <Text variant="small" color="tertiary" className="text-mini">
          {size.width} × {size.height}
        </Text>
      </header>
      <div
        className={cn(
          "nodrag nopan nowheel relative bg-control",
          !iframeInteractive && "pointer-events-none",
        )}
        style={{ width: size.width, height: size.height }}
      >
        {error && preview ? (
          <div className="absolute inset-x-3 top-3 z-10 rounded-control bg-popover px-3 py-2 shadow-control">
            <Text variant="small" color="red">
              {error}
            </Text>
          </div>
        ) : null}
        {preview ? (
          <HtmlArtifactIframe
            src={preview.src}
            title={`${data.artifact.title} ${data.viewport} preview`}
            onEscape={data.onExitInspect}
            designPicker={
              preview.designCapability
                ? {
                    capability: preview.designCapability,
                    enabled: data.mode === "inspect",
                    selectedSelector,
                    onSelect: (selection, additive) =>
                      data.onElementSelect(data.artifact, selection, additive),
                  }
                : undefined
            }
          />
        ) : (
          <div className="grid h-full place-items-center px-8 text-center">
            <Text variant="small" color="secondary">
              {error ?? "Loading design preview…"}
            </Text>
          </div>
        )}
      </div>
    </article>
  );
}

const DesignArtboardNodeMemo = React.memo(DesignArtboardNodeView);

function SourceArtboardNodeView({ data, selected }: NodeProps<SourceArtboardNode>) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const interactive = data.mode === "inspect" || data.mode === "preview";
  const size = VIEWPORT_SIZE[data.viewport];
  const syncPicker = React.useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      {
        type: SOURCE_DESIGN_PICKER_COMMAND,
        capability: data.capability,
        enabled: data.mode === "inspect",
        selectedSelector: data.selectedSelector ?? "",
      },
      "*",
    );
  }, [data.capability, data.mode, data.selectedSelector]);

  React.useEffect(() => {
    const receiveMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data === GENERATIVE_UI_ESCAPE_MESSAGE) {
        data.onExitInspect();
        return;
      }
      if (
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== SOURCE_DESIGN_PICKER_SELECTION ||
        event.data.capability !== data.capability
      ) {
        return;
      }
      const descriptor = parseSourceElementDescriptor(event.data.descriptor);
      if (descriptor) data.onElementSelect(descriptor);
    };
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [data]);
  React.useEffect(syncPicker, [syncPicker]);

  const src = React.useMemo(() => {
    const url = new URL(data.src);
    url.searchParams.set("aidenRevision", String(data.revision));
    return url.toString();
  }, [data.revision, data.src]);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-card bg-popover shadow-popover transition-shadow duration-150",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-well",
      )}
      style={{ width: size.width, height: size.height + 38 }}
      aria-label={`${data.title} source-backed artboard`}
      data-source-design-artboard
    >
      <NodeToolbar
        isVisible={selected}
        position={Position.Top}
        offset={12}
        className="flex items-center gap-2 rounded-popover bg-popover px-2 py-1.5 text-primary shadow-popover"
      >
        <AppWindow className="size-4 text-accent" aria-hidden="true" />
        <Text variant="small-strong" truncate className="max-w-60">
          {data.title}
        </Text>
        <span className="rounded-control bg-list-selection px-2 py-1 text-mini text-secondary">
          Live source
        </span>
      </NodeToolbar>
      <header className="source-artboard-drag-handle flex h-[38px] cursor-grab items-center gap-2 border-b border-separator px-3 active:cursor-grabbing">
        <span className="size-2 rounded-full bg-green" aria-hidden="true" />
        <Text variant="small-strong" truncate className="min-w-0 flex-1">
          {data.title}
        </Text>
        <Text variant="small" color="tertiary" className="text-mini">
          Source-backed · {size.width} × {size.height}
        </Text>
      </header>
      <div
        className={cn(
          "nodrag nopan nowheel relative bg-control",
          !interactive && "pointer-events-none",
        )}
        style={{ width: size.width, height: size.height }}
      >
        <iframe
          ref={frameRef}
          title={`${data.title} local app preview`}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          src={src}
          className="block h-full w-full border-0 bg-control"
          onLoad={syncPicker}
        />
      </div>
    </article>
  );
}

const SourceArtboardNodeMemo = React.memo(SourceArtboardNodeView);

function DesignImageNodeView({ data, selected }: NodeProps<DesignImageNode>) {
  const source = data.attachment.data
    ? `data:${data.attachment.mimeType};base64,${data.attachment.data}`
    : "";
  return (
    <figure
      className={cn(
        "overflow-hidden rounded-card bg-popover p-2 shadow-popover",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-well",
      )}
      data-design-image={data.attachment.id}
    >
      <img
        src={source}
        alt={data.attachment.name}
        draggable={false}
        className="block max-h-[30rem] max-w-[32rem] rounded-[8px] object-contain"
      />
      <figcaption className="mt-2 max-w-[30rem] truncate px-1 text-small text-secondary">
        {data.attachment.name}
      </figcaption>
    </figure>
  );
}

const DesignImageNodeMemo = React.memo(DesignImageNodeView);
const NODE_TYPES: NodeTypes = {
  designArtboard: DesignArtboardNodeMemo,
  designImage: DesignImageNodeMemo,
  sourceArtboard: SourceArtboardNodeMemo,
};

function canvasImageAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const marker = result.indexOf(",");
      if (marker < 0) {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      resolve({
        id: `design-image-${crypto.randomUUID()}`,
        kind: "image",
        name: file.name,
        mimeType: file.type,
        size: file.size,
        data: result.slice(marker + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

function CanvasToolButton({
  label,
  description,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string;
  description: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={shortcut ? `${label} (${shortcut})` : label}
          aria-keyshortcuts={shortcut}
          aria-pressed={active}
          className={cn(
            "design-canvas-control grid size-9 place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-list-hover hover:text-primary",
            active && "bg-list-selection text-accent",
          )}
        >
          {children}
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="right"
          align="center"
          sideOffset={10}
          collisionPadding={12}
          className="z-[70] flex max-w-64 items-start gap-3 rounded-control bg-popover px-2.5 py-2 text-primary shadow-popover"
        >
          <span className="min-w-0">
            <span className="block text-small-strong">{label}</span>
            <span className="mt-0.5 block text-mini text-secondary">{description}</span>
          </span>
          {shortcut ? (
            <kbd className="shrink-0 rounded-control bg-control px-1.5 py-0.5 font-sans text-mini text-secondary">
              {shortcut}
            </kbd>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function DesignWorkspaceCanvas({
  chatId,
  project,
  workspaceId,
  artifacts,
  livePreviewAuthority,
  projectReconciliationError,
  projectReconciliationBusy = false,
  onRetryProjectReconciliation,
  generating,
  initialMediaId,
  unavailableMessage,
  targets,
  sourceSelection,
  selectedImages,
  onTargetsChange,
  onSourceSelectionChange,
  onSelectedImagesChange,
  onRequestComposerFocus,
  onProjectChange,
  onPersistenceBarrierChange,
}: {
  chatId: string;
  project?: DesignProjectSnapshotV1;
  workspaceId?: string;
  artifacts: readonly DesignWorkspaceArtifactEntry[];
  livePreviewAuthority?: string;
  projectReconciliationError?: string;
  projectReconciliationBusy?: boolean;
  onRetryProjectReconciliation?: () => void;
  generating: boolean;
  initialMediaId?: string;
  unavailableMessage?: string;
  targets: readonly DesignTurnTargetV1[];
  sourceSelection?: SourceSelectionBindingV1;
  selectedImages: readonly Attachment[];
  onTargetsChange: (targets: DesignTurnTargetV1[]) => void;
  onSourceSelectionChange: (selection: SourceSelectionBindingV1 | undefined) => void;
  onSelectedImagesChange: (images: Attachment[]) => void;
  onRequestComposerFocus: () => void;
  onProjectChange: (project: DesignProjectSnapshotV1) => void;
  onPersistenceBarrierChange?: (
    barrier: (() => Promise<DesignProjectPersistenceSnapshotV1 | undefined>) | undefined,
  ) => void;
}) {
  const navigate = useNavigate();
  const [viewport, setViewport] = React.useState<DesignViewport>("desktop");
  const [mode, setMode] = React.useState<CanvasMode>("select");
  const [activeVersions, setActiveVersions] = React.useState<Record<string, string>>({});
  const activeVersionsRef = React.useRef(activeVersions);
  activeVersionsRef.current = activeVersions;
  const [canvasImages, setCanvasImages] = React.useState<Attachment[]>([]);
  const [sourcePreview, setSourcePreview] = React.useState<SourcePreviewStateV1>();
  const [previewSetupOpen, setPreviewSetupOpen] = React.useState(false);
  const [previewBusy, setPreviewBusy] = React.useState(false);
  const [connectionOpen, setConnectionOpen] = React.useState(false);
  const [connectionBusy, setConnectionBusy] = React.useState(false);
  const [connectionWorkspaces, setConnectionWorkspaces] = React.useState<Workspace[]>([]);
  const [connectionWorkspaceId, setConnectionWorkspaceId] = React.useState("");
  const [sourceRevision, setSourceRevision] = React.useState(0);
  const [designerActions, setDesignerActions] = React.useState<DesignerActionV1[]>([]);
  const [actionBusy, setActionBusy] = React.useState(false);
  const [multifileActions, setMultifileActions] = React.useState<
    SourceDesignerMultifileActionViewV1[]
  >([]);
  const [multifileBusy, setMultifileBusy] = React.useState(false);
  const [dismissedMultifileActionId, setDismissedMultifileActionId] = React.useState<string>();
  const [flowSaveRevision, setFlowSaveRevision] = React.useState(0);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [commentsOpen, setCommentsOpen] = React.useState(false);
  const [commentView, setCommentView] = React.useState<DesignCommentProjectViewV1>();
  const [connectedCommentTarget, setConnectedCommentTarget] =
    React.useState<DesignCommentTargetV1>();
  const [commentsLoading, setCommentsLoading] = React.useState(false);
  const [commentsError, setCommentsError] = React.useState<string>();
  const [inspectorTab, setInspectorTab] = React.useState<DesignProjectInspectorTab>("preview");
  const [inspectorFind, setInspectorFind] = React.useState("");
  const [comparisonMediaId, setComparisonMediaId] = React.useState<string>();
  const [selectedGroupId, setSelectedGroupId] = React.useState<string>();
  const [sourceByMediaId, setSourceByMediaId] = React.useState<
    Record<
      string,
      DesignProjectSourceDocument & {
        revisionId: string;
        lineageId: string;
        createdAt: number;
        model?: string;
      }
    >
  >({});
  const [generatedSourceLoadingMediaIds, setGeneratedSourceLoadingMediaIds] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const [generatedSourceErrors, setGeneratedSourceErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [connectedSource, setConnectedSource] = React.useState<DesignProjectSourceDocument>();
  const [connectedSourceLoading, setConnectedSourceLoading] = React.useState(false);
  const [designSystemOpen, setDesignSystemOpen] = React.useState(false);
  const [designSystemBusy, setDesignSystemBusy] = React.useState(false);
  const [designSystemName, setDesignSystemName] = React.useState("App design system");
  const [designPackageRoot, setDesignPackageRoot] = React.useState(".");
  const [designRouteScope, setDesignRouteScope] = React.useState("/");
  const [designTokenPath, setDesignTokenPath] = React.useState("");
  const [designCatalogPath, setDesignCatalogPath] = React.useState("");
  const [designSystemProjection, setDesignSystemProjection] =
    React.useState<DesignSystemProjectionV1>();
  const [designSystemModelContext, setDesignSystemModelContext] = React.useState<unknown>();
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [handoffPreview, setHandoffPreview] = React.useState<
    ManagedDesignHandoffPreviewV1 | ExistingDesignHandoffPreviewV1
  >();
  const [handoffTargetKind, setHandoffTargetKind] = React.useState<"managed" | "existing">(
    "managed",
  );
  const [handoffWorkspaces, setHandoffWorkspaces] = React.useState<Workspace[]>([]);
  const [handoffWorkspaceId, setHandoffWorkspaceId] = React.useState("");
  const [dirtyCheckoutAcknowledged, setDirtyCheckoutAcknowledged] = React.useState(false);
  const [existingWorkspaceAcknowledged, setExistingWorkspaceAcknowledged] = React.useState(false);
  const [handoffLinks, setHandoffLinks] = React.useState<
    Array<{
      workspaceId: string;
      chatId: string;
      taskId: string;
      branchLabel: string;
    }>
  >([]);
  const [activeHandoffOperationId, setActiveHandoffOperationId] = React.useState<string>();
  const [handoffRecoveries, setHandoffRecoveries] = React.useState<DesignHandoffRecoveryViewV1[]>(
    [],
  );
  const [handoffRecoveriesLoading, setHandoffRecoveriesLoading] = React.useState(false);
  const [handoffRecoveriesError, setHandoffRecoveriesError] = React.useState<string>();
  const [handoffRecoveryBusyId, setHandoffRecoveryBusyId] = React.useState<string>();
  const [directEditOpen, setDirectEditOpen] = React.useState(false);
  const [directEditBusy, setDirectEditBusy] = React.useState(false);
  const [directEditControl, setDirectEditControl] = React.useState<
    "padding" | "gap" | "width" | "height" | "alignment" | "radius" | "text" | "color"
  >("padding");
  const [directEditValue, setDirectEditValue] = React.useState("16px");
  const [directEditArtifacts, setDirectEditArtifacts] = React.useState<
    DesignWorkspaceArtifactEntry[]
  >([]);
  const [prototypeDirectEditUndo, setPrototypeDirectEditUndo] = React.useState<{
    undoId: string;
    lineageId: string;
    nodeId: string;
    editedMediaId: string;
    revertMediaId: string;
  }>();
  const [prototypeDirectEditUndoBusy, setPrototypeDirectEditUndoBusy] = React.useState(false);
  const [nodes, setNodes] = React.useState<StudioNode[]>([]);
  const nodesRef = React.useRef(nodes);
  nodesRef.current = nodes;
  const [savedProject, setSavedProject] = React.useState(project);
  const connectedWorkspaceId =
    savedProject?.connectionState === "connected" ? savedProject.workspaceId : undefined;
  const [latestExport, setLatestExport] = React.useState<
    { id: string; fileName: string } | undefined
  >();
  const [assetsHydrated, setAssetsHydrated] = React.useState(!project);
  const [missingReferenceAssetIds, setMissingReferenceAssetIds] = React.useState<string[]>([]);
  const [referenceRepairBusyAssetId, setReferenceRepairBusyAssetId] = React.useState<string>();
  const savedProjectRef = React.useRef(project);
  const flowRef = React.useRef<ReactFlowInstance<StudioNode> | null>(null);
  const flowViewportRef = React.useRef(project?.canvas.flowViewport ?? { x: 0, y: 0, zoom: 1 });
  const assetIdByNodeRef = React.useRef(new Map<string, string>());
  const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persistenceBarrierRef = React.useRef(
    new DesignProjectPersistenceBarrier<DesignProjectPersistenceSnapshotV1 | undefined>(),
  );
  const prototypeDirectEditRetryRef = React.useRef(new DesignPrototypeDirectEditRetryState());
  const connectedDirectEditRetryRef = React.useRef(new DesignConnectedDirectEditRetryState());
  const persistAttemptRef = React.useRef<
    (canvas?: DesignProjectCanvasV1) => Promise<DesignProjectSnapshotV1 | undefined>
  >(async () => undefined);
  const lastPersistedCanvasRef = React.useRef(project ? JSON.stringify(project.canvas) : undefined);
  const uploadRef = React.useRef<HTMLInputElement | null>(null);
  const groups = React.useMemo(
    () =>
      durableDesignWorkspaceArtifactGroups(savedProject, [...artifacts, ...directEditArtifacts]),
    [artifacts, directEditArtifacts, savedProject],
  );
  const selectedGroup = groups.find(({ id }) => id === selectedGroupId);
  const selectedGroupNode = savedProject?.canvas.nodes.find(
    (node) => node.kind === "artboard" && node.id === selectedGroupId,
  );
  const selectedMediaId = selectedGroup
    ? (activeVersions[selectedGroup.id] ??
      selectedGroupNode?.activeMediaId ??
      selectedGroup.revisions[selectedGroup.revisions.length - 1]?.artifact.mediaId)
    : undefined;
  const selectedSource = selectedMediaId ? sourceByMediaId[selectedMediaId] : connectedSource;
  const compareSource = comparisonMediaId ? sourceByMediaId[comparisonMediaId] : undefined;
  const selectedRevisionKey =
    selectedGroup?.revisions.map(({ artifact }) => artifact.mediaId).join("\0") ?? "";
  const selectedDirectEditTarget = targets.find(
    (target) =>
      target.mediaId === selectedMediaId &&
      target.selection?.elementId &&
      target.selection.selector === `[data-aiden-id="${target.selection.elementId}"]`,
  );
  const requestedDirectEdit = React.useMemo<DesignDirectEditV1>(() => {
    const value = directEditValue.trim();
    return directEditControl === "padding"
      ? { kind: "spacing", property: "padding", value }
      : directEditControl === "gap"
        ? { kind: "spacing", property: "gap", value }
        : directEditControl === "width"
          ? { kind: "size", property: "width", value }
          : directEditControl === "height"
            ? { kind: "size", property: "height", value }
            : directEditControl === "alignment"
              ? {
                  kind: "alignment",
                  property: "justify-content",
                  value: value as "center",
                }
              : directEditControl === "radius"
                ? { kind: "radius", property: "border-radius", value }
                : directEditControl === "color"
                  ? {
                      kind: "color-token",
                      property: "background-color",
                      token: value,
                    }
                  : { kind: "static-text", text: directEditValue };
  }, [directEditControl, directEditValue]);
  const prototypeDirectEditPayload = React.useMemo(
    () =>
      !sourceSelection &&
      savedProject &&
      selectedGroupNode?.lineageId &&
      selectedMediaId &&
      selectedDirectEditTarget?.selection
        ? {
            projectId: savedProject.id,
            lineageId: selectedGroupNode.lineageId,
            mediaId: selectedMediaId,
            selection: selectedDirectEditTarget.selection,
            edit: requestedDirectEdit,
          }
        : undefined,
    [
      requestedDirectEdit,
      savedProject,
      selectedDirectEditTarget?.selection,
      selectedGroupNode?.lineageId,
      selectedMediaId,
      sourceSelection,
    ],
  );
  React.useEffect(() => {
    prototypeDirectEditRetryRef.current.resetUnless(prototypeDirectEditPayload);
  }, [prototypeDirectEditPayload]);
  const connectedDirectEditPayload = React.useMemo(
    () =>
      sourceSelection && savedProject
        ? {
            projectId: savedProject.id,
            sourceSelectionId: sourceSelection.id,
            edit: requestedDirectEdit,
          }
        : undefined,
    [requestedDirectEdit, savedProject, sourceSelection],
  );
  React.useEffect(() => {
    connectedDirectEditRetryRef.current.resetUnless(connectedDirectEditPayload);
  }, [connectedDirectEditPayload]);
  const generatedCommentTarget = React.useMemo<DesignCommentTargetV1 | undefined>(() => {
    if (!savedProject || !selectedGroupNode?.lineageId || !selectedMediaId) {
      return undefined;
    }
    const selected = targets.find(
      (target) => target.mediaId === selectedMediaId && target.selection,
    );
    if (
      !selected?.selection?.elementId ||
      selected.selection.selector !== `[data-aiden-id="${selected.selection.elementId}"]`
    ) {
      return undefined;
    }
    return {
      projectId: savedProject.id,
      lineageId: selectedGroupNode.lineageId,
      mediaId: selectedMediaId,
      element: {
        selector: selected.selection.selector,
        selectorMatchCount: 1,
        tagName: selected.selection.tagName,
        ...(selected.selection.elementId ? { elementId: selected.selection.elementId } : {}),
      },
      source: {
        kind: "generated-artifact",
        artifactId: selected.artifactId,
      },
    };
  }, [savedProject, selectedGroupNode?.lineageId, selectedMediaId, targets]);
  const currentCommentTarget = generatedCommentTarget ?? connectedCommentTarget;
  const targetsRef = React.useRef(targets);
  React.useLayoutEffect(() => {
    targetsRef.current = targets;
  }, [targets]);
  const publishTargets = React.useCallback(
    (next: DesignTurnTargetV1[]) => {
      targetsRef.current = next;
      onTargetsChange(next);
    },
    [onTargetsChange],
  );

  React.useEffect(() => {
    const previousProject = savedProjectRef.current;
    const preserveTransientEdits = Boolean(
      previousProject && project && isDesignProjectMetadataOnlyUpdate(previousProject, project),
    );
    setSavedProject(project);
    savedProjectRef.current = project;
    if (preserveTransientEdits) {
      lastPersistedCanvasRef.current = project ? JSON.stringify(project.canvas) : undefined;
      return;
    }
    setDirectEditArtifacts([]);
    setPrototypeDirectEditUndo(undefined);
    setAssetsHydrated(!project);
    setMissingReferenceAssetIds([]);
    if (!project) return;
    setViewport(project.canvas.viewport);
    flowViewportRef.current = project.canvas.flowViewport;
    lastPersistedCanvasRef.current = JSON.stringify(project.canvas);
    assetIdByNodeRef.current = new Map(
      project.canvas.nodes.flatMap((node) =>
        node.kind === "reference-image" && node.assetId ? [[node.id, node.assetId]] : [],
      ),
    );
    setActiveVersions(
      Object.fromEntries(
        project.canvas.nodes.flatMap((node) =>
          node.kind === "artboard" && node.activeMediaId ? [[node.id, node.activeMediaId]] : [],
        ),
      ),
    );
    let cancelled = false;
    void Promise.all(
      project.canvas.nodes.flatMap((node) =>
        node.kind === "reference-image" && node.assetId
          ? [
              designerApi.readReferenceAsset(node.assetId).then((result) => ({
                assetId: node.assetId!,
                image: result
                  ? {
                      id: node.id,
                      kind: "image" as const,
                      name: result.asset.name,
                      mimeType: result.asset.mimeType,
                      size: result.asset.size,
                      data: result.data,
                    }
                  : undefined,
              })),
            ]
          : [],
      ),
    )
      .then((results) => {
        if (!cancelled) {
          setCanvasImages(results.flatMap(({ image }) => (image === undefined ? [] : [image])));
          setMissingReferenceAssetIds([
            ...new Set(
              results.flatMap(({ assetId, image }) => (image === undefined ? [assetId] : [])),
            ),
          ]);
          setAssetsHydrated(true);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          toast.error(cause instanceof Error ? cause.message : "Reference images need repair.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const loadHandoffRecoveries = React.useCallback(async (projectId: string) => {
    setHandoffRecoveriesLoading(true);
    setHandoffRecoveriesError(undefined);
    try {
      const records = await designerApi.projectHandoffRecoveries(projectId);
      if (savedProjectRef.current?.id === projectId) setHandoffRecoveries(records);
    } catch (cause) {
      if (savedProjectRef.current?.id === projectId) {
        setHandoffRecoveriesError(
          cause instanceof Error ? cause.message : "Preserved handoffs could not be loaded.",
        );
      }
    } finally {
      if (savedProjectRef.current?.id === projectId) setHandoffRecoveriesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    setHandoffRecoveries([]);
    setHandoffRecoveriesError(undefined);
    setHandoffRecoveriesLoading(false);
    if (!project?.id) return;
    void loadHandoffRecoveries(project.id);
  }, [loadHandoffRecoveries, project?.id]);

  React.useEffect(() => {
    if (!savedProject) {
      setHandoffLinks([]);
      return;
    }
    let cancelled = false;
    void designerApi
      .projectHandoffLinks(savedProject.id)
      .then((links) => {
        if (!cancelled) setHandoffLinks(links);
      })
      .catch(() => {
        if (!cancelled) setHandoffLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [savedProject?.id]);

  React.useEffect(() => {
    if (!savedProject?.id) {
      setLatestExport(undefined);
      return;
    }
    let cancelled = false;
    void designerApi
      .latestProjectExport(savedProject.id)
      .then((record) => {
        if (!cancelled) setLatestExport(record);
      })
      .catch(() => {
        if (!cancelled) setLatestExport(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [savedProject?.id]);

  const loadComments = React.useCallback(async () => {
    if (!savedProject?.id) return;
    setCommentsLoading(true);
    setCommentsError(undefined);
    try {
      setCommentView(await designerApi.listComments(savedProject.id));
    } catch (cause) {
      setCommentsError(cause instanceof Error ? cause.message : "Comments are unavailable.");
    } finally {
      setCommentsLoading(false);
    }
  }, [savedProject?.id]);

  React.useEffect(() => {
    setCommentView(undefined);
    setCommentsError(undefined);
    if (commentsOpen) void loadComments();
  }, [commentsOpen, loadComments, savedProject?.id]);

  const updateCommentStatus = React.useCallback(
    async (comment: DesignCommentV1, operation: "resolve" | "reopen") => {
      const currentProject = savedProjectRef.current;
      const currentView = commentView;
      if (!currentProject || !currentView) return;
      setCommentsLoading(true);
      setCommentsError(undefined);
      try {
        const input = {
          projectId: currentProject.id,
          id: comment.id,
          expectedRevision: comment.revision,
          expectedDatabaseRevision: currentView.databaseRevision,
        };
        setCommentView(
          operation === "resolve"
            ? await designerApi.resolveComment(input)
            : await designerApi.reopenComment(input),
        );
      } catch (cause) {
        setCommentsError(cause instanceof Error ? cause.message : "The comment changed.");
        await loadComments();
      } finally {
        setCommentsLoading(false);
      }
    },
    [commentView, loadComments],
  );

  React.useEffect(() => {
    if (!commentsOpen || !commentView || !currentCommentTarget) return;
    const requiresReconciliation = commentView.comments.some(
      (comment) =>
        !comment.stale &&
        comment.target.lineageId === currentCommentTarget.lineageId &&
        comment.target.mediaId !== currentCommentTarget.mediaId,
    );
    if (!requiresReconciliation) return;
    let cancelled = false;
    void designerApi
      .reconcileCommentTarget({
        expectedDatabaseRevision: commentView.databaseRevision,
        current: currentCommentTarget,
      })
      .then((view) => {
        if (!cancelled) setCommentView(view);
      })
      .catch(() => {
        if (!cancelled) void loadComments();
      });
    return () => {
      cancelled = true;
    };
  }, [commentView, commentsOpen, currentCommentTarget, loadComments]);

  const hydrateGeneratedSource = React.useCallback(
    async (projectId: string, lineageId: string, mediaId: string): Promise<boolean> => {
      setGeneratedSourceLoadingMediaIds((current) => new Set([...current, mediaId]));
      setGeneratedSourceErrors((current) => {
        const next = { ...current };
        delete next[mediaId];
        return next;
      });
      try {
        const source = await designerApi.readGeneratedSource(projectId, lineageId, mediaId);
        setSourceByMediaId((current) => ({ ...current, [mediaId]: source }));
        return true;
      } catch (cause) {
        setSourceByMediaId((current) => {
          const next = { ...current };
          delete next[mediaId];
          return next;
        });
        setGeneratedSourceErrors((current) => ({
          ...current,
          [mediaId]:
            cause instanceof Error ? cause.message : "The saved source could not be loaded.",
        }));
        return false;
      } finally {
        setGeneratedSourceLoadingMediaIds((current) => {
          const next = new Set(current);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!savedProject || !selectedGroup || !selectedGroupNode?.lineageId) {
      setSourceByMediaId({});
      setGeneratedSourceErrors({});
      setGeneratedSourceLoadingMediaIds(new Set());
      return;
    }
    let cancelled = false;
    const mediaIds = selectedGroup.revisions.map(({ artifact }) => artifact.mediaId);
    setSourceByMediaId({});
    setGeneratedSourceErrors({});
    setGeneratedSourceLoadingMediaIds(new Set(mediaIds));
    for (const mediaId of mediaIds) {
      void designerApi
        .readGeneratedSource(savedProject.id, selectedGroupNode.lineageId!, mediaId)
        .then((source) => {
          if (!cancelled)
            setSourceByMediaId((current) => ({
              ...current,
              [mediaId]: source,
            }));
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setGeneratedSourceErrors((current) => ({
              ...current,
              [mediaId]:
                cause instanceof Error ? cause.message : "The saved source could not be loaded.",
            }));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setGeneratedSourceLoadingMediaIds((current) => {
              const next = new Set(current);
              next.delete(mediaId);
              return next;
            });
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [savedProject?.id, selectedGroupId, selectedGroupNode?.lineageId, selectedRevisionKey]);

  React.useEffect(() => {
    if (!connectedWorkspaceId || !savedProject || unavailableMessage) {
      setSourcePreview(undefined);
      setDesignerActions([]);
      setMultifileActions([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      designerApi.previewState({ projectId: savedProject.id }),
      designerApi.listActions({ projectId: savedProject.id }),
      ...(savedProject ? [designerApi.listMultifileActions(savedProject.id)] : []),
    ])
      .then(([preview, actions, multifile]) => {
        if (cancelled) return;
        setSourcePreview(preview);
        setDesignerActions(actions);
        setMultifileActions(multifile ?? []);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          toast.error(cause instanceof Error ? cause.message : "Could not open local app tools.");
        }
      });
    const offPreview = designerApi.onPreviewChanged((payload) => {
      if (payload.projectId === savedProject.id) setSourcePreview(payload.state);
    });
    const offAction = designerApi.onActionChanged(({ action }) => {
      if (
        action.projectId !== savedProject.id ||
        action.chatId !== chatId ||
        action.workspaceId !== connectedWorkspaceId
      )
        return;
      setDesignerActions((current) => [
        action,
        ...current.filter((candidate) => candidate.id !== action.id),
      ]);
    });
    const offMultifile = designerApi.onMultifileActionChanged(({ action }) => {
      if (action.projectId !== savedProject?.id || action.workspaceId !== connectedWorkspaceId)
        return;
      setDismissedMultifileActionId(undefined);
      setMultifileActions((current) => [
        action,
        ...current.filter((candidate) => candidate.actionId !== action.actionId),
      ]);
    });
    return () => {
      cancelled = true;
      offPreview();
      offAction();
      offMultifile();
    };
  }, [chatId, connectedWorkspaceId, savedProject?.id, unavailableMessage]);

  React.useEffect(() => {
    if (!savedProject || !sourceSelection) {
      setConnectedSource(undefined);
      setConnectedSourceLoading(false);
      return;
    }
    let cancelled = false;
    setConnectedSource(undefined);
    setConnectedSourceLoading(true);
    void designerApi
      .readConnectedSource(savedProject.id, sourceSelection.id)
      .then((source) => {
        if (!cancelled) {
          setConnectedSource(source);
          setConnectedSourceLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setConnectedSource(undefined);
        setConnectedSourceLoading(false);
        toast.error(cause instanceof Error ? cause.message : "The workspace source is stale.");
      });
    return () => {
      cancelled = true;
    };
  }, [savedProject, sourceSelection]);

  React.useEffect(() => {
    if (!savedProject?.designSystemBinding) {
      setDesignSystemProjection(undefined);
      return;
    }
    let cancelled = false;
    void Promise.all([
      designerApi.designSystemProjection(savedProject.id),
      designerApi.designSystemModelContext(savedProject.id),
    ])
      .then(([projection, modelContext]) => {
        if (!cancelled) {
          setDesignSystemProjection(projection);
          setDesignSystemModelContext(modelContext);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesignSystemProjection(undefined);
          setDesignSystemModelContext(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [savedProject?.designSystemBinding, savedProject?.id]);

  React.useEffect(() => {
    let cancelled = false;
    setConnectedCommentTarget(undefined);
    if (!savedProject || !sourceSelection) return;
    void designerApi
      .connectedCommentTarget(savedProject.id, sourceSelection.id)
      .then((target) => {
        if (!cancelled) setConnectedCommentTarget(target);
      })
      .catch(() => {
        if (!cancelled) setConnectedCommentTarget(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [savedProject?.id, sourceSelection]);

  const acceptProjectUpdate = React.useCallback(
    (next: DesignProjectSnapshotV1) => {
      savedProjectRef.current = next;
      setSavedProject(next);
      onProjectChange(next);
    },
    [onProjectChange],
  );

  const openProjectConnection = React.useCallback(async () => {
    if (!savedProjectRef.current || connectionBusy) return;
    setConnectionBusy(true);
    try {
      const candidates = (await workspacesApi.list()).filter(
        (workspace) =>
          Boolean(workspace.folderPath) &&
          workspace.permission !== "none" &&
          !workspace.managedWorktree,
      );
      setConnectionWorkspaces(candidates);
      setConnectionWorkspaceId((selected) =>
        candidates.some(({ id }) => id === selected)
          ? selected
          : (candidates.find(({ id }) => id === savedProjectRef.current?.workspaceId)?.id ??
            candidates[0]?.id ??
            ""),
      );
      setConnectionOpen(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Local app workspaces are unavailable.");
    } finally {
      setConnectionBusy(false);
    }
  }, [connectionBusy]);

  const connectProject = React.useCallback(async () => {
    const current = savedProjectRef.current;
    if (!current || !connectionWorkspaceId || connectionBusy) return;
    setConnectionBusy(true);
    try {
      const result = await designerApi.connectProject({
        projectId: current.id,
        expectedRevision: current.revision,
        workspaceId: connectionWorkspaceId,
      });
      if (result.status === "conflict") {
        acceptProjectUpdate(result.current);
        throw new Error("This Design Project changed. Review it before connecting again.");
      }
      acceptProjectUpdate(result.project);
      setSourcePreview(undefined);
      setDesignerActions([]);
      setMultifileActions([]);
      onSourceSelectionChange(undefined);
      setConnectionOpen(false);
      toast.success(
        current.connectionState === "prototype-only"
          ? "Prototype connected. Its conversation and revisions are unchanged."
          : "Local app connection updated.",
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The local app could not be connected.");
    } finally {
      setConnectionBusy(false);
    }
  }, [acceptProjectUpdate, connectionBusy, connectionWorkspaceId, onSourceSelectionChange]);

  const updateDesignSystem = React.useCallback(async () => {
    const current = savedProjectRef.current;
    if (!current || designSystemBusy) return;
    setDesignSystemBusy(true);
    try {
      if (current.designSystemBinding) {
        const result = await designerApi.refreshDesignSystem({
          projectId: current.id,
          expectedRevision: current.revision,
        });
        acceptProjectUpdate(result.project);
        setDesignSystemProjection(result.projection);
        setDesignSystemModelContext(await designerApi.designSystemModelContext(result.project.id));
        toast.success("Design system refreshed from the reviewed files.");
      } else {
        const sources = [
          ...(designTokenPath.trim()
            ? [
                {
                  workspaceRelativePath: designTokenPath.trim(),
                  kind: "tokens-v1" as const,
                },
              ]
            : []),
          ...(designCatalogPath.trim()
            ? [
                {
                  workspaceRelativePath: designCatalogPath.trim(),
                  kind: "catalog-v1" as const,
                },
              ]
            : []),
        ];
        const result = await designerApi.attachDesignSystem({
          projectId: current.id,
          expectedRevision: current.revision,
          name: designSystemName.trim(),
          packageRoot: designPackageRoot.trim(),
          routeScope: designRouteScope.trim(),
          sources,
        });
        acceptProjectUpdate(result.project);
        setDesignSystemProjection(result.projection);
        setDesignSystemModelContext(await designerApi.designSystemModelContext(result.project.id));
        toast.success("Design system attached as read-only model context.");
      }
      setDesignSystemOpen(false);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "The design system could not be updated.",
      );
    } finally {
      setDesignSystemBusy(false);
    }
  }, [
    acceptProjectUpdate,
    designCatalogPath,
    designPackageRoot,
    designRouteScope,
    designSystemBusy,
    designSystemName,
    designTokenPath,
  ]);

  const detachDesignSystem = React.useCallback(async () => {
    const current = savedProjectRef.current;
    if (!current?.designSystemBinding || designSystemBusy) return;
    setDesignSystemBusy(true);
    try {
      const next = await designerApi.detachDesignSystem({
        projectId: current.id,
        expectedRevision: current.revision,
      });
      acceptProjectUpdate(next);
      setDesignSystemProjection(undefined);
      setDesignSystemModelContext(undefined);
      setDesignSystemOpen(false);
      toast.success("Design system detached.");
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "The design system could not be detached.",
      );
    } finally {
      setDesignSystemBusy(false);
    }
  }, [acceptProjectUpdate, designSystemBusy]);

  const previewHandoff = React.useCallback(async () => {
    const current = savedProjectRef.current;
    if (!current || handoffBusy) return;
    setHandoffBusy(true);
    try {
      if (current.connectionState === "connected" && current.workspaceId) {
        const preview =
          handoffTargetKind === "managed"
            ? await designerApi.previewManagedHandoff(current.id)
            : await designerApi.previewExistingHandoff(current.id);
        setHandoffPreview(preview);
        setDirtyCheckoutAcknowledged(preview.kind === "managed-worktree" && !preview.dirtyCheckout);
        setExistingWorkspaceAcknowledged(false);
      } else {
        const candidates = (await workspacesApi.list()).filter(
          (workspace) => Boolean(workspace.folderPath) && !workspace.managedWorktree,
        );
        setHandoffWorkspaces(candidates);
        setHandoffWorkspaceId((selected) =>
          candidates.some(({ id }) => id === selected) ? selected : (candidates[0]?.id ?? ""),
        );
        setHandoffPreview(undefined);
      }
      setHandoffOpen(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The handoff target is unavailable.");
    } finally {
      setHandoffBusy(false);
    }
  }, [handoffBusy, handoffTargetKind]);

  const reviewHandoffTarget = React.useCallback(async () => {
    const current = savedProjectRef.current;
    if (
      !current ||
      (current.connectionState === "prototype-only" && !handoffWorkspaceId) ||
      handoffBusy
    )
      return;
    setHandoffBusy(true);
    try {
      const preview =
        handoffTargetKind === "managed"
          ? await designerApi.previewManagedHandoff(current.id, handoffWorkspaceId || undefined)
          : await designerApi.previewExistingHandoff(current.id, handoffWorkspaceId || undefined);
      setHandoffPreview(preview);
      setDirtyCheckoutAcknowledged(preview.kind === "managed-worktree" && !preview.dirtyCheckout);
      setExistingWorkspaceAcknowledged(false);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The handoff target is unavailable.");
    } finally {
      setHandoffBusy(false);
    }
  }, [handoffBusy, handoffTargetKind, handoffWorkspaceId]);

  const beginHandoff = React.useCallback(async () => {
    const current = savedProjectRef.current;
    if (
      !current ||
      !handoffPreview ||
      !selectedGroupNode?.lineageId ||
      !selectedMediaId ||
      handoffBusy
    ) {
      return;
    }
    setHandoffBusy(true);
    const operationId = `handoff:${crypto.randomUUID()}`;
    setActiveHandoffOperationId(operationId);
    try {
      const base = {
        projectId: current.id,
        expectedRevision: current.revision,
        lineageId: selectedGroupNode.lineageId,
        mediaId: selectedMediaId,
        previewDigest: handoffPreview.previewDigest,
        operationId,
      };
      const result =
        handoffPreview.kind === "managed-worktree"
          ? await designerApi.beginManagedHandoff({
              ...base,
              dirtyCheckoutAcknowledged,
              ...(current.connectionState === "prototype-only"
                ? { sourceWorkspaceId: handoffPreview.source.workspaceId }
                : {}),
            })
          : await designerApi.beginExistingHandoff({
              ...base,
              strongWarningAcknowledged: existingWorkspaceAcknowledged,
              ...(current.connectionState === "prototype-only"
                ? { sourceWorkspaceId: handoffPreview.target.workspaceId }
                : {}),
            });
      if (result.status === "published" && result.record.linkage) {
        setHandoffOpen(false);
        toast.success("Managed workspace and implementation task created.");
        void navigate({
          to: "/chat/$chatId",
          params: { chatId: result.record.linkage.chatId },
        });
        return;
      }
      toast.error(
        result.record.recoveryReason ??
          "The managed workspace was preserved and needs recovery review.",
      );
      await loadHandoffRecoveries(current.id);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The handoff could not be completed.");
      await loadHandoffRecoveries(current.id);
    } finally {
      setActiveHandoffOperationId(undefined);
      setHandoffBusy(false);
    }
  }, [
    dirtyCheckoutAcknowledged,
    existingWorkspaceAcknowledged,
    handoffBusy,
    handoffPreview,
    loadHandoffRecoveries,
    navigate,
    selectedGroupNode?.lineageId,
    selectedMediaId,
  ]);

  const runHandoffRecovery = React.useCallback(
    async (record: DesignHandoffRecoveryViewV1, operation: "resume" | "cancel") => {
      const current = savedProjectRef.current;
      if (!current || handoffRecoveryBusyId) return;
      setHandoffRecoveryBusyId(record.operationId);
      try {
        const result =
          operation === "resume"
            ? await designerApi.resumeHandoff(record.operationId)
            : await designerApi.cancelHandoff(record.operationId);
        if (result.status === "published" && result.record.linkage) {
          toast.success("Handoff completed.");
          void navigate({
            to: "/chat/$chatId",
            params: { chatId: result.record.linkage.chatId },
          });
        } else if (result.status === "rolled-back") {
          toast.info("Handoff cancelled and rolled back.");
        } else {
          toast.error(
            result.record.recoveryReason ?? "The preserved handoff still needs recovery review.",
          );
        }
        await loadHandoffRecoveries(current.id);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "The handoff operation failed.");
      } finally {
        setHandoffRecoveryBusyId(undefined);
      }
    },
    [handoffRecoveryBusyId, loadHandoffRecoveries, navigate],
  );

  const bindSourceSelection = React.useCallback(
    async (descriptor: SourceElementDescriptorV1) => {
      if (!connectedWorkspaceId || sourcePreview?.status !== "running") return;
      try {
        const projectId = savedProjectRef.current?.id;
        if (!projectId) return;
        const binding = await designerApi.bindSelection({
          projectId,
          sessionId: sourcePreview.sessionId,
          descriptor,
        });
        onSourceSelectionChange(binding);
        publishTargets([]);
        onSelectedImagesChange([]);
      } catch (cause) {
        onSourceSelectionChange(undefined);
        toast.error(
          cause instanceof Error
            ? cause.message
            : "That element does not expose exact React source metadata.",
        );
      }
    },
    [
      connectedWorkspaceId,
      onSelectedImagesChange,
      onSourceSelectionChange,
      publishTargets,
      sourcePreview,
    ],
  );

  const startSourcePreview = React.useCallback(
    async (scriptId: string) => {
      if (!connectedWorkspaceId || previewBusy) return;
      setPreviewBusy(true);
      try {
        const current = savedProjectRef.current;
        if (current?.connectionState === "connected") {
          const saved = await designerApi.updateProject({
            id: current.id,
            expectedRevision: current.revision,
            canvas: current.canvas,
            referenceAssetIds: current.referenceAssetIds,
            ...(current.designSystemBinding
              ? { designSystemBinding: current.designSystemBinding }
              : {}),
            previewScriptId: scriptId,
          });
          if (saved.status === "conflict") {
            acceptProjectUpdate(saved.current);
            throw new Error("The project changed. Review the restored preview configuration.");
          }
          acceptProjectUpdate(saved.project);
        }
        const projectId = savedProjectRef.current?.id;
        if (!projectId) throw new Error("This Design Project is unavailable.");
        const state = await designerApi.startPreview({ projectId, scriptId });
        setSourcePreview(state);
        setPreviewSetupOpen(false);
        requestAnimationFrame(() => void flowRef.current?.fitView({ padding: 0.18, maxZoom: 0.9 }));
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not start the local app.");
      } finally {
        setPreviewBusy(false);
      }
    },
    [acceptProjectUpdate, connectedWorkspaceId, previewBusy],
  );

  const stopSourcePreview = React.useCallback(async () => {
    if (!connectedWorkspaceId || previewBusy) return;
    setPreviewBusy(true);
    try {
      const projectId = savedProjectRef.current?.id;
      if (!projectId) throw new Error("This Design Project is unavailable.");
      await designerApi.stopPreview({ projectId });
      setSourcePreview(await designerApi.previewState({ projectId }));
      onSourceSelectionChange(undefined);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not stop the local app.");
    } finally {
      setPreviewBusy(false);
    }
  }, [connectedWorkspaceId, onSourceSelectionChange, previewBusy]);

  const exportArtifact = React.useCallback(
    async (artifact: ChatHtmlArtifactV1) => {
      try {
        await chatsApi.exportHtmlArtifact(chatId, artifact.mediaId);
      } catch {
        toast.error("Aiden couldn't export this design.");
      }
    },
    [chatId],
  );

  const applyDirectEdit = React.useCallback(async () => {
    if (
      !savedProject ||
      (!connectedDirectEditPayload && !prototypeDirectEditPayload) ||
      directEditBusy
    ) {
      return;
    }
    setDirectEditBusy(true);
    try {
      if (connectedDirectEditPayload) {
        const operationId = connectedDirectEditRetryRef.current.operationIdFor(
          connectedDirectEditPayload,
        );
        await designerApi.applyConnectedDirectEdit({
          operationId,
          ...connectedDirectEditPayload,
        });
        connectedDirectEditRetryRef.current.complete(operationId);
        setDirectEditOpen(false);
        toast.success("Designer Action ready for exact review.");
        return;
      }
      if (!prototypeDirectEditPayload || !selectedGroupNode) {
        throw new Error("Select one exact generated element before editing it.");
      }
      const operationId = prototypeDirectEditRetryRef.current.operationIdFor(
        prototypeDirectEditPayload,
      );
      const result = await designerApi.applyPrototypeDirectEdit({
        operationId,
        ...prototypeDirectEditPayload,
      });
      prototypeDirectEditRetryRef.current.complete(operationId);
      const revertMediaId = prototypeDirectEditPayload.mediaId;
      acceptProjectUpdate(result.project);
      setDirectEditArtifacts((current) => [
        ...current.filter(({ artifact }) => artifact.mediaId !== result.artifact.mediaId),
        { artifact: result.artifact, source: "persisted" },
      ]);
      setActiveVersions((current) => ({
        ...current,
        [selectedGroupNode.id]: result.artifact.mediaId,
      }));
      setPrototypeDirectEditUndo({
        undoId: result.undoId,
        lineageId: prototypeDirectEditPayload.lineageId,
        nodeId: selectedGroupNode.id,
        editedMediaId: result.artifact.mediaId,
        revertMediaId,
      });
      const sourceHydrated = await hydrateGeneratedSource(
        result.project.id,
        prototypeDirectEditPayload.lineageId,
        result.artifact.mediaId,
      );
      setDirectEditOpen(false);
      publishTargets([]);
      if (sourceHydrated) {
        toast.success("Created a new immutable Design revision.");
      } else {
        toast.info("Direct edit saved. Reload the Code view to read its source.");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The direct edit could not be proven.");
    } finally {
      setDirectEditBusy(false);
    }
  }, [
    acceptProjectUpdate,
    connectedDirectEditPayload,
    directEditBusy,
    hydrateGeneratedSource,
    publishTargets,
    prototypeDirectEditPayload,
    savedProject,
    selectedGroupNode,
  ]);

  const undoPrototypeDirectEdit = React.useCallback(async () => {
    const current = savedProjectRef.current;
    const undo = prototypeDirectEditUndo;
    if (!current || !undo || prototypeDirectEditUndoBusy) return;
    setPrototypeDirectEditUndoBusy(true);
    try {
      const result = await designerApi.undoPrototypeDirectEdit({
        projectId: current.id,
        lineageId: undo.lineageId,
        editedMediaId: undo.editedMediaId,
        revertMediaId: undo.revertMediaId,
        undoId: undo.undoId,
      });
      acceptProjectUpdate(result.project);
      setDirectEditArtifacts((artifacts) => [
        ...artifacts.filter(({ artifact }) => artifact.mediaId !== result.artifact.mediaId),
        { artifact: result.artifact, source: "persisted" },
      ]);
      setActiveVersions((versions) => ({
        ...versions,
        [undo.nodeId]: result.artifact.mediaId,
      }));
      const sourceHydrated = await hydrateGeneratedSource(
        result.project.id,
        undo.lineageId,
        result.artifact.mediaId,
      );
      setPrototypeDirectEditUndo(undefined);
      publishTargets([]);
      if (sourceHydrated) {
        toast.success("Created a new exact-revert Design revision.");
      } else {
        toast.info("Undo saved. Reload the Code view to read its source.");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The direct edit could not be undone.");
    } finally {
      setPrototypeDirectEditUndoBusy(false);
    }
  }, [
    acceptProjectUpdate,
    hydrateGeneratedSource,
    prototypeDirectEditUndo,
    prototypeDirectEditUndoBusy,
    publishTargets,
  ]);

  const selectElement = React.useCallback(
    (artifact: ChatHtmlArtifactV1, selection: DesignElementSelectionV1, additive: boolean) => {
      const target: DesignTurnTargetV1 = {
        mediaId: artifact.mediaId,
        artifactId: artifact.id,
        selection,
      };
      const current = targetsRef.current;
      const next = additive
        ? [...current.filter((item) => item.mediaId !== artifact.mediaId), target].slice(-5)
        : [target];
      publishTargets(next);
      const group = groups.find((candidate) =>
        candidate.revisions.some(({ artifact: revision }) => revision.mediaId === artifact.mediaId),
      );
      setSelectedGroupId(group?.id);
      setInspectorOpen(Boolean(group));
      if (!additive) {
        onSelectedImagesChange([]);
        onSourceSelectionChange(undefined);
      }
    },
    [groups, onSelectedImagesChange, onSourceSelectionChange, publishTargets],
  );

  const changeVersion = React.useCallback(
    (groupId: string, mediaId: string) => {
      const nextActiveVersions = {
        ...activeVersionsRef.current,
        [groupId]: mediaId,
      };
      activeVersionsRef.current = nextActiveVersions;
      setActiveVersions(nextActiveVersions);
      const group = groups.find((candidate) => candidate.id === groupId);
      const artifact = group?.revisions.find(
        (revision) => revision.artifact.mediaId === mediaId,
      )?.artifact;
      if (!artifact) return;
      const nextTargets = targetsRef.current.map((target) =>
        group?.revisions.some((revision) => revision.artifact.mediaId === target.mediaId)
          ? { mediaId: artifact.mediaId, artifactId: artifact.id }
          : target,
      );
      publishTargets(nextTargets);
    },
    [groups, publishTargets],
  );

  const buildDurableCanvas = React.useCallback(
    (currentNodes: readonly StudioNode[]): DesignProjectCanvasV1 | undefined => {
      const currentProject = savedProjectRef.current;
      if (!currentProject) return undefined;
      const previous = new Map(currentProject.canvas.nodes.map((node) => [node.id, node]));
      const durableNodes: DesignProjectCanvasV1["nodes"] = [];
      for (const node of currentNodes) {
        if (node.type === "designArtboard") {
          const data = node.data as DesignArtboardData;
          const prior = previous.get(node.id);
          // Generated lineage and revision membership are published by main.
          // The canvas may persist layout and the user's active-version choice,
          // but it must never infer ownership from streamed renderer artifacts.
          if (prior?.kind !== "artboard") continue;
          const requestedActiveMediaId =
            activeVersionsRef.current[node.id] ?? data.artifact.mediaId;
          durableNodes.push({
            ...prior,
            x: node.position.x,
            y: node.position.y,
            activeMediaId: prior.artifactMediaIds?.includes(requestedActiveMediaId)
              ? requestedActiveMediaId
              : prior.activeMediaId,
          });
          continue;
        }
        if (node.type === "designImage") {
          const assetId = assetIdByNodeRef.current.get(node.id);
          if (!assetId) continue;
          durableNodes.push({
            id: node.id,
            kind: "reference-image" as const,
            canonicalOrigin: "reference-asset" as const,
            x: node.position.x,
            y: node.position.y,
            assetId,
          });
          continue;
        }
        durableNodes.push({
          id: `source-preview:${currentProject.workspaceId ?? "unbound"}`,
          kind: "source-preview" as const,
          canonicalOrigin: "connected-app" as const,
          x: node.position.x,
          y: node.position.y,
        });
      }
      for (const previousNode of currentProject.canvas.nodes) {
        if (!durableNodes.some(({ id }) => id === previousNode.id)) {
          durableNodes.push(previousNode);
        }
      }
      return {
        viewport,
        flowViewport: flowViewportRef.current,
        nodes: durableNodes,
      };
    },
    [viewport],
  );

  const persistLatestCanvas = React.useCallback(
    async (canvasSnapshot?: DesignProjectCanvasV1) => {
      const currentProject = savedProjectRef.current;
      if (!currentProject) return undefined;
      const canvas = canvasSnapshot ?? buildDurableCanvas(nodes);
      if (!canvas) return currentProject;
      const serialized = JSON.stringify(canvas);
      if (serialized === lastPersistedCanvasRef.current) return currentProject;
      const result = await designerApi.updateProject({
        id: currentProject.id,
        expectedRevision: currentProject.revision,
        canvas,
        referenceAssetIds: canvas.nodes.flatMap((node) =>
          node.kind === "reference-image" && node.assetId ? [node.assetId] : [],
        ),
        ...(currentProject.designSystemBinding
          ? { designSystemBinding: currentProject.designSystemBinding }
          : {}),
        ...(currentProject.previewScriptId
          ? { previewScriptId: currentProject.previewScriptId }
          : {}),
      });
      if (result.status === "conflict") {
        acceptProjectUpdate(result.current);
        lastPersistedCanvasRef.current = JSON.stringify(result.current.canvas);
        setNodes([]);
        throw new Error(
          "This canvas changed in another window. The latest version was restored. Select the revision again before sending.",
        );
      }
      acceptProjectUpdate(result.project);
      lastPersistedCanvasRef.current = serialized;
      return result.project;
    },
    [acceptProjectUpdate, buildDurableCanvas, nodes],
  );
  persistAttemptRef.current = persistLatestCanvas;

  const flushProjectPersistence = React.useCallback(() => {
    const targetSnapshot = snapshotDesignTurnTargets(targetsRef.current);
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = undefined;
    return persistenceBarrierRef.current.flush(async () => {
      // An earlier debounce save may advance savedProjectRef while this flush
      // waits. Rebuild only after acquiring the barrier so immutable ownership
      // and expectedRevision both come from that latest persisted project.
      const canvasSnapshot = buildDurableCanvas(nodesRef.current);
      const persistedProject = await persistAttemptRef.current(canvasSnapshot);
      return persistedProject ? { project: persistedProject, targets: targetSnapshot } : undefined;
    });
  }, [buildDurableCanvas]);

  React.useEffect(() => {
    onPersistenceBarrierChange?.(flushProjectPersistence);
    return () => onPersistenceBarrierChange?.(undefined);
  }, [flushProjectPersistence, onPersistenceBarrierChange]);

  React.useEffect(() => {
    if (!savedProject || !assetsHydrated) return;
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = undefined;
      void flushProjectPersistence().catch((cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : "The canvas could not be saved.");
      });
    }, 350);
    return () => clearTimeout(persistTimerRef.current);
  }, [
    activeVersions,
    assetsHydrated,
    canvasImages,
    flowSaveRevision,
    nodes,
    flushProjectPersistence,
    savedProject,
    viewport,
  ]);

  React.useEffect(() => {
    setNodes((current) => {
      const savedPositions = new Map(
        savedProject?.canvas.nodes.map((node) => [node.id, { x: node.x, y: node.y }]) ?? [],
      );
      const currentPositions = new Map(current.map((node) => [node.id, node.position]));
      const positions = new Map(savedPositions);
      for (const [nodeId, position] of currentPositions) positions.set(nodeId, position);
      const positionsByMediaId = new Map<string, { x: number; y: number }>();
      for (const node of current) {
        if (node.type !== "designArtboard") continue;
        const data = node.data as DesignArtboardData;
        for (const revision of data.group.revisions) {
          positionsByMediaId.set(revision.artifact.mediaId, node.position);
        }
      }
      const sourceNode: SourceArtboardNode[] =
        sourcePreview?.status === "running"
          ? [
              {
                id: `source-preview:${connectedWorkspaceId ?? "unbound"}`,
                type: "sourceArtboard",
                position: positions.get(`source-preview:${connectedWorkspaceId ?? "unbound"}`) ?? {
                  x: 0,
                  y: 0,
                },
                selected: Boolean(sourceSelection),
                draggable: mode === "select",
                selectable: mode === "select",
                dragHandle: ".source-artboard-drag-handle",
                data: {
                  kind: "source",
                  title: sourcePreview.script.label,
                  src: sourcePreview.src,
                  capability: sourcePreview.capability,
                  viewport,
                  mode,
                  selectedSelector: sourceSelection?.selection.selector,
                  revision: sourceRevision,
                  onElementSelect: (descriptor) => void bindSourceSelection(descriptor),
                  onExitInspect: () => setMode("select"),
                },
              },
            ]
          : [];
      const sourceOffset = sourceNode.length > 0 ? VIEWPORT_SIZE[viewport].width + 120 : 0;
      const designNodes: DesignArtboardNode[] = groups.map((group, index) => {
        const requested =
          activeVersions[group.id] ??
          (initialMediaId &&
          group.revisions.some((item) => item.artifact.mediaId === initialMediaId)
            ? initialMediaId
            : undefined);
        const revision =
          group.revisions.find((item) => item.artifact.mediaId === requested) ??
          group.revisions[group.revisions.length - 1]!;
        const artifact = revision.artifact;
        const target = targets.find((item) => item.mediaId === artifact.mediaId);
        return {
          id: group.id,
          type: "designArtboard",
          position: resolveDesignArtboardPosition({
            groupId: group.id,
            revisionMediaIds: group.revisions.map(({ artifact: item }) => item.mediaId),
            positionsByNodeId: currentPositions,
            positionsByMediaId,
            fallback: savedPositions.get(group.id) ?? {
              x: sourceOffset + index * (VIEWPORT_SIZE[viewport].width + 120),
              y: 0,
            },
          }),
          selected: Boolean(target),
          draggable: mode === "select",
          selectable: mode === "select",
          dragHandle: ".design-artboard-drag-handle",
          data: {
            kind: "design",
            chatId,
            group,
            artifact,
            ...(revision.source === "live" && livePreviewAuthority ? { livePreviewAuthority } : {}),
            viewport,
            mode,
            target,
            onElementSelect: selectElement,
            onExitInspect: () => setMode("select"),
            onVersionChange: changeVersion,
            onExport: (item) => void exportArtifact(item),
          },
        };
      });
      const imageNodes: DesignImageNode[] = canvasImages.map((attachment, index) => ({
        id: attachment.id,
        type: "designImage",
        position: positions.get(attachment.id) ?? {
          x: index * 560,
          y: VIEWPORT_SIZE[viewport].height + 220,
        },
        selected: selectedImages.some((item) => item.id === attachment.id),
        draggable: mode === "select",
        selectable: mode === "select",
        data: { kind: "image", attachment },
      }));
      return [...sourceNode, ...designNodes, ...imageNodes];
    });
  }, [
    activeVersions,
    bindSourceSelection,
    canvasImages,
    changeVersion,
    chatId,
    exportArtifact,
    groups,
    initialMediaId,
    livePreviewAuthority,
    mode,
    selectElement,
    selectedImages,
    sourcePreview,
    sourceRevision,
    sourceSelection,
    savedProject,
    targets,
    viewport,
    workspaceId,
  ]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      if (event.key.toLowerCase() === "v") setMode("select");
      if (event.key.toLowerCase() === "h") setMode("hand");
      if (event.key.toLowerCase() === "e") setMode("inspect");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onNodesChange = React.useCallback((changes: NodeChange<StudioNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onSelectionChange = React.useCallback(
    ({ nodes: selectedNodes }: { nodes: StudioNode[] }) => {
      if (mode !== "select") return;
      const nextTargets: DesignTurnTargetV1[] = [];
      const nextImages: Attachment[] = [];
      const existingTargets = new Map(targetsRef.current.map((target) => [target.mediaId, target]));
      let sourceSelected = false;
      for (const node of selectedNodes) {
        if (node.type === "designImage") {
          nextImages.push((node.data as ImageNodeData).attachment);
          continue;
        }
        if (node.type === "sourceArtboard") {
          sourceSelected = true;
          continue;
        }
        const designData = node.data as DesignArtboardData;
        setSelectedGroupId(designData.group.id);
        const existing = existingTargets.get(designData.artifact.mediaId);
        nextTargets.push(
          existing ?? {
            mediaId: designData.artifact.mediaId,
            artifactId: designData.artifact.id,
          },
        );
      }
      publishTargets(nextTargets.slice(0, 5));
      if (nextTargets.length > 0) setInspectorOpen(true);
      onSelectedImagesChange(nextImages.slice(0, 5));
      if (!sourceSelected || nextTargets.length > 0 || nextImages.length > 0) {
        onSourceSelectionChange(undefined);
      }
    },
    [mode, onSelectedImagesChange, onSourceSelectionChange, publishTargets],
  );

  const addImages = React.useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const remaining = MAX_CANVAS_IMAGES - canvasImages.length;
      const accepted = Array.from(files)
        .filter((file) => file.type.startsWith("image/") && file.size <= MAX_CANVAS_IMAGE_BYTES)
        .slice(0, remaining);
      if (accepted.length === 0) {
        toast.info("Choose images up to 8 MB each.");
        return;
      }
      try {
        const rawAttachments = await Promise.all(accepted.map(canvasImageAttachment));
        const attachments = await Promise.all(
          rawAttachments.map(async (attachment) => {
            if (!attachment.data) throw new Error(`Could not persist ${attachment.name}.`);
            const asset = await designerApi.putReferenceAsset({
              name: attachment.name,
              mimeType: attachment.mimeType,
              data: attachment.data,
            });
            const nodeId = `reference-node:${crypto.randomUUID()}`;
            assetIdByNodeRef.current.set(nodeId, asset.id);
            return { ...attachment, id: nodeId };
          }),
        );
        setCanvasImages((current) => [...current, ...attachments]);
        onSelectedImagesChange(attachments);
        publishTargets([]);
        onSourceSelectionChange(undefined);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not add those images.");
      }
    },
    [canvasImages.length, onSelectedImagesChange, onSourceSelectionChange, publishTargets],
  );

  const removeMissingReferenceAsset = React.useCallback(
    async (assetId: string) => {
      const current = savedProjectRef.current;
      if (!current || referenceRepairBusyAssetId) return;
      setReferenceRepairBusyAssetId(assetId);
      try {
        const result = await designerApi.removeMissingReferenceAsset({
          projectId: current.id,
          expectedRevision: current.revision,
          assetId,
        });
        if (result.status === "conflict") {
          acceptProjectUpdate(result.current);
          toast.error(
            "This project changed before the missing image could be removed. The latest version was restored.",
          );
          return;
        }
        acceptProjectUpdate(result.project);
        setMissingReferenceAssetIds((assetIds) =>
          assetIds.filter((candidate) => candidate !== assetId),
        );
        toast.success("Missing reference image removed.");
      } catch (cause) {
        toast.error(
          cause instanceof Error
            ? cause.message
            : "The missing reference image could not be removed.",
        );
      } finally {
        setReferenceRepairBusyAssetId(undefined);
      }
    },
    [acceptProjectUpdate, referenceRepairBusyAssetId],
  );

  const updateDesignerAction = React.useCallback(
    async (action: DesignerActionV1, operation: "apply" | "reject" | "undo") => {
      if (actionBusy || !connectedWorkspaceId || !savedProject) return;
      setActionBusy(true);
      try {
        const updated =
          operation === "apply"
            ? await designerApi.applyAction({
                projectId: savedProject.id,
                actionId: action.id,
              })
            : operation === "undo"
              ? await designerApi.undoAction({
                  projectId: savedProject.id,
                  actionId: action.id,
                })
              : await designerApi.rejectAction({
                  projectId: savedProject.id,
                  actionId: action.id,
                });
        setDesignerActions((current) => [
          updated,
          ...current.filter((candidate) => candidate.id !== updated.id),
        ]);
        if (operation === "apply" || operation === "undo") {
          setSourceRevision((current) => current + 1);
          onSourceSelectionChange(undefined);
        }
        if (updated.status === "stale") {
          toast.error(updated.message ?? "The source changed before the action could finish.");
        } else if (updated.status === "applied") {
          toast.success("Designer Action applied.");
        } else if (updated.status === "undone") {
          toast.success("Designer Action undone.");
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "The Designer Action failed.");
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, connectedWorkspaceId, onSourceSelectionChange, savedProject],
  );

  const reviewAction =
    designerActions.find((action) => action.status === "pending") ??
    designerActions.find((action) => action.status === "applied");
  const reviewMultifileAction = multifileActions.find(
    (action) =>
      action.actionId !== dismissedMultifileActionId &&
      ["prepared", "committed", "recoverable"].includes(action.stage),
  );
  const updateMultifileAction = React.useCallback(
    async (action: SourceDesignerMultifileActionViewV1, operation: "apply" | "undo") => {
      if (multifileBusy || !savedProject) return;
      setMultifileBusy(true);
      try {
        const updated =
          operation === "apply"
            ? await designerApi.applyMultifileAction(savedProject.id, action.actionId)
            : await designerApi.undoMultifileAction(savedProject.id, action.actionId);
        setMultifileActions((current) => [
          updated,
          ...current.filter((candidate) => candidate.actionId !== updated.actionId),
        ]);
        setSourceRevision((current) => current + 1);
        onSourceSelectionChange(undefined);
        if (updated.stage === "recoverable") {
          toast.error("This Designer Action needs conflict recovery review.");
        } else {
          toast.success(operation === "apply" ? "Multi-file action applied." : "Action undone.");
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "The multi-file action failed.");
      } finally {
        setMultifileBusy(false);
      }
    },
    [multifileBusy, onSourceSelectionChange, savedProject],
  );
  const revisionSummaries: DesignProjectRevisionSummary[] =
    selectedGroup?.revisions.map(({ artifact }, index) => {
      const source = sourceByMediaId[artifact.mediaId];
      return {
        id: artifact.mediaId,
        lineageId: selectedGroupNode?.lineageId ?? `unavailable:${artifact.id}`,
        label: artifact.title || `Revision ${index + 1}`,
        createdAt: source?.createdAt ?? savedProject?.createdAt ?? 0,
        provenance: source?.provenance ?? "Generated by Aiden",
        ...(source?.model ? { model: source.model } : {}),
        active: artifact.mediaId === selectedMediaId,
      };
    }) ?? [];
  const designerActionSummaries: DesignProjectDesignerActionSummary[] = designerActions.map(
    (action) => ({
      id: action.id,
      label: action.label,
      createdAt: action.createdAt,
      status: action.status,
      fileLabel: action.path,
    }),
  );
  designerActionSummaries.push(
    ...multifileActions.map((action) => ({
      id: action.actionId,
      label: action.label,
      createdAt: action.createdAt,
      status:
        action.stage === "prepared"
          ? ("pending" as const)
          : action.stage === "committed"
            ? ("applied" as const)
            : action.stage === "undone"
              ? ("undone" as const)
              : ("stale" as const),
      fileLabel: `${action.files.length} files`,
    })),
  );
  const missingReferenceNotice = missingReferenceAssetIds[0] ? (
    <MissingReferenceRepairNotice
      count={missingReferenceAssetIds.length}
      busy={referenceRepairBusyAssetId === missingReferenceAssetIds[0]}
      onRemove={() => void removeMissingReferenceAsset(missingReferenceAssetIds[0]!)}
    />
  ) : null;
  const projectReconciliationNotice = projectReconciliationError ? (
    <ProjectReconciliationNotice
      message={projectReconciliationError}
      busy={projectReconciliationBusy}
      offset={Boolean(missingReferenceNotice)}
      onRetry={onRetryProjectReconciliation}
    />
  ) : null;

  if (unavailableMessage) {
    return (
      <section
        className="relative grid h-full place-items-center bg-well px-8"
        aria-label="Design workspace canvas"
      >
        {missingReferenceNotice}
        {projectReconciliationNotice}
        {savedProject?.connectionState === "connected" ? (
          <ProjectConnectionControl
            mode="reconnect"
            open={connectionOpen}
            busy={connectionBusy}
            workspaces={connectionWorkspaces}
            workspaceId={connectionWorkspaceId}
            onWorkspaceChange={setConnectionWorkspaceId}
            onOpen={() => void openProjectConnection()}
            onOpenChange={setConnectionOpen}
            onConfirm={() => void connectProject()}
          />
        ) : null}
        <DesignEmptyState
          title="Design is unavailable here"
          description={unavailableMessage}
          generating={false}
        />
      </section>
    );
  }

  if (groups.length === 0 && canvasImages.length === 0 && sourcePreview?.status !== "running") {
    return (
      <section
        className="relative grid h-full min-h-[32rem] place-items-center overflow-hidden bg-well px-8"
        aria-label="Design workspace canvas"
        data-design-workspace-canvas
      >
        {missingReferenceNotice}
        {projectReconciliationNotice}
        <CanvasToolRail
          mode={mode}
          onModeChange={setMode}
          onNewDesign={onRequestComposerFocus}
          onUpload={() => uploadRef.current?.click()}
        />
        {savedProject?.connectionState === "prototype-only" ? (
          <ProjectConnectionControl
            mode="connect"
            open={connectionOpen}
            busy={connectionBusy}
            workspaces={connectionWorkspaces}
            workspaceId={connectionWorkspaceId}
            onWorkspaceChange={setConnectionWorkspaceId}
            onOpen={() => void openProjectConnection()}
            onOpenChange={setConnectionOpen}
            onConfirm={() => void connectProject()}
          />
        ) : savedProject?.connectionState === "connected" ? (
          <SourcePreviewControl
            state={sourcePreview}
            open={previewSetupOpen}
            busy={previewBusy}
            onOpenChange={setPreviewSetupOpen}
            onStart={(scriptId) => void startSourcePreview(scriptId)}
            onStop={() => void stopSourcePreview()}
          />
        ) : null}
        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          multiple
          aria-label="Add reference images to canvas"
          className="sr-only"
          onChange={(event) => {
            void addImages(event.target.files);
            event.target.value = "";
          }}
        />
        <DesignEmptyState
          title={generating ? "Building your first interface…" : "What should we design?"}
          description={
            generating
              ? "Aiden is turning your brief into responsive artboards on the canvas."
              : "Describe one screen or a whole flow below. You can also add reference images to the canvas."
          }
          generating={generating}
        />
      </section>
    );
  }

  return (
    <section
      className="relative h-full min-h-[32rem] w-full min-w-0 overflow-hidden bg-well text-primary"
      aria-label="Design workspace canvas"
      data-design-workspace-canvas
      data-design-preview-stage
      data-canvas-mode={mode}
    >
      {missingReferenceNotice}
      {projectReconciliationNotice}
      <ReactFlow<StudioNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onInit={(instance) => {
          flowRef.current = instance;
          if (savedProject) {
            void instance.setViewport(savedProject.canvas.flowViewport);
          } else {
            requestAnimationFrame(() => void instance.fitView({ padding: 0.18, maxZoom: 0.9 }));
          }
        }}
        onMoveEnd={(_event, nextViewport) => {
          flowViewportRef.current = nextViewport;
          setFlowSaveRevision((current) => current + 1);
        }}
        fitView={!savedProject}
        fitViewOptions={{ padding: 0.18, maxZoom: 0.9 }}
        minZoom={0.12}
        maxZoom={2}
        panOnDrag={mode === "hand"}
        zoomOnScroll
        selectionOnDrag={mode === "select"}
        nodesDraggable={mode === "select"}
        nodesConnectable={false}
        elementsSelectable={mode === "select"}
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode="Shift"
        className="aiden-design-flow"
        aria-label="Infinite design canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      <CanvasToolRail
        mode={mode}
        onModeChange={setMode}
        onNewDesign={() => {
          publishTargets([]);
          onSelectedImagesChange([]);
          onRequestComposerFocus();
        }}
        onUpload={() => uploadRef.current?.click()}
      />
      {savedProject?.connectionState === "prototype-only" ? (
        <ProjectConnectionControl
          mode="connect"
          open={connectionOpen}
          busy={connectionBusy}
          workspaces={connectionWorkspaces}
          workspaceId={connectionWorkspaceId}
          onWorkspaceChange={setConnectionWorkspaceId}
          onOpen={() => void openProjectConnection()}
          onOpenChange={setConnectionOpen}
          onConfirm={() => void connectProject()}
        />
      ) : savedProject?.connectionState === "connected" ? (
        <SourcePreviewControl
          state={sourcePreview}
          open={previewSetupOpen}
          busy={previewBusy}
          onOpenChange={setPreviewSetupOpen}
          onStart={(scriptId) => void startSourcePreview(scriptId)}
          onStop={() => void stopSourcePreview()}
          savedScriptId={savedProject.previewScriptId}
        />
      ) : null}
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        multiple
        aria-label="Add reference images to canvas"
        className="sr-only"
        onChange={(event) => {
          void addImages(event.target.files);
          event.target.value = "";
        }}
      />

      <div className="design-canvas-toolbar absolute right-4 top-4 z-20 flex items-center gap-1 rounded-popover bg-popover p-1 shadow-control">
        {(["desktop", "tablet", "phone"] as const).map((id) => {
          const Icon = id === "desktop" ? Monitor : id === "tablet" ? Tablet : Smartphone;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={viewport === id}
              aria-label={`${id} artboards`}
              onClick={() => setViewport(id)}
              className={cn(
                "design-canvas-control grid size-8 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary",
                viewport === id && "bg-list-selection text-accent",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </button>
          );
        })}
        <span className="mx-1 h-5 w-px bg-separator" aria-hidden="true" />
        <Button
          size="small"
          variant="accent"
          disabled={handoffBusy || !selectedGroupNode?.lineageId || !selectedMediaId}
          onClick={() => void previewHandoff()}
          aria-label="Continue in workspace"
          title="Create an isolated managed worktree and a normal implementation task"
          className="design-canvas-continue design-canvas-control"
        >
          <span className="design-canvas-continue-label">Continue in workspace</span>
          <ArrowRight aria-hidden="true" />
        </Button>
        <button
          type="button"
          disabled={!selectedDirectEditTarget && !sourceSelection}
          onClick={() => setDirectEditOpen(true)}
          className="design-canvas-control grid size-8 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary disabled:opacity-40"
          aria-label="Edit selected element"
          title={
            sourceSelection
              ? "Create a reviewable Designer Action for this exact connected element"
              : selectedDirectEditTarget
                ? "Create a literal, immutable revision for this element"
                : "Select one stable element in a generated artboard"
          }
        >
          <SlidersHorizontal className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-pressed={inspectorOpen}
          disabled={!selectedGroup && !sourceSelection}
          onClick={() => {
            setInspectorOpen((open) => !open);
            setCommentsOpen(false);
          }}
          className="design-canvas-control grid size-8 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary disabled:opacity-40"
          aria-label="Toggle Design inspector"
        >
          <Code2 className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-pressed={designSystemOpen}
          disabled={savedProject?.connectionState !== "connected"}
          onClick={() => setDesignSystemOpen(true)}
          className="design-canvas-control grid size-8 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary disabled:opacity-40"
          aria-label={
            savedProject?.designSystemBinding
              ? "Manage attached design system"
              : "Attach a design system"
          }
          title={
            savedProject?.connectionState === "connected"
              ? designSystemProjection?.freshness === "current"
                ? `${designSystemProjection.snapshot?.name ?? "Design system"} is current`
                : "Attach or verify a local design system"
              : "Connect a local app before attaching its design system"
          }
        >
          <Palette className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-pressed={commentsOpen}
          disabled={!savedProject}
          onClick={() => {
            setCommentsOpen((open) => !open);
            setInspectorOpen(false);
          }}
          className="design-canvas-control grid size-8 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary disabled:opacity-40"
          aria-label="Toggle Design comments"
        >
          <MessageSquareText className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void flowRef.current?.fitView({ padding: 0.18, maxZoom: 0.9 })}
          className="design-canvas-control h-8 rounded-control px-2 text-small-strong text-secondary hover:bg-list-hover hover:text-primary"
        >
          Fit
        </button>
        {generating ? (
          <Loader2 className="mx-2 size-4 animate-spin text-secondary" aria-label="Generating" />
        ) : null}
      </div>

      <Dialog
        open={directEditOpen}
        onOpenChange={(open) => {
          if (!directEditBusy) setDirectEditOpen(open);
        }}
        title="Edit selected element"
        description={
          sourceSelection
            ? "Only a unique, non-repeated component chain can change. A successful edit creates a Designer Action for exact review; it does not write source yet."
            : "Only exact literal HTML values can change. A successful edit creates a new immutable revision; it never rewrites the previous source."
        }
        confirmLabel={sourceSelection ? "Create Designer Action" : "Create revision"}
        confirmDisabled={!directEditValue.trim() || (!selectedDirectEditTarget && !sourceSelection)}
        busy={directEditBusy}
        onConfirm={applyDirectEdit}
      >
        <div className="grid gap-3">
          <label className="grid gap-1 text-small-strong">
            Control
            <select
              value={directEditControl}
              onChange={(event) => {
                const control = event.currentTarget.value as typeof directEditControl;
                setDirectEditControl(control);
                setDirectEditValue(
                  control === "alignment"
                    ? "center"
                    : control === "text"
                      ? (selectedDirectEditTarget?.selection?.text ?? "Text")
                      : control === "color"
                        ? "--color-action-primary"
                        : control === "width" || control === "height"
                          ? "100%"
                          : "16px",
                );
              }}
              className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
            >
              <option value="padding">Padding</option>
              <option value="gap">Gap</option>
              <option value="width">Width</option>
              <option value="height">Height</option>
              <option value="alignment">Horizontal alignment</option>
              <option value="radius">Corner radius</option>
              <option value="text">Static text</option>
              <option value="color">Background semantic token</option>
            </select>
          </label>
          <label className="grid gap-1 text-small-strong">
            {directEditControl === "color"
              ? "CSS custom property"
              : directEditControl === "text"
                ? "Text"
                : "Value"}
            {directEditControl === "alignment" ? (
              <select
                value={directEditValue}
                onChange={(event) => setDirectEditValue(event.currentTarget.value)}
                className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
              >
                <option value="start">Start</option>
                <option value="center">Center</option>
                <option value="end">End</option>
                <option value="space-between">Space between</option>
                <option value="space-around">Space around</option>
              </select>
            ) : (
              <input
                value={directEditValue}
                maxLength={directEditControl === "text" ? 2000 : 64}
                onChange={(event) => setDirectEditValue(event.currentTarget.value)}
                placeholder={directEditControl === "color" ? "--color-action-primary" : "16px"}
                className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
              />
            )}
          </label>
          <Text as="p" variant="small" color="tertiary">
            Dynamic styles, rich or localized text, computed classes, ambiguous selectors, and
            unverified semantic colors are blocked.
          </Text>
        </div>
      </Dialog>

      <Dialog
        open={designSystemOpen}
        onOpenChange={(open) => {
          if (!designSystemBusy) setDesignSystemOpen(open);
        }}
        title={
          savedProject?.designSystemBinding ? "Attached design system" : "Attach design system"
        }
        description="Aiden reads only the reviewed static JSON files. It does not run package code or gain write, command, network, or Git access."
        confirmLabel={savedProject?.designSystemBinding ? "Refresh files" : "Attach design system"}
        confirmDisabled={
          !savedProject?.designSystemBinding &&
          (!designSystemName.trim() ||
            !designPackageRoot.trim() ||
            !designRouteScope.trim().startsWith("/") ||
            (!designTokenPath.trim() && !designCatalogPath.trim()))
        }
        busy={designSystemBusy}
        onConfirm={updateDesignSystem}
      >
        {savedProject?.designSystemBinding ? (
          <div className="grid gap-3">
            <div className="rounded-control bg-control p-3">
              <Text variant="small-strong">
                {designSystemProjection?.snapshot?.name ?? "Attached design system"}
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-1">
                {designSystemProjection?.freshness === "current"
                  ? `${designSystemProjection.snapshot?.tokens.colors.length ?? 0} colors · ${designSystemProjection.snapshot?.components.length ?? 0} components · ${designSystemProjection.snapshot?.icons.length ?? 0} icons`
                  : "Refresh to prove the reviewed files are still current before sending context to a model."}
              </Text>
            </div>
            {designSystemModelContext ? (
              <details className="rounded-control bg-well p-3 text-small">
                <summary className="cursor-default font-medium text-secondary">
                  Exactly what Aiden sends with an accepted Design turn
                </summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-mini text-tertiary">
                  {JSON.stringify(designSystemModelContext, null, 2)}
                </pre>
              </details>
            ) : (
              <Text as="p" variant="small" color="tertiary">
                Refresh the reviewed files to preview the exact normalized model context.
              </Text>
            )}
            <Button
              variant="transparent"
              className="justify-self-start text-red"
              disabled={designSystemBusy}
              onClick={() => void detachDesignSystem()}
            >
              Detach design system
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-small-strong">
              Name
              <input
                value={designSystemName}
                maxLength={160}
                onChange={(event) => setDesignSystemName(event.currentTarget.value)}
                className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-small-strong">
                Confirmed package root
                <input
                  value={designPackageRoot}
                  maxLength={256}
                  placeholder="packages/ui"
                  onChange={(event) => setDesignPackageRoot(event.currentTarget.value)}
                  className="h-9 rounded-control border border-separator bg-input px-3 font-mono text-small text-primary outline-none focus:bg-control"
                />
              </label>
              <label className="grid gap-1 text-small-strong">
                Route scope
                <input
                  value={designRouteScope}
                  maxLength={160}
                  placeholder="/settings"
                  onChange={(event) => setDesignRouteScope(event.currentTarget.value)}
                  className="h-9 rounded-control border border-separator bg-input px-3 font-mono text-small text-primary outline-none focus:bg-control"
                />
              </label>
            </div>
            <label className="grid gap-1 text-small-strong">
              Semantic tokens JSON
              <input
                value={designTokenPath}
                maxLength={512}
                placeholder="packages/ui/semantic.tokens.json"
                onChange={(event) => setDesignTokenPath(event.currentTarget.value)}
                className="h-9 rounded-control border border-separator bg-input px-3 font-mono text-small text-primary outline-none focus:bg-control"
              />
            </label>
            <label className="grid gap-1 text-small-strong">
              Reviewed component catalog JSON
              <input
                value={designCatalogPath}
                maxLength={512}
                placeholder="packages/ui/components.catalog.json"
                onChange={(event) => setDesignCatalogPath(event.currentTarget.value)}
                className="h-9 rounded-control border border-separator bg-input px-3 font-mono text-small text-primary outline-none focus:bg-control"
              />
            </label>
            <Text as="p" variant="small" color="tertiary">
              Paths are relative to the connected workspace and must stay inside the confirmed
              package. The package and route labels become part of the reviewed, path-free model
              context. Add either file or both.
            </Text>
          </div>
        )}
      </Dialog>

      <Dialog
        open={handoffOpen}
        onOpenChange={(open) => {
          if (!handoffBusy) setHandoffOpen(open);
        }}
        title="Continue in workspace"
        description={
          handoffTargetKind === "managed"
            ? "Aiden will create an isolated managed worktree from committed HEAD, then open a normal workspace task with this selected prototype as untrusted design context. No application source is written during handoff."
            : "Use the existing authorized workspace only when isolation is not appropriate. The handoff creates a normal Ask-permission task and does not write source, but later approved edits will affect this checkout."
        }
        confirmLabel={handoffPreview ? "Create workspace task" : "Review target"}
        confirmDisabled={
          handoffPreview
            ? handoffPreview.kind === "managed-worktree"
              ? Boolean(handoffPreview.dirtyCheckout && !dirtyCheckoutAcknowledged)
              : !existingWorkspaceAcknowledged
            : savedProject?.connectionState === "prototype-only" && !handoffWorkspaceId
        }
        busy={handoffBusy}
        onConfirm={handoffPreview ? beginHandoff : reviewHandoffTarget}
      >
        <div
          className="mb-3 grid grid-cols-2 rounded-control bg-control p-1"
          role="radiogroup"
          aria-label="Handoff target"
        >
          {(["managed", "existing"] as const).map((kind) => (
            <label
              key={kind}
              className={cn(
                "flex items-center gap-2 rounded-control px-2 py-1.5 text-small",
                handoffTargetKind === kind && "bg-list-selection text-primary",
              )}
            >
              <input
                type="radio"
                name="handoff-target"
                value={kind}
                checked={handoffTargetKind === kind}
                onChange={() => {
                  setHandoffTargetKind(kind);
                  setHandoffPreview(undefined);
                  setExistingWorkspaceAcknowledged(false);
                }}
              />
              {kind === "managed" ? "Managed worktree" : "Existing workspace"}
            </label>
          ))}
        </div>
        {!handoffPreview && savedProject?.connectionState === "prototype-only" ? (
          <div className="grid gap-2">
            <label className="grid gap-1 text-small-strong">
              Source repository
              <select
                value={handoffWorkspaceId}
                onChange={(event) => setHandoffWorkspaceId(event.currentTarget.value)}
                className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
              >
                {handoffWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <Text as="p" variant="small" color="secondary">
              Select an authorized Git workspace. Aiden will review its committed branch before
              creating an isolated managed worktree; the prototype remains immutable.
            </Text>
            {handoffWorkspaces.length === 0 ? (
              <Text as="p" variant="small" color="red">
                Add a local Git workspace first.
              </Text>
            ) : null}
          </div>
        ) : handoffPreview ? (
          <div className="grid gap-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-control p-3 text-small">
              <dt className="text-tertiary">Repository</dt>
              <dd className="truncate text-primary">
                {
                  (handoffPreview.kind === "managed-worktree"
                    ? handoffPreview.source
                    : handoffPreview.target
                  ).repositoryLabel
                }
              </dd>
              <dt className="text-tertiary">Committed branch</dt>
              <dd className="truncate text-primary">
                {
                  (handoffPreview.kind === "managed-worktree"
                    ? handoffPreview.source
                    : handoffPreview.target
                  ).branchLabel
                }
              </dd>
              <dt className="text-tertiary">New branch</dt>
              <dd className="text-primary">
                {handoffPreview.kind === "managed-worktree"
                  ? "Aiden-managed feature branch"
                  : "No new branch"}
              </dd>
              <dt className="text-tertiary">Permissions</dt>
              <dd className="text-primary">Ask before source changes</dd>
            </dl>
            {handoffPreview.kind === "existing-workspace" ? (
              <label className="flex gap-3 rounded-control bg-well p-3 text-small text-secondary">
                <input
                  type="checkbox"
                  checked={existingWorkspaceAcknowledged}
                  onChange={(event) =>
                    setExistingWorkspaceAcknowledged(event.currentTarget.checked)
                  }
                />
                <span>
                  {handoffPreview.requiredStrongWarningAcknowledgement}. Later approved actions will
                  affect this exact checkout.
                </span>
              </label>
            ) : handoffPreview.dirtyCheckout ? (
              <label className="flex gap-3 rounded-control bg-well p-3 text-small text-secondary">
                <input
                  type="checkbox"
                  checked={dirtyCheckoutAcknowledged}
                  onChange={(event) => setDirtyCheckoutAcknowledged(event.currentTarget.checked)}
                />
                <span>
                  {handoffPreview.requiredDirtyCheckoutAcknowledgement}. The worktree starts from
                  committed HEAD, so current uncommitted changes are not included.
                </span>
              </label>
            ) : (
              <Text as="p" variant="small" color="secondary">
                The source checkout is clean. The new worktree will start from the confirmed commit.
              </Text>
            )}
          </div>
        ) : null}
        {handoffLinks.length > 0 ? (
          <div className="mt-3 grid gap-2 border-t border-separator pt-3">
            <Text variant="small-strong">Implementation tasks</Text>
            {handoffLinks.map((link) => (
              <button
                key={link.taskId}
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/chat/$chatId",
                    params: { chatId: link.chatId },
                  })
                }
                className="flex items-center justify-between rounded-control bg-control px-3 py-2 text-left text-small text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="truncate">{link.branchLabel}</span>
                <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
        {activeHandoffOperationId ? (
          <div className="mt-3 border-t border-separator pt-3">
            <Button
              size="small"
              variant="toolbar"
              onClick={() =>
                void designerApi
                  .cancelHandoff(activeHandoffOperationId)
                  .then((result) => {
                    toast.info(
                      result.status === "rolled-back"
                        ? "Handoff cancelled and rolled back."
                        : "Cancellation requested; preserved work remains recoverable.",
                    );
                  })
                  .catch((cause: unknown) => {
                    toast.error(
                      cause instanceof Error
                        ? cause.message
                        : "Cancellation could not be requested.",
                    );
                  })
              }
            >
              Cancel handoff
            </Button>
          </div>
        ) : null}
      </Dialog>

      {prototypeDirectEditUndo ||
      handoffRecoveriesLoading ||
      handoffRecoveriesError ||
      handoffRecoveries.length > 0 ? (
        <div className="design-canvas-status-stack" aria-label="Design project status">
          {prototypeDirectEditUndo ? (
            <section className="design-direct-edit-undo flex items-center gap-3 rounded-popover bg-popover px-3 py-2.5 shadow-popover">
              <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />
              <div className="min-w-0 flex-1" role="status" aria-live="polite">
                <Text as="p" variant="small-strong">
                  Direct edit saved
                </Text>
                <Text as="p" variant="small" color="secondary">
                  Undo creates a new exact-revert revision.
                </Text>
              </div>
              <Button
                size="small"
                variant="toolbar"
                className="design-canvas-control"
                disabled={prototypeDirectEditUndoBusy}
                onClick={() => void undoPrototypeDirectEdit()}
                aria-label="Undo direct edit as a new exact-revert revision"
              >
                {prototypeDirectEditUndoBusy ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Undo2 aria-hidden="true" />
                )}
                Undo
              </Button>
            </section>
          ) : null}
          <DesignHandoffRecoveryPanel
            records={handoffRecoveries}
            loading={handoffRecoveriesLoading}
            error={handoffRecoveriesError}
            busyOperationId={handoffRecoveryBusyId}
            onRetry={() => {
              const current = savedProjectRef.current;
              if (current) void loadHandoffRecoveries(current.id);
            }}
            onResume={(record) => void runHandoffRecovery(record, "resume")}
            onCancel={(record) => void runHandoffRecovery(record, "cancel")}
            onOpen={(record) => {
              if (!record.linkage) return;
              void navigate({
                to: "/chat/$chatId",
                params: { chatId: record.linkage.chatId },
              });
            }}
          />
        </div>
      ) : null}

      {mode === "inspect" ? (
        <div className="absolute inset-x-0 top-4 z-20 mx-auto flex w-fit items-center gap-2 rounded-popover bg-popover px-3 py-2 shadow-popover">
          <ScanSearch className="size-4 text-accent" aria-hidden="true" />
          <Text variant="small-strong">Visual edit mode</Text>
          <Button size="small" variant="transparent" onClick={() => setMode("select")}>
            Done
          </Button>
        </div>
      ) : null}
      {reviewMultifileAction ? (
        <MultifileDesignerActionReview
          action={reviewMultifileAction}
          busy={multifileBusy}
          onApply={() => void updateMultifileAction(reviewMultifileAction, "apply")}
          onUndo={() => void updateMultifileAction(reviewMultifileAction, "undo")}
          onLater={() => setDismissedMultifileActionId(reviewMultifileAction.actionId)}
        />
      ) : reviewAction ? (
        <DesignerActionReview
          action={reviewAction}
          busy={actionBusy}
          onApply={() => void updateDesignerAction(reviewAction, "apply")}
          onReject={() => void updateDesignerAction(reviewAction, "reject")}
          onUndo={() => void updateDesignerAction(reviewAction, "undo")}
        />
      ) : null}
      {commentsOpen && savedProject ? (
        <div className="absolute inset-y-0 right-0 z-40">
          <DesignCommentsPanel
            view={commentView}
            currentTarget={currentCommentTarget}
            loading={commentsLoading}
            error={commentsError}
            layout="drawer"
            onCreate={async (body, target) => {
              const currentView = commentView ?? (await designerApi.listComments(savedProject.id));
              try {
                setCommentView(
                  await designerApi.createComment({
                    expectedDatabaseRevision: currentView.databaseRevision,
                    target,
                    body,
                  }),
                );
              } catch (cause) {
                await loadComments();
                throw cause;
              }
            }}
            onResolve={(comment) => void updateCommentStatus(comment, "resolve")}
            onReopen={(comment) => void updateCommentStatus(comment, "reopen")}
            onSelectTarget={(target) => {
              const node = savedProject.canvas.nodes.find(
                (candidate) =>
                  candidate.kind === "artboard" && candidate.lineageId === target.lineageId,
              );
              if (!node) return;
              setSelectedGroupId(node.id);
              changeVersion(node.id, target.mediaId);
            }}
            onRetry={() => void loadComments()}
            onClose={() => setCommentsOpen(false)}
          />
        </div>
      ) : null}
      {inspectorOpen && savedProject ? (
        <div className="absolute inset-y-0 right-0 z-40">
          <DesignProjectInspector
            selectionTitle={selectedGroup?.title ?? sourceSelection?.selection.label}
            connectionState={savedProject.connectionState}
            hasPrototypeArtboards={savedProject.canvas.nodes.some(
              ({ kind }) => kind === "artboard",
            )}
            activeTab={inspectorTab}
            source={selectedSource}
            sourceLoading={
              Boolean(
                selectedMediaId &&
                !selectedSource &&
                generatedSourceLoadingMediaIds.has(selectedMediaId),
              ) || Boolean(sourceSelection && !selectedMediaId && connectedSourceLoading)
            }
            sourceError={
              selectedMediaId && !selectedSource
                ? generatedSourceErrors[selectedMediaId]
                : undefined
            }
            compareSource={compareSource}
            revisions={revisionSummaries}
            designerActions={designerActionSummaries}
            preview={
              <div className="grid h-full place-items-center p-6 text-center">
                <Text color="secondary">
                  The live sandbox preview remains on the canvas so inspection never mounts a second
                  executable document.
                </Text>
              </div>
            }
            findQuery={inspectorFind}
            layout="drawer"
            onTabChange={setInspectorTab}
            onFindChange={setInspectorFind}
            onCopySource={(source) => {
              void navigator.clipboard
                .writeText(source.content)
                .then(() => toast.success("Source copied."))
                .catch(() => toast.error("Aiden could not copy the source."));
            }}
            onSaveSource={(source) => {
              const artifact = selectedGroup?.revisions.find(
                ({ artifact }) => artifact.mediaId === selectedMediaId,
              )?.artifact;
              if (artifact && source.contentHash === selectedSource?.contentHash) {
                void exportArtifact(artifact);
              }
            }}
            onRetrySource={
              selectedGroupNode?.lineageId && selectedMediaId
                ? () => {
                    void hydrateGeneratedSource(
                      savedProject.id,
                      selectedGroupNode.lineageId!,
                      selectedMediaId,
                    );
                  }
                : undefined
            }
            onExportBundle={() => {
              if (!selectedGroupNode?.lineageId || !selectedMediaId) return;
              void designerApi
                .exportProjectBundle(savedProject.id, selectedGroupNode.lineageId, selectedMediaId)
                .then((result) => {
                  if (result.status !== "saved") return;
                  if (result.exportId && result.fileName) {
                    setLatestExport({
                      id: result.exportId,
                      fileName: result.fileName,
                    });
                  }
                  toast.success("Design source bundle saved.");
                })
                .catch((cause: unknown) =>
                  toast.error(cause instanceof Error ? cause.message : "Export failed."),
                );
            }}
            canExportBundle={Boolean(selectedGroupNode?.lineageId && selectedMediaId)}
            latestExportName={latestExport?.fileName}
            onRevealExport={
              latestExport
                ? () => {
                    void designerApi
                      .revealProjectExport(savedProject.id, latestExport.id)
                      .catch((cause: unknown) =>
                        toast.error(
                          cause instanceof Error
                            ? cause.message
                            : "The saved export is unavailable.",
                        ),
                      );
                  }
                : undefined
            }
            onSelectRevision={(lineageId, revisionId) => {
              if (lineageId === selectedGroupNode?.lineageId && selectedGroup) {
                changeVersion(selectedGroup.id, revisionId);
              }
            }}
            onCompareRevision={(lineageId, revisionId) => {
              if (lineageId !== selectedGroupNode?.lineageId) return;
              setComparisonMediaId(revisionId);
              setInspectorTab("code");
            }}
            onCloseComparison={() => setComparisonMediaId(undefined)}
            onSelectDesignerAction={(actionId) => {
              const action = designerActions.find(({ id }) => id === actionId);
              if (action?.status === "pending" || action?.status === "applied") {
                toast.info("Use the exact Designer Action review on the canvas.");
              }
            }}
            onClose={() => setInspectorOpen(false)}
          />
        </div>
      ) : null}
    </section>
  );
}

function CanvasToolRail({
  mode,
  onModeChange,
  onNewDesign,
  onUpload,
}: {
  mode: CanvasMode;
  onModeChange: (mode: CanvasMode) => void;
  onNewDesign: () => void;
  onUpload: () => void;
}) {
  return (
    <nav
      className="absolute left-4 top-4 z-30 flex flex-col items-center gap-1 rounded-popover bg-popover p-1.5 shadow-popover"
      aria-label="Canvas tools"
    >
      <CanvasToolButton
        label="Select"
        description="Select and move items on the canvas."
        shortcut="V"
        active={mode === "select"}
        onClick={() => onModeChange("select")}
      >
        <MousePointer2 className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Visual edits"
        description="Pick an element in a generated screen or running app."
        shortcut="E"
        active={mode === "inspect"}
        onClick={() => onModeChange("inspect")}
      >
        <ScanSearch className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Preview"
        description="Use the interface without selecting its elements."
        active={mode === "preview"}
        onClick={() => onModeChange("preview")}
      >
        <Play className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <span className="my-1 h-px w-6 bg-separator" aria-hidden="true" />
      <CanvasToolButton
        label="New design"
        description="Focus the prompt to describe another screen or flow."
        onClick={onNewDesign}
      >
        <Plus className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Add reference image"
        description="Add up to six local images as visual references."
        onClick={onUpload}
      >
        <ImagePlus className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Hand"
        description="Pan around the canvas without moving artboards."
        shortcut="H"
        active={mode === "hand"}
        onClick={() => onModeChange("hand")}
      >
        <Hand className="size-4" aria-hidden="true" />
      </CanvasToolButton>
    </nav>
  );
}

function ProjectConnectionControl({
  mode,
  open,
  busy,
  workspaces,
  workspaceId,
  onWorkspaceChange,
  onOpen,
  onOpenChange,
  onConfirm,
}: {
  mode: "connect" | "reconnect";
  open: boolean;
  busy: boolean;
  workspaces: readonly Workspace[];
  workspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onOpen: () => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const label = mode === "connect" ? "Connect app…" : "Reconnect app…";
  return (
    <div className="design-source-preview-control absolute right-4 top-16 z-30">
      <Button
        size="small"
        variant="toolbar"
        disabled={busy}
        onClick={onOpen}
        className="design-canvas-control shadow-control"
      >
        {busy ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <AppWindow aria-hidden="true" />
        )}
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) onOpenChange(next);
        }}
        title={mode === "connect" ? "Connect this prototype" : "Reconnect this Design Project"}
        description="Choose a folder workspace with file access. Aiden keeps the existing conversation, generated revisions, comments, and canvas in place."
        confirmLabel={mode === "connect" ? "Connect app" : "Reconnect app"}
        confirmDisabled={!workspaceId || workspaces.length === 0}
        busy={busy}
        onConfirm={onConfirm}
      >
        {workspaces.length > 0 ? (
          <div className="grid gap-2">
            <label htmlFor="design-project-connection-workspace" className="text-small-strong">
              App workspace
            </label>
            <Select value={workspaceId} onValueChange={onWorkspaceChange}>
              <SelectTrigger id="design-project-connection-workspace" aria-label="App workspace">
                {workspaces.find(({ id }) => id === workspaceId)?.name ?? "Choose a workspace"}
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Text as="p" variant="small" color="secondary">
              Generated HTML, CSS, and JavaScript stay in Aiden until you explicitly export or hand
              off source changes.
            </Text>
          </div>
        ) : (
          <Text as="p" variant="small" color="secondary">
            Add a folder workspace with file access before connecting this project.
          </Text>
        )}
      </Dialog>
    </div>
  );
}

function SourcePreviewControl({
  state,
  open,
  busy,
  onOpenChange,
  onStart,
  onStop,
  savedScriptId,
}: {
  state?: SourcePreviewStateV1;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (scriptId: string) => void;
  onStop: () => void;
  savedScriptId?: string;
}) {
  const running = state?.status === "running";
  return (
    <div className="design-source-preview-control absolute right-4 top-16 z-30">
      <Button
        size="small"
        variant="toolbar"
        disabled={!state || busy}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="design-canvas-control shadow-control"
      >
        {busy ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <AppWindow aria-hidden="true" />
        )}
        {running ? "Local preview" : "Start local preview"}
      </Button>
      {open ? (
        <section
          role="dialog"
          aria-label="Local preview"
          className="mt-2 w-[22rem] rounded-popover bg-popover p-3 shadow-popover"
        >
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-control bg-list-selection text-accent">
              <Code2 className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <Text variant="small-strong">
                {running ? "Source-backed preview" : "Start local preview"}
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-1">
                {running
                  ? "Aiden owns this process. Visual edits bind to exact React source when metadata is available."
                  : "Review the detected command, then start it explicitly."}
              </Text>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="design-canvas-control grid size-7 shrink-0 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary"
              aria-label="Close local app controls"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          {state?.status === "ready" ? (
            <div className="mt-3 space-y-2">
              {state.scripts.map((script) => (
                <div key={script.id} className="rounded-control bg-control p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Text variant="small-strong">{script.label}</Text>
                    {savedScriptId === script.id ? (
                      <span className="rounded-pill bg-list-selection px-2 py-0.5 text-mini text-secondary">
                        Saved configuration · stopped
                      </span>
                    ) : null}
                  </div>
                  <code className="mt-1 block break-all text-mini text-secondary">
                    {script.command}
                  </code>
                  <Button
                    size="small"
                    variant="accent"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => onStart(script.id)}
                  >
                    <Play aria-hidden="true" /> Start
                  </Button>
                </div>
              ))}
            </div>
          ) : state?.status === "running" ? (
            <div className="mt-3">
              <code className="block break-all rounded-control bg-control p-2.5 text-mini text-secondary">
                {state.script.command}
              </code>
              <div className="mt-2 flex items-center justify-between gap-3">
                <Text variant="small" color="secondary">
                  Running on an Aiden-owned loopback session
                </Text>
                <Button size="small" variant="toolbar" disabled={busy} onClick={onStop}>
                  Stop
                </Button>
              </div>
            </div>
          ) : state?.status === "unsupported" || state?.status === "failed" ? (
            <div className="mt-3 rounded-control bg-control p-2.5">
              <Text variant="small" color={state.status === "failed" ? "red" : "secondary"}>
                {state.reason}
              </Text>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 text-secondary">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              <Text variant="small">Checking package scripts…</Text>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function previewCode(value: string): string {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}\n…` : value;
}

function MultifileDesignerActionReview({
  action,
  busy,
  onApply,
  onUndo,
  onLater,
}: {
  action: SourceDesignerMultifileActionViewV1;
  busy: boolean;
  onApply: () => void;
  onUndo: () => void;
  onLater: () => void;
}) {
  const [selectedPath, setSelectedPath] = React.useState(action.files[0]?.path ?? "");
  React.useEffect(() => {
    if (!action.files.some(({ path }) => path === selectedPath)) {
      setSelectedPath(action.files[0]?.path ?? "");
    }
  }, [action, selectedPath]);
  const file = action.files.find(({ path }) => path === selectedPath) ?? action.files[0];
  const pending = action.stage === "prepared";
  const applied = action.stage === "committed";
  return (
    <aside
      aria-label="Multi-file Designer Action review"
      className="absolute bottom-16 left-4 right-4 z-30 flex max-h-[min(42rem,76%)] flex-col overflow-hidden rounded-popover bg-popover shadow-popover sm:left-auto sm:w-[42rem]"
    >
      <header className="flex items-start gap-3 border-b border-separator px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-list-selection text-accent">
          {applied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Code2 className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" truncate>
            {action.label}
          </Text>
          <Text as="p" variant="small" color="secondary">
            {action.files.length} existing files · atomic rollback and crash recovery
          </Text>
        </div>
        <span className="rounded-control bg-control px-2 py-1 text-mini text-secondary">
          {action.stage === "recoverable"
            ? "Recovery needed"
            : pending
              ? "Review required"
              : "Applied"}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex gap-1 overflow-x-auto border-b border-separator px-3 py-2"
          role="tablist"
          aria-label="Changed files"
        >
          {action.files.map((candidate) => (
            <button
              key={candidate.path}
              type="button"
              role="tab"
              aria-selected={candidate.path === file?.path}
              onClick={() => setSelectedPath(candidate.path)}
              className={cn(
                "shrink-0 rounded-control px-2.5 py-1.5 font-mono text-mini text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                candidate.path === file?.path && "bg-list-selection text-primary",
              )}
            >
              {candidate.path}
            </button>
          ))}
        </div>
        {file ? (
          <div className="grid min-h-0 flex-1 gap-px overflow-auto bg-separator sm:grid-cols-2">
            <section className="min-w-0 bg-popover p-3" aria-label={`${file.path} before`}>
              <Text variant="small-strong" color="secondary">
                Before · {file.beforeSha256.slice(0, 10)}
              </Text>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-control bg-control p-2.5 font-mono text-mini text-secondary">
                {file.before}
              </pre>
            </section>
            <section className="min-w-0 bg-popover p-3" aria-label={`${file.path} after`}>
              <Text variant="small-strong" color="secondary">
                After · {file.afterSha256.slice(0, 10)}
              </Text>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-control bg-control p-2.5 font-mono text-mini text-primary">
                {file.after}
              </pre>
            </section>
          </div>
        ) : null}
        {action.recovery ? (
          <div className="border-t border-separator px-4 py-3 text-small text-danger">
            {action.recovery.conflicts
              .map((conflict) => `${conflict.path}: ${conflict.reason}`)
              .join(" · ")}
          </div>
        ) : null}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-separator px-4 py-3">
        <Button size="small" variant="toolbar" disabled={busy} onClick={onLater}>
          Later
        </Button>
        {pending ? (
          <Button size="small" variant="accent" disabled={busy} onClick={onApply}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />}Apply all files
          </Button>
        ) : applied ? (
          <Button size="small" variant="toolbar" disabled={busy} onClick={onUndo}>
            {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}Undo exact action
          </Button>
        ) : null}
      </footer>
    </aside>
  );
}

function DesignerActionReview({
  action,
  busy,
  onApply,
  onReject,
  onUndo,
}: {
  action: DesignerActionV1;
  busy: boolean;
  onApply: () => void;
  onReject: () => void;
  onUndo: () => void;
}) {
  const pending = action.status === "pending";
  return (
    <aside
      aria-label="Designer Action review"
      className="absolute bottom-16 right-4 z-30 flex max-h-[min(36rem,70%)] w-[30rem] flex-col overflow-hidden rounded-popover bg-popover shadow-popover"
    >
      <header className="flex items-start gap-3 border-b border-separator px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-list-selection text-accent">
          {pending ? (
            <Code2 className="size-4" aria-hidden="true" />
          ) : (
            <Check className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" truncate>
            {action.label}
          </Text>
          <Text as="p" variant="small" color="secondary" truncate className="mt-0.5">
            {action.path} · {action.selectionLabel}
          </Text>
        </div>
        <span className="rounded-control bg-control px-2 py-1 text-mini text-secondary">
          {pending ? "Review required" : "Applied"}
        </span>
      </header>
      <div className="min-h-0 overflow-auto px-4 py-3">
        <Text variant="small-strong" color="secondary">
          Before
        </Text>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-control p-2.5 font-mono text-mini text-secondary">
          {previewCode(action.before)}
        </pre>
        <Text variant="small-strong" color="secondary" className="mt-3">
          After
        </Text>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-control p-2.5 font-mono text-mini text-primary">
          {previewCode(action.after)}
        </pre>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-separator px-4 py-3">
        {pending ? (
          <>
            <Button size="small" variant="toolbar" disabled={busy} onClick={onReject}>
              Deny
            </Button>
            <Button size="small" variant="accent" disabled={busy} onClick={onApply}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              Apply
            </Button>
          </>
        ) : (
          <Button size="small" variant="toolbar" disabled={busy} onClick={onUndo}>
            {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
            Undo exact action
          </Button>
        )}
      </footer>
    </aside>
  );
}

function DesignEmptyState({
  title,
  description,
  generating,
}: {
  title: string;
  description: string;
  generating: boolean;
}) {
  return (
    <div className="max-w-md text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-popover text-secondary shadow-control">
        {generating ? (
          <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <PanelsTopLeft className="size-5" aria-hidden="true" />
        )}
      </span>
      <Text as="h3" variant="heading1" className="mt-4 text-heading2">
        {title}
      </Text>
      <Text as="p" variant="small" color="secondary" className="mt-2">
        {description}
      </Text>
    </div>
  );
}

function ProjectReconciliationNotice({
  message,
  busy,
  offset,
  onRetry,
}: {
  message: string;
  busy: boolean;
  offset: boolean;
  onRetry?: () => void;
}) {
  return (
    <section
      className={cn(
        "absolute left-16 right-4 z-30 flex flex-col items-stretch gap-3 rounded-popover bg-popover px-3 py-2 shadow-popover sm:left-20 sm:right-auto sm:max-w-md sm:flex-row sm:items-center",
        offset ? "top-28 sm:top-24" : "top-4",
      )}
      role="alert"
      aria-label="Design history reconciliation"
    >
      <div className="min-w-0 flex-1">
        <Text variant="small-strong">Design history needs refresh</Text>
        <Text variant="small" color="secondary">
          {message} Retry to finish adding it.
        </Text>
      </div>
      {onRetry ? (
        <Button size="small" variant="toolbar" disabled={busy} onClick={onRetry}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Retry
        </Button>
      ) : null}
    </section>
  );
}

function MissingReferenceRepairNotice({
  count,
  busy,
  onRemove,
}: {
  count: number;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <section
      className="absolute left-16 right-4 top-4 z-30 flex flex-col items-stretch gap-3 rounded-popover bg-popover px-3 py-2 shadow-popover sm:left-20 sm:right-auto sm:max-w-sm sm:flex-row sm:items-center"
      role="alert"
      aria-label="Missing reference image"
    >
      <div className="min-w-0 flex-1">
        <Text variant="small-strong">
          {count === 1 ? "A reference image is missing" : `${count} reference images are missing`}
        </Text>
        <Text variant="small" color="secondary">
          Remove the unavailable image from this project to finish repair.
        </Text>
      </div>
      <Button size="small" variant="toolbar" disabled={busy} onClick={onRemove}>
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <X aria-hidden="true" />}
        Remove
      </Button>
    </section>
  );
}
