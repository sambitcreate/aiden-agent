import type { NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";
import { IMAGE_NODE_DEFINITIONS } from "../../shared/images/ports";
import type { ImageModelRef, ImageNodeType, WorkflowNode, WorkflowPosition } from "../../shared/images/schema";
import type { WorkflowFlowNode } from "../flow-adapter-core";
import { GenerateImageNode } from "./generate-image-node";
import { ImageInputNode } from "./image-input-node";
import { OutputNode } from "./output-node";
import { PromptNode } from "./prompt-node";

/** Module-level and stable: React Flow re-mounts every node when nodeTypes changes identity. */
export const NODE_COMPONENTS: Record<ImageNodeType, ComponentType<NodeProps<WorkflowFlowNode>>> = {
  prompt: PromptNode,
  "image-input": ImageInputNode,
  "generate-image": GenerateImageNode,
  output: OutputNode,
};

export const ADDABLE_NODES = (Object.keys(IMAGE_NODE_DEFINITIONS) as ImageNodeType[]).map((type) => ({
  type,
  label: IMAGE_NODE_DEFINITIONS[type].title,
}));

export function createWorkflowNode(
  type: ImageNodeType,
  id: string,
  position: WorkflowPosition,
  defaultModel: ImageModelRef | undefined,
): WorkflowNode {
  switch (type) {
    case "prompt":
      return { id, type, position, data: { text: "" } };
    case "image-input":
      return { id, type, position, data: {} };
    case "generate-image":
      return { id, type, position, data: defaultModel ? { model: { ...defaultModel }, count: 1 } : { count: 1 } };
    case "output":
      return { id, type, position, data: {} };
  }
}
