import type { WorkflowRunScope } from "../shared/create-images/execution";

export const CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE = "selected-node-only";

export interface CreateImagesDownstreamPathChoiceView {
  id: string;
  downstreamPath: readonly string[];
  title: string;
  detail: string;
}

export function createImagesRunScopeForPathChoice(
  startNodeId: string,
  choiceId: string,
  choices: readonly CreateImagesDownstreamPathChoiceView[],
): WorkflowRunScope | undefined {
  if (choiceId === CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE) {
    return { kind: "from-node", nodeId: startNodeId };
  }
  const selected = choices.find((choice) => choice.id === choiceId);
  if (!selected || selected.downstreamPath.length === 0) return undefined;
  return {
    kind: "from-node",
    nodeId: startNodeId,
    downstreamPath: [...selected.downstreamPath],
  };
}
