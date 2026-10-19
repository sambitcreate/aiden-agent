import * as React from "react";
import { MessageSquarePlus, MoreHorizontal, Pencil, ShieldCheck, Trash2 } from "lucide-react";
import { AidenUiBlock, type AidenUiAction } from "./aiden-ui/aiden-ui-block";
import {
  AlertDialog,
  Button,
  Callout,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "./ui";
import { workspaceArtifactsApi } from "../lib/ipc";
import { formatRelativeTime } from "../lib/relative-time";
import type { Workspace } from "../lib/types";
import type { WorkspaceArtifactsState } from "../lib/use-workspace-artifacts";
import {
  pickWorkspaceArtifact,
  workspaceArtifactPage,
  workspaceArtifactPageAccess,
  workspaceArtifactProblems,
} from "../lib/workspace-artifacts-view";
import { describeWorkspaceArtifactCommands, type WorkspaceArtifactView } from "../shared/workspace-artifacts";

/** Page state is saved this long after the last change, like an inline visual's. */
const STATE_SAVE_DELAY_MS = 400;

export interface ArtifactsPanelProps {
  workspace: Workspace | null;
  artifacts: WorkspaceArtifactsState;
  selectedId: string | null;
  onSelect: (artifactId: string) => void;
  /** Stages a change request for this page in the active chat's composer. */
  onAskAiden: (view: WorkspaceArtifactView) => void;
  /** Follow-ups and other page actions that leave the page. */
  onAction?: (view: WorkspaceArtifactView, action: AidenUiAction) => void;
}

/**
 * The Tools panel's Artifacts tab: the workspace's saved pages, one at a
 * time, with their live data. The page draws with the same Aiden UI renderer
 * as inline visuals; everything around it (switching, approval, rename,
 * delete) is Aiden's own UI.
 */
export function ArtifactsPanel({ workspace, artifacts, selectedId, onSelect, onAskAiden, onAction }: ArtifactsPanelProps) {
  const current = artifacts.workspaceId === (workspace?.id ?? null);
  const views = current ? artifacts.views : [];
  const activeId = pickWorkspaceArtifact(views, selectedId);
  const view = views.find((entry) => entry.artifact.id === activeId) ?? null;

  if (!workspace) {
    return <EmptyState className="h-full" title="No workspace" description="Choose a workspace to see its artifacts." />;
  }
  if (!current || !artifacts.loaded) return <ArtifactsSkeleton />;
  if (!view) {
    return artifacts.error ? (
      <EmptyState
        className="h-full"
        role="alert"
        title="Artifacts unavailable"
        description={artifacts.error}
        action={<Button size="small" onClick={artifacts.reload}>Try again</Button>}
      />
    ) : (
      <EmptyState
        className="h-full"
        title="No artifacts yet"
        description="Ask Aiden to make one, like a page of this repository's open pull requests."
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactsHeader
        workspaceId={workspace.id}
        views={views}
        view={view}
        onSelect={onSelect}
        onAskAiden={onAskAiden}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-artifact-page={view.artifact.id}>
        {view.artifact.description ? (
          <Text variant="small" color="secondary" as="p" className="mb-3">
            {view.artifact.description}
          </Text>
        ) : null}
        <ArtifactAccessNotice workspace={workspace} view={view} />
        <ArtifactPage workspaceId={workspace.id} view={view} onAction={onAction} />
      </div>
    </div>
  );
}

function ArtifactsSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-label="Loading artifacts" aria-busy="true">
      <span className="block h-3 w-1/3 animate-pulse rounded-pill bg-control" />
      {[86, 64, 78].map((width, index) => (
        <div key={index} className="flex h-12 items-center rounded-card bg-well px-3">
          <span className="h-2.5 animate-pulse rounded-pill bg-control" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

function ArtifactsHeader({
  workspaceId,
  views,
  view,
  onSelect,
  onAskAiden,
}: {
  workspaceId: string;
  views: readonly WorkspaceArtifactView[];
  view: WorkspaceArtifactView;
  onSelect: (artifactId: string) => void;
  onAskAiden: (view: WorkspaceArtifactView) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const menuTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const title = view.artifact.visual.title;
  const refreshedAt = view.snapshot?.refreshedAt;
  const problems = workspaceArtifactProblems(view);
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-separator px-3">
      {views.length > 1 ? (
        <Select value={view.artifact.id} onValueChange={onSelect}>
          <SelectTrigger size="small" aria-label="Artifact" className="w-auto max-w-[60%] min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {views.map((entry) => (
              <SelectItem key={entry.artifact.id} value={entry.artifact.id}>
                {entry.artifact.visual.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Text variant="small-strong" truncate className="min-w-0">
          {title}
        </Text>
      )}
      <span className="min-w-0 flex-1 truncate text-small text-tertiary" aria-live="polite">
        {problems.length > 0 ? (
          <span className="text-status-warning">
            {problems.length === 1 ? `${problems[0]!.name} didn’t load` : `${problems.length} sources didn’t load`}
          </span>
        ) : refreshedAt ? (
          `Updated ${formatRelativeTime(refreshedAt)}`
        ) : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={menuTriggerRef} variant="transparent" size="small" iconOnly aria-label={`Actions for ${title}`}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => onAskAiden(view)}>
            <MessageSquarePlus aria-hidden="true" />
            Ask Aiden to change this
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil aria-hidden="true" />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem color="red" onSelect={() => setDeleting(true)}>
            <Trash2 aria-hidden="true" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameArtifactDialog
        open={renaming}
        onOpenChange={setRenaming}
        workspaceId={workspaceId}
        view={view}
        returnFocus={() => menuTriggerRef.current}
      />
      <DeleteArtifactDialog open={deleting} onOpenChange={setDeleting} workspaceId={workspaceId} view={view} />
    </div>
  );
}

function RenameArtifactDialog({
  open,
  onOpenChange,
  workspaceId,
  view,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  view: WorkspaceArtifactView;
  returnFocus: () => HTMLElement | null;
}) {
  const [title, setTitle] = React.useState(view.artifact.visual.title);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setTitle(view.artifact.visual.title);
    setError(null);
  }, [open, view.artifact.visual.title]);
  const trimmed = title.trim();
  const save = async () => {
    if (!trimmed || trimmed === view.artifact.visual.title) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workspaceArtifactsApi.rename(workspaceId, view.artifact.id, trimmed);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename this artifact.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename artifact"
      confirmLabel="Rename"
      confirmDisabled={!trimmed || trimmed.length > 80}
      busy={busy}
      onConfirm={save}
      submitOnEnter
      returnFocus={returnFocus}
    >
      <Input aria-label="Artifact name" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} autoFocus />
      {error ? (
        <p role="alert" className="mt-2 text-small text-support-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function DeleteArtifactDialog({
  open,
  onOpenChange,
  workspaceId,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  view: WorkspaceArtifactView;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete “${view.artifact.visual.title}”?`}
      description="The page and its saved data are removed from this workspace for every chat. Chats keep their history."
      confirmLabel="Delete"
      confirmVariant="destructive"
      busy={busy}
      keepOpenOnConfirm
      onConfirm={async () => {
        setBusy(true);
        try {
          await workspaceArtifactsApi.delete(workspaceId, view.artifact.id);
          onOpenChange(false);
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : "Could not delete this artifact.");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** Why live data is held back, and the one step that releases it. */
function ArtifactAccessNotice({ workspace, view }: { workspace: Workspace; view: WorkspaceArtifactView }) {
  const access = workspaceArtifactPageAccess(view, workspace);
  const [reviewing, setReviewing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (access === "blocked") {
    return (
      <Callout className="mb-3">
        <Text variant="small">
          {workspace.folderPath
            ? "Workspace access is off, so this page shows the data it last saved and its buttons are off."
            : "This workspace has no folder, so this page can’t read live data or run its buttons."}
        </Text>
      </Callout>
    );
  }
  if (access !== "needs-approval") return null;
  return (
    <Callout color="warning" className="mb-3">
      <div className="flex items-center gap-3">
        <Text variant="small" className="min-w-0 flex-1">
          This page runs commands in your workspace. Allow them to load live data.
        </Text>
        <Button size="small" onClick={() => setReviewing(true)}>
          <ShieldCheck aria-hidden="true" />
          Review…
        </Button>
      </div>
      <Dialog
        open={reviewing}
        onOpenChange={setReviewing}
        title="Allow these commands?"
        description={`“${view.artifact.visual.title}” runs these in ${workspace.name} when it refreshes or you press its buttons. Changing any of them asks again.`}
        confirmLabel="Allow"
        busy={busy}
        size="large"
        onConfirm={async () => {
          setBusy(true);
          try {
            await workspaceArtifactsApi.approve(workspace.id, view.artifact.id, view.digest);
            setReviewing(false);
          } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : "Could not allow these commands.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <pre className="m-0 whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small">
          {describeWorkspaceArtifactCommands(view.artifact.sources, view.artifact.actions)}
        </pre>
      </Dialog>
    </Callout>
  );
}

function ArtifactPage({
  workspaceId,
  view,
  onAction,
}: {
  workspaceId: string;
  view: WorkspaceArtifactView;
  onAction?: (view: WorkspaceArtifactView, action: AidenUiAction) => void;
}) {
  const visual = React.useMemo(() => workspaceArtifactPage(view), [view]);
  const artifactId = view.artifact.id;
  const pending = React.useRef<{ timer: ReturnType<typeof setTimeout>; save: () => void } | null>(null);
  const flush = React.useCallback(() => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    clearTimeout(current.timer);
    current.save();
  }, []);
  // A page switch or unmount saves what is still waiting.
  React.useEffect(() => flush, [artifactId, flush]);
  const onStateChange = React.useCallback(
    (state: Record<string, unknown>) => {
      if (pending.current) clearTimeout(pending.current.timer);
      const save = () => {
        void workspaceArtifactsApi.saveState(workspaceId, artifactId, state).catch(() => {
          // State is a convenience: the page still works, it just reopens as it was.
        });
      };
      pending.current = { save, timer: setTimeout(() => { pending.current = null; save(); }, STATE_SAVE_DELAY_MS) };
    },
    [artifactId, workspaceId],
  );
  const handleAction = React.useCallback((action: AidenUiAction) => onAction?.(view, action), [onAction, view]);
  // AidenUiBlock contains its own render failures, falling back to the page's text.
  return <AidenUiBlock key={artifactId} visual={visual} hideCaption onStateChange={onStateChange} onAction={handleAction} />;
}
