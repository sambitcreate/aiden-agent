import type { NodeProps } from "@xyflow/react";
import { Button, Text } from "../../components/ui";
import { CanvasNodeChrome } from "../../canvas";
import { useWorkflowEditor } from "../editor-context";
import type { WorkflowFlowNode } from "../flow-adapter-core";
import { ownValue } from "../run-view-core";
import { ImageNodeFrame } from "./node-frame";
import { NodePorts } from "./node-ports";

export function ImageInputNodeBody({ url, label, onChoose }: { url?: string; label: string; onChoose(): void }) {
  return (
    <div className="image-node-body flex flex-col gap-2">
      {url ? <img className="image-node-media" src={url} alt={label} /> : <Text variant="small" color="secondary">No image chosen</Text>}
      <Button size="small" variant="muted" className="nodrag shrink-0" onClick={onChoose}>
        {url ? "Replace Image…" : "Choose Image…"}
      </Button>
    </div>
  );
}

export function ImageInputNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const editor = useWorkflowEditor();
  const node = data.node;
  if (node.type !== "image-input") return null;
  const label = node.data.label ?? "Reference image";
  const url = node.data.assetId ? ownValue(editor.assetUrls, node.data.assetId) : undefined;
  return (
    <ImageNodeFrame dimensions={node.dimensions}>
      <CanvasNodeChrome title={node.title ?? "Image Input"} selected={selected}>
        <ImageInputNodeBody url={url} label={label} onChoose={() => editor.importImage(id)} />
      </CanvasNodeChrome>
      <NodePorts type="image-input" />
    </ImageNodeFrame>
  );
}
