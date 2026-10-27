import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { workspacesApi } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import type { Workspace } from "../../lib/types";
import type { WorkspaceMemoryFactView } from "../../../main/services/workspace-memory-facts";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function factDetails(fact: WorkspaceMemoryFactView): string {
  return [
    fact.savedBy === "you" ? "Saved by you" : "Saved by Aiden",
    dateFormat.format(fact.updatedAt),
    fact.alwaysOn ? "Always included" : undefined,
    fact.expiresAt ? `Until ${dateFormat.format(fact.expiresAt)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What Aiden remembers in one workspace, with a permanent delete per fact. */
export function MemoryFactsSection({ workspaces }: { workspaces: Workspace[] }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string>();
  const workspaceId =
    selectedId && workspaces.some((workspace) => workspace.id === selectedId)
      ? selectedId
      : workspaces[0]?.id;
  const facts = useQuery({
    queryKey: queryKeys.workspaceMemoryFacts(workspaceId ?? ""),
    queryFn: () => workspacesApi.memoryFacts(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const [pendingDelete, setPendingDelete] = React.useState<WorkspaceMemoryFactView>();
  const [deleting, setDeleting] = React.useState(false);
  const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "";

  const confirmDelete = async () => {
    const fact = pendingDelete;
    if (!fact || !workspaceId || deleting) return;
    setDeleting(true);
    try {
      await workspacesApi.deleteMemoryFact(workspaceId, fact.id);
      queryClient.setQueryData<WorkspaceMemoryFactView[]>(
        queryKeys.workspaceMemoryFacts(workspaceId),
        (current) => current?.filter((item) => item.id !== fact.id),
      );
      setPendingDelete(undefined);
      toast.success("Memory deleted.");
    } catch {
      toast.error("Couldn't delete that memory. Try again.");
    } finally {
      setDeleting(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMemoryFacts(workspaceId) });
    }
  };

  if (workspaces.length === 0) return null;
  return (
    <>
      <FieldSet title="What Aiden remembers">
        <Field label="Workspace" description="Facts Aiden can recall in this workspace's chats.">
          <Select value={workspaceId} onValueChange={setSelectedId}>
            <SelectTrigger aria-label="Workspace to show memories for" className="max-w-56">
              <span className="min-w-0 truncate text-left">
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {facts.isPending ? (
          <Text as="p" variant="small" color="secondary" className="p-4" role="status">
            Loading memories…
          </Text>
        ) : facts.isError ? (
          <Text as="p" variant="small" color="secondary" className="p-4" role="status">
            Memories couldn't be read. Reopen this page to try again.
          </Text>
        ) : facts.data?.length ? (
          <ul aria-label={`Memories in ${workspaceName}`} className="contents">
            {facts.data.map((fact) => (
              <li key={fact.id} className="contents">
                <Field
                  label={<span className="whitespace-pre-wrap break-words font-normal">{fact.text}</span>}
                  description={factDetails(fact)}
                  className="grid-cols-[minmax(0,1fr)_auto] max-[540px]:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <Button
                    size="small"
                    variant="transparent"
                    aria-label={`Delete memory: ${fact.text}`}
                    onClick={() => setPendingDelete(fact)}
                  >
                    Delete
                  </Button>
                </Field>
              </li>
            ))}
          </ul>
        ) : (
          <Text as="p" variant="small" color="secondary" className="p-4">
            Aiden hasn't saved anything in this workspace yet.
          </Text>
        )}
      </FieldSet>
      <Text as="p" variant="small" color="secondary" className="text-pretty">
        Deleting a memory removes it for good. Aiden can still see anything already in a chat, and
        it may suggest the fact again later. Bots keep their own memory in each Bot's page.
      </Text>
      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(undefined);
        }}
        title="Delete this memory?"
        description={pendingDelete ? `“${pendingDelete.text}” will be removed for good.` : undefined}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        confirmVariant="destructive"
        busy={deleting}
        keepOpenOnConfirm
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
