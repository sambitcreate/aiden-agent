import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { AlertDialog, Button, Dialog, EmptyState, Input, Text } from "../components/ui";
import { Tabs } from "../components/ui-primitives";
import { StudioSurface } from "../canvas";
import { createImagesIpc } from "../lib/create-images-ipc";
import type { ImagesHomeView } from "../main/images-home-search";
import type { MutateWorkflowRequest, MutateWorkflowResponse } from "../shared/images/ipc-types";
import type { ImageModelOption } from "../shared/images/port";
import type { WorkflowSummary } from "../shared/images/schema";
import type { ImageWorkflowTemplate } from "../shared/images/templates";
import { ImageLibrary } from "./image-library";
import { summarizeWorkflowImages } from "./library-core";
import { deleteWorkflowDescription, ownValue } from "./run-view-core";
import { useGallery } from "./use-gallery";
import { useImageActions } from "./viewer/use-image-actions";
import { WorkflowGrid, type WorkflowCardActions } from "./workflow-grid";

const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

const REFUSED: Record<NonNullable<MutateWorkflowResponse["reason"]>, string> = {
  busy: "Stop the run first, then delete this workflow.",
  "not-found": "This workflow no longer exists.",
};

const VIEWS = [
  { value: "workflows", label: "Workflows" },
  { value: "images", label: "All Images" },
] as const;

export function ImagesHome({ view = "workflows" }: { view?: ImagesHomeView }) {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<{ workflow: WorkflowSummary; title: string } | null>(null);
  const [deleting, setDeleting] = React.useState<WorkflowSummary | null>(null);
  const [imageCounts, setImageCounts] = React.useState<Record<string, number>>({});
  const [models, setModels] = React.useState<readonly ImageModelOption[]>([]);
  const gallery = useGallery();
  const imageActions = useImageActions({ onSaved: gallery.refresh });

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
    let cancelled = false;
    // Display names only: without them, models show by id.
    createImagesIpc.listModels().then(
      (listed) => {
        if (!cancelled) setModels(listed.models);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const summaries = React.useMemo(() => summarizeWorkflowImages(gallery.items), [gallery.items]);
  const liveWorkflowIds = React.useMemo(() => (workflows ? new Set(workflows.map((workflow) => workflow.id)) : null), [workflows]);

  const open = React.useCallback(
    (workflowId: string) => void navigate({ to: "/images/$workflowId", params: { workflowId } }),
    [navigate],
  );
  // Replace, so Back leaves Images instead of stepping through views; Back from a workflow returns to this view.
  const changeView = (next: ImagesHomeView) =>
    void navigate({ to: "/images", search: next === "images" ? { view: "images" } : {}, replace: true });
  const create = async (template: ImageWorkflowTemplate) => {
    try {
      open((await createImagesIpc.create({ template })).workflow.id);
    } catch (failure) {
      setError(message(failure));
    }
  };
  const mutate = async (request: MutateWorkflowRequest, failure: string): Promise<MutateWorkflowResponse> => {
    const result = await createImagesIpc.mutate(request).catch((): MutateWorkflowResponse => ({ ok: false }));
    // Refresh first: a successful reload clears the error, so the refusal must land after it.
    await refresh();
    if (!result.ok) setError(result.reason ? REFUSED[result.reason] : failure);
    return result;
  };
  const cardActions: WorkflowCardActions = {
    open: (workflow) => open(workflow.id),
    rename: (workflow) => setRenaming({ workflow, title: workflow.title }),
    duplicate: (workflow) => void mutate({ op: "duplicate", workflowId: workflow.id }, "That workflow could not be duplicated."),
    remove: setDeleting,
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
      <div className="flex h-full min-h-0 flex-col">
        <Tabs<ImagesHomeView> value={view} onValueChange={changeView} items={VIEWS} aria-label="Images views" className="shrink-0 px-6 pb-3 pt-1" />
        {error ? <Text as="p" role="alert" color="status-red" className="shrink-0 px-6 pb-3">{error}</Text> : null}
        <div role="tabpanel" aria-label={view === "images" ? "All Images" : "Workflows"} className="flex min-h-0 flex-1 flex-col">
          {view === "images" ? (
            <ImageLibrary gallery={gallery} models={models} actions={imageActions} liveWorkflowIds={liveWorkflowIds} onOpenWorkflow={open} />
          ) : workflows && workflows.length === 0 ? (
            <EmptyState
              title="No image workflows yet"
              description="Start from the Starter template to turn a prompt into an image."
              action={<Button variant="accent" onClick={() => void create("starter")}>New from Starter</Button>}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
              <WorkflowGrid workflows={workflows ?? []} summaries={summaries} galleryReady={gallery.status === "ready"} actions={cardActions} />
            </div>
          )}
        </div>
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
          const result = await mutate({ op: "rename", workflowId: renaming.workflow.id, title: renaming.title.trim() }, "That workflow could not be renamed.");
          // Library items carry workflow titles.
          if (result.ok) gallery.refresh();
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
        description={deleteWorkflowDescription(deleting ? (ownValue(imageCounts, deleting.id) ?? 0) : 0)}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          const result = await mutate({ op: "delete", workflowId: deleting.id }, "That workflow could not be deleted.");
          if (result.ok) gallery.refresh();
          setDeleting(null);
        }}
      />
    </StudioSurface>
  );
}
