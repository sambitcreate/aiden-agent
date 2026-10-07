import { EmptyState, ScrollArea } from "../components/ui";

export function DesignRoute(_props: { projectId?: string }) {
  return (
    <ScrollArea title="Design">
      <EmptyState title="No design projects yet" description="Design projects will appear here." />
    </ScrollArea>
  );
}
