import * as React from "react";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button, Dialog, Text } from "../components/ui";
import { workspacesApi } from "../lib/ipc";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { RemoteHostAdapter } from "../lib/hosts/remote-host-adapter";
import { hostResultValue } from "../lib/hosts/host-chat-adapter";
import { type HostFolderPlace } from "../lib/hosts/remote-new-chat";
import { RemoteFolderList } from "./remote-new-chat-view";
import { PEER_PROJECT_CLONE_FEATURE, PEER_PROJECT_FILES_MAX_BYTES, type PeerProjectSource } from "../shared/peer-project-clone";
import type { PeerHostStatus, PeerHostView } from "../shared/peer-host";
import type { HostBrowserPage } from "../lib/hosts/host-resources";
import { newCloneId } from "../lib/workspace-menu";

export interface PeerProjectCloneDialogProps {
  workspaceId: string;
  onClose(): void;
  onCreated(hostId: string, workspace: { id: string; name: string }): void;
}

export function PeerProjectCloneDialog({ workspaceId, onClose, onCreated }: PeerProjectCloneDialogProps) {
  const hosts = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({ queryKey: hostQueryKeys.statuses(), queryFn: skipToken });
  const available = (hosts.data ?? []).filter(host => host.enabled && host.features.includes(PEER_PROJECT_CLONE_FEATURE) && host.capabilities.includes("workspace:manage") && host.capabilities.includes("workspace:browse") && statuses.data?.some(status => status.hostId === host.id && status.state.kind === "connected"));
  const [target, setTarget] = React.useState("");
  const host = available.find(row => row.id === target) ?? available[0];
  const source = useQuery({ queryKey: ["peer-project-clone-source", workspaceId], queryFn: () => workspacesApi.peerClonePreview(workspaceId), staleTime: 0 });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [place, setPlace] = React.useState<HostFolderPlace | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef<string | null>(null);
  const stopRequested = React.useRef(false);
  const [adapter, setAdapter] = React.useState<RemoteHostAdapter | null>(null);
  React.useEffect(() => {
    setPlace(null);
    if (!host) { setAdapter(null); return; }
    const next = new RemoteHostAdapter(host);
    setAdapter(next);
    return () => { next.dispose(); };
  // The selected host's identity owns every folder handle.
  }, [host?.id]);
  React.useEffect(() => () => { if (request.current) void workspacesApi.cancelPeerClone(request.current); }, []);
  const bound = adapter?.hostId === host?.id && Boolean(host);
  const roots = useQuery({ queryKey: ["peer-project-clone-roots", host?.id], queryFn: async () => { await adapter!.ready(); return hostResultValue(await adapter!.roots()); }, enabled: bound });
  const location = place?.location.location;
  const children = useInfiniteQuery({
    queryKey: ["peer-project-clone-folders", host?.id, location],
    queryFn: ({ pageParam }) => adapter!.children(location!, pageParam || undefined).then(hostResultValue),
    initialPageParam: "", getNextPageParam: (page: HostBrowserPage) => page.nextCursor,
    enabled: Boolean(bound && location),
  });
  const total = source.data?.files.filter(file => selected.has(file.name)).reduce((sum, file) => sum + file.bytes, 0) ?? 0;
  const submit = async () => {
    if (!host || !adapter || !bound || !place || !source.data || busy) return;
    setBusy(true); setError(null);
    const cloneId = newCloneId();
    request.current = cloneId;
    stopRequested.current = false;
    try {
      const selection = await adapter.selectFolder(place.location.location);
      const result = await workspacesApi.peerClone({ cloneId, hostId: host.id, workspaceId, selection: selection.selection, files: [...selected] });
      if (!result.ok) throw new Error(result.error.code === "outcome_unknown" ? "The connection changed before the clone was confirmed. Check the paired computer's project list before trying again." : result.error.message);
      const workspace = result.value as { id: string; name: string };
      if (stopRequested.current) {
        setError(`The project finished before cancellation. It is available in the ${host.name} sidebar.`);
      } else {
        onCreated(host.id, workspace);
        onClose();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The project could not be cloned."); }
    finally { request.current = null; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title="Add project to another machine" description="Clone the repository on a paired computer. That computer uses its own Git credentials. Local edits and unpushed commits stay here." confirmLabel={busy ? "Cloning project…" : "Clone project"} confirmDisabled={busy || !source.data || !host || !place || total > PEER_PROJECT_FILES_MAX_BYTES} busy={busy} onConfirm={submit} size="large">
    <div className="flex flex-col gap-4">
      {source.isPending ? <Text variant="small" color="secondary">Reading project…</Text> : source.error ? <Text variant="small" color="secondary" role="alert">{source.error.message}</Text> : source.data ? <Text variant="small" color="secondary" className="break-words">{source.data.name} · {source.data.url}</Text> : null}
      {available.length ? <div className="flex flex-wrap gap-2" role="group" aria-label="Destination computer">{available.map(row => <Button key={row.id} size="small" variant={row.id === host?.id ? "filled" : "transparent"} disabled={busy} aria-pressed={row.id === host?.id} onClick={() => { setTarget(row.id); setPlace(null); }}>{row.name}</Button>)}</div> : <Text variant="small" color="secondary">Connect a paired computer running a version of Aiden that supports project cloning. Allow project creation and folder browsing there.</Text>}
      {host && adapter && bound ? <>
        <Text variant="small" color="secondary">Choose the parent folder on {host.name}. A new {source.data?.repositoryName ?? "repository"} folder will be created inside it.</Text>
        <RemoteFolderList hostLabel={host.name} roots={roots.data} rootsError={roots.error?.message ?? null} place={place} pages={children.data?.pages ?? []} loading={location ? children.isFetching : roots.isFetching} error={children.error?.message ?? null} hasMore={Boolean(children.hasNextPage)} busy={busy} onOpen={setPlace} onLoadMore={() => { void children.fetchNextPage(); }} />
      </> : null}
      <PeerProjectEnvironmentFiles source={source.data} selected={selected} disabled={busy} onToggle={name => setSelected(current => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; })} />
      {total > PEER_PROJECT_FILES_MAX_BYTES ? <Text variant="small" color="secondary" role="alert">Choose up to 512 KiB of environment files.</Text> : null}
      {busy ? <div className="flex items-center gap-2" role="status"><Loader2 className="size-4 animate-spin" aria-hidden="true" /><Text variant="small">Cloning and copying selected files. This can take up to 90 seconds.</Text><Button size="small" variant="transparent" onClick={() => { stopRequested.current = true; if (request.current) void workspacesApi.cancelPeerClone(request.current); }}>Stop</Button></div> : null}
      {error ? <Text variant="small" color="secondary" className="break-words" role="alert">{error}</Text> : null}
    </div>
  </Dialog>;
}

export function PeerProjectEnvironmentFiles({ source, selected, disabled, onToggle }: { source?: PeerProjectSource; selected: ReadonlySet<string>; disabled: boolean; onToggle(name: string): void }) {
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
    <legend className="text-small font-medium text-primary">Optional environment files</legend>
    <Text variant="small" color="secondary">These files may contain secrets. Nothing is selected by default. Only ignored root-level .env and .dev.vars files are offered, up to 128 KiB each. Existing files on the destination are never overwritten.</Text>
    {source?.files.length ? source.files.map(file => <label key={file.name} className="flex items-center gap-2 text-small text-primary"><input type="checkbox" role="checkbox" className="accent-current focus-visible:outline-2 focus-visible:outline-focus-ring" checked={selected.has(file.name)} onChange={() => onToggle(file.name)} /><span className="min-w-0 flex-1 truncate">{file.name}</span><span className="text-secondary">{file.bytes.toLocaleString()} bytes</span></label>) : <Text variant="small" color="secondary">No eligible environment files.</Text>}
  </fieldset>;
}
