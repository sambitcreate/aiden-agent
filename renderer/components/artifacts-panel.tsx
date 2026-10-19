import * as React from "react";
import { MessageSquarePlus, MoreHorizontal, Pencil, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
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
import { cn } from "../lib/ui-utils";
import type { Workspace } from "../lib/types";
import type { WorkspaceArtifactsState } from "../lib/use-workspace-artifacts";
import {
  pickWorkspaceArtifact,
  workspaceArtifactPage,
  workspaceArtifactPageAccess,
  workspaceArtifactProblems,
} from "../lib/workspace-artifacts-view";
import {
  resolveWorkspaceArtifactCommand,
  workspaceArtifactCommandList,
  type WorkspaceArtifactView,
} from "../shared/workspace-artifacts";

/** Page state is saved this long after the last change, like an inline visual's. */
const STATE_SAVE_DELAY_MS = 400;
/** A page refreshed this recently (say, by the chat that just made it) is not re-read on open. */
const FRESH_ENOUGH_MS = 15_000;

export interface ArtifactsPanelProps {
  workspace: Workspace | null;
  /** The tab is on screen: only then do sources refresh on open or on their interval. */
  active: boolean;
  artifacts: WorkspaceArtifactsState;
  selectedId: string | null;
  onSelect: (artifactId: string) => void;
  /** Stages a change request for this page in the active chat's composer. */
  onAskAiden: (view: WorkspaceArtifactView) => void;
  /** Follow-ups and composer text the page hands to the chat; buttons (`run`) are handled here. */
  onAction?: (view: WorkspaceArtifactView, action: AidenUiAction) => void;
}

/**
 * The Tools panel's Artifacts tab: the workspace's saved pages, one at a
 * time, with their live data. The page draws with the same Aiden UI renderer
 * as inline visuals; everything around it (switching, approval, rename,
 * delete) is Aiden's own UI.
 */
export function ArtifactsPanel({ workspace, active, artifacts, selectedId, onSelect, onAskAiden, onAction }: ArtifactsPanelProps) {
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
    <ArtifactView
      workspace={workspace}
      active={active}
      views={views}
      view={view}
      onSelect={onSelect}
      onAskAiden={onAskAiden}
      onAction={onAction}
      artifactsError={artifacts.error}
      onRetry={artifacts.reload}
      onStateSaved={artifacts.rememberState}
    />
  );
}

/**
 * Re-reads the page's sources when it is shown, when the person asks, and on
 * its interval while visible. Only pages allowed to run do.
 */
function useArtifactRefresh(workspace: Workspace, view: WorkspaceArtifactView, active: boolean) {
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const artifactId = view.artifact.id;
  const canRun = view.artifact.sources.length > 0 && workspaceArtifactPageAccess(view, workspace) === "run";
  const request = React.useRef(0);
  const refresh = React.useCallback(async () => {
    if (!canRun) return;
    const id = ++request.current;
    setRefreshing(true);
    setError(null);
    try {
      await workspaceArtifactsApi.refresh(workspace.id, artifactId);
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : "Could not refresh this page.");
    } finally {
      if (id === request.current) setRefreshing(false);
    }
  }, [artifactId, canRun, workspace.id]);
  React.useEffect(() => {
    // A refresh still running for the previous page must not report into this one.
    request.current += 1;
    setError(null);
    setRefreshing(false);
  }, [artifactId]);
  const refreshedAtRef = React.useRef(view.snapshot?.refreshedAt);
  React.useLayoutEffect(() => {
    refreshedAtRef.current = view.snapshot?.refreshedAt;
  }, [view.snapshot?.refreshedAt]);
  const onOpen = view.artifact.refresh.onOpen;
  React.useEffect(() => {
    if (!active || !onOpen) return;
    const last = refreshedAtRef.current;
    if (last !== undefined && Date.now() - last < FRESH_ENOUGH_MS) return;
    void refresh();
  }, [active, onOpen, refresh]);
  const intervalSeconds = view.artifact.refresh.intervalSeconds;
  React.useEffect(() => {
    if (!active || !intervalSeconds) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalSeconds * 1_000);
    return () => window.clearInterval(timer);
  }, [active, intervalSeconds, refresh]);
  return { canRun, refreshing, error, refresh };
}

function ArtifactView({
  workspace,
  active,
  views,
  view,
  onSelect,
  onAskAiden,
  onAction,
  artifactsError,
  onRetry,
  onStateSaved,
}: {
  workspace: Workspace;
  active: boolean;
  views: readonly WorkspaceArtifactView[];
  view: WorkspaceArtifactView;
  onSelect: (artifactId: string) => void;
  onAskAiden: (view: WorkspaceArtifactView) => void;
  onAction?: (view: WorkspaceArtifactView, action: AidenUiAction) => void;
  artifactsError: string | null;
  onRetry: () => void;
  onStateSaved: (artifactId: string, state: Record<string, unknown>) => void;
}) {
  const refresh = useArtifactRefresh(workspace, view, active);
  const pageRef = React.useRef<HTMLDivElement | null>(null);
  const buttons = useArtifactButtons(workspace, refresh.refresh);
  const { press } = buttons;
  const handleAction = React.useCallback(
    (target: WorkspaceArtifactView, action: AidenUiAction) => {
      if (action.kind === "run") press(target, action.name, action.args);
      else onAction?.(target, action);
    },
    [onAction, press],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactsHeader
        workspaceId={workspace.id}
        views={views}
        view={view}
        refresh={refresh}
        onSelect={onSelect}
        onAskAiden={onAskAiden}
      />
      <div ref={pageRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none" data-artifact-page={view.artifact.id}>
        {artifactsError ? (
          <Callout color="warning" className="mb-3" role="alert">
            <div className="flex items-center gap-3">
              <Text variant="small" className="min-w-0 flex-1">
                Couldn’t reload this workspace’s artifacts: {artifactsError}
              </Text>
              <Button size="small" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </Callout>
        ) : null}
        {view.artifact.description ? (
          <Text variant="small" color="secondary" as="p" className="mb-3">
            {view.artifact.description}
          </Text>
        ) : null}
        <ArtifactAccessNotice key={view.artifact.id} workspace={workspace} view={view} returnFocus={() => pageRef.current} />
        <ArtifactPage workspaceId={workspace.id} view={view} onAction={handleAction} onStateSaved={onStateSaved} />
        {buttons.dialog}
      </div>
    </div>
  );
}

interface PendingButton {
  artifactId: string;
  digest: string;
  name: string;
  label: string;
  args: unknown[];
  preview: string;
}

/**
 * A page's buttons run the command the page declared, filled with the values
 * it passes. Under Ask the person confirms each press with the exact command;
 * under Full a press runs at once, as a chat's commands would.
 */
function useArtifactButtons(workspace: Workspace, refresh: () => Promise<void>) {
  const [pending, setPending] = React.useState<PendingButton | null>(null);
  const [running, setRunning] = React.useState(false);
  const run = React.useCallback(
    async (button: PendingButton) => {
      setRunning(true);
      try {
        const result = await workspaceArtifactsApi.run(workspace.id, button.artifactId, button.name, button.args, button.digest);
        if (result.ok) toast.success(button.label, result.output ? { description: result.output } : undefined);
        else toast.error(`${button.label} failed`, { description: result.output });
        void refresh();
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : `${button.label} could not run.`);
      } finally {
        setRunning(false);
        setPending(null);
      }
    },
    [refresh, workspace.id],
  );
  const press = React.useCallback(
    (view: WorkspaceArtifactView, name: string, args: unknown[]) => {
      if (running) return;
      const action = view.artifact.actions.find((entry) => entry.name === name);
      if (!action) {
        toast.error(`This page has no button named “${name}”. Ask Aiden to change it.`);
        return;
      }
      const access = workspaceArtifactPageAccess(view, workspace);
      if (access === "blocked") {
        toast.error("Workspace access is off, so this page’s buttons can’t run.");
        return;
      }
      if (access === "needs-approval") {
        toast.error("Allow this page’s commands first.");
        return;
      }
      let preview: string;
      try {
        preview = resolveWorkspaceArtifactCommand(action, args).preview;
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : `${action.label} could not run.`);
        return;
      }
      const button = { artifactId: view.artifact.id, digest: view.digest, name, label: action.label, args, preview };
      if (workspace.permission === "ask") setPending(button);
      else void run(button);
    },
    [run, running, workspace],
  );
  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !running) setPending(null);
      }}
      title={pending ? `${pending.label}?` : ""}
      description={`This runs in ${workspace.name}:`}
      confirmLabel="Run"
      busy={running}
      size="large"
      onConfirm={() => (pending ? run(pending) : undefined)}
    >
      <pre className="m-0 whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small">{pending?.preview}</pre>
    </Dialog>
  );
  return { press, dialog };
}

function ArtifactsSkeleton() {
  return (
    <div role="status" className="space-y-3 p-4" aria-label="Loading artifacts" aria-busy="true">
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
  refresh,
  onSelect,
  onAskAiden,
}: {
  workspaceId: string;
  views: readonly WorkspaceArtifactView[];
  view: WorkspaceArtifactView;
  refresh: ReturnType<typeof useArtifactRefresh>;
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
      <span className="min-w-0 flex-1 truncate text-small text-tertiary">
        {refresh.error ? (
          <span role="status" className="text-status-warning">Couldn’t refresh: {refresh.error}</span>
        ) : problems.length > 0 ? (
          <span role="status" className="text-status-warning">
            {problems.length === 1 ? `${problems[0]!.name} didn’t load` : `${problems.length} sources didn’t load`}
          </span>
        ) : refreshedAt ? (
          `Updated ${formatRelativeTime(refreshedAt)}`
        ) : null}
      </span>
      {refresh.canRun ? (
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={() => void refresh.refresh()}
          disabled={refresh.refreshing}
          aria-label={`Refresh ${title}`}
          title="Refresh"
        >
          <RefreshCw className={cn(refresh.refreshing && "animate-spin")} />
        </Button>
      ) : null}
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
        <p role="alert" className="mt-2 text-small text-status-red">
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

interface ApprovalSnapshot {
  artifactId: string;
  digest: string;
  title: string;
  commands: { label: string; command: string }[];
}

/** Why live data is held back, and the one step that releases it. */
function ArtifactAccessNotice({
  workspace,
  view,
  returnFocus,
}: {
  workspace: Workspace;
  view: WorkspaceArtifactView;
  returnFocus: () => HTMLElement | null;
}) {
  const access = workspaceArtifactPageAccess(view, workspace);
  // What the dialog shows is frozen when it opens, and Allow approves exactly that.
  const [reviewing, setReviewing] = React.useState<ApprovalSnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const changed = reviewing !== null && reviewing.digest !== view.digest;
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
        <Button
          size="small"
          onClick={() =>
            setReviewing({
              artifactId: view.artifact.id,
              digest: view.digest,
              title: view.artifact.visual.title,
              commands: workspaceArtifactCommandList(view.artifact.sources, view.artifact.actions),
            })
          }
        >
          <ShieldCheck aria-hidden="true" />
          Review…
        </Button>
      </div>
      <Dialog
        open={reviewing !== null}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
        title="Allow these commands?"
        description={`“${reviewing?.title ?? ""}” runs these in ${workspace.name} when it refreshes or you press its buttons. Changing any of them asks again.`}
        confirmLabel="Allow"
        confirmDisabled={changed}
        busy={busy}
        size="large"
        returnFocus={returnFocus}
        onConfirm={async () => {
          if (!reviewing || changed) return;
          setBusy(true);
          try {
            await workspaceArtifactsApi.approve(workspace.id, reviewing.artifactId, reviewing.digest);
            setReviewing(null);
          } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : "Could not allow these commands.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {changed ? (
          <Callout color="warning" className="mb-3" role="alert">
            <Text variant="small">This page’s commands changed while you were reading. Close this and review them again.</Text>
          </Callout>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Commands">
          {reviewing?.commands.map((entry, index) => (
            <li key={index} className="rounded-card bg-well p-3">
              <Text variant="small-strong" as="p">
                {entry.label}
              </Text>
              <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-small">{entry.command}</pre>
            </li>
          ))}
        </ul>
      </Dialog>
    </Callout>
  );
}

function ArtifactPage({
  workspaceId,
  view,
  onAction,
  onStateSaved,
}: {
  workspaceId: string;
  view: WorkspaceArtifactView;
  onAction?: (view: WorkspaceArtifactView, action: AidenUiAction) => void;
  /** Keeps the list's copy current, so switching pages and back shows the page as it was left. */
  onStateSaved: (artifactId: string, state: Record<string, unknown>) => void;
}) {
  const onStateSavedRef = React.useRef(onStateSaved);
  React.useLayoutEffect(() => {
    onStateSavedRef.current = onStateSaved;
  }, [onStateSaved]);
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
        onStateSavedRef.current(artifactId, state);
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
