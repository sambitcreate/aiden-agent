import { EmptyState } from "../components/ui";

export const DESIGN_CANVAS_EMPTY_COPY = "Designs will appear here.";

export function DesignCanvasEmpty() {
  return <EmptyState placement="inline" title={DESIGN_CANVAS_EMPTY_COPY} />;
}
