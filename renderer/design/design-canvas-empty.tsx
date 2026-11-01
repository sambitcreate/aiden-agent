import { EmptyState } from "../components/ui";

export const DESIGN_CANVAS_EMPTY_COPY = "Ask Aiden to design something, or add a note.";

export function DesignCanvasEmpty() {
  return <EmptyState placement="inline" title={DESIGN_CANVAS_EMPTY_COPY} />;
}
