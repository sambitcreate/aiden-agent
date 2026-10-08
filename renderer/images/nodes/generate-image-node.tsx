import type { NodeProps } from "@xyflow/react";
import { Badge, Button } from "../../components/ui";
import { CanvasNodeChrome } from "../../canvas";
import type { ImageModelOption } from "../../shared/images/port";
import type { AttemptSnapshot } from "../../shared/images/run-types";
import type { ImageModelRef } from "../../shared/images/schema";
import { AttemptBadge } from "../attempt-badge";
import { useWorkflowEditor } from "../editor-context";
import type { WorkflowFlowNode } from "../flow-adapter-core";
import { ModelPicker } from "../model-picker";
import { STALE_LABEL } from "../run-view-core";
import { NodePorts } from "./node-ports";

export function GenerateImageNodeBody({
  model,
  models,
  attempt,
  running,
  stale = false,
  onModel,
  onRunFromHere,
}: {
  model: ImageModelRef | undefined;
  models: readonly ImageModelOption[];
  attempt: AttemptSnapshot | undefined;
  running: boolean;
  stale?: boolean;
  onModel(model: ImageModelRef): void;
  onRunFromHere(): void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ModelPicker value={model} models={models} onChange={onModel} />
      {attempt ? <AttemptBadge attempt={attempt} /> : null}
      {stale ? <Badge color="warning">{STALE_LABEL}</Badge> : null}
      <Button size="small" variant="muted" className="nodrag" disabled={running} onClick={onRunFromHere}>
        Run from Here
      </Button>
    </div>
  );
}

export function GenerateImageNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const editor = useWorkflowEditor();
  const node = data.node;
  if (node.type !== "generate-image") return null;
  return (
    <div className="image-node">
      <CanvasNodeChrome title={node.title ?? "Generate Image"} selected={selected}>
        <GenerateImageNodeBody
          model={node.data.model}
          models={editor.models}
          attempt={editor.attempts.get(id)}
          running={editor.running}
          stale={editor.stale.has(id)}
          onModel={(model) => editor.apply({ type: "set-model", nodeId: id, model })}
          onRunFromHere={() => editor.runFromHere(id)}
        />
      </CanvasNodeChrome>
      <NodePorts type="generate-image" />
    </div>
  );
}
