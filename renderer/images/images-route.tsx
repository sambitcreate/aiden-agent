import "../canvas/styles";
import "./images.css";
import { ImagesHome } from "./images-home";
import { WorkflowEditor } from "./workflow-editor";

/** The route contract is `ImagesRoute({ workflowId? })`: the library without an id, the editor with one. */
export function ImagesRoute({ workflowId }: { workflowId?: string }) {
  return workflowId ? <WorkflowEditor key={workflowId} workflowId={workflowId} /> : <ImagesHome />;
}
