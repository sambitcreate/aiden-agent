import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Smartphone } from "lucide-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Text,
} from "./ui";
import { aidenRemoteApi } from "../lib/ipc";
import { queryKeys, useAidenRemoteSettings } from "../lib/queries";
import {
  groupRemoteDevices,
  remoteConnectionSummary,
  type RemoteDeviceGroups,
} from "../lib/remote-connection-status";
import type { AidenRemoteDeviceView } from "../shared/aiden-remote";

function relativeSeen(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function DeviceRow({
  device,
  state,
}: {
  device: AidenRemoteDeviceView;
  state: keyof RemoteDeviceGroups;
}) {
  const timestamp = state === "previous" ? (device.revokedAt ?? device.lastSeenAt) : device.lastSeenAt;
  const detail = state === "previous"
    ? `Removed ${relativeSeen(timestamp)}`
    : state === "pending"
      ? "Finishing connection"
    : `Last seen ${relativeSeen(timestamp)}`;

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-1.5">
      <Smartphone className="size-4 shrink-0 text-secondary" />
      <div className="min-w-0 flex-1">
        <Text variant="small-strong" truncate className="block">{device.name}</Text>
        <Text
          variant="small"
          color="secondary"
          truncate
          className="block"
          title={state === "pending" ? "Waiting for the first authenticated connection" : new Date(timestamp).toLocaleString()}
        >
          {device.type === "ipad" ? "iPad" : "iPhone"} · {detail}
        </Text>
      </div>
      <span
        aria-hidden="true"
        className={state === "active" ? "size-2 rounded-full bg-green" : "size-2 rounded-full bg-tertiary"}
      />
    </div>
  );
}

function DeviceGroup({
  label,
  devices,
  state,
}: {
  label: string;
  devices: AidenRemoteDeviceView[];
  state: keyof RemoteDeviceGroups;
}) {
  if (devices.length === 0) return null;
  return (
    <section aria-label={label}>
      <div className="flex items-center justify-between px-2 pb-1 pt-2 text-small-strong text-tertiary">
        <span>{label}</span>
        <span>{devices.length}</span>
      </div>
      {devices.map((device) => <DeviceRow key={device.id} device={device} state={state} />)}
    </section>
  );
}

export function RemoteConnectionPopover({
  settingsBlockedReason,
  onManage,
}: {
  settingsBlockedReason?: string;
  onManage: () => void;
}) {
  const queryClient = useQueryClient();
  const settings = useAidenRemoteSettings();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => aidenRemoteApi.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
  }), [queryClient]);

  const snapshot = settings.data;
  const groups = snapshot
    ? groupRemoteDevices(snapshot.devices, { serviceRunning: snapshot.status.running })
    : { active: [], pending: [], inactive: [], previous: [] };
  const summary = snapshot
    ? remoteConnectionSummary({
        enabled: snapshot.status.enabled,
        running: snapshot.status.running,
        error: snapshot.status.error,
        activeDeviceCount: groups.active.length,
      })
    : settings.isLoading ? "Checking" : "Unavailable";
  const statusTone = snapshot?.status.error || (snapshot?.status.enabled && !snapshot.status.running)
    ? "bg-red"
    : groups.active.length > 0
      ? "bg-green"
      : snapshot?.status.running
        ? "bg-accent"
        : "bg-tertiary";

  const manage = () => {
    setOpen(false);
    onManage();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          iconOnly
          size="large"
          variant="transparent"
          aria-label={`Mobile connections · ${summary}`}
          title="Mobile connections"
          className="relative size-9"
        >
          <Smartphone />
          <span
            aria-hidden="true"
            className={`absolute bottom-1 right-1 size-2 rounded-full ring-2 ring-sidebar ${statusTone}`}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={{ top: 8, right: 8, bottom: 8, left: 14 }}
        className="w-80 p-0"
      >
        <div className="border-b border-separator px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Text variant="strong">Aiden On The Go</Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">{summary}</Text>
            </div>
            <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${statusTone}`} aria-hidden="true" />
          </div>
          {snapshot?.status.error ? (
            <Text as="p" variant="small" color="secondary" className="mt-2 text-red">
              {snapshot.status.error}
            </Text>
          ) : null}
        </div>

        <div className="max-h-72 overflow-y-auto px-2 py-2">
          {settings.isLoading ? (
            <p className="px-3 py-3 text-small text-secondary">Checking mobile connections…</p>
          ) : !snapshot ? (
            <p className="px-3 py-3 text-small text-secondary">Connection status is unavailable.</p>
          ) : snapshot.devices.length === 0 ? (
            <p className="px-3 py-3 text-small text-secondary">No devices have been paired with this Mac.</p>
          ) : (
            <>
              <DeviceGroup label="Active" devices={groups.active} state="active" />
              <DeviceGroup label="Finishing" devices={groups.pending} state="pending" />
              <DeviceGroup label="Inactive" devices={groups.inactive} state="inactive" />
              {groups.previous.length > 0 ? (
                <details className="group mt-1">
                  <summary className="flex cursor-default list-none items-center justify-between rounded-lg px-2 py-2 text-small-strong text-tertiary outline-none hover:bg-list-hover focus-visible:bg-list-selection [&::-webkit-details-marker]:hidden">
                    <span>Previous</span>
                    <span className="flex items-center gap-1.5">
                      {groups.previous.length}
                      <ChevronDown className="size-3.5 transition-transform duration-150 group-open:rotate-180" />
                    </span>
                  </summary>
                  {groups.previous.map((device) => (
                    <DeviceRow key={device.id} device={device} state="previous" />
                  ))}
                </details>
              ) : null}
            </>
          )}
        </div>

        <div className="border-t border-separator px-3 py-2.5">
          <Button
            variant="transparent"
            className="w-full justify-start"
            disabled={Boolean(settingsBlockedReason)}
            title={settingsBlockedReason}
            onClick={manage}
          >
            <Smartphone /> Add or manage connections
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
