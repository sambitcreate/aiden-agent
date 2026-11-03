import * as React from "react";
import {
  Download,
  History,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "./ui";
import { workspaceArtifactsApi } from "../lib/ipc";
import { focusRegionEntry } from "../lib/focus-regions";
import { formatRelativeTime } from "../lib/relative-time";
import { cn } from "../lib/ui-utils";
import type { Workspace } from "../lib/types";
import type { WorkspaceArtifactsState } from "../lib/use-workspace-artifacts";
import {
  pickWorkspaceArtifact,
  workspaceArtifactPage,
  workspaceArtifactCanRefresh,
  WORKSPACE_ARTIFACT_PAGE_IDEAS,
  workspaceArtifactImportAccess,
  workspaceArtifactNewPageRequest,
  workspaceArtifactPageAccess,
  workspaceArtifactProblems,
  workspaceArtifactRevisionWaitsForApproval,
} from "../lib/workspace-artifacts-view";
import {
  WORKSPACE_ARTIFACT_LIMITS,
  resolveWorkspaceArtifactCommand,
  workspaceArtifactCommandList,
  type WorkspaceArtifactImportPreview,
  type WorkspaceArtifactRevisionSummary,
  type WorkspaceArtifactView,
} from "../shared/workspace-artifacts";

/** Page state is saved this long after the last change. */
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
  /**
   * Stages a request for a new page in the active chat's composer, never
   * sending it. Without it the panel offers no New page entry.
   */
  onDraftNewPage?: (request: string) => void;
  /** Why there is no chat to draft into right now; New page explains this instead of drafting. */
  newPageUnavailable?: string | null;
}

/** Opens the New page dialog; focus goes back to `opener` if nothing is drafted. */
type OpenNewPage = (opener: HTMLElement | null) => void;
/** Asks for a page file to import; its preview returns focus to `opener`. */
type StartImport = (opener: HTMLElement | null) => void;

/**
 * The Tools panel's Artifacts tab: the workspace's saved pages, one at a
 * time, with their live data. The page draws with the same Aiden UI renderer
 * as inline visuals; everything around it (switching, approval, rename,
 * delete) is Aiden's own UI.
 */
export function ArtifactsPanel({
  workspace,
  active,
  artifacts,
  selectedId,
  onSelect,
  onAskAiden,
  onAction,
  onDraftNewPage,
  newPageUnavailable = null,
}: ArtifactsPanelProps) {
  const current = artifacts.workspaceId === (workspace?.id ?? null);
  const views = current ? artifacts.views : [];
  const activeId = pickWorkspaceArtifact(views, selectedId);
  const view = views.find((entry) => entry.artifact.id === activeId) ?? null;
  // One New page dialog for the tab: it belongs to the workspace, not to the page shown.
  const [creating, setCreating] = React.useState(false);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const openNewPage: OpenNewPage | null = onDraftNewPage
    ? (opener) => {
        openerRef.current = opener;
        setCreating(true);
      }
    : null;
  const newPageDialog = onDraftNewPage ? (
    <NewArtifactPageDialog
      open={creating}
      onOpenChange={setCreating}
      onDraft={onDraftNewPage}
      unavailable={newPageUnavailable}
      returnFocus={() => openerRef.current}
    />
  ) : null;
  // Import, like New page, belongs to the workspace rather than the page shown.
  const importer = useArtifactImport(workspace, onSelect);

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
      <>
        <ArtifactsEmptyState onNewPage={openNewPage} onImport={importer.start} />
        {newPageDialog}
        {importer.dialog}
      </>
    );
  }
  return (
    <>
      <ArtifactView
        workspace={workspace}
        active={active}
        views={views}
        view={view}
        onSelect={onSelect}
        onAskAiden={onAskAiden}
        onAction={onAction}
        onNewPage={openNewPage}
        onImport={importer.start}
        artifactsError={artifacts.error}
        onRetry={artifacts.reload}
        onStateSaved={artifacts.rememberState}
      />
      {newPageDialog}
      {importer.dialog}
    </>
  );
}

type ReadyImport = Extract<WorkspaceArtifactImportPreview, { status: "ready" }> & { workspaceId: string };

/**
 * Import page: main asks for the file, checks it like any page Aiden saves,
 * and holds it under a token. Nothing is added, and so nothing runs, until
 * the person reads what it can run and presses Import; Cancel lets main
 * forget it. The imported page is never approved.
 */
function useArtifactImport(workspace: Workspace | null, onSelect: (artifactId: string) => void) {
  const [preview, setPreview] = React.useState<ReadyImport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const previewRef = React.useRef(preview);
  previewRef.current = preview;
  const openerRef = React.useRef<HTMLElement | null>(null);
  // A ref, so a second press while the file dialog is up opens no other.
  const choosingRef = React.useRef(false);
  const workspaceId = workspace?.id ?? null;
  const workspaceIdRef = React.useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  const discard = React.useCallback((held: ReadyImport) => {
    // Main also forgets it once it expires, so a failed discard costs nothing.
    void workspaceArtifactsApi.importDiscard(held.workspaceId, held.token).catch(() => undefined);
  }, []);
  // A preview belongs to the workspace it was read for.
  React.useEffect(() => {
    const held = previewRef.current;
    if (held && held.workspaceId !== workspaceId) {
      setPreview(null);
      discard(held);
    }
  }, [discard, workspaceId]);
  React.useEffect(
    () => () => {
      if (previewRef.current) discard(previewRef.current);
    },
    [discard],
  );
  const start = React.useCallback<StartImport>(
    (opener) => {
      if (!workspace || choosingRef.current) return;
      choosingRef.current = true;
      openerRef.current = opener;
      const id = workspace.id;
      void workspaceArtifactsApi
        .importPreview(id)
        .then(
          (result) => {
            if (result.status !== "ready") return;
            const held = { ...result, workspaceId: id };
            if (workspaceIdRef.current === id) setPreview(held);
            else discard(held);
          },
          (cause: unknown) => {
            toast.error(cause instanceof Error ? cause.message : "Could not import this page.");
          },
        )
        .finally(() => {
          choosingRef.current = false;
        });
    },
    [discard, workspace],
  );
  const confirm = async () => {
    const held = previewRef.current;
    if (!held || busy) return;
    setBusy(true);
    try {
      const artifact = await workspaceArtifactsApi.importConfirm(held.workspaceId, held.token);
      setPreview(null);
      onSelectRef.current(artifact.id);
      toast.success(`Imported “${artifact.visual.title}”`);
    } catch (cause) {
      // Main spent the token either way, so the preview cannot be confirmed again.
      setPreview(null);
      toast.error(cause instanceof Error ? cause.message : "Could not import this page.");
    } finally {
      setBusy(false);
    }
  };
  const dialog = (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (open) return;
        const held = previewRef.current;
        setPreview(null);
        if (held) discard(held);
      }}
      title={preview ? `Import “${preview.title}”?` : ""}
      description={preview?.description ?? (workspace ? `Adds this page to ${workspace.name}.` : undefined)}
      confirmLabel="Import"
      busy={busy}
      size={preview?.commands.length ? "large" : undefined}
      onConfirm={confirm}
      returnFocus={() => (openerRef.current?.isConnected ? openerRef.current : null)}
    >
      {preview && workspace ? <ArtifactImportDetails preview={preview} workspace={workspace} /> : null}
    </Dialog>
  );
  return { start, dialog };
}

/** What an imported page can run and read here, and what happens to it under this workspace's access. */
function ArtifactImportDetails({ preview, workspace }: { preview: ReadyImport; workspace: Workspace }) {
  const access = workspaceArtifactImportAccess(workspace);
  if (preview.commands.length === 0 && preview.files.length === 0) {
    return (
      <Text variant="small" color="secondary" as="p">
        It runs no commands and reads no workspace files.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {preview.commands.length > 0 ? (
        <>
          <Text variant="small" as="p">
            It can run these commands in {workspace.name}:
          </Text>
          <ArtifactCommandList commands={preview.commands} />
          <Callout color={access === "run" ? "warning" : undefined}>
            <Text variant="small">
              {access === "needs-approval"
                ? "You’ll be asked to allow these before they run."
                : access === "run"
                  ? "With Full access these run whenever the page refreshes or you press its buttons."
                  : "These won’t run while workspace access is off."}
            </Text>
          </Callout>
        </>
      ) : null}
      {preview.files.length > 0 ? (
        <>
          <Text variant="small" as="p">
            It reads these files in {workspace.name}:
          </Text>
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Files">
            {preview.files.map((file) => (
              <li key={file} className="rounded-card bg-well p-3">
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-small">{file}</pre>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Each command a page can run, labelled and verbatim, as the person approves them. */
function ArtifactCommandList({ commands }: { commands: readonly { label: string; command: string }[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Commands">
      {commands.map((entry, index) => (
        <li key={index} className="rounded-card bg-well p-3">
          <Text variant="small-strong" as="p">
            {entry.label}
          </Text>
          <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-small">{entry.command}</pre>
        </li>
      ))}
    </ul>
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
  const canRun = workspaceArtifactCanRefresh(view, workspace);
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
  const approved = view.artifact.approvedDigest === view.digest;
  const approvedRef = React.useRef({ artifactId, approved });
  React.useEffect(() => {
    const before = approvedRef.current;
    approvedRef.current = { artifactId, approved };
    // Allowing the page's commands loads what they read, however fresh the rest is.
    const justApproved = approved && !before.approved && before.artifactId === artifactId;
    if (!active || (!onOpen && !justApproved)) return;
    const last = refreshedAtRef.current;
    if (!justApproved && last !== undefined && Date.now() - last < FRESH_ENOUGH_MS) return;
    void refresh();
  }, [active, approved, artifactId, onOpen, refresh]);
  const intervalSeconds = view.artifact.refresh.intervalSeconds;
  React.useEffect(() => {
    if (!active || !intervalSeconds) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalSeconds * 1_000);
    return () => window.clearInterval(timer);
  }, [active, intervalSeconds, refresh]);
  // A restore made here brings back sources whose saved data is from another
  // version: once that revision arrives, re-read them if the page may run.
  const [awaiting, setAwaiting] = React.useState<{ artifactId: string; revision: number } | null>(null);
  const revision = view.artifact.revision;
  React.useEffect(() => {
    if (!awaiting) return;
    if (awaiting.artifactId !== artifactId) {
      setAwaiting(null);
      return;
    }
    if (revision < awaiting.revision) return;
    setAwaiting(null);
    if (active) void refresh();
  }, [active, artifactId, awaiting, refresh, revision]);
  // Named by the restored page, which may no longer be the one shown when the restore finishes.
  const refreshAtRevision = React.useCallback(
    (restoredId: string, target: number) => setAwaiting({ artifactId: restoredId, revision: target }),
    [],
  );
  return { canRun, refreshing, error, refresh, refreshAtRevision };
}

function ArtifactView({
  workspace,
  active,
  views,
  view,
  onSelect,
  onAskAiden,
  onAction,
  onNewPage,
  onImport,
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
  onNewPage: OpenNewPage | null;
  onImport: StartImport;
  artifactsError: string | null;
  onRetry: () => void;
  onStateSaved: (artifactId: string, state: Record<string, unknown>) => void;
}) {
  const refresh = useArtifactRefresh(workspace, view, active);
  const pageRef = React.useRef<HTMLDivElement | null>(null);
  const buttons = useArtifactButtons(workspace, view, refresh.refresh);
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
        workspace={workspace}
        views={views}
        view={view}
        refresh={refresh}
        onSelect={onSelect}
        onAskAiden={onAskAiden}
        onNewPage={onNewPage}
        onImport={onImport}
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
        <ArtifactSourceErrors view={view} />
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

/** Why each failed source didn't load, in its own words (for example "gh: not logged in"). */
function ArtifactSourceErrors({ view }: { view: WorkspaceArtifactView }) {
  const failed = workspaceArtifactProblems(view).filter((problem) => problem.status === "error");
  if (failed.length === 0) return null;
  return (
    <Callout color="warning" className="mb-3">
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Sources that didn’t load">
        {failed.map((problem) => (
          <li key={problem.name}>
            <Text variant="small" className="break-words">
              <span className="font-semibold">{problem.name}</span>: {problem.message}
            </Text>
          </li>
        ))}
      </ul>
    </Callout>
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
function useArtifactButtons(workspace: Workspace, view: WorkspaceArtifactView, refresh: () => Promise<void>) {
  const [pending, setPending] = React.useState<PendingButton | null>(null);
  const [running, setRunning] = React.useState(false);
  // A ref, so a second press in the same frame sees the first one.
  const runningRef = React.useRef(false);
  const currentRef = React.useRef({ artifactId: view.artifact.id, refresh });
  React.useLayoutEffect(() => {
    currentRef.current = { artifactId: view.artifact.id, refresh };
  }, [refresh, view.artifact.id]);
  // A confirmation belongs to the page it was asked on.
  React.useEffect(() => {
    if (!runningRef.current) setPending((current) => (current && current.artifactId !== view.artifact.id ? null : current));
  }, [view.artifact.id]);
  const changed = pending !== null && pending.artifactId === view.artifact.id && pending.digest !== view.digest;
  const run = React.useCallback(
    async (button: PendingButton) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      const status = toast.loading(`${button.label}…`);
      try {
        const result = await workspaceArtifactsApi.run(workspace.id, button.artifactId, button.name, button.args, button.digest);
        if (result.ok) toast.success(button.label, { id: status, ...(result.output ? { description: result.output } : {}) });
        else toast.error(`${button.label} failed`, { id: status, description: result.output });
        // Re-read the page that ran, which may no longer be the one on screen.
        if (currentRef.current.artifactId === button.artifactId) void currentRef.current.refresh();
        else void workspaceArtifactsApi.refresh(workspace.id, button.artifactId).catch(() => undefined);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : `${button.label} could not run.`, { id: status });
      } finally {
        runningRef.current = false;
        setRunning(false);
        setPending(null);
      }
    },
    [workspace.id],
  );
  const press = React.useCallback(
    (target: WorkspaceArtifactView, name: string, args: unknown[]) => {
      if (runningRef.current) {
        toast.info("Another button on this page is still running.");
        return;
      }
      const action = target.artifact.actions.find((entry) => entry.name === name);
      if (!action) {
        toast.error(`This page has no button named “${name}”. Ask Aiden to change it.`);
        return;
      }
      const access = workspaceArtifactPageAccess(target, workspace);
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
      const button = { artifactId: target.artifact.id, digest: target.digest, name, label: action.label, args, preview };
      if (workspace.permission === "ask") setPending(button);
      else void run(button);
    },
    [run, workspace],
  );
  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !runningRef.current) setPending(null);
      }}
      title={pending ? `${pending.label}?` : ""}
      description={`This runs in ${workspace.name}:`}
      confirmLabel="Run"
      confirmDisabled={changed}
      busy={running}
      size="large"
      onConfirm={() => (pending && !changed ? run(pending) : undefined)}
    >
      {changed ? (
        <Callout color="warning" className="mb-3" role="alert">
          <Text variant="small">This page changed after you pressed the button. Close this and press it again.</Text>
        </Callout>
      ) : null}
      <pre className="m-0 whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small">{pending?.preview}</pre>
    </Dialog>
  );
  return { press, dialog };
}

/** Placeholder rows, one per width (a percentage of the row). */
function SkeletonRows({ widths }: { widths: readonly number[] }) {
  return widths.map((width, index) => (
    <div key={index} className="flex h-12 items-center rounded-card bg-well px-3">
      <span className="h-2.5 animate-pulse rounded-pill bg-control" style={{ width: `${width}%` }} />
    </div>
  ));
}

function ArtifactsSkeleton() {
  return (
    <div role="status" className="space-y-3 p-4" aria-label="Loading artifacts" aria-busy="true">
      <span className="block h-3 w-1/3 animate-pulse rounded-pill bg-control" />
      <SkeletonRows widths={[86, 64, 78]} />
    </div>
  );
}

function ArtifactsEmptyState({ onNewPage, onImport }: { onNewPage: OpenNewPage | null; onImport: StartImport }) {
  return (
    <EmptyState
      className="h-full"
      title="No artifacts yet"
      description={
        onNewPage
          ? "Pages Aiden keeps for this workspace, like its open pull requests or CI on main. Ask in chat, or start one here."
          : "Ask Aiden to make one, like a page of this repository's open pull requests."
      }
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onNewPage ? (
            <Button variant="accent" size="small" onClick={(event) => onNewPage(event.currentTarget)}>
              <Plus aria-hidden="true" />
              New page…
            </Button>
          ) : null}
          <Button size="small" onClick={(event) => onImport(event.currentTarget)}>
            <Upload aria-hidden="true" />
            Import page…
          </Button>
        </div>
      }
    />
  );
}

/**
 * Starts a page by adding the request to the chat's message box. The dialog
 * never builds or sends anything: the person reads the request and sends it.
 */
function NewArtifactPageDialog({
  open,
  onOpenChange,
  onDraft,
  unavailable,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDraft: (request: string) => void;
  /** Why there is no chat to add the request to; shown instead of drafting. */
  unavailable: string | null;
  returnFocus: () => HTMLElement | null;
}) {
  const [subject, setSubject] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Set when the request was drafted, so focus follows it to the message box.
  const draftedRef = React.useRef(false);
  React.useEffect(() => {
    if (open) draftedRef.current = false;
  }, [open]);
  const request = workspaceArtifactNewPageRequest(subject);
  const inputId = React.useId();
  const reasonId = React.useId();
  const close = (next: boolean) => {
    // Cleared on close, so reopening never shows the last text first.
    if (!next) setSubject("");
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New page"
      description={
        unavailable ? (
          <span id={reasonId}>{unavailable}</span>
        ) : (
          "Aiden adds the request to your chat’s message box. Review it there, then send."
        )
      }
      confirmLabel="Draft in chat"
      confirmDisabled={!request || unavailable !== null}
      confirmDescribedBy={unavailable ? reasonId : undefined}
      submitOnEnter
      onConfirm={() => {
        onDraft(request);
        draftedRef.current = true;
        close(false);
      }}
      returnFocus={() => (draftedRef.current ? focusRegionEntry("composer") : null) ?? returnFocus()}
    >
      <div>
        <Label htmlFor={inputId}>What should it show?</Label>
        <Input
          ref={inputRef}
          id={inputId}
          value={subject}
          placeholder="For example, failing tests on this branch"
          onChange={(event) => setSubject(event.target.value)}
          className="mt-1.5"
          autoFocus
        />
      </div>
      <div role="group" aria-label="Suggestions" className="mt-3 flex flex-wrap gap-2">
        {WORKSPACE_ARTIFACT_PAGE_IDEAS.map((idea) => (
          <Button
            key={idea.label}
            variant="muted"
            size="small"
            aria-label={`Use: ${idea.label}`}
            onClick={() => {
              setSubject(idea.subject);
              inputRef.current?.focus();
            }}
          >
            {idea.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}

function ArtifactsHeader({
  workspace,
  views,
  view,
  refresh,
  onSelect,
  onAskAiden,
  onNewPage,
  onImport,
}: {
  workspace: Workspace;
  views: readonly WorkspaceArtifactView[];
  view: WorkspaceArtifactView;
  refresh: ReturnType<typeof useArtifactRefresh>;
  onSelect: (artifactId: string) => void;
  onAskAiden: (view: WorkspaceArtifactView) => void;
  onNewPage: OpenNewPage | null;
  onImport: StartImport;
}) {
  // Each dialog belongs to the page it was opened on, and closes if another page takes its place.
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [browsing, setBrowsing] = React.useState<string | null>(null);
  // Read when a restore finishes, which may be after another page took this one's place.
  const browsingRef = React.useRef(browsing);
  browsingRef.current = browsing;
  const workspaceId = workspace.id;
  const artifactId = view.artifact.id;
  const menuTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const askedRef = React.useRef(false);
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
      {onNewPage ? (
        <Button
          variant="transparent"
          size="small"
          iconOnly
          aria-label="New page…"
          title="New page"
          onClick={(event) => onNewPage(event.currentTarget)}
        >
          <Plus aria-hidden="true" />
        </Button>
      ) : null}
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
        <DropdownMenuContent
          align="end"
          className="w-56"
          onCloseAutoFocus={(event) => {
            // After Ask Aiden, focus follows the request to the message box (or stays on the trigger).
            if (!askedRef.current) return;
            askedRef.current = false;
            const composer = focusRegionEntry("composer");
            if (!composer) return;
            event.preventDefault();
            composer.focus();
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              askedRef.current = true;
              onAskAiden(view);
            }}
          >
            <MessageSquarePlus aria-hidden="true" />
            Ask Aiden to change this
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(artifactId)}>
            <Pencil aria-hidden="true" />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setBrowsing(artifactId)}>
            <History aria-hidden="true" />
            Earlier versions…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              const name = title;
              workspaceArtifactsApi.exportPage(workspaceId, artifactId).then(
                (result) => {
                  if (result.status === "saved") toast.success(`Exported “${name}”`);
                },
                (cause: unknown) => toast.error(cause instanceof Error ? cause.message : "Could not export this page."),
              );
            }}
          >
            <Download aria-hidden="true" />
            Export page…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onImport(menuTriggerRef.current)}>
            <Upload aria-hidden="true" />
            Import page…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem color="red" onSelect={() => setDeleting(artifactId)}>
            <Trash2 aria-hidden="true" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameArtifactDialog
        open={renaming === artifactId}
        onOpenChange={(open) => setRenaming(open ? artifactId : null)}
        workspaceId={workspaceId}
        view={view}
        returnFocus={() => menuTriggerRef.current}
      />
      <DeleteArtifactDialog
        open={deleting === artifactId}
        onOpenChange={(open) => setDeleting(open ? artifactId : null)}
        workspaceId={workspaceId}
        view={view}
      />
      <ArtifactHistoryDialog
        // A fresh dialog per page, so a restore still running for another page shows nothing here.
        key={artifactId}
        open={browsing === artifactId}
        onOpenChange={(open) => setBrowsing(open ? artifactId : null)}
        workspace={workspace}
        view={view}
        onRestored={(restoredId, revision) => {
          refresh.refreshAtRevision(restoredId, revision);
          // A dialog opened on another page since the restore began stays open.
          if (browsingRef.current === restoredId) setBrowsing(null);
        }}
        returnFocus={() => menuTriggerRef.current}
      />
    </div>
  );
}

type HistoryLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: WorkspaceArtifactRevisionSummary[] };

/**
 * The page's kept earlier versions, newest first. Restoring one makes it the
 * page again as a new version, so a restore can itself be undone here.
 */
function ArtifactHistoryDialog({
  open,
  onOpenChange,
  workspace,
  view,
  onRestored,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  view: WorkspaceArtifactView;
  /**
   * Called with the page and its new revision, so it can re-read its sources
   * once it arrives and close this dialog if it still belongs to that page.
   */
  onRestored: (artifactId: string, revision: number) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [load, setLoad] = React.useState<HistoryLoad>({ status: "loading" });
  const [restoring, setRestoring] = React.useState<number | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const artifactId = view.artifact.id;
  const title = view.artifact.visual.title;
  // Read each time the dialog opens, so it lists what is kept now.
  React.useEffect(() => {
    if (!open) {
      // Forget the list on close, so reopening never shows a stale one first.
      setLoad({ status: "loading" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    workspaceArtifactsApi.history(workspace.id, artifactId).then(
      (entries) => {
        if (!cancelled) setLoad({ status: "ready", entries });
      },
      (cause: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: cause instanceof Error ? cause.message : "Could not load earlier versions." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifactId, attempt, open, workspace.id]);
  // A ref, so a second press in the same frame sees the first one.
  const restoringRef = React.useRef(false);
  const restore = async (revision: number) => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(revision);
    try {
      const restored = await workspaceArtifactsApi.restore(workspace.id, artifactId, revision);
      onRestored(artifactId, restored.revision);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not restore this version.");
    } finally {
      restoringRef.current = false;
      setRestoring(null);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Earlier versions"
      description={`Restore an earlier version of “${title}”. It keeps its current name, and you can undo a restore here too.`}
      confirmHidden
      returnFocus={returnFocus}
    >
      {load.status === "loading" ? (
        <div role="status" aria-label="Loading earlier versions" aria-busy="true" className="flex flex-col gap-2">
          <SkeletonRows widths={[72, 56]} />
        </div>
      ) : load.status === "error" ? (
        <Callout color="warning" role="alert">
          <div className="flex items-center gap-3">
            <Text variant="small" className="min-w-0 flex-1">
              {load.message}
            </Text>
            <Button size="small" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : load.entries.length === 0 ? (
        <Text variant="small" color="secondary" as="p">
          No earlier versions yet. Aiden keeps the last {WORKSPACE_ARTIFACT_LIMITS.history} versions of a page.
        </Text>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Earlier versions">
          {load.entries.map((entry) => (
            <li key={entry.revision} className="flex items-center gap-3 rounded-card bg-well p-3">
              <div className="min-w-0 flex-1">
                <Text variant="small-strong" as="p">
                  Revision {entry.revision}
                  <span className="font-normal text-tertiary"> · {formatRelativeTime(entry.savedAt)}</span>
                </Text>
                {entry.title !== title ? (
                  <Text variant="small" color="secondary" as="p" truncate>
                    Named “{entry.title}”
                  </Text>
                ) : null}
                {workspaceArtifactRevisionWaitsForApproval(entry, workspace) ? (
                  <Text variant="small" as="p" className="text-status-warning">
                    Different commands — needs allowing again
                  </Text>
                ) : null}
              </div>
              {/* Not disabled while a restore runs: that would drop keyboard focus inside the dialog. It looks disabled instead. */}
              <Button
                size="small"
                className="aria-disabled:pointer-events-none aria-disabled:opacity-45"
                aria-disabled={restoring !== null || undefined}
                aria-label={`Restore revision ${entry.revision}`}
                onClick={() => void restore(entry.revision)}
              >
                {restoring === entry.revision ? "Restoring…" : "Restore"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
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
      confirmDisabled={!trimmed || trimmed.length > WORKSPACE_ARTIFACT_LIMITS.titleChars}
      busy={busy}
      onConfirm={save}
      submitOnEnter
      returnFocus={returnFocus}
    >
      <Input aria-label="Artifact name" value={title} maxLength={WORKSPACE_ARTIFACT_LIMITS.titleChars} onChange={(event) => setTitle(event.target.value)} autoFocus />
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
        <ArtifactCommandList commands={reviewing?.commands ?? []} />
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
