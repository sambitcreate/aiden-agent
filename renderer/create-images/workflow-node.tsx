import * as React from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  GalleryHorizontalEnd,
  Image as ImageIcon,
  Images,
  RefreshCw,
  Sparkles,
  TextCursorInput,
  X,
} from "lucide-react";
import { CREATE_IMAGES_NODE_DEFINITIONS } from "../shared/create-images/ports";
import type {
  CreateImagesNodeType,
  GenerateImageNodeV1,
  PromptNodeV1,
  WorkflowNodeV1,
} from "../shared/create-images/schema";
import { CREATE_IMAGES_MAX_PROMPT_LENGTH } from "../shared/create-images/schema";
import { Badge, Textarea } from "../components/ui";
import { useCreateImagesCanvasActions } from "./canvas-context";
import { boundedPromptText } from "./editor-core";
import { CreateImagesNodeRunStatusBadge } from "./run-ui";
import {
  createImagesCuratedGeminiModels,
  createImagesProviderModelLabel,
  evaluateCreateImagesProviderBinding,
  type CreateImagesProviderModelCapability,
} from "../shared/create-images/providers";
import { createImagesBindingIssueLabel } from "./provider-connection-core";

export interface CreateImagesCanvasNodeData extends Record<string, unknown> {
  workflowNode: WorkflowNodeV1;
}

export type CreateImagesCanvasNode = Node<CreateImagesCanvasNodeData, CreateImagesNodeType>;

const NODE_ICONS: Readonly<
  Record<CreateImagesNodeType, React.ComponentType<{ className?: string }>>
> = {
  "image-input": ImageIcon,
  prompt: TextCursorInput,
  "generate-image": Sparkles,
  output: Images,
  "output-gallery": GalleryHorizontalEnd,
};

function NodePorts({ node, direction }: { node: WorkflowNodeV1; direction: "inputs" | "outputs" }) {
  const ports = CREATE_IMAGES_NODE_DEFINITIONS[node.type][direction];
  if (ports.length === 0) return null;
  return (
    <div
      className={`create-images-port-rail flex flex-col gap-1 ${
        direction === "inputs" ? "mb-3" : "mt-3"
      }`}
      data-direction={direction}
    >
      {ports.map((port) => (
        <div
          key={port.id}
          className={`relative flex min-h-6 items-center rounded-control bg-well px-2 text-mini text-tertiary ${
            direction === "inputs" ? "justify-start" : "justify-end"
          }`}
        >
          <Handle
            id={port.id}
            type={direction === "inputs" ? "target" : "source"}
            position={direction === "inputs" ? Position.Left : Position.Right}
            className="create-images-handle"
            style={{ top: "50%" }}
            aria-label={`${direction === "inputs" ? "Input" : "Output"}: ${port.label}`}
            title={`${port.label} · ${port.kind}`}
          />
          <span
            data-create-images-port-label={port.id}
            aria-hidden="true"
            className="pointer-events-none max-w-full truncate"
            title={`${port.label} · ${port.kind}`}
          >
            {port.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function PromptBody({ node }: { node: PromptNodeV1 }) {
  const { beginNodeEdit, commitNodeEdit, updateNodeDraft } = useCreateImagesCanvasActions();
  const [draft, setDraft] = React.useState(node.data.text);

  React.useEffect(() => setDraft(node.data.text), [node.data.text]);

  return (
    <Textarea
      className="nodrag nopan nowheel min-h-20 max-h-40 overflow-y-auto bg-input/55 text-small leading-relaxed"
      aria-label={`Prompt text · ${node.id}`}
      value={draft}
      maxLength={CREATE_IMAGES_MAX_PROMPT_LENGTH}
      placeholder="Describe the image…"
      onFocus={() => beginNodeEdit(node.id)}
      onChange={(event) => {
        const text = boundedPromptText(event.target.value);
        setDraft(text);
        updateNodeDraft(node.id, (current) =>
          current.type === "prompt" ? { ...current, data: { text } } : current,
        );
      }}
      onBlur={() => commitNodeEdit(node.id)}
    />
  );
}

function normalizedGenerationData(
  node: GenerateImageNodeV1,
  model: CreateImagesProviderModelCapability,
): GenerateImageNodeV1["data"] {
  return {
    providerId: "gemini",
    modelId: model.id,
    aspectRatio: model.aspectRatios.includes(node.data.aspectRatio)
      ? node.data.aspectRatio
      : model.aspectRatios[0]!,
    imageSize: model.imageSizes.includes(node.data.imageSize)
      ? node.data.imageSize
      : model.imageSizes[0]!,
    outputMime: model.outputMimes.includes(node.data.outputMime)
      ? node.data.outputMime
      : model.outputMimes[0]!,
    count:
      node.data.count <= model.maxOutputs
        ? node.data.count
        : (Math.min(4, Math.max(1, model.maxOutputs)) as 1 | 2 | 3 | 4),
  };
}

function GenerateImageBody({ node }: { node: GenerateImageNodeV1 }) {
  const actions = useCreateImagesCanvasActions();
  const models = createImagesCuratedGeminiModels(actions.providerStatus);
  const selectedModel = models.find((model) => model.id === node.data.modelId);
  const releaseModels = createImagesCuratedGeminiModels({
    ...actions.providerStatus,
    connectionState: "disconnected",
    capabilitySnapshot: undefined,
  });
  const releaseSelectedModel = releaseModels.find((model) => model.id === node.data.modelId);
  const enforceCurrentCapabilities =
    actions.providerStatus.connectionState === "connected" &&
    actions.providerStatus.capabilitySnapshot?.state === "current";
  const optionModel =
    selectedModel ?? (enforceCurrentCapabilities ? undefined : (releaseSelectedModel ?? models[0]));
  const binding = evaluateCreateImagesProviderBinding(node, actions.providerStatus);
  const remoteIssue =
    binding.status === "blocked" ? createImagesBindingIssueLabel(binding.issue) : undefined;
  const update = (data: GenerateImageNodeV1["data"]) =>
    actions.updateNode(node.id, (current) =>
      current.type === "generate-image" ? { ...current, data } : current,
    );
  const unavailableSelectedModel =
    Boolean(node.data.modelId) && !models.some((model) => model.id === node.data.modelId);

  return (
    <div className="nodrag nopan nowheel flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge color="blue">Gemini</Badge>
        <Badge>{node.data.imageSize}</Badge>
        <Badge>{node.data.aspectRatio}</Badge>
      </div>
      <label className="grid gap-1 text-mini text-tertiary">
        Model
        <select
          className="create-images-node-select"
          aria-label={`Image model · ${node.id}`}
          value={node.data.modelId ?? ""}
          onChange={(event) => {
            const model = models.find((candidate) => candidate.id === event.target.value);
            if (model) update(normalizedGenerationData(node, model));
          }}
        >
          {!node.data.modelId ? <option value="">Choose a supported model</option> : null}
          {unavailableSelectedModel ? (
            <option value={node.data.modelId} disabled>
              {createImagesProviderModelLabel(node.data.modelId)} · unavailable
            </option>
          ) : null}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-mini text-tertiary">
          Aspect
          <select
            className="create-images-node-select"
            aria-label={`Aspect ratio · ${node.id}`}
            value={node.data.aspectRatio}
            disabled={!optionModel}
            onChange={(event) =>
              update({
                ...node.data,
                aspectRatio: event.target.value as GenerateImageNodeV1["data"]["aspectRatio"],
              })
            }
          >
            {optionModel && !optionModel.aspectRatios.includes(node.data.aspectRatio) ? (
              <option value={node.data.aspectRatio} disabled>
                {node.data.aspectRatio} · unavailable
              </option>
            ) : null}
            {optionModel?.aspectRatios.map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-mini text-tertiary">
          Size
          <select
            className="create-images-node-select"
            aria-label={`Image size · ${node.id}`}
            value={node.data.imageSize}
            disabled={!optionModel}
            onChange={(event) =>
              update({
                ...node.data,
                imageSize: event.target.value as GenerateImageNodeV1["data"]["imageSize"],
              })
            }
          >
            {optionModel && !optionModel.imageSizes.includes(node.data.imageSize) ? (
              <option value={node.data.imageSize} disabled>
                {node.data.imageSize} · unavailable
              </option>
            ) : null}
            {optionModel?.imageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-mini text-tertiary">
          Format
          <select
            className="create-images-node-select"
            aria-label={`Output format · ${node.id}`}
            value={node.data.outputMime}
            disabled={!optionModel}
            onChange={(event) =>
              update({
                ...node.data,
                outputMime: event.target.value as GenerateImageNodeV1["data"]["outputMime"],
              })
            }
          >
            {optionModel && !optionModel.outputMimes.includes(node.data.outputMime) ? (
              <option value={node.data.outputMime} disabled>
                {node.data.outputMime} · unavailable
              </option>
            ) : null}
            {optionModel?.outputMimes.map((mime) => (
              <option key={mime} value={mime}>
                {mime === "image/png" ? "PNG" : "JPEG"}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-mini text-tertiary">
          Images
          <select
            className="create-images-node-select"
            aria-label={`Output count · ${node.id}`}
            value={node.data.count}
            disabled={!optionModel}
            onChange={(event) =>
              update({
                ...node.data,
                count: Number(event.target.value) as GenerateImageNodeV1["data"]["count"],
              })
            }
          >
            {node.data.count > (optionModel?.maxOutputs ?? 0) ? (
              <option value={node.data.count} disabled>
                {node.data.count} · unavailable
              </option>
            ) : null}
            {Array.from({ length: Math.min(4, optionModel?.maxOutputs ?? 0) }, (_, index) => (
              <option key={index + 1} value={index + 1}>
                {index + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className={`create-images-node-provider-state ${actions.executionMode === "gemini" && remoteIssue ? "text-red" : "text-tertiary"}`}
        role={actions.executionMode === "gemini" && remoteIssue ? "alert" : "status"}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        <span>
          {actions.executionMode === "local-mock"
            ? `Local mock is active · ${remoteIssue ?? "Gemini configuration ready"}`
            : (remoteIssue ?? "Current Gemini capabilities verified")}
        </span>
      </div>
    </div>
  );
}

function NodeBody({ node }: { node: WorkflowNodeV1 }) {
  if (node.type === "prompt") return <PromptBody node={node} />;
  if (node.type === "generate-image") {
    return <GenerateImageBody node={node} />;
  }
  if (node.type === "output-gallery") {
    return (
      <div className="grid grid-cols-2 gap-1.5" aria-label="Empty output gallery preview">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="create-images-output-tile aspect-square rounded-[8px] bg-well"
          />
        ))}
      </div>
    );
  }
  return (
    <div
      className="create-images-output-tile flex aspect-[4/3] items-center justify-center rounded-control bg-well"
      aria-label="Empty output preview"
    >
      <Images className="size-6 text-quaternary" aria-hidden="true" />
    </div>
  );
}

function RunOutputThumbnail({
  assetId,
  index,
  node,
}: {
  assetId: string;
  index: number;
  node: WorkflowNodeV1;
}) {
  const actions = useCreateImagesCanvasActions();
  const retainRunAssetPreview = actions.retainRunAssetPreview;
  React.useEffect(() => retainRunAssetPreview(assetId), [assetId, retainRunAssetPreview]);
  const preview = actions.runAssetPreview(assetId);
  const label = `${CREATE_IMAGES_NODE_DEFINITIONS[node.type].title} output ${index + 1}`;
  return preview ? (
    <img
      className="create-images-run-output-preview block aspect-square min-w-0 rounded-[8px] border border-field object-contain"
      src={preview.url}
      alt={label}
      draggable={false}
      onLoad={() => actions.runAssetPreviewLoaded(assetId, preview.token)}
      onError={() => actions.runAssetPreviewFailed(assetId, preview.token)}
    />
  ) : (
    <span
      className="flex aspect-square min-w-0 items-center justify-center rounded-[8px] border border-field bg-well text-mini text-tertiary"
      role="status"
      aria-label={`Loading ${label}`}
    >
      <ImageIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

function RunOutputPreviews({ node }: { node: WorkflowNodeV1 }) {
  const actions = useCreateImagesCanvasActions();
  const outputAssetIds = actions.nodeRunState(node.id)?.outputAssetIds ?? [];
  if (outputAssetIds.length === 0) return null;
  return (
    <div
      className="nodrag nopan nowheel mt-3 grid grid-cols-2 gap-1.5"
      aria-label={`${CREATE_IMAGES_NODE_DEFINITIONS[node.type].title} generated outputs`}
    >
      {outputAssetIds.map((assetId, index) => (
        <RunOutputThumbnail
          key={`${assetId}:${index}`}
          assetId={assetId}
          index={index}
          node={node}
        />
      ))}
    </div>
  );
}

function ImageInputBody({ node }: { node: Extract<WorkflowNodeV1, { type: "image-input" }> }) {
  const actions = useCreateImagesCanvasActions();
  const assetId = node.data.assetId;
  const retainAssetPreview = actions.retainAssetPreview;
  React.useEffect(
    () => (assetId ? retainAssetPreview(assetId) : undefined),
    [assetId, retainAssetPreview],
  );
  const preview = assetId ? actions.assetPreview(assetId) : undefined;
  const previewStatus = assetId ? actions.assetPreviewStatus(assetId) : undefined;
  const missing = assetId ? actions.assetPreviewMissing(assetId) : false;
  const pending = actions.imageChoicePending(node.id);
  const chooseRef = React.useRef<HTMLButtonElement | null>(null);
  const replaceRef = React.useRef<HTMLButtonElement | null>(null);
  const restoreAfterChoice = React.useRef(false);
  const restoreAfterRemove = React.useRef(false);

  React.useLayoutEffect(() => {
    if (restoreAfterChoice.current && !pending) {
      restoreAfterChoice.current = false;
      (preview ? replaceRef.current : chooseRef.current)?.focus();
    }
    if (restoreAfterRemove.current && !preview) {
      restoreAfterRemove.current = false;
      chooseRef.current?.focus();
    }
  }, [missing, pending, preview]);

  const choose = () => {
    restoreAfterChoice.current = true;
    actions.chooseImage(node.id);
  };
  if (preview) {
    const rawAspect = preview.asset.width / preview.asset.height;
    const boundedAspect = Math.min(1.78, Math.max(0.72, rawAspect));
    return (
      <div className="nodrag nopan nowheel group/image relative overflow-hidden rounded-card bg-well">
        <div
          className="create-images-image-node-frame create-images-preview-grid"
          style={{ aspectRatio: String(boundedAspect) }}
        >
          <img
            className="block size-full object-contain"
            src={preview.url}
            alt={node.data.label || preview.asset.originalName || "Imported reference image"}
            draggable={false}
            onLoad={() => actions.assetPreviewLoaded(preview.asset.assetId, preview.token)}
            onError={() => actions.assetPreviewFailed(preview.asset.assetId, preview.token)}
          />
        </div>
        <div className="create-images-image-node-label pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-3.25rem)] truncate rounded-pill px-2 py-1 text-mini font-medium">
          {node.data.label || preview.asset.originalName || "Reference image"}
        </div>
        <div className="create-images-image-node-actions absolute right-2 top-2 flex items-center gap-1">
          <button
            ref={replaceRef}
            type="button"
            className="create-images-image-node-action flex size-7 items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={`Replace image for Image Input · ${node.id}`}
            title="Replace image"
            onClick={choose}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="create-images-image-node-action flex size-7 items-center justify-center rounded-control text-red outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={`Remove image from Image Input · ${node.id}`}
            title="Remove image"
            onClick={() => {
              restoreAfterRemove.current = true;
              actions.removeImage(node.id);
            }}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="nodrag nopan nowheel flex min-h-40 w-full flex-col items-center justify-center rounded-card border border-red/30 bg-red/5 px-3 text-center">
        <ImageIcon className="size-5 text-red" aria-hidden="true" />
        <span className="mt-2 text-small-strong text-primary">Image file is missing</span>
        <span className="mt-0.5 text-mini text-secondary">Replace or remove this reference.</span>
        <div className="mt-2 flex items-center gap-2">
          <button
            ref={chooseRef}
            type="button"
            className="rounded-control px-1.5 py-1 text-mini text-secondary outline-none hover:bg-control focus-visible:ring-2 focus-visible:ring-focus-ring"
            disabled={pending}
            aria-label={`Replace missing image for Image Input · ${node.id}`}
            onClick={choose}
          >
            {pending ? "Importing…" : "Replace"}
          </button>
          <button
            type="button"
            className="rounded-control px-1.5 py-1 text-mini text-red outline-none hover:bg-red/10 focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={`Remove missing image from Image Input · ${node.id}`}
            onClick={() => {
              restoreAfterRemove.current = true;
              actions.removeImage(node.id);
            }}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }
  return (
    <button
      ref={chooseRef}
      type="button"
      className="nodrag nopan nowheel create-images-preview-grid flex min-h-40 w-full flex-col items-center justify-center rounded-card border border-dashed border-field bg-well text-center outline-none hover:border-focus-ring focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-wait disabled:opacity-60"
      disabled={pending}
      aria-label={`Choose image for Image Input · ${node.id}`}
      onClick={choose}
    >
      <ImageIcon className="size-5 text-tertiary" aria-hidden="true" />
      <span className="mt-2 max-w-40 truncate text-small-strong text-secondary">
        {pending ? "Importing image…" : (node.data.label ?? "Choose an image")}
      </span>
      <span className="mt-0.5 max-w-44 text-mini text-tertiary">
        {node.data.assetId
          ? previewStatus === "unavailable"
            ? "Preview unavailable · replace or try again"
            : previewStatus === "retrying"
              ? "Retrying preview…"
              : "Loading preview…"
          : "Drop or choose a raster image · 64 MB max"}
      </span>
    </button>
  );
}

function ImageInputNode({
  node,
  selected,
  runStatus,
}: {
  node: Extract<WorkflowNodeV1, { type: "image-input" }>;
  selected: boolean;
  runStatus?: string;
}) {
  return (
    <div
      className="create-images-node create-images-image-node relative w-60 text-primary"
      data-selected={selected ? "true" : "false"}
      data-run-status={runStatus}
      data-create-images-image-node
    >
      <ImageInputBody node={node} />
      <Handle
        id="image"
        type="source"
        position={Position.Right}
        className="create-images-handle create-images-image-node-handle"
        style={{ top: "50%" }}
        aria-label="Output: Image"
        title="Image · image"
      />
    </div>
  );
}

export const WorkflowNode = React.memo(function WorkflowNode({
  data,
  selected,
}: NodeProps<CreateImagesCanvasNode>) {
  const node = data.workflowNode;
  const definition = CREATE_IMAGES_NODE_DEFINITIONS[node.type];
  const Icon = NODE_ICONS[node.type];
  const runState = useCreateImagesCanvasActions().nodeRunState(node.id);
  if (node.type === "image-input") {
    return <ImageInputNode node={node} selected={selected} runStatus={runState?.status} />;
  }
  return (
    <div
      className="create-images-node w-72 rounded-card border border-field bg-popover p-3 text-primary shadow-control"
      data-selected={selected ? "true" : "false"}
      data-run-status={runState?.status}
    >
      <NodePorts node={node} direction="inputs" />
      <header className="mb-3 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-[8px] bg-control text-secondary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-small-strong font-medium">{definition.title}</div>
          <div className="truncate text-mini text-tertiary">{definition.category}</div>
        </div>
        {runState ? (
          <CreateImagesNodeRunStatusBadge
            status={runState.status}
            retryMode={runState.retryMode}
            compact
          />
        ) : null}
      </header>
      <NodeBody node={node} />
      <RunOutputPreviews node={node} />
      <NodePorts node={node} direction="outputs" />
    </div>
  );
});
