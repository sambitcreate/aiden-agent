import "../canvas/styles";
import "./images.css";
import type { ImagesHomeView } from "../main/images-home-search";
import { ImagesHome } from "./images-home";
import { WorkflowEditor } from "./workflow-editor";

/**
 * The route contract is `ImagesRoute({ workflowId?, view? })`: the home without an id (its
 * Workflows or All Images view), the editor with one.
 */
export function ImagesRoute({ workflowId, view = "workflows" }: { workflowId?: string; view?: ImagesHomeView }) {
  return workflowId ? <WorkflowEditor key={workflowId} workflowId={workflowId} /> : <ImagesHome view={view} />;
}
