import * as React from "react";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Folder, Loader2, TriangleAlert } from "lucide-react";
import { Composer } from "../components/composer";
import {
  RemoteMachinePicker,
  RemoteModelPicker,
  RemoteProjectPicker,
  SCRATCH_PROJECT,
  type NewChatMachineId,
} from "../components/remote-new-chat-pickers";
import { RemoteHostMarker, RemoteHostStatusRow } from "../components/sidebar-remote";
import { Button, Dialog, EmptyState, ScrollArea, Text, toast } from "../components/ui";
import { composerSurfacesFor } from "../lib/hosts/composer-surfaces";
import { hostResultValue, isOutcomeUnknown, type HostChatCapability } from "../lib/hosts/host-chat-adapter";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import {
  defaultHostModel,
  findHostModel,
  type HostBrowserPage,
  type HostBrowserRoot,
  type HostCreatedWorkspace,
  type HostModelCatalog,
  type HostModelChoice,
} from "../lib/hosts/host-resources";
import { remoteAttachmentUploads } from "../lib/hosts/remote-attachments";
import { RemoteHostAdapter } from "../lib/hosts/remote-host-adapter";
import {
  hostFolderChoice,
  hostFolderPlaces,
  RemoteNewChatControl,
  type HostFolderPlace,
  type RemoteNewChatSnapshot,
} from "../lib/hosts/remote-new-chat";
import {
  newChatMachines,
  remoteProjectChoices,
  unlistedProjects,
  type NewChatMachine,
  type RemoteProjectChoice,
} from "../lib/hosts/new-chat-targets";
import { peerHostsApi } from "../lib/ipc";
import type { Attachment } from "../lib/types";
import { hostResourceKey, type PeerHostFeedSnapshot, type PeerHostStatus, type PeerHostView } from "../shared/peer-host";

/**
 * `/host/$hostId/new`: a new chat that runs on a paired host. The project,
 * model and folder choices all come from that host, and every step (create
 * the project, create the chat, upload its files, start its first turn) runs
 * there through its adapter. Nothing here reads or writes this Mac's
 * workspaces, models, files, terminal or browser.
 */

const noop = () => {};
const subscribeNothing = () => noop;
const nothing = () => null;

/** The composer draft for a host's new chat, kept apart from every other host's. */
export function remoteNewChatDraftKey(hostId: string): string {
  return hostResourceKey({ hostId, resourceId: "draft:new-chat" });
}

export interface RemoteNewChatPaneProps {
  host: NewChatMachine;
  /** Every paired host this Mac could start a chat on, for the machine picker. */
  machines: readonly NewChatMachine[];
  capabilities: ReadonlySet<HostChatCapability>;
  snapshot: RemoteNewChatSnapshot | null;
  projects: readonly RemoteProjectChoice[];
  /** A project ID, `SCRATCH_PROJECT`, or empty while none is chosen. */
  project: string;
  models: HostModelCatalog | undefined;
  modelsLoading: boolean;
  model: HostModelChoice | undefined;
  onSelectMachine(machine: NewChatMachineId): void;
  onSelectProject(projectId: string): void;
  onBrowse(): void;
  onSelectModel(choice: HostModelChoice): void;
  onSend(text: string, attachments: Attachment[]): Promise<void>;
  onRetry(): void;
  onDismiss(): void;
  onOpenChat(chatId: string): void;
  onReconnect(hostId: string): Promise<void>;
  onManage(): void;
}

/** Why the composer cannot send yet, or null when it can. */
function sendBlockedReason(props: RemoteNewChatPaneProps): string | null {
  const { host, capabilities, snapshot, project, projects } = props;
  if (host.disabledReason) return host.disabledReason;
  if (!snapshot) return `Connecting to ${host.label}…`;
  if (snapshot.unresolved) return "Retry or dismiss the message above before sending another.";
  // A project this host does not list, such as one carried over from another Mac, is no choice at all.
  const chosen = project === SCRATCH_PROJECT || projects.some((choice) => choice.id === project);
  if (!chosen) {
    return capabilities.has("createWorkspace") || projects.length > 0
      ? `Choose a project on ${host.label} first.`
      : `${host.label} has no projects this Mac can use yet.`;
  }
  return null;
}

/** The new remote chat's presentation; all state arrives in props. */
export function RemoteNewChatPane(props: RemoteNewChatPaneProps) {
  const { host, machines, capabilities, snapshot, projects, project, models, modelsLoading, model } = props;
  const blocked = sendBlockedReason(props);
  const unresolved = snapshot?.unresolved ?? null;
  const starting = Boolean(snapshot?.starting);
  const unavailable = host.availability !== "online";
  const chosenModel = findHostModel(models, model);
  const draftKey = remoteNewChatDraftKey(host.id);

  return (
    <ScrollArea
      className="h-full min-h-0"
      alignFooterToScrollContent
      title={
        <span className="flex min-w-0 items-center gap-2">
          <RemoteHostMarker hostLabel={host.label} stale={unavailable} />
          <span className="min-w-0">
            <span className="block truncate">New chat</span>
            <span className="block truncate text-small font-normal text-secondary">{`Runs on ${host.label}`}</span>
          </span>
        </span>
      }
      footer={
        <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-3">
          {unresolved ? (
            <div
              role="alert"
              data-remote-new-chat-unresolved="true"
              className="flex items-start gap-2.5 rounded-card bg-status-warning-surface p-3"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <Text variant="small-strong" as="p">
                  {unresolved.message}
                </Text>
                <Text variant="small" color="secondary" as="p" className="mt-0.5 line-clamp-3 break-words">
                  {unresolved.text}
                </Text>
                <Text variant="small" color="tertiary" as="p" className="mt-1">
                  Retry checks with that Mac and never sends it twice.
                </Text>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button variant="muted" size="small" disabled={unresolved.retrying} onClick={props.onDismiss}>
                  Dismiss
                </Button>
                <Button variant="muted" size="small" onClick={() => props.onOpenChat(unresolved.chatId)}>
                  Open chat
                </Button>
                <Button variant="accent" size="small" disabled={unresolved.retrying || unavailable} onClick={props.onRetry}>
                  {unresolved.retrying ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  Retry
                </Button>
              </div>
            </div>
          ) : null}
          {unavailable ? <RemoteHostStatusRow host={host} onReconnect={props.onReconnect} onManage={props.onManage} /> : null}
          <Composer
            // Keyed by host, so a draft typed for one Mac never appears for another.
            key={draftKey}
            chatId={draftKey}
            surfaces={composerSurfacesFor(capabilities)}
            ready={blocked === null}
            readinessMessage={blocked ?? undefined}
            hasMessages={false}
            freezeWhileSending
            firstMessageSaving={starting}
            onSend={(text, attachments) => props.onSend(text, attachments)}
            onStop={noop}
            isGenerating={false}
            // Images are refused only when the chosen model is known not to read them.
            visionSupported={chosenModel ? chosenModel.supportsImages : undefined}
            remoteContext={
              <>
                <RemoteMachinePicker machines={machines} selected={host.id} disabled={starting} onSelect={props.onSelectMachine} />
                <RemoteProjectPicker
                  hostLabel={host.label}
                  projects={projects}
                  selected={project}
                  disabled={starting || Boolean(host.disabledReason)}
                  canCreate={capabilities.has("createWorkspace")}
                  canBrowse={capabilities.has("createWorkspace") && capabilities.has("browseFolders")}
                  onSelect={props.onSelectProject}
                  onBrowse={props.onBrowse}
                />
              </>
            }
            modelPicker={
              <RemoteModelPicker
                hostLabel={host.label}
                catalog={models}
                loading={modelsLoading}
                selected={model}
                disabled={starting}
                onSelect={props.onSelectModel}
              />
            }
          />
        </div>
      }
    >
      <div className="flex min-h-full items-center justify-center">
        <EmptyState
          title={`What would you like to work on with ${host.label}?`}
          description="This chat, its files and its tools run on that Mac."
        />
      </div>
    </ScrollArea>
  );
}

interface FolderBrowserProps {
  hostLabel: string;
  roots: HostBrowserRoot[] | undefined;
  rootsError: string | null;
  /** The open folder, or null while the host's shared roots are listed. */
  place: HostFolderPlace | null;
  pages: HostBrowserPage[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  busy: boolean;
  onOpen(place: HostFolderPlace | null): void;
  onLoadMore(): void;
}

/** The folders a host lets this Mac browse: its approved roots, then their subfolders. */
export function RemoteFolderList({
  hostLabel,
  roots,
  rootsError,
  place,
  pages,
  loading,
  error,
  hasMore,
  busy,
  onOpen,
  onLoadMore,
}: FolderBrowserProps) {
  const breadcrumbs = pages[0]?.breadcrumbs ?? [];
  const location = place?.location ?? null;
  const entries = pages.flatMap((page) => page.entries);
  const rows: HostFolderPlace[] = place
    ? entries.map((entry) => hostFolderPlaces.entry(place, entry))
    : (roots ?? []).map((root) => hostFolderPlaces.root(root));
  const failure = location ? error : rootsError;
  return (
    <div className="flex min-h-64 flex-col gap-2" aria-busy={loading || busy || undefined}>
      <nav aria-label={`Folders on ${hostLabel}`} className="flex min-w-0 flex-wrap items-center gap-0.5 text-small text-secondary">
        <Button variant="transparent" size="small" disabled={busy || !location} onClick={() => onOpen(null)}>
          {hostLabel}
        </Button>
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={crumb.location}>
            <ChevronRight className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
            <Button
              variant="transparent"
              size="small"
              disabled={busy || crumb.location === location?.location}
              onClick={() => place && onOpen(hostFolderPlaces.ancestor(place, crumb, index))}
            >
              {crumb.label}
            </Button>
          </React.Fragment>
        ))}
      </nav>
      <div className="min-h-0 overflow-hidden rounded-card bg-well">
        {failure ? (
          <Text as="p" variant="small" color="secondary" className="p-4">
            {failure}
          </Text>
        ) : loading && rows.length === 0 ? (
          <Text as="p" variant="small" color="secondary" className="p-4">
            Loading folders…
          </Text>
        ) : rows.length === 0 ? (
          <Text as="p" variant="small" color="secondary" className="p-4">
            {location ? "No folders inside this one." : `${hostLabel} hasn't shared any folders with this Mac.`}
          </Text>
        ) : (
          <ul aria-label={location ? `Folders in ${location.label}` : `Shared folders on ${hostLabel}`}>
            {rows.map((row, index) => (
              <li key={row.location.location} className={index ? "border-t border-separator" : undefined}>
                <button
                  type="button"
                  disabled={busy}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-regular text-primary outline-none transition-colors duration-150 hover:bg-control-hover focus-visible:bg-list-selection disabled:opacity-60"
                  onClick={() => onOpen(row)}
                >
                  <Folder className="size-4 shrink-0 text-secondary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{row.location.label}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {location && hasMore ? (
        <Button variant="filled" size="small" className="self-start" disabled={loading || busy} onClick={onLoadMore}>
          {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Browses a host's approved folders and turns the chosen one into a project
 * on that host. The host names each folder by an opaque location and mints a
 * single-use selection for it; no host path is typed or read on this Mac.
 */
function RemoteFolderBrowserDialog({
  open,
  onOpenChange,
  hostLabel,
  adapter,
  control,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  hostLabel: string;
  adapter: RemoteHostAdapter;
  control: RemoteNewChatControl;
  onCreated(workspace: HostCreatedWorkspace): void;
}) {
  const [place, setPlace] = React.useState<HostFolderPlace | null>(null);
  const location = place?.location ?? null;
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) setPlace(null);
  }, [open]);
  const roots = useQuery({
    queryKey: hostQueryKeys.browser(adapter.hostId),
    queryFn: async () => hostResultValue(await adapter.roots()),
    enabled: open,
    staleTime: 30_000,
  });
  const children = useInfiniteQuery({
    queryKey: hostQueryKeys.browser(adapter.hostId, location?.location ?? "-"),
    queryFn: async ({ pageParam }) =>
      hostResultValue(await adapter.children(location?.location ?? "", pageParam || undefined)),
    initialPageParam: "",
    getNextPageParam: (page: HostBrowserPage) => page.nextCursor,
    enabled: open && location !== null,
    staleTime: 30_000,
  });

  const chooseFolder = async () => {
    if (!place) return;
    setBusy(true);
    try {
      // The control mints the single-use selection just before spending it, and replays it after a lost answer.
      // The folder is named by the host's IDs, which survive a re-listing; its handles change every time.
      const workspace = await control.createFolderWorkspace(hostFolderChoice(place));
      onCreated(workspace);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        isOutcomeUnknown(error)
          ? `${hostLabel} didn't confirm the new project. Choose the folder again to check; it won't create a second one.`
          : errorText(error, "That folder could not be used."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Choose a folder on ${hostLabel}`}
      description="The new project uses this folder on that Mac."
      confirmLabel={busy ? "Creating project…" : "Use this folder"}
      confirmDisabled={!place}
      busy={busy}
      onConfirm={chooseFolder}
      size="large"
    >
      <RemoteFolderList
        hostLabel={hostLabel}
        roots={roots.data}
        rootsError={roots.isError ? errorText(roots.error, "Folders could not be read.") : null}
        place={place}
        pages={children.data?.pages ?? []}
        loading={location ? children.isFetching : roots.isFetching}
        error={children.isError ? errorText(children.error, "This folder could not be read.") : null}
        hasMore={children.hasNextPage}
        busy={busy}
        onOpen={setPlace}
        onLoadMore={() => void children.fetchNextPage()}
      />
    </Dialog>
  );
}

interface RemoteNewChatBinding {
  adapter: RemoteHostAdapter;
  control: RemoteNewChatControl;
}

/** Owns the adapter and control for one host, rebuilt when its grants change. */
function useRemoteNewChat(host: PeerHostView | undefined): RemoteNewChatBinding | null {
  const [binding, setBinding] = React.useState<RemoteNewChatBinding | null>(null);
  const hostId = host?.id;
  const grants = host ? `${host.features.join(",")}|${host.capabilities.join(",")}` : "";
  const hostRef = React.useRef(host);
  hostRef.current = host;
  React.useEffect(() => {
    const view = hostRef.current;
    if (!view || view.id !== hostId) return;
    const adapter = new RemoteHostAdapter(view);
    const control = new RemoteNewChatControl(adapter);
    const detach = control.attach();
    const next = { adapter, control };
    setBinding(next);
    return () => {
      detach();
      adapter.dispose();
      setBinding((current) => (current === next ? null : current));
    };
  }, [hostId, grants]);
  return binding;
}

export interface RemoteNewChatRouteProps {
  hostId: string;
  /** A project on the host to preselect, such as the sidebar project the chat was started from. */
  workspaceId?: string;
  onOpenChat(chatId: string): void;
  onSelectMachine(machine: NewChatMachineId): void;
  onManage(): void;
}

/** The new remote chat route, fed by the host queries the sidebar keeps current. */
export function RemoteNewChatRoute({ hostId, workspaceId, onOpenChat, onSelectMachine, onManage }: RemoteNewChatRouteProps) {
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({ queryKey: hostQueryKeys.statuses(), queryFn: skipToken });
  const feed = useQuery<PeerHostFeedSnapshot | null>({ queryKey: hostQueryKeys.feed(hostId), queryFn: skipToken });
  const view = list.data?.find((entry) => entry.id === hostId && entry.enabled);
  const binding = useRemoteNewChat(view);
  const control = binding?.control ?? null;
  const subscribe = React.useMemo(() => (control ? control.subscribe.bind(control) : subscribeNothing), [control]);
  const getSnapshot = React.useMemo(() => (control ? control.getSnapshot.bind(control) : nothing), [control]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const capabilities = React.useMemo(() => binding?.adapter.capabilities() ?? new Set<HostChatCapability>(), [binding]);
  const models = useQuery({
    queryKey: hostQueryKeys.models(hostId),
    queryFn: async () => hostResultValue(await binding!.adapter.models()),
    enabled: Boolean(binding) && capabilities.has("createChat") && snapshot?.status.availability === "online",
    staleTime: 60_000,
  });
  const [created, setCreated] = React.useState<{ hostId: string; projects: RemoteProjectChoice[] }>({ hostId, projects: [] });
  const projects = React.useMemo(
    () => remoteProjectChoices(feed.data, created.hostId === hostId ? created.projects : []),
    [feed.data, created, hostId],
  );
  const adopt = React.useCallback(
    (workspace: HostCreatedWorkspace) => {
      setCreated((current) => ({
        hostId,
        projects: [{ id: workspace.id, name: workspace.name }, ...(current.hostId === hostId ? current.projects : [])],
      }));
      setProject(workspace.id);
    },
    [hostId],
  );
  const [project, setProject] = React.useState<string>(workspaceId ?? "");
  const [model, setModel] = React.useState<HostModelChoice | undefined>(undefined);
  const [browsing, setBrowsing] = React.useState(false);

  // Once the host's feed lists a project this window created, the feed alone speaks for it.
  React.useEffect(() => {
    setCreated((current) => {
      const pending = unlistedProjects(current.projects, feed.data);
      return pending.length === current.projects.length ? current : { ...current, projects: pending };
    });
  }, [feed.data]);

  // Preselect the most recent project, then the host's default model, once they are known.
  // A project the host's feed does not list is replaced, so a stale choice never reaches the host.
  React.useEffect(() => {
    const known = project === SCRATCH_PROJECT || projects.some((choice) => choice.id === project);
    if (project && !known && feed.data) setProject(projects[0]?.id ?? "");
    else if (!project && projects[0]) setProject(projects[0].id);
  }, [project, projects, feed.data]);
  React.useEffect(() => {
    if (!findHostModel(models.data, model)) setModel(defaultHostModel(models.data));
  }, [model, models.data]);

  const reconnect = React.useCallback(async (id: string) => {
    try {
      await peerHostsApi.reconnect(id);
    } catch (error) {
      toast.error(errorText(error, "Aiden could not reconnect to that Mac."));
    }
  }, []);

  if (list.isPending) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center" aria-label="Loading">
        <Text variant="small" color="secondary">
          Loading…
        </Text>
      </div>
    );
  }
  const machines = newChatMachines(list.data ?? [], statuses.data ?? []);
  const listed = machines.find((entry) => entry.id === hostId);
  if (!view || !listed) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <EmptyState
          title="This Mac is not connected"
          description="Pair it again or turn it back on in Settings → Remote Access to start chats on it."
        />
      </div>
    );
  }

  const send = async (text: string, attachments: Attachment[]) => {
    if (!binding) throw new Error(`Connecting to ${listed.label}…`);
    const uploads = remoteAttachmentUploads(attachments);
    let target = project;
    if (target === SCRATCH_PROJECT) {
      // Once created, the scratch project is the selection, so a retry never makes another.
      const scratch = await binding.control.createWorkspace({ mode: "scratch" });
      target = scratch.id;
      adopt(scratch);
    }
    try {
      const started = await binding.control.start({ workspaceId: target, ...(model ? { model } : {}) }, text, uploads);
      onOpenChat(started.chatId);
    } catch (error) {
      // The unresolved banner holds the message and offers Retry.
      if (isOutcomeUnknown(error) && binding.control.getSnapshot().unresolved) return;
      throw error;
    }
  };
  const retry = () => {
    if (!binding) return;
    binding.control.retryUnresolved().then(onOpenChat, (error: unknown) => {
      toast.error(errorText(error, "That message could not be sent."));
    });
  };

  return (
    <>
      <RemoteNewChatPane
        host={listed}
        machines={machines}
        capabilities={capabilities}
        snapshot={snapshot}
        projects={projects}
        project={project}
        models={models.data}
        modelsLoading={models.isFetching}
        model={model}
        onSelectMachine={onSelectMachine}
        onSelectProject={setProject}
        onBrowse={() => setBrowsing(true)}
        onSelectModel={setModel}
        onSend={send}
        onRetry={retry}
        onDismiss={() => binding?.control.dismissUnresolved()}
        onOpenChat={onOpenChat}
        onReconnect={reconnect}
        onManage={onManage}
      />
      {binding ? (
        <RemoteFolderBrowserDialog
          open={browsing}
          onOpenChange={setBrowsing}
          hostLabel={listed.label}
          adapter={binding.adapter}
          control={binding.control}
          onCreated={adopt}
        />
      ) : null}
    </>
  );
}

export function RemoteNewChatView({ hostId, workspaceId }: { hostId: string; workspaceId?: string }) {
  const navigate = useNavigate();
  const openChat = React.useCallback(
    (chatId: string) => void navigate({ to: "/host/$hostId/chat/$chatId", params: { hostId, chatId } }),
    [hostId, navigate],
  );
  const selectMachine = React.useCallback(
    (machine: NewChatMachineId) => {
      if (machine === "local") void navigate({ to: "/" });
      // Another Mac starts with no project: this one's project ID means nothing there.
      else if (machine !== hostId) void navigate({ to: "/host/$hostId/new", params: { hostId: machine }, search: {} });
    },
    [hostId, navigate],
  );
  const manage = React.useCallback(() => {
    void navigate({ to: "/settings", search: { section: "remoteAccess" } });
  }, [navigate]);
  return (
    <RemoteNewChatRoute
      hostId={hostId}
      {...(workspaceId ? { workspaceId } : {})}
      onOpenChat={openChat}
      onSelectMachine={selectMachine}
      onManage={manage}
    />
  );
}
