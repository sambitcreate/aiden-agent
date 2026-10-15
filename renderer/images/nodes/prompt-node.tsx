import type { NodeProps } from "@xyflow/react";
import { Textarea } from "../../components/ui";
import { CanvasNodeChrome } from "../../canvas";
import { useWorkflowEditor } from "../editor-context";
import type { WorkflowFlowNode } from "../flow-adapter-core";
import { NodePorts } from "./node-ports";

export function PromptNodeBody({ text, onChange }: { text: string; onChange(text: string): void }) {
  return (
    <Textarea
      aria-label="Prompt text"
      className="nodrag nowheel"
      density="compact"
      rows={4}
      value={text}
      placeholder="Describe the image you want"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function PromptNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const editor = useWorkflowEditor();
  const node = data.node;
  if (node.type !== "prompt") return null;
  return (
    <div className="image-node">
      <CanvasNodeChrome title={node.title ?? "Prompt"} selected={selected}>
        <PromptNodeBody text={node.data.text} onChange={(text) => editor.apply({ type: "set-prompt", nodeId: id, text })} />
      </CanvasNodeChrome>
      <NodePorts type="prompt" />
    </div>
  );
}
