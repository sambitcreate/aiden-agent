import * as React from "react";
import { LoaderCircle, RefreshCw, Smartphone, Tablet, TriangleAlert } from "lucide-react";
import { Button, Switch, Text, toast } from "./ui";
import { DeviceViewer } from "./device-viewer";
import { devicesApi } from "../lib/ipc";
import type { DeviceServiceState, DeviceSession, DeviceSummary } from "../shared/devices";

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
  onRefresh(): void;
  onOpen(device: DeviceSummary): void;
  /** Grants or revokes agent access. Granting installs agent-device from npm. */
  onAgentAccess(granted: boolean): void;
  /** Renders the live viewer for the open session. */
  viewer?: (session: DeviceSession, device: DeviceSummary) => React.ReactNode;
}

const SETUP_COPY =
  "Setup downloads two pinned helper tools, expo-device-hub and agent-device, from npm into Aiden's app data. " +
  "Installing them also lets node-datachannel download its prebuilt native binary. " +
  "Nothing is sent about your chats, and the simulators stay on this Mac.";

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

function AgentAccessRow({
  granted,
  pending,
  compact,
  onChange,
}: {
  granted: boolean;
  pending: string | null;
  compact: boolean;
  onChange(granted: boolean): void;
}) {
  return (
    <div className="devices-agent-access">
      <span className="min-w-0 flex-1">
        <Text id="devices-agent-access-label" variant="small-strong" className="block">
          Let Aiden use simulators
        </Text>
        <Text
          id="devices-agent-access-description"
          variant="small"
          color="secondary"
          className={compact ? "sr-only" : "block"}
        >
          In chats, Aiden can open a simulator here and tap, type, and install apps with agent-device while you
          watch. Turning this on installs agent-device from npm.
        </Text>
      </span>
      {pending === "agent" ? (
        <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
      ) : null}
      <Switch
        checked={granted}
        disabled={pending !== null}
        aria-labelledby="devices-agent-access-label"
        aria-describedby="devices-agent-access-description"
        onCheckedChange={onChange}
      />
    </div>
  );
}

function DeviceList({
  devices,
  chatId,
  pending,
  onOpen,
  onRefresh,
}: {
  devices: DeviceSummary[];
  chatId?: string;
  pending: string | null;
  onOpen(device: DeviceSummary): void;
  onRefresh(): void;
}) {
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
          title="Refresh simulators"
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
      {devices.length === 0 ? (
        <Text variant="small" color="secondary" className="devices-list-note">
          No iOS simulators found. Add one in Xcode under Window → Devices and Simulators.
        </Text>
      ) : (
        <ul className="devices-list-rows">
          {devices.map((device) => {
            const opening = pending === device.id;
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
                  {opening ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {device.booted ? "Open" : "Boot & open"}
                </Button>
              </li>
            );
          })}
        </ul>
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
  onOpen,
  onAgentAccess,
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
  const host = state.hostStatuses[Object.keys(state.hostStatuses)[0] ?? ""];
  const detail = host?.detail;
  const errorLine = error ? (
    <Text variant="small" className="text-red" role="alert">
      {error}
    </Text>
  ) : null;

  switch (state.hostStatus) {
    case "disabled":
    case "needs-consent":
      return (
        <Empty icon={<Smartphone aria-hidden />} title="iOS Simulator">
          <p className={explain}>
            Watch and control Xcode simulators here, and let Aiden drive them while you watch.
          </p>
          <p className={explain}>{detail ?? SETUP_COPY}</p>
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
          <AgentAccessRow
            granted={state.consent.agentAccess}
            pending={pending}
            compact={compact}
            onChange={onAgentAccess}
          />
          <DeviceList
            devices={state.devices}
            chatId={chatId}
            pending={pending}
            onOpen={onOpen}
            onRefresh={onRefresh}
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
          void devicesApi.refresh().catch(() => undefined);
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
      onStart={() => void run("start", () => devicesApi.refresh())}
      onRefresh={() => void run("refresh", () => devicesApi.refresh())}
      onAgentAccess={(granted) => void run("agent", () => devicesApi.setConsent("agentAccess", granted))}
      onOpen={(device) =>
        chatId
          ? void run(device.id, () =>
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
