import type { NodeProps } from "@xyflow/react";
import { Badge, Text } from "../../components/ui";
import { CanvasNodeChrome } from "../../canvas";
import type { OutputRef } from "../../shared/images/run-types";
import { useWorkflowEditor } from "../editor-context";
import type { WorkflowFlowNode } from "../flow-adapter-core";
import { STALE_LABEL, ownValue } from "../run-view-core";
import { NodePorts } from "./node-ports";

const GALLERY_LIMIT = 4;

export function OutputNodeBody({ images, urls, stale = false }: { images: readonly OutputRef[]; urls: Readonly<Record<string, string>>; stale?: boolean }) {
  if (images.length === 0) {
    return <Text variant="small" color="secondary">Run the workflow to see images here.</Text>;
  }
  return (
    <div className="flex flex-col gap-2">
      {stale ? <Badge color="warning">{STALE_LABEL}</Badge> : null}
      <div className="image-gallery" role="list" aria-label="Generated images">
        {images.slice(0, GALLERY_LIMIT).map((image, index) => {
          const url = ownValue(urls, image.assetId);
          const name = `Generated image ${index + 1}`;
          return (
            <div role="listitem" key={image.assetId}>
              {url ? (
                <img src={url} alt={name} width={image.width} height={image.height} />
              ) : (
                <div className="image-gallery-placeholder" role="img" aria-label={`${name}, loading`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OutputNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const editor = useWorkflowEditor();
  const node = data.node;
  if (node.type !== "output") return null;
  return (
    <div className="image-node">
      <CanvasNodeChrome title={node.title ?? node.data.label ?? "Output"} selected={selected}>
        <OutputNodeBody images={editor.outputsFor(id)} urls={editor.assetUrls} stale={editor.stale.has(id)} />
      </CanvasNodeChrome>
      <NodePorts type="output" />
    </div>
  );
}
