import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Loader2, MoreHorizontal, Plus, RotateCw } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FieldSet,
  Input,
  Switch,
  Text,
  toast,
} from "../ui";
import { peerHostsApi } from "../../lib/ipc";
import { hostQueryKeys } from "../../lib/hosts/host-query-keys";
import {
  mergePeerHostStatus,
  peerHostPresentation,
  peerLocalNameError,
} from "../../lib/peer-connections";
import type { PeerHostStatus, PeerHostView } from "../../shared/peer-host";
import { PeerAddDeviceSheet } from "./peer-add-device-sheet";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Paired hosts and their live supervisor status. The registry list never
 * starts supervision; statuses are read only once a host is enabled.
 */
function usePeerConnections() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: hostQueryKeys.list(),
    queryFn: peerHostsApi.list,
    staleTime: Infinity,
  });
  const supervised = (list.data ?? []).some((host) => host.enabled);

  React.useEffect(
    () =>
      peerHostsApi.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: hostQueryKeys.list() });
        void queryClient.invalidateQueries({ queryKey: hostQueryKeys.statuses() });
      }),
    [queryClient],
  );

  // Listen before the first read so no transition slips between them.
  const [listening, setListening] = React.useState(false);
  React.useEffect(() => {
    if (!supervised) return;
    const off = peerHostsApi.onHostState((status) => {
      queryClient.setQueryData<PeerHostStatus[]>(hostQueryKeys.statuses(), (current) =>
        mergePeerHostStatus(current, status),
      );
    });
    setListening(true);
    return () => {
      off();
      setListening(false);
    };
  }, [queryClient, supervised]);

  const statuses = useQuery({
    queryKey: hostQueryKeys.statuses(),
    queryFn: async () => {
      const incoming = await peerHostsApi.statuses();
      const ids = new Set(incoming.map((status) => status.hostId));
      const kept = (queryClient.getQueryData<PeerHostStatus[]>(hostQueryKeys.statuses()) ?? []).filter(
        (status) => ids.has(status.hostId),
      );
      return incoming.reduce(mergePeerHostStatus, kept);
    },
    enabled: supervised && listening,
    staleTime: Infinity,
  });

  return { list, statuses: statuses.data ?? [] };
}

/** Re-render once a second while a retry countdown is shown. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export interface PeerHostRowProps {
  host: PeerHostView;
  status?: PeerHostStatus;
  now: number;
  busy: boolean;
  onEnabledChange(enabled: boolean): void;
  onReconnect(): void;
  onRename(): void;
  onRepair(): void;
  onForget(): void;
}

/** One paired host: name, live status, Reconnect, the enable switch and a "···" menu. */
export function PeerHostRow({
  host,
  status,
  now,
  busy,
  onEnabledChange,
  onReconnect,
  onRename,
  onRepair,
  onForget,
}: PeerHostRowProps) {
  const presentation = peerHostPresentation(host, status, now);
  return (
    <div
      data-peer-host-id={host.id}
      className="relative flex items-center gap-3 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden max-[540px]:flex-wrap"
    >
      <Laptop className="size-4 shrink-0 text-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Text variant="small-strong" truncate className="block">{host.name}</Text>
        {presentation.detail ? (
          <Text variant="small" color="secondary" className="block break-words">{presentation.detail}</Text>
        ) : null}
      </div>
      <Badge color={presentation.tone}>{presentation.label}</Badge>
      {presentation.needsRepair ? (
        <Button size="small" variant="filled" disabled={busy} onClick={onRepair}>
          Re-pair
        </Button>
      ) : presentation.canReconnect ? (
        <Button size="small" variant="transparent" disabled={busy} onClick={onReconnect}>
          {busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
          Reconnect
        </Button>
      ) : null}
      <Switch
        checked={host.enabled}
        disabled={busy}
        onCheckedChange={onEnabledChange}
        aria-label={`Control ${host.name}`}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button iconOnly size="small" variant="transparent" aria-label={`More for ${host.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>Rename locally…</DropdownMenuItem>
          <DropdownMenuItem onSelect={onRepair}>Re-pair…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onForget}>Forget…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RenameDialog({
  host,
  onClose,
}: {
  host: PeerHostView | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDraft(host?.name ?? "");
    setFailure(null);
  }, [host]);
  const invalid = peerLocalNameError(draft);
  const save = async () => {
    if (!host || invalid) return;
    setSaving(true);
    try {
      await peerHostsApi.rename(host.id, draft);
      onClose();
    } catch (error) {
      setFailure(errorMessage(error, "Couldn't rename this device."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={host !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Rename locally"
      description="Only this device uses this name. The other computer keeps its own."
      confirmLabel="Save"
      confirmDisabled={invalid !== null || draft.trim() === host?.name}
      busy={saving}
      onConfirm={save}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          value={draft}
          autoFocus
          aria-label="Local name"
          aria-invalid={failure !== null || undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setFailure(null);
          }}
        />
      </form>
      {failure || (invalid && draft.trim()) ? (
        <Text as="p" variant="small" color="status-red" role="alert" className="mt-2">
          {failure ?? invalid}
        </Text>
      ) : null}
    </Dialog>
  );
}

/** Connections → Control other devices. */
export function PeerHostsSettings({ hostLabel }: { hostLabel: string }) {
  const { list, statuses } = usePeerConnections();
  const hosts = list.data ?? [];
  const byHost = new Map(statuses.map((status) => [status.hostId, status]));
  const now = useNow(statuses.some((status) => status.state.kind === "backoff"));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<{ replaceHost?: { id: string; name: string } } | null>(null);
  const [renaming, setRenaming] = React.useState<PeerHostView | null>(null);
  const [forgetting, setForgetting] = React.useState<PeerHostView | null>(null);

  const act = async (hostId: string, work: () => Promise<unknown>, fallback: string) => {
    setBusy(hostId);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error, fallback));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <FieldSet title="Paired computers">
        <Field
          label="Add a computer"
          description="Find another computer running Aiden nearby or on your tailnet, or use a setup code."
        >
          <div className="flex justify-end max-[540px]:justify-start">
            <Button size="small" variant="accent" onClick={() => setSheet({})}>
              <Plus /> Add device
            </Button>
          </div>
        </Field>
        {list.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-small text-secondary" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading paired computers…
          </div>
        ) : hosts.length === 0 ? (
          <EmptyState
            placement="inline"
            title="No computers yet"
            description={`Add another computer running Aiden to use its chats, workspaces and Bots from this ${hostLabel}.`}
          />
        ) : (
          hosts.map((host) => (
            <PeerHostRow
              key={host.id}
              host={host}
              status={byHost.get(host.id)}
              now={now}
              busy={busy === host.id}
              onEnabledChange={(enabled) =>
                void act(host.id, () => peerHostsApi.setEnabled(host.id, enabled), "Couldn't change this connection.")
              }
              onReconnect={() =>
                void act(host.id, () => peerHostsApi.reconnect(host.id), "Couldn't reconnect.")
              }
              onRename={() => setRenaming(host)}
              onRepair={() => setSheet({ replaceHost: { id: host.id, name: host.name } })}
              onForget={() => setForgetting(host)}
            />
          ))
        )}
      </FieldSet>
      <Text as="p" variant="small" color="secondary" className="-mt-4 mb-7 px-4">
        The other computer decides what this {hostLabel} may do, and can remove its access at any time.
        Nothing here changes who can control this {hostLabel}.
      </Text>

      <PeerAddDeviceSheet
        open={sheet !== null}
        onOpenChange={(open) => !open && setSheet(null)}
        replaceHost={sheet?.replaceHost}
      />
      <RenameDialog host={renaming} onClose={() => setRenaming(null)} />
      <AlertDialog
        open={forgetting !== null}
        onOpenChange={(open) => !open && setForgetting(null)}
        title={forgetting ? `Forget ${forgetting.name}?` : "Forget computer?"}
        description={`This ${hostLabel} deletes its saved access and stops showing that computer's chats. To use it again, pair again. The other computer lists this ${hostLabel} until you remove it there.`}
        confirmLabel="Forget"
        confirmVariant="destructive"
        busy={forgetting !== null && busy === forgetting.id}
        onConfirm={async () => {
          const host = forgetting;
          if (!host) return;
          await act(host.id, () => peerHostsApi.remove(host.id), "Couldn't forget this computer.");
          setForgetting(null);
        }}
      />
    </>
  );
}
