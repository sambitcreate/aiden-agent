import * as React from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Columns2,
  ChevronLeft,
  ChevronRight,
  Boxes,
  Download,
  EyeOff,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  Images,
  Maximize2,
  PenTool,
  Plus,
  Lock,
  ListOrdered,
  Unlock,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TextCursorInput,
  X,
} from "lucide-react";
import {
  CREATE_IMAGES_NODE_DEFINITIONS,
  createImagesNodePorts,
} from "../shared/create-images/ports";
import type {
  CreateImagesNodeType,
  GenerateImageNodeV1,
  PromptNodeV1,
  WorkflowNodeV1,
} from "../shared/create-images/schema";
import {
  CREATE_IMAGES_MAX_PROMPT_LENGTH,
  CREATE_IMAGES_MAX_PROMPT_VARIABLES,
  CREATE_IMAGES_PROMPT_VARIABLE_NAME,
} from "../shared/create-images/schema";
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
import { AnnotationBody } from "./annotation-node";
import { createImagesAdaptiveAssetGrantUrl } from "../shared/create-images/ipc";

export interface CreateImagesCanvasNodeData extends Record<string, unknown> {
  workflowNode: WorkflowNodeV1;
}

export type CreateImagesCanvasNode = Node<CreateImagesCanvasNodeData, CreateImagesNodeType>;

const NODE_ICONS: Readonly<
  Record<CreateImagesNodeType, React.ComponentType<{ className?: string }>>
> = {
  "image-input": ImageIcon,
  prompt: TextCursorInput,
  "prompt-list": ListOrdered,
  "generate-image": Sparkles,
  output: Images,
  "output-gallery": GalleryHorizontalEnd,
  "image-compare": Columns2,
  annotation: PenTool,
  group: Boxes,
};

function NodePorts({ node, direction }: { node: WorkflowNodeV1; direction: "inputs" | "outputs" }) {
  const ports = createImagesNodePorts(node, direction);
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
  const actions = useCreateImagesCanvasActions();
  const [draft, setDraft] = React.useState(node.data.text);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => setDraft(node.data.text), [node.data.text]);

  return (
    <div>
    <Textarea
      ref={textareaRef}
      className="nodrag nopan nowheel min-h-20 max-h-40 overflow-y-auto bg-input/55 text-small leading-relaxed"
      aria-label={`Prompt text · ${node.id}`}
      value={draft}
      maxLength={CREATE_IMAGES_MAX_PROMPT_LENGTH}
      placeholder="Describe the image…"
      onFocus={() => actions.beginNodeEdit(node.id)}
      onChange={(event) => {
        const text = boundedPromptText(event.target.value);
        setDraft(text);
        actions.beginNodeEdit(node.id);
        actions.updateNodeDraft(node.id, (current) =>
          current.type === "prompt" ? { ...current, data: { ...current.data, text } } : current,
        );
      }}
      onBlur={() => actions.commitNodeEdit(node.id)}
    />
    {(node.data.variables ?? []).length > 0 ? (
      <div className="nodrag nopan nowheel mt-2 grid gap-1.5" aria-label="Prompt variables">
        {(node.data.variables ?? []).map((variable) => (
          <div key={variable.id} className="flex items-center gap-1.5 rounded-control bg-well px-1.5 py-1">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left font-mono text-mini text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              title={`Insert \${${variable.name}}`}
              onClick={() => {
                const textarea = textareaRef.current;
                const start = textarea?.selectionStart ?? draft.length;
                const end = textarea?.selectionEnd ?? start;
                const token = `\${${variable.name}}`;
                const text = boundedPromptText(`${draft.slice(0, start)}${token}${draft.slice(end)}`);
                setDraft(text);
                actions.updateNode(node.id, (current) =>
                  current.type === "prompt" ? { ...current, data: { ...current.data, text } } : current,
                );
                requestAnimationFrame(() => {
                  textarea?.focus();
                  textarea?.setSelectionRange(start + token.length, start + token.length);
                });
              }}
            >
              {`\${${variable.name}}`}
            </button>
            <input
              className="w-20 rounded-control border border-field bg-input px-1.5 py-1 text-mini outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={`Variable name ${variable.name}`}
              value={variable.name}
              maxLength={32}
              onChange={(event) => {
                const name = event.target.value;
                if (!CREATE_IMAGES_PROMPT_VARIABLE_NAME.test(name)) return;
                if ((node.data.variables ?? []).some((candidate) => candidate.id !== variable.id && candidate.name === name)) return;
                actions.updateNode(node.id, (current) =>
                  current.type === "prompt"
                    ? {
                        ...current,
                        data: {
                          ...current.data,
                          variables: (current.data.variables ?? []).map((candidate) =>
                            candidate.id === variable.id ? { ...candidate, name } : candidate,
                          ),
                        },
                      }
                    : current,
                );
              }}
            />
            <button
              type="button"
              className="grid size-6 place-items-center rounded-control text-tertiary outline-none hover:bg-control-hover hover:text-red focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={`Remove variable ${variable.name}`}
              onClick={() => actions.removePromptVariable(node.id, variable.id)}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    ) : null}
    <button
      type="button"
      className="nodrag nopan nowheel mt-2 flex items-center gap-1 rounded-control px-1.5 py-1 text-mini text-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-45"
      disabled={(node.data.variables ?? []).length >= CREATE_IMAGES_MAX_PROMPT_VARIABLES}
      onClick={() => {
        const existing = new Set((node.data.variables ?? []).map((variable) => variable.name));
        let index = existing.size + 1;
        while (existing.has(`value${index}`)) index += 1;
        const variable = {
          id: `var-${Date.now()}-${index}`,
          name: `value${index}`,
          required: true,
        };
        actions.updateNode(node.id, (current) =>
          current.type === "prompt"
            ? {
                ...current,
                data: {
                  ...current.data,
                  variables: [...(current.data.variables ?? []), variable],
                },
              }
            : current,
        );
      }}
    >
      <Plus className="size-3" aria-hidden="true" />
      Add variable
    </button>
    </div>
  );
}

function PromptListBody({
  node,
}: {
  node: Extract<WorkflowNodeV1, { type: "prompt-list" }>;
}) {
  const actions = useCreateImagesCanvasActions();
  return (
    <div className="space-y-2">
      <select
        className="nodrag nopan h-8 w-full rounded-control border border-field bg-input px-2 text-small outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        aria-label="Prompt list format"
        value={node.data.format}
        onChange={(event) =>
          actions.updateNode(node.id, (candidate) =>
            candidate.type === "prompt-list"
              ? {
                  ...candidate,
                  data: {
                    ...candidate.data,
                    format: event.target.value as "lines" | "json",
                  },
                }
              : candidate,
          )
        }
      >
        <option value="lines">One prompt per line</option>
        <option value="json">JSON string array</option>
      </select>
      <Textarea
        className="nodrag nopan nowheel min-h-28 max-h-52 overflow-y-auto bg-input/55 text-small leading-relaxed"
        maxLength={CREATE_IMAGES_MAX_PROMPT_LENGTH}
        value={node.data.source}
        placeholder={node.data.format === "json" ? '["First prompt", "Second prompt"]' : "First prompt\nSecond prompt"}
        aria-label="Prompt list items"
        onChange={(event) => {
          const source = event.target.value.slice(0, CREATE_IMAGES_MAX_PROMPT_LENGTH);
          actions.updateNode(node.id, (candidate) =>
            candidate.type === "prompt-list"
              ? { ...candidate, data: { ...candidate.data, source } }
              : candidate,
          );
        }}
      />
      <p className="text-mini text-tertiary">Up to 8 confirmed provider requests.</p>
    </div>
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
  if (node.type === "prompt-list") return <PromptListBody node={node} />;
  if (node.type === "generate-image") {
    return <GenerateImageBody node={node} />;
  }
  if (node.type === "image-compare") return <ImageCompareBody node={node} />;
  if (node.type === "output-gallery") return <OutputGalleryBody node={node} />;
  if (node.type === "annotation") return <AnnotationBody node={node} />;
  return (
    <div
      className="create-images-output-tile flex aspect-[4/3] items-center justify-center rounded-control bg-well"
      aria-label="Empty output preview"
    >
      <Images className="size-6 text-quaternary" aria-hidden="true" />
    </div>
  );
}

function OutputGalleryTile({
  assetId,
  index,
  selected,
  onSelectedChange,
}: {
  assetId: string;
  index: number;
  selected: boolean;
  onSelectedChange(selected: boolean): void;
}) {
  const actions = useCreateImagesCanvasActions();
  const retain = actions.retainRunAssetPreview;
  React.useEffect(() => retain(assetId), [assetId, retain]);
  const preview = actions.runAssetPreview(assetId);
  const label = `Gallery image ${index + 1}`;
  return (
    <div
      className="create-images-gallery-tile group/gallery relative aspect-square overflow-hidden rounded-[8px] border border-field bg-well"
      data-selected={selected ? "true" : "false"}
    >
      {preview ? (
        <button
          type="button"
          className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
          aria-label={`Inspect ${label}`}
          onClick={(event) => actions.inspectAsset(assetId, "run", label, event.currentTarget)}
        >
          <img
            className="size-full object-cover"
            src={createImagesAdaptiveAssetGrantUrl(preview.token, 256)}
            alt={label}
            draggable={false}
            onLoad={() => actions.runAssetPreviewLoaded(assetId, preview.token)}
            onError={() => actions.runAssetPreviewFailed(assetId, preview.token)}
          />
        </button>
      ) : (
        <span className="grid size-full place-items-center text-quaternary" role="status">
          <ImageIcon className="size-4" aria-hidden="true" />
        </span>
      )}
      <label className="absolute left-1.5 top-1.5 grid size-6 cursor-pointer place-items-center rounded-control border border-field bg-popover/90 shadow-control backdrop-blur-md">
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--accent)]"
          checked={selected}
          aria-label={`Select ${label}`}
          onChange={(event) => onSelectedChange(event.target.checked)}
        />
      </label>
      <button
        type="button"
        className="create-images-image-node-action absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-control opacity-0 outline-none group-hover/gallery:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring"
        aria-label={`Hide ${label}`}
        title="Hide from gallery"
        onClick={() => actions.setRunAssetHidden(assetId, true)}
      >
        <EyeOff className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function OutputGalleryBody({
  node,
}: {
  node: Extract<WorkflowNodeV1, { type: "output-gallery" }>;
}) {
  const actions = useCreateImagesCanvasActions();
  const outputAssetIds = actions.nodeRunState(node.id)?.outputAssetIds ?? [];
  const visible = outputAssetIds.filter((assetId) => !actions.runAssetHidden(assetId));
  const hidden = outputAssetIds.filter((assetId) => actions.runAssetHidden(assetId));
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const visibleSet = new Set(visible);
  const selectedVisible = [...selected].filter((assetId) => visibleSet.has(assetId));
  if (outputAssetIds.length === 0) {
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
    <div className="nodrag nopan nowheel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-mini tabular-nums text-secondary">
          {visible.length} of {outputAssetIds.length} visible
        </span>
        <div className="flex items-center gap-1">
          {hidden.length > 0 ? (
            <button
              type="button"
              className="rounded-control px-1.5 py-1 text-mini text-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              onClick={() => hidden.forEach((assetId) => actions.setRunAssetHidden(assetId, false))}
            >
              <RotateCcw className="mr-1 inline size-3" aria-hidden="true" />
              Restore {hidden.length}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-control px-1.5 py-1 text-mini font-medium text-accent outline-none hover:bg-list-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-45"
            disabled={visible.length === 0}
            onClick={() =>
              actions.extractRunAssets(
                node.id,
                selectedVisible.length > 0 ? selectedVisible : visible,
              )
            }
          >
            Extract {selectedVisible.length > 0 ? selectedVisible.length : "all"}
          </button>
          <button
            type="button"
            className="rounded-control px-1.5 py-1 text-mini font-medium text-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-45"
            disabled={visible.length === 0}
            onClick={() =>
              actions.exportRunAssetsZip(
                selectedVisible.length > 0 ? selectedVisible : visible,
              )
            }
          >
            <Download className="mr-1 inline size-3" aria-hidden="true" />
            ZIP {selectedVisible.length > 0 ? selectedVisible.length : "all"}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5" aria-label="Output gallery">
        {visible.map((assetId, index) => (
          <OutputGalleryTile
            key={`${assetId}:${index}`}
            assetId={assetId}
            index={index}
            selected={selected.has(assetId)}
            onSelectedChange={(checked) =>
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(assetId);
                else next.delete(assetId);
                return next;
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function CompareImage({
  assetId,
  label,
}: {
  assetId: string | undefined;
  label: string;
}) {
  const actions = useCreateImagesCanvasActions();
  const retain = actions.retainRunAssetPreview;
  React.useEffect(() => (assetId ? retain(assetId) : undefined), [assetId, retain]);
  const preview = assetId ? actions.runAssetPreview(assetId) : undefined;
  return preview ? (
    <img
      className="absolute inset-0 size-full object-cover"
      src={createImagesAdaptiveAssetGrantUrl(preview.token, 512)}
      alt={label}
      draggable={false}
      onLoad={() => actions.runAssetPreviewLoaded(preview.asset.assetId, preview.token)}
      onError={() => actions.runAssetPreviewFailed(preview.asset.assetId, preview.token)}
    />
  ) : (
    <span className="absolute inset-0 grid place-items-center bg-well text-mini text-tertiary">
      {assetId ? `Loading ${label}…` : `Connect ${label}`}
    </span>
  );
}

function ImageCompareBody({
  node,
}: {
  node: Extract<WorkflowNodeV1, { type: "image-compare" }>;
}) {
  const actions = useCreateImagesCanvasActions();
  const left = actions.inputRunAssetIds(node.id, "left")[0];
  const right = actions.inputRunAssetIds(node.id, "right")[0];
  const editingRef = React.useRef(false);
  const begin = () => {
    if (editingRef.current) return;
    editingRef.current = true;
    actions.beginNodeEdit(node.id, true);
  };
  const commit = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    actions.commitNodeEdit(node.id);
  };
  const divider = Math.round(node.data.divider * 100);
  return (
    <div className="nodrag nopan nowheel">
      <div className="create-images-compare relative aspect-[4/3] overflow-hidden rounded-card border border-field bg-well">
        <CompareImage assetId={right} label="Image B" />
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - divider}% 0 0)` }}
        >
          <CompareImage assetId={left} label="Image A" />
        </div>
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35)]"
          style={{ left: `${divider}%` }}
          aria-hidden="true"
        />
        <input
          type="range"
          min="0"
          max="100"
          value={divider}
          aria-label="Image comparison divider"
          className="create-images-compare-slider absolute inset-0 size-full cursor-ew-resize opacity-0"
          onPointerDown={begin}
          onPointerUp={commit}
          onPointerCancel={commit}
          onFocus={begin}
          onBlur={commit}
          onChange={(event) => {
            begin();
            const value = Number(event.target.value) / 100;
            actions.updateNodeDraft(node.id, (candidate) =>
              candidate.type === "image-compare"
                ? { ...candidate, data: { divider: value } }
                : candidate,
            );
          }}
        />
        <span className="pointer-events-none absolute bottom-2 left-2 rounded-pill bg-black/60 px-2 py-1 text-mini font-medium text-white">
          A
        </span>
        <span className="pointer-events-none absolute bottom-2 right-2 rounded-pill bg-black/60 px-2 py-1 text-mini font-medium text-white">
          B
        </span>
      </div>
      <div className="mt-1.5 text-center text-mini tabular-nums text-tertiary">{divider}%</div>
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
  const label = `${CREATE_IMAGES_NODE_DEFINITIONS[node.type].title} image ${index + 1}`;
  return preview ? (
    <div className="create-images-run-output-trigger group/output relative aspect-square min-w-0 overflow-hidden rounded-[8px] border border-field">
      <button
        type="button"
        className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        aria-label={`Inspect ${label}`}
        title="Open image inspector"
        onClick={(event) => actions.inspectAsset(assetId, "run", label, event.currentTarget)}
      >
        <img
          className="create-images-run-output-preview block size-full object-contain"
          src={createImagesAdaptiveAssetGrantUrl(preview.token, 256)}
          alt={label}
          draggable={false}
          onLoad={() => actions.runAssetPreviewLoaded(assetId, preview.token)}
          onError={() => actions.runAssetPreviewFailed(assetId, preview.token)}
        />
        <span className="create-images-run-output-inspect" aria-hidden="true">
          <Maximize2 />
        </span>
      </button>
      <button
        type="button"
        className="create-images-image-node-action absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-control opacity-0 outline-none transition-opacity group-hover/output:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none"
        aria-label={`Save ${label}`}
        title="Save image"
        onClick={() => actions.saveAsset(assetId, "run")}
      >
        <Download className="size-3.5" aria-hidden="true" />
      </button>
    </div>
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
  const lineage = actions.recentNodeOutputs(node.id);
  const [lineageIndex, setLineageIndex] = React.useState(0);
  React.useEffect(() => {
    setLineageIndex((current) => Math.min(current, Math.max(0, lineage.length - 1)));
  }, [lineage.length]);
  const lineageItem = lineage[lineageIndex];
  const retainRecent = actions.retainRecentAssetPreview;
  React.useEffect(
    () => (lineageItem ? retainRecent(lineageItem.assetId) : undefined),
    [lineageItem, retainRecent],
  );
  const lineagePreview = lineageItem
    ? actions.recentAssetPreview(lineageItem.assetId)
    : undefined;
  if (outputAssetIds.length === 0 && !lineageItem) return null;
  return (
    <div className="nodrag nopan nowheel mt-3 space-y-1.5">
      {outputAssetIds.length > 0 ? (
        <div
          className="grid grid-cols-2 gap-1.5"
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
      ) : null}
      {lineageItem ? (
        <div className="rounded-[9px] border border-field bg-well/65 p-1.5">
          <div className="mb-1 flex items-center gap-1 text-mini text-tertiary">
            <span className="min-w-0 flex-1 truncate">Previous outputs</span>
            <span className="tabular-nums">{lineageIndex + 1}/{lineage.length}</span>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-control outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label="Newer generated output"
              disabled={lineageIndex === 0}
              onClick={() => setLineageIndex((current) => Math.max(0, current - 1))}
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-control outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label="Older generated output"
              disabled={lineageIndex >= lineage.length - 1}
              onClick={() =>
                setLineageIndex((current) => Math.min(lineage.length - 1, current + 1))
              }
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          {lineagePreview ? (
            <button
              type="button"
              className="block aspect-square w-full overflow-hidden rounded-[7px] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={`Inspect previous output ${lineageIndex + 1}`}
              onClick={(event) =>
                actions.inspectAsset(
                  lineageItem.assetId,
                  "recent",
                  lineageItem.prompt || `Previous output ${lineageIndex + 1}`,
                  event.currentTarget,
                  lineageItem.runId,
                )
              }
            >
              <img
                className="size-full object-cover"
                src={createImagesAdaptiveAssetGrantUrl(lineagePreview.token, 256)}
                alt=""
                draggable={false}
                onLoad={() =>
                  actions.recentAssetPreviewLoaded(lineageItem.assetId, lineagePreview.token)
                }
                onError={() =>
                  actions.recentAssetPreviewFailed(lineageItem.assetId, lineagePreview.token)
                }
              />
            </button>
          ) : (
            <span className="grid aspect-square place-items-center rounded-[7px] text-mini text-tertiary">
              Loading previous output…
            </span>
          )}
          <p className="mt-1 truncate text-mini text-tertiary">
            {lineageItem.modelLabel} · {new Date(lineageItem.createdAt).toLocaleString()}
          </p>
        </div>
      ) : null}
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
      <div className="group/image relative overflow-hidden rounded-card bg-well">
        <div
          className="create-images-image-node-frame create-images-preview-grid"
          style={{ aspectRatio: String(boundedAspect) }}
          onDoubleClick={() => actions.fitImageToMedia(node.id)}
          title="Double-click to fit the node to this image"
        >
          <img
            className="block size-full object-contain"
            src={createImagesAdaptiveAssetGrantUrl(
              preview.token,
              Math.max(node.dimensions?.width ?? 320, node.dimensions?.height ?? 320),
            )}
            alt={node.data.label || preview.asset.originalName || "Imported reference image"}
            draggable={false}
            onLoad={() => actions.assetPreviewLoaded(preview.asset.assetId, preview.token)}
            onError={() => actions.assetPreviewFailed(preview.asset.assetId, preview.token)}
          />
        </div>
        <div className="create-images-image-node-label pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-3.25rem)] truncate rounded-pill px-2 py-1 text-mini font-medium">
          {node.data.label || preview.asset.originalName || "Reference image"}
        </div>
        <div className="nodrag nopan nowheel create-images-image-node-actions absolute right-2 top-2 flex items-center gap-1">
          <button
            type="button"
            className="create-images-image-node-action flex size-7 items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={`Save image from Image Input · ${node.id}`}
            title="Save image"
            onClick={() => actions.saveAsset(preview.asset.assetId, "workflow")}
          >
            <Download className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="create-images-image-node-action flex size-7 items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={`Inspect image for Image Input · ${node.id}`}
            title="Open image inspector"
            onClick={(event) =>
              actions.inspectAsset(
                preview.asset.assetId,
                "workflow",
                node.data.label || preview.asset.originalName || "Reference image",
                event.currentTarget,
              )
            }
          >
            <Maximize2 className="size-3.5" aria-hidden="true" />
          </button>
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
  const actions = useCreateImagesCanvasActions();
  return (
    <div
      className={`create-images-node create-images-image-node relative text-primary ${node.dimensions ? "size-full" : "w-60"}`}
      data-selected={selected ? "true" : "false"}
      data-run-status={runStatus}
      data-create-images-image-node
    >
      <NodeResizer
        minWidth={180}
        minHeight={120}
        maxWidth={1_200}
        maxHeight={1_600}
        isVisible={selected && !actions.nodeLayoutLocked(node.id)}
        onResizeStart={() => actions.beginNodeEdit(node.id, true)}
        onResize={(_event, parameters) =>
          actions.updateNodeDraft(node.id, (candidate) => ({
            ...candidate,
            dimensions: { width: parameters.width, height: parameters.height },
          }))
        }
        onResizeEnd={() => actions.commitNodeEdit(node.id)}
      />
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

function GroupWorkflowNode({
  node,
  selected,
}: {
  node: Extract<WorkflowNodeV1, { type: "group" }>;
  selected: boolean;
}) {
  const actions = useCreateImagesCanvasActions();
  return (
    <div
      className="create-images-group-node size-full rounded-card border-2 p-3 text-primary"
      data-selected={selected ? "true" : "false"}
      data-color={node.data.color}
    >
      <NodeResizer
        minWidth={240}
        minHeight={180}
        maxWidth={1_200}
        maxHeight={1_600}
        isVisible={selected}
        onResizeStart={() => actions.beginNodeEdit(node.id, true)}
        onResize={(_event, parameters) =>
          actions.updateNodeDraft(node.id, (candidate) => ({
            ...candidate,
            dimensions: { width: parameters.width, height: parameters.height },
          }))
        }
        onResizeEnd={() => actions.commitNodeEdit(node.id)}
      />
      <div className="flex items-center gap-2 rounded-control bg-popover/80 px-2 py-1.5 shadow-control backdrop-blur-md">
        <Boxes className="size-3.5 text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-small-strong font-medium">
          {node.title || "Group"}
        </span>
        <span className="text-mini tabular-nums text-tertiary">{node.data.memberNodeIds.length}</span>
        <select
          className="nodrag nopan w-16 rounded-control border border-field bg-input px-1 py-0.5 text-mini outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-label="Group color"
          value={node.data.color}
          onChange={(event) =>
            actions.updateNode(node.id, (candidate) =>
              candidate.type === "group"
                ? {
                    ...candidate,
                    data: {
                      ...candidate.data,
                      color: event.target.value as typeof candidate.data.color,
                    },
                  }
                : candidate,
            )
          }
        >
          {(["blue", "green", "orange", "purple", "gray"] as const).map((color) => (
            <option key={color} value={color}>{color}</option>
          ))}
        </select>
        <button
          type="button"
          className="nodrag nopan grid size-6 place-items-center rounded-control text-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-label={node.data.locked ? "Unlock group layout" : "Lock group layout"}
          aria-pressed={node.data.locked}
          onClick={() =>
            actions.updateNode(node.id, (candidate) =>
              candidate.type === "group"
                ? { ...candidate, data: { ...candidate.data, locked: !candidate.data.locked } }
                : candidate,
            )
          }
        >
          {node.data.locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
        </button>
      </div>
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
  const actions = useCreateImagesCanvasActions();
  const runState = actions.nodeRunState(node.id);
  if (node.type === "image-input") {
    return <ImageInputNode node={node} selected={selected} runStatus={runState?.status} />;
  }
  if (node.type === "group") return <GroupWorkflowNode node={node} selected={selected} />;
  return (
    <div
      className={`create-images-node rounded-card border border-field bg-popover p-3 text-primary shadow-control ${node.dimensions ? "size-full overflow-auto" : "w-72"}`}
      data-selected={selected ? "true" : "false"}
      data-run-status={runState?.status}
    >
      <NodeResizer
        minWidth={180}
        minHeight={120}
        maxWidth={1_200}
        maxHeight={1_600}
        isVisible={selected && !actions.nodeLayoutLocked(node.id)}
        onResizeStart={() => actions.beginNodeEdit(node.id, true)}
        onResize={(_event, parameters) =>
          actions.updateNodeDraft(node.id, (candidate) => ({
            ...candidate,
            dimensions: { width: parameters.width, height: parameters.height },
          }))
        }
        onResizeEnd={() => actions.commitNodeEdit(node.id)}
      />
      <NodePorts node={node} direction="inputs" />
      <header className="mb-3 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-[8px] bg-control text-secondary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-small-strong font-medium">
            {node.title || definition.title}
          </div>
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
      {node.type === "image-compare" || node.type === "output-gallery" ? null : (
        <RunOutputPreviews node={node} />
      )}
      <NodePorts node={node} direction="outputs" />
    </div>
  );
});
