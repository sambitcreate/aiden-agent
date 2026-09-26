import * as React from "react";
import { LoaderCircle, Monitor, RefreshCw, Smartphone, Tablet, TriangleAlert } from "lucide-react";
import { Button, Switch, Text, toast } from "./ui";
import { DeviceViewer } from "./device-viewer";
import { devicesApi } from "../lib/ipc";
import {
  DEVICE_SETUP_NOTICE,
  LOCAL_DEVICE_HOST_ID,
  type DeviceHostInfo,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSummary,
} from "../shared/devices";

export interface DevicesPanelProps {
  workspaceId: string;
  /** The chat whose simulator sessions this panel shows and opens. */
  chatId?: string;
  /** Presented and selected. Nothing is read, started, or streamed until it is. */
  active: boolean;
  compact: boolean;
}

export interface DevicesPanelViewProps {
  state: DeviceServiceState | null;
  chatId?: string;
  compact: boolean;
  /** The action in flight, e.g. "setup" or a device id being opened. */
  pending: string | null;
  error: string | null;
  onSetup(): void;
  onStart(): void;
  /** Refreshes this Mac and every paired Mac. */
  onRefresh(): void;
  /** Contacts paired Macs only. */
  onRefreshPeers(): void;
  onOpen(device: DeviceSummary): void;
  /** Grants or revokes agent access. Granting installs agent-device from npm. */
  onAgentAccess(granted: boolean): void;
  /** Lets paired Macs that were granted simulator control view and drive this Mac's simulators. */
  onPeerSharing(granted: boolean): void;
  /** Renders the live viewer for the open session. */
  viewer?: (session: DeviceSession, device: DeviceSummary) => React.ReactNode;
}


function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <section aria-labelledby="devices-empty-title" className="browser-empty h-full min-h-0">
      {icon}
      <Text id="devices-empty-title" variant="strong">
        {title}
      </Text>
      {children}
    </section>
  );
}

function ConsentRow({
  id,
  label,
  description,
  pendingKey,
  granted,
  pending,
  compact,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  pendingKey: string;
  granted: boolean;
  pending: string | null;
  compact: boolean;
  onChange(granted: boolean): void;
}) {
  return (
    <div className="devices-agent-access">
      <span className="min-w-0 flex-1">
        <Text id={`${id}-label`} variant="small-strong" className="block">
          {label}
        </Text>
        <Text id={`${id}-description`} variant="small" color="secondary" className={compact ? "sr-only" : "block"}>
          {description}
        </Text>
      </span>
      {pending === pendingKey ? (
        <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
      ) : null}
      <Switch
        checked={granted}
        disabled={pending !== null}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        onCheckedChange={onChange}
      />
    </div>
  );
}

const LOCAL_STATUS_NOTES: Partial<Record<DeviceHostInfo["status"], string>> = {
  "needs-consent": "Simulator streaming is not set up on this Mac.",
  installing: "Installing simulator helpers…",
  starting: "Starting simulator helpers…",
  stopped: "The simulator helpers are installed but not running.",
  unavailable: "Simulators are unavailable on this Mac.",
  error: "The simulator helpers stopped.",
};

/** Why a host lists no devices right now, or null when it is ready. */
function hostNote(host: DeviceHostInfo): string | null {
  if (host.status === "ready") return null;
  if (host.detail) return host.detail;
  if (host.kind === "local") return LOCAL_STATUS_NOTES[host.status] ?? null;
  return `${host.name} is not sharing simulators right now.`;
}

function DeviceRows({
  devices,
  chatId,
  pending,
  onOpen,
}: {
  devices: DeviceSummary[];
  chatId?: string;
  pending: string | null;
  onOpen(device: DeviceSummary): void;
}) {
  return (
    <ul className="devices-list-rows">
      {devices.map((device) => {
        const opening = pending === `${device.hostId}:${device.id}`;
        return (
          <li key={`${device.hostId}:${device.id}`} className="devices-list-row">
            {device.kind === "ipad" ? <Tablet aria-hidden /> : <Smartphone aria-hidden />}
            <span className="min-w-0 flex-1">
              <Text variant="small-strong" className="block truncate">
                {device.name}
              </Text>
              <Text variant="small" color="secondary" className="block truncate">
                {device.version}
                {device.booted ? " · Booted" : ""}
              </Text>
            </span>
            <Button
              variant="muted"
              size="small"
              disabled={!chatId || pending !== null}
              aria-label={`${device.booted ? "Open" : "Boot and open"} ${device.name}`}
              onClick={() => onOpen(device)}
            >
              {opening ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {device.booted ? "Open" : "Boot & open"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function HostGroup({
  host,
  devices,
  chatId,
  pending,
  onOpen,
  onRefreshPeers,
}: {
  host: DeviceHostInfo;
  devices: DeviceSummary[];
  chatId?: string;
  pending: string | null;
  onOpen(device: DeviceSummary): void;
  onRefreshPeers(): void;
}) {
  const titleId = `devices-host-${host.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const note = hostNote(host);
  return (
    <section aria-labelledby={titleId} className="devices-host-group">
      <header className="devices-host-header">
        <Monitor aria-hidden />
        <Text id={titleId} variant="small-strong" className="min-w-0 flex-1 truncate">
          {host.name}
        </Text>
        {host.kind === "peer" && host.status !== "ready" ? (
          <Button variant="transparent" size="small" disabled={pending !== null} onClick={onRefreshPeers}>
            {pending === "peers" ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            Try again
          </Button>
        ) : null}
      </header>
      {note ? (
        <Text variant="small" color="secondary" className="devices-list-note">
          {note}
        </Text>
      ) : devices.length === 0 ? (
        <Text variant="small" color="secondary" className="devices-list-note">
          No iOS simulators found on {host.kind === "local" ? "this Mac" : host.name}.
        </Text>
      ) : (
        <DeviceRows devices={devices} chatId={chatId} pending={pending} onOpen={onOpen} />
      )}
    </section>
  );
}

function DeviceList({
  hosts,
  devices,
  chatId,
  pending,
  onOpen,
  onRefresh,
  onRefreshPeers,
}: {
  hosts: DeviceHostInfo[];
  devices: DeviceSummary[];
  chatId?: string;
  pending: string | null;
  onOpen(device: DeviceSummary): void;
  onRefresh(): void;
  onRefreshPeers(): void;
}) {
  // A lone Mac keeps the flat list; paired Macs add one group per host, this Mac first.
  const grouped = hosts.some((host) => host.kind === "peer");
  return (
    <section aria-labelledby="devices-list-title" className="devices-list">
      <header className="devices-list-header">
        <Text id="devices-list-title" variant="small-strong" color="secondary">
          iOS Simulators
        </Text>
        <Button
          variant="transparent"
          size="small"
          aria-label="Refresh simulators"
          title="Refresh simulators on this Mac and paired Macs"
          disabled={pending !== null}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden />
        </Button>
      </header>
      {!chatId ? (
        <Text variant="small" color="secondary" className="devices-list-note">
          Open a chat to attach a simulator to it.
        </Text>
      ) : null}
      {grouped ? (
        hosts.map((host) => (
          <HostGroup
            key={host.id}
            host={host}
            devices={devices.filter((device) => device.hostId === host.id)}
            chatId={chatId}
            pending={pending}
            onOpen={onOpen}
            onRefreshPeers={onRefreshPeers}
          />
        ))
      ) : devices.length === 0 ? (
        <Text variant="small" color="secondary" className="devices-list-note">
          No iOS simulators found. Add one in Xcode under Window → Devices and Simulators.
        </Text>
      ) : (
        <DeviceRows devices={devices} chatId={chatId} pending={pending} onOpen={onOpen} />
      )}
    </section>
  );
}

/** Pure render of one service state, so every status can be tested without IPC. */
export function DevicesPanelView({
  state,
  chatId,
  compact,
  pending,
  error,
  onSetup,
  onStart,
  onRefresh,
  onRefreshPeers,
  onOpen,
  onAgentAccess,
  onPeerSharing,
  viewer,
}: DevicesPanelViewProps) {
  // A narrow panel keeps explanations for assistive technology only; status and errors stay visible.
  const explain = compact ? "sr-only" : undefined;
  const spinner = <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />;
  if (!state) {
    return (
      <Empty icon={spinner} title="iOS Simulator">
        <p role="status">Checking simulator setup…</p>
      </Empty>
    );
  }
  const detail = state.hostStatuses[LOCAL_DEVICE_HOST_ID]?.detail;
  // Paired Macs stay usable while this Mac's own helpers are unavailable, e.g. without Xcode.
  const peerReady =
    state.consent.streaming && state.hosts.some((host) => host.kind === "peer" && host.status === "ready");
  const status = peerReady ? "ready" : state.hostStatus;
  const errorLine = error ? (
    <Text variant="small" className="text-red" role="alert">
      {error}
    </Text>
  ) : null;

  switch (status) {
    case "disabled":
    case "needs-consent":
      return (
        <Empty icon={<Smartphone aria-hidden />} title="iOS Simulator">
          <p className={explain}>
            Watch and control Xcode simulators here, and let Aiden drive them while you watch.
          </p>
          <p className={explain}>{detail ?? DEVICE_SETUP_NOTICE}</p>
          {errorLine}
          <Button
            variant="muted"
            size="small"
            disabled={state.hostStatus === "disabled" || pending !== null}
            onClick={onSetup}
          >
            {pending === "setup" ? spinner : null}
            Set up simulator streaming
          </Button>
        </Empty>
      );
    case "installing":
    case "starting":
      return (
        <Empty
          icon={spinner}
          title={state.hostStatus === "installing" ? "Installing simulator helpers…" : "Starting simulator helpers…"}
        >
          <p role="status">{detail ?? "This usually takes a few seconds."}</p>
        </Empty>
      );
    case "stopped":
      return (
        <Empty icon={<Smartphone aria-hidden />} title="iOS Simulator">
          <p className={explain}>The simulator helpers are installed but not running.</p>
          {errorLine}
          <Button variant="muted" size="small" disabled={pending !== null} onClick={onStart}>
            {pending === "start" ? spinner : null}
            Start
          </Button>
        </Empty>
      );
    case "unavailable":
    case "error":
      return (
        <Empty
          icon={<TriangleAlert aria-hidden />}
          title={state.hostStatus === "unavailable" ? "Simulators unavailable" : "Simulator helpers stopped"}
        >
          <p>
            {state.unavailableReason ?? detail ?? "Something went wrong starting the simulator helpers."}
          </p>
          {errorLine}
          <Button variant="muted" size="small" disabled={pending !== null} onClick={onStart}>
            {pending === "start" ? spinner : null}
            Try again
          </Button>
        </Empty>
      );
    case "ready": {
      const session = chatId
        ? state.sessions.find((candidate) => candidate.chatId === chatId)
        : undefined;
      const device = session
        ? state.devices.find(
            (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
          )
        : undefined;
      if (session && device && viewer) return <>{viewer(session, device)}</>;
      return (
        <div className="flex h-full min-h-0 flex-col">
          {errorLine ? <div className="px-3 pt-3">{errorLine}</div> : null}
          <ConsentRow
            id="devices-agent-access"
            label="Let Aiden use simulators"
            description="In chats, Aiden can open a simulator on this Mac and tap, type, and install apps with agent-device while you watch. Turning this on installs agent-device from npm."
            pendingKey="agent"
            granted={state.consent.agentAccess}
            pending={pending}
            compact={compact}
            onChange={onAgentAccess}
          />
          {state.hostStatus === "ready" ? (
            <ConsentRow
              id="devices-peer-sharing"
              label="Share with paired Macs"
              description="Paired Macs you allowed to control simulators can watch and control this Mac's simulators while Aiden is open. Turning this off disconnects them."
              pendingKey="peerSharing"
              granted={state.consent.peerSharing}
              pending={pending}
              compact={compact}
              onChange={onPeerSharing}
            />
          ) : null}
          <DeviceList
            hosts={state.hosts}
            devices={state.devices}
            chatId={chatId}
            pending={pending}
            onOpen={onOpen}
            onRefresh={onRefresh}
            onRefreshPeers={onRefreshPeers}
          />
        </div>
      );
    }
  }
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function DevicesPanel({ chatId, active, compact }: DevicesPanelProps) {
  const [state, setState] = React.useState<DeviceServiceState | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const visible = useDocumentVisible();
  const listedRef = React.useRef(false);

  React.useEffect(() => {
    if (!active) return;
    let current = true;
    const unsubscribe = devicesApi.onState((next) => {
      if (current) setState(next);
    });
    devicesApi
      .getState()
      .then((next) => {
        if (!current) return;
        setState(next);
        // A running hub from earlier in this session lists simulators once, without starting anything.
        if (next.hostStatus === "ready" && !listedRef.current) {
          listedRef.current = true;
          void devicesApi.refresh("local").catch(() => undefined);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : "Could not read simulator state.");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [active]);

  const run = async (key: string, task: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
    } finally {
      setPending(null);
    }
  };

  const close = (session: DeviceSession, shutdown: boolean) =>
    void devicesApi
      .close({ chatId: session.chatId, hostId: session.hostId, deviceId: session.deviceId, shutdown })
      .catch((reason: unknown) =>
        toast.error(reason instanceof Error ? reason.message : "Could not close the simulator."),
      );

  return (
    <DevicesPanelView
      state={state}
      chatId={chatId}
      compact={compact}
      pending={pending}
      error={error}
      onSetup={() => void run("setup", () => devicesApi.setConsent("streaming", true))}
      onStart={() => void run("start", () => devicesApi.refresh("local"))}
      onRefresh={() => void run("refresh", () => devicesApi.refresh())}
      onRefreshPeers={() => void run("peers", () => devicesApi.refreshPeers())}
      onAgentAccess={(granted) => void run("agent", () => devicesApi.setConsent("agentAccess", granted))}
      onPeerSharing={(granted) => void run("peerSharing", () => devicesApi.setConsent("peerSharing", granted))}
      onOpen={(device) =>
        chatId
          ? void run(`${device.hostId}:${device.id}`, () =>
              devicesApi.open({ chatId, hostId: device.hostId, deviceId: device.id }),
            )
          : undefined
      }
      viewer={(session, device) => (
        <DeviceViewer
          key={`${session.hostId}:${session.deviceId}`}
          chatId={session.chatId}
          session={session}
          device={device}
          active={active && visible}
          compact={compact}
          onClose={(shutdown) => close(session, shutdown)}
        />
      )}
    />
  );
}
