import * as React from "react";
import { CloudOff, Globe, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "./ui";
import { cn } from "../lib/ui-utils";
import type { SidebarMachineFilter } from "../lib/sidebar-organization";
import {
  machineFilterForHost,
  type SidebarHost,
} from "../lib/sidebar-remote-groups";

/**
 * Sidebar pieces for paired hosts. They render only when a host is paired, so
 * the local-only sidebar is unchanged.
 */

export function remoteHostMarkerLabel(hostLabel: string, stale: boolean): string {
  return stale ? `On ${hostLabel}, offline` : `On ${hostLabel}`;
}

/** Soft globe that marks a row as living on another machine. */
export function RemoteHostMarker({
  hostLabel,
  stale = false,
  className,
}: {
  hostLabel: string;
  stale?: boolean;
  className?: string;
}) {
  const label = remoteHostMarkerLabel(hostLabel, stale);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-remote-host-marker="true"
      className={cn("inline-flex size-5 shrink-0 items-center justify-center text-tertiary", className)}
    >
      <Globe className="size-3.5" aria-hidden="true" />
    </span>
  );
}

/** Small pills naming each machine in a cross-machine group. */
export function MachineBadges({ labels }: { labels: readonly string[] }) {
  if (labels.length < 2) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" aria-label={`On ${labels.join(", ")}`}>
      {labels.map((label) => (
        <span
          key={label}
          aria-hidden="true"
          className="inline-flex h-4 max-w-full items-center truncate rounded-pill bg-control px-1.5 text-mini font-medium text-tertiary"
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/** Compact header chip shown while the sidebar lists one machine only. */
export function MachineFilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 min-w-0 items-center gap-0.5 rounded-pill bg-control pl-2 text-mini font-medium text-secondary">
      <span className="min-w-0 truncate" title={`Showing ${label} only`}>
        {label}
      </span>
      <Button
        variant="transparent"
        size="small"
        iconOnly
        className="size-6 text-tertiary"
        aria-label={`Show all machines instead of ${label} only`}
        onClick={onClear}
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </span>
  );
}

function shownByFilter(host: SidebarHost, filter: SidebarMachineFilter): boolean {
  return filter === "all" || filter === machineFilterForHost(host.id);
}

export interface RemoteHostStatusListProps {
  hosts: readonly SidebarHost[];
  filter: SidebarMachineFilter;
  onReconnect: (hostId: string) => Promise<void>;
  onManage: () => void;
}

function RemoteHostStatusRow({
  host,
  onReconnect,
  onManage,
}: {
  host: SidebarHost;
  onReconnect: (hostId: string) => Promise<void>;
  onManage: () => void;
}) {
  const [reconnecting, setReconnecting] = React.useState(false);
  const blocked = host.availability === "blocked";
  const reconnect = async () => {
    setReconnecting(true);
    try {
      await onReconnect(host.id);
    } finally {
      setReconnecting(false);
    }
  };
  return (
    <div
      role="status"
      data-host-availability={host.availability}
      className={cn(
        "flex min-h-8 min-w-0 items-center gap-2 rounded-control py-1 pl-2.5 pr-1 text-small",
        blocked ? "bg-status-red-surface" : "bg-status-warning-surface",
      )}
    >
      {blocked ? (
        <KeyRound className="size-3.5 shrink-0 text-status-red" aria-hidden="true" />
      ) : (
        <CloudOff className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate text-primary">
        {host.label}
        <span className="text-secondary"> · {blocked ? "Needs re-pairing" : "Offline"}</span>
      </span>
      {blocked ? (
        <Button
          variant="transparent"
          size="small"
          aria-label={`Open Connections to re-pair ${host.label}`}
          onClick={onManage}
        >
          Connections
        </Button>
      ) : (
        <Button
          variant="transparent"
          size="small"
          aria-label={`Reconnect to ${host.label}`}
          disabled={reconnecting}
          onClick={() => void reconnect()}
        >
          {reconnecting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          Reconnect
        </Button>
      )}
    </div>
  );
}

/**
 * Offline and blocked hosts whose rows the sidebar is showing. Their rows stay
 * listed as last-known and read-only; this is where the user reconnects.
 */
export function RemoteHostStatusList({ hosts, filter, onReconnect, onManage }: RemoteHostStatusListProps) {
  const unavailable = hosts.filter(
    (host) =>
      (host.availability === "offline" || host.availability === "blocked") &&
      shownByFilter(host, filter),
  );
  if (unavailable.length === 0) return null;
  return (
    <div role="group" aria-label="Unavailable machines" className="flex flex-col gap-1 px-2.5 pb-2">
      {unavailable.map((host) => (
        <RemoteHostStatusRow key={host.id} host={host} onReconnect={onReconnect} onManage={onManage} />
      ))}
    </div>
  );
}
