import * as React from "react";
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
import {
  Download,
  Hand,
  ImagePlus,
  Loader2,
  Monitor,
  MousePointer2,
  PanelsTopLeft,
  Play,
  Plus,
  ScanSearch,
  Smartphone,
  Tablet,
} from "lucide-react";
import type { Attachment } from "../lib/types";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import {
  groupDesignWorkspaceArtifacts,
  type DesignElementSelectionV1,
  type DesignTurnTargetV1,
  type DesignWorkspaceArtifactEntry,
  type DesignWorkspaceArtifactGroup,
} from "../shared/design-workspace";
import { chatsApi } from "../lib/ipc";
import { cn } from "../lib/ui-utils";
import { Button, Text, toast } from "./ui";
import { HtmlArtifactIframe } from "./html-artifact-frame";
import { htmlArtifactThemeTokensFromDocument } from "../lib/html-artifact-preview";

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

type DesignArtboardNode = Node<DesignArtboardData, "designArtboard">;
type DesignImageNode = Node<ImageNodeData, "designImage">;
type StudioNode = DesignArtboardNode | DesignImageNode;

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
      )
      .then((result) => {
        if (cancelled) return;
        if (!result?.src) {
          setError("This design version is no longer available.");
          return;
        }
        setPreview({ src: result.src, designCapability: result.designCapability });
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
  }, [data.artifact.id, data.artifact.mediaId, data.chatId]);

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
  shortcut,
  active = false,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active || undefined}
      title={shortcut ? `${label} · ${shortcut}` : label}
      className={cn(
        "grid size-9 place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-list-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active && "bg-list-selection text-accent",
      )}
    >
      {children}
    </button>
  );
}

export function DesignWorkspaceCanvas({
  chatId,
  artifacts,
  generating,
  initialMediaId,
  unavailableMessage,
  targets,
  selectedImages,
  onTargetsChange,
  onSelectedImagesChange,
  onRequestComposerFocus,
}: {
  chatId: string;
  artifacts: readonly DesignWorkspaceArtifactEntry[];
  generating: boolean;
  initialMediaId?: string;
  unavailableMessage?: string;
  targets: readonly DesignTurnTargetV1[];
  selectedImages: readonly Attachment[];
  onTargetsChange: (targets: DesignTurnTargetV1[]) => void;
  onSelectedImagesChange: (images: Attachment[]) => void;
  onRequestComposerFocus: () => void;
}) {
  const [viewport, setViewport] = React.useState<DesignViewport>("desktop");
  const [mode, setMode] = React.useState<CanvasMode>("select");
  const [activeVersions, setActiveVersions] = React.useState<Record<string, string>>({});
  const [canvasImages, setCanvasImages] = React.useState<Attachment[]>([]);
  const [nodes, setNodes] = React.useState<StudioNode[]>([]);
  const flowRef = React.useRef<ReactFlowInstance<StudioNode> | null>(null);
  const uploadRef = React.useRef<HTMLInputElement | null>(null);
  const groups = React.useMemo(() => groupDesignWorkspaceArtifacts(artifacts), [artifacts]);
  const targetsRef = React.useRef(targets);
  React.useLayoutEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

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
      onTargetsChange(next);
      if (!additive) onSelectedImagesChange([]);
    },
    [onSelectedImagesChange, onTargetsChange],
  );

  const changeVersion = React.useCallback(
    (groupId: string, mediaId: string) => {
      setActiveVersions((current) => ({ ...current, [groupId]: mediaId }));
      const group = groups.find((candidate) => candidate.id === groupId);
      const artifact = group?.revisions.find(
        (revision) => revision.artifact.mediaId === mediaId,
      )?.artifact;
      if (!artifact) return;
      onTargetsChange(
        targetsRef.current.map((target) =>
          group?.revisions.some((revision) => revision.artifact.mediaId === target.mediaId)
            ? { mediaId: artifact.mediaId, artifactId: artifact.id }
            : target,
        ),
      );
    },
    [groups, onTargetsChange],
  );

  React.useEffect(() => {
    setNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      const designNodes: DesignArtboardNode[] = groups.map((group, index) => {
        const requested =
          activeVersions[group.id] ??
          (initialMediaId &&
          group.revisions.some((item) => item.artifact.mediaId === initialMediaId)
            ? initialMediaId
            : undefined);
        const artifact =
          group.revisions.find((item) => item.artifact.mediaId === requested)?.artifact ??
          group.revisions[group.revisions.length - 1]!.artifact;
        const target = targets.find((item) => item.mediaId === artifact.mediaId);
        return {
          id: group.id,
          type: "designArtboard",
          position: positions.get(group.id) ?? {
            x: index * (VIEWPORT_SIZE[viewport].width + 120),
            y: 0,
          },
          selected: Boolean(target),
          draggable: mode === "select",
          selectable: mode === "select",
          dragHandle: ".design-artboard-drag-handle",
          data: {
            kind: "design",
            chatId,
            group,
            artifact,
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
      return [...designNodes, ...imageNodes];
    });
  }, [
    activeVersions,
    canvasImages,
    changeVersion,
    chatId,
    exportArtifact,
    groups,
    initialMediaId,
    mode,
    selectElement,
    selectedImages,
    targets,
    viewport,
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
      for (const node of selectedNodes) {
        if (node.type === "designImage") {
          nextImages.push((node.data as ImageNodeData).attachment);
          continue;
        }
        const designData = node.data as DesignArtboardData;
        const existing = targetsRef.current.find(
          (target) => target.mediaId === designData.artifact.mediaId,
        );
        nextTargets.push(
          existing ?? {
            mediaId: designData.artifact.mediaId,
            artifactId: designData.artifact.id,
          },
        );
      }
      onTargetsChange(nextTargets.slice(0, 5));
      onSelectedImagesChange(nextImages.slice(0, 5));
    },
    [mode, onSelectedImagesChange, onTargetsChange],
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
        const attachments = await Promise.all(accepted.map(canvasImageAttachment));
        setCanvasImages((current) => [...current, ...attachments]);
        onSelectedImagesChange(attachments);
        onTargetsChange([]);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not add those images.");
      }
    },
    [canvasImages.length, onSelectedImagesChange, onTargetsChange],
  );

  if (unavailableMessage) {
    return (
      <section
        className="grid h-full place-items-center bg-well px-8"
        aria-label="Design workspace canvas"
      >
        <DesignEmptyState
          title="Design is unavailable here"
          description={unavailableMessage}
          generating={false}
        />
      </section>
    );
  }

  if (groups.length === 0 && canvasImages.length === 0) {
    return (
      <section
        className="relative grid h-full min-h-[32rem] place-items-center overflow-hidden bg-well px-8"
        aria-label="Design workspace canvas"
        data-design-workspace-canvas
      >
        <CanvasToolRail
          mode={mode}
          onModeChange={setMode}
          onNewDesign={onRequestComposerFocus}
          onUpload={() => uploadRef.current?.click()}
        />
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
      <ReactFlow<StudioNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onInit={(instance) => {
          flowRef.current = instance;
          requestAnimationFrame(() => void instance.fitView({ padding: 0.18, maxZoom: 0.9 }));
        }}
        fitView
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
          onTargetsChange([]);
          onSelectedImagesChange([]);
          onRequestComposerFocus();
        }}
        onUpload={() => uploadRef.current?.click()}
      />
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

      <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-popover bg-popover p-1 shadow-control">
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
                "grid size-8 place-items-center rounded-control text-secondary hover:bg-list-hover hover:text-primary",
                viewport === id && "bg-list-selection text-accent",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </button>
          );
        })}
        <span className="mx-1 h-5 w-px bg-separator" aria-hidden="true" />
        <button
          type="button"
          onClick={() => void flowRef.current?.fitView({ padding: 0.18, maxZoom: 0.9 })}
          className="h-8 rounded-control px-2 text-small-strong text-secondary hover:bg-list-hover hover:text-primary"
        >
          Fit
        </button>
        {generating ? (
          <Loader2 className="mx-2 size-4 animate-spin text-secondary" aria-label="Generating" />
        ) : null}
      </div>

      {mode === "inspect" ? (
        <div className="absolute inset-x-0 top-4 z-20 mx-auto flex w-fit items-center gap-2 rounded-popover bg-popover px-3 py-2 shadow-popover">
          <ScanSearch className="size-4 text-accent" aria-hidden="true" />
          <Text variant="small-strong">Visual edit mode</Text>
          <Button size="small" variant="transparent" onClick={() => setMode("select")}>
            Done
          </Button>
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
        shortcut="V"
        active={mode === "select"}
        onClick={() => onModeChange("select")}
      >
        <MousePointer2 className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Visual edits"
        shortcut="E"
        active={mode === "inspect"}
        onClick={() => onModeChange("inspect")}
      >
        <ScanSearch className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Preview"
        active={mode === "preview"}
        onClick={() => onModeChange("preview")}
      >
        <Play className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <span className="my-1 h-px w-6 bg-separator" aria-hidden="true" />
      <CanvasToolButton label="New design" onClick={onNewDesign}>
        <Plus className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton label="Upload image" onClick={onUpload}>
        <ImagePlus className="size-4" aria-hidden="true" />
      </CanvasToolButton>
      <CanvasToolButton
        label="Hand"
        shortcut="H"
        active={mode === "hand"}
        onClick={() => onModeChange("hand")}
      >
        <Hand className="size-4" aria-hidden="true" />
      </CanvasToolButton>
    </nav>
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
