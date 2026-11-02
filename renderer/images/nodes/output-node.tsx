import type { NodeProps } from "@xyflow/react";
import { Badge, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Text } from "../../components/ui";
import { CanvasNodeChrome } from "../../canvas";
import type { OutputRef } from "../../shared/images/run-types";
import { useWorkflowEditor } from "../editor-context";
import type { WorkflowFlowNode } from "../flow-adapter-core";
import { STALE_LABEL, ownValue } from "../run-view-core";
import { ImageNodeFrame } from "./node-frame";
import { NodePorts } from "./node-ports";
import { openContextMenuFromKeyboard } from "../../lib/keyboard-context-menu";

const GALLERY_LIMIT = 4;

/** What a thumbnail can do: open the viewer, and the right-click actions on its image. */
export interface OutputImageActions {
  open(index: number): void;
  saveAs(assetId: string): void;
  copy(assetId: string): void;
  reveal(assetId: string): void;
  revealLabel: string;
}

function Thumbnail({ image, index, url, name, more, actions }: { image: OutputRef; index: number; url?: string; name: string; more: number; actions?: OutputImageActions }) {
  const media = url ? (
    <img src={url} alt={more > 0 ? "" : name} width={image.width} height={image.height} draggable={false} />
  ) : (
    <div className="image-gallery-placeholder" role="img" aria-label={`${name}, loading`} />
  );
  if (!actions) return media;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onKeyDown={openContextMenuFromKeyboard}>
        <button
          type="button"
          className="image-thumb nodrag"
          aria-label={more > 0 ? `${name} and ${more} more` : undefined}
          onClick={() => actions.open(index)}
        >
          {media}
          {more > 0 ? <span className="image-thumb-more" aria-hidden="true">+{more}</span> : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.saveAs(image.assetId)}>Save…</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copy(image.assetId)}>Copy Image</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.reveal(image.assetId)}>{actions.revealLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function OutputNodeBody({
  images,
  urls,
  stale = false,
  actions,
}: {
  images: readonly OutputRef[];
  urls: Readonly<Record<string, string>>;
  stale?: boolean;
  actions?: OutputImageActions;
}) {
  if (images.length === 0) {
    return <Text variant="small" color="secondary">Run the workflow to see images here.</Text>;
  }
  const shown = images.slice(0, GALLERY_LIMIT);
  const hidden = images.length - shown.length;
  return (
    <div className="flex flex-col gap-2">
      {stale ? <Badge color="warning">{STALE_LABEL}</Badge> : null}
      <div className="image-gallery" role="list" aria-label="Generated images">
        {shown.map((image, index) => (
          <div role="listitem" key={image.assetId}>
            <Thumbnail
              image={image}
              index={index}
              url={ownValue(urls, image.assetId)}
              name={`Generated image ${index + 1}`}
              more={index === shown.length - 1 ? hidden : 0}
              actions={actions}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function OutputNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const editor = useWorkflowEditor();
  const node = data.node;
  if (node.type !== "output") return null;
  const { openImage, imageActions } = editor;
  return (
    <ImageNodeFrame>
      <CanvasNodeChrome title={node.title ?? node.data.label ?? "Output"} selected={selected}>
        <OutputNodeBody
          images={editor.outputsFor(id)}
          urls={editor.assetUrls}
          stale={editor.stale.has(id)}
          actions={{ ...imageActions, open: (index) => openImage(id, index) }}
        />
      </CanvasNodeChrome>
      <NodePorts type="output" />
    </ImageNodeFrame>
  );
}
