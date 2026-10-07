import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import * as React from "react";
import {
  AlertDialog,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Text,
} from "../components/ui";
import { StudioSurface } from "../canvas";
import { createImagesIpc } from "../lib/create-images-ipc";
import type { MutateWorkflowRequest, MutateWorkflowResponse } from "../shared/images/ipc-types";
import type { WorkflowSummary } from "../shared/images/schema";
import type { ImageWorkflowTemplate } from "../shared/images/templates";
import { deleteWorkflowDescription } from "./run-view-core";

const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

const REFUSED: Record<NonNullable<MutateWorkflowResponse["reason"]>, string> = {
  busy: "Stop the run first, then delete this workflow.",
  "not-found": "This workflow no longer exists.",
};

export function ImagesHome() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<{ workflow: WorkflowSummary; title: string } | null>(null);
  const [deleting, setDeleting] = React.useState<WorkflowSummary | null>(null);
  const [imageCounts, setImageCounts] = React.useState<Record<string, number>>({});

  const refresh = React.useCallback(async () => {
    try {
      const listed = await createImagesIpc.list();
      setWorkflows(listed.workflows);
      setImageCounts(listed.imageCounts);
      setError(null);
    } catch (failure) {
      setError(message(failure));
    }
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (workflowId: string) => void navigate({ to: "/images/$workflowId", params: { workflowId } });
  const create = async (template: ImageWorkflowTemplate) => {
    try {
      open((await createImagesIpc.create({ template })).workflow.id);
    } catch (failure) {
      setError(message(failure));
    }
  };
  const mutate = async (request: MutateWorkflowRequest, failure: string): Promise<MutateWorkflowResponse> => {
    const result = await createImagesIpc.mutate(request).catch((): MutateWorkflowResponse => ({ ok: false }));
    if (!result.ok) setError(result.reason ? REFUSED[result.reason] : failure);
    await refresh();
    return result;
  };

  return (
    <StudioSurface
      title="Images"
      actions={
        <>
          <Button variant="muted" onClick={() => void create("blank")}>New Blank Workflow</Button>
          <Button variant="accent" onClick={() => void create("starter")}>New from Starter</Button>
        </>
      }
    >
      <div className="h-full overflow-y-auto px-6 py-4">
        {error ? <Text as="p" role="alert" color="status-red" className="mb-3">{error}</Text> : null}
        {workflows && workflows.length === 0 ? (
          <EmptyState
            title="No image workflows yet"
            description="Start from the Starter template to turn a prompt into an image."
            action={<Button variant="accent" onClick={() => void create("starter")}>New from Starter</Button>}
          />
        ) : (
          <ul aria-label="Image workflows" className="mx-auto flex max-w-3xl flex-col gap-1">
            {(workflows ?? []).map((workflow) => (
              <li key={workflow.id} className="flex items-center gap-2">
                <Button variant="transparent" className="min-w-0 flex-1 justify-start" onClick={() => open(workflow.id)}>
                  <span className="truncate">{workflow.title}</span>
                </Button>
                <Text variant="small" color="secondary">{new Date(workflow.updatedAt).toLocaleString()}</Text>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="transparent" iconOnly aria-label={`More actions for ${workflow.title}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming({ workflow, title: workflow.title })}>Rename…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void mutate({ op: "duplicate", workflowId: workflow.id }, "That workflow could not be duplicated.")}>
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDeleting(workflow)}>Delete…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog
        open={renaming !== null}
        onOpenChange={(next) => {
          if (!next) setRenaming(null);
        }}
        title="Rename workflow"
        confirmLabel="Rename"
        confirmDisabled={!renaming?.title.trim()}
        submitOnEnter
        onConfirm={async () => {
          if (!renaming) return;
          await mutate({ op: "rename", workflowId: renaming.workflow.id, title: renaming.title.trim() }, "That workflow could not be renamed.");
          setRenaming(null);
        }}
      >
        <Input
          aria-label="Workflow name"
          maxLength={120}
          value={renaming?.title ?? ""}
          onChange={(event) => setRenaming((current) => (current ? { ...current, title: event.target.value } : current))}
        />
      </Dialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={`Delete “${deleting?.title ?? ""}”?`}
        description={deleteWorkflowDescription(deleting ? (imageCounts[deleting.id] ?? 0) : 0)}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          await mutate({ op: "delete", workflowId: deleting.id }, "That workflow could not be deleted.");
          setDeleting(null);
        }}
      />
    </StudioSurface>
  );
}
