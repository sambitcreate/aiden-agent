import { EmptyState, ScrollArea } from "../components/ui";

export function ImagesRoute(_props: { workflowId?: string }) {
  return (
    <ScrollArea title="Images">
      <EmptyState title="No image workflows yet" description="Image workflows will appear here." />
    </ScrollArea>
  );
}
