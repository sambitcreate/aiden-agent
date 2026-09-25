import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { AlertDialog, Badge, Button, Callout, Field, FieldSet, Switch, Text } from "../ui";
import { devicesApi } from "../../lib/ipc";
import { useAppCapabilities } from "../../lib/app-capabilities";
import {
  DEVICE_SETUP_NOTICE,
  type DeviceConsentKind,
  type DeviceServiceState,
  type DeviceToolchainState,
} from "../../shared/devices";

type Pending = DeviceConsentKind | "prune" | "remove" | null;

export interface SimulatorSettingsViewProps {
  state: DeviceServiceState | null;
  toolchain: DeviceToolchainState | null;
  pending: Pending;
  error: string | null;
  /** Streaming or agent access being turned on, awaiting the npm download confirmation. */
  confirming: "streaming" | "agentAccess" | "remove" | null;
  onConsent(kind: DeviceConsentKind, granted: boolean): void;
  onConfirm(): void;
  onCancelConfirm(): void;
  onPrune(): void;
  onRemove(): void;
}

const CONSENT_ROWS: ReadonlyArray<{ kind: DeviceConsentKind; label: string; description: string }> = [
  {
    kind: "streaming",
    label: "Simulator streaming",
    description:
      "Run the pinned device hub on this Mac so you can view and control iOS Simulators in the Environment panel.",
  },
  {
    kind: "agentAccess",
    label: "Agent access",
    description:
      "In chats, Aiden can open a simulator and tap, type, and install apps with agent-device while you watch.",
  },
  {
    kind: "peerSharing",
    label: "Share with paired Macs",
    description:
      "Paired Macs that you granted simulator control can view and drive this Mac’s simulators. Nothing is shared until you turn this on.",
  },
];

const CONFIRM_COPY = {
  streaming: {
    title: "Set up simulator streaming?",
    confirmLabel: "Download and set up",
    body: DEVICE_SETUP_NOTICE,
  },
  agentAccess: {
    title: "Allow agent access to simulators?",
    confirmLabel: "Download and allow",
    body: "Aiden downloads the pinned agent-device helper from npm into its app data. Chats can then drive a simulator on this Mac while you watch. You can turn this off at any time.",
  },
} as const;

function statusLabel(state: DeviceServiceState): string {
  if (state.unavailableReason) return state.unavailableReason;
  switch (state.hostStatus) {
    case "ready":
      return "Running";
    case "installing":
      return "Installing helpers…";
    case "starting":
      return "Starting…";
    case "stopped":
      return "Set up. Starts when you open the Simulator tab.";
    case "error":
      return "The device hub stopped unexpectedly.";
    case "unavailable":
      return "Unavailable on this Mac.";
    case "disabled":
      return "Turned off for this build.";
    default:
      return "Not set up.";
  }
}

export function SimulatorSettingsView({
  state,
  toolchain,
  pending,
  error,
  confirming,
  onConsent,
  onConfirm,
  onCancelConfirm,
  onPrune,
  onRemove,
}: SimulatorSettingsViewProps) {
  if (!state) {
    return (
      <FieldSet title="Permissions">
        <Field>
          {error ? (
            <Callout color="red" role="alert">
              {error}
            </Callout>
          ) : (
            <Text role="status" variant="small" color="secondary">
              Reading simulator settings…
            </Text>
          )}
        </Field>
      </FieldSet>
    );
  }
  const busy = pending !== null;
  const anyInstalled = toolchain?.tools.some((tool) => tool.installed.length > 0) ?? false;
  const stale = toolchain?.tools.some((tool) => tool.installed.some((version) => version !== tool.pinned)) ?? false;
  const anyGranted = state.consent.streaming || state.consent.agentAccess || state.consent.peerSharing;
  const confirmCopy = confirming === "streaming" || confirming === "agentAccess" ? CONFIRM_COPY[confirming] : null;

  return (
    <>
      <FieldSet title="Permissions">
        {CONSENT_ROWS.map((row) => {
          const needsStreaming = row.kind !== "streaming" && !state.consent.streaming;
          return (
            <Field
              key={row.kind}
              label={row.label}
              description={needsStreaming ? `${row.description} Requires simulator streaming.` : row.description}
            >
              <div className="flex items-center justify-end gap-2">
                {pending === row.kind ? (
                  <LoaderCircle className="size-4 animate-spin text-secondary motion-reduce:animate-none" aria-hidden />
                ) : null}
                <Switch
                  checked={state.consent[row.kind]}
                  disabled={busy || state.hostStatus === "disabled" || (needsStreaming && !state.consent[row.kind])}
                  aria-label={row.label}
                  onCheckedChange={(granted) => onConsent(row.kind, granted)}
                />
              </div>
            </Field>
          );
        })}
        <Field label="Status" description="Checked when this page opens. Aiden never polls in the background.">
          <Text variant="small" color="secondary" role="status" className="text-right">
            {statusLabel(state)}
          </Text>
        </Field>
      </FieldSet>

      <FieldSet title="Helper tools">
        {(toolchain?.tools ?? []).map((tool) => {
          const others = tool.installed.filter((version) => version !== tool.pinned);
          const current = tool.installed.includes(tool.pinned);
          return (
            <Field
              key={tool.id}
              label={<span className="font-mono">{tool.name}</span>}
              description={
                others.length > 0
                  ? `Older versions on disk: ${others.join(", ")}`
                  : current
                    ? "Installed from npm into Aiden’s app data."
                    : "Downloaded from npm only after you allow it."
              }
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge className="whitespace-nowrap">Pinned {tool.pinned}</Badge>
                <Badge color={current ? "green" : undefined} className="whitespace-nowrap">
                  {current ? "Installed" : "Not installed"}
                </Badge>
              </div>
            </Field>
          );
        })}
        <Field
          label="Prune old versions"
          description="Delete helper versions Aiden no longer uses. The pinned versions stay."
        >
          <Button size="small" variant="transparent" disabled={busy || !stale} onClick={onPrune}>
            {pending === "prune" ? "Pruning…" : "Prune"}
          </Button>
        </Field>
        <Field
          label="Remove installed tools"
          description="Turn every simulator permission off, stop the helpers, and delete their files and screenshots."
        >
          <Button
            size="small"
            variant="destructive"
            disabled={busy || (!anyInstalled && !anyGranted)}
            onClick={onRemove}
          >
            {pending === "remove" ? "Removing…" : "Remove…"}
          </Button>
        </Field>
      </FieldSet>

      {error ? (
        <Callout color="red" role="alert" className="mb-7">
          {error}
        </Callout>
      ) : null}

      <AlertDialog
        open={confirmCopy !== null}
        onOpenChange={(open) => (open ? undefined : onCancelConfirm())}
        title={confirmCopy?.title ?? ""}
        description={confirmCopy?.body}
        confirmLabel={confirmCopy?.confirmLabel}
        busy={busy}
        onConfirm={onConfirm}
      />
      <AlertDialog
        open={confirming === "remove"}
        onOpenChange={(open) => (open ? undefined : onCancelConfirm())}
        title="Remove simulator tools?"
        description="Simulator streaming, agent access, and sharing turn off. Aiden stops the helpers and deletes them with their screenshots. Your simulators and apps are not touched."
        confirmLabel="Remove tools"
        confirmVariant="destructive"
        busy={busy}
        onConfirm={onConfirm}
      />
    </>
  );
}

export function SimulatorSettings() {
  const capabilities = useAppCapabilities();
  const [state, setState] = React.useState<DeviceServiceState | null>(null);
  const [toolchain, setToolchain] = React.useState<DeviceToolchainState | null>(null);
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<SimulatorSettingsViewProps["confirming"]>(null);

  React.useEffect(() => {
    if (!capabilities.devices) return;
    let current = true;
    const unsubscribe = devicesApi.onState((next) => {
      if (current) setState(next);
    });
    Promise.all([devicesApi.getState(), devicesApi.toolchain()])
      .then(([nextState, nextToolchain]) => {
        if (!current) return;
        setState(nextState);
        setToolchain(nextToolchain);
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : "Could not read simulator settings.");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [capabilities.devices]);

  const run = async (key: Exclude<Pending, null>, task: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
    } finally {
      // Installs and removals change what is on disk either way.
      await devicesApi.toolchain().then(setToolchain, () => undefined);
      setPending(null);
      setConfirming(null);
    }
  };

  if (!capabilities.devices) {
    return (
      <FieldSet title="Permissions">
        <Field>
          <Text variant="small" color="secondary">
            Simulator devices are not available in this build.
          </Text>
        </Field>
      </FieldSet>
    );
  }

  return (
    <SimulatorSettingsView
      state={state}
      toolchain={toolchain}
      pending={pending}
      error={error}
      confirming={confirming}
      onConsent={(kind, granted) => {
        // Turning on anything that downloads from npm asks first; sharing and every revoke do not.
        if (granted && (kind === "streaming" || kind === "agentAccess")) setConfirming(kind);
        else void run(kind, () => devicesApi.setConsent(kind, granted).then(setState));
      }}
      onConfirm={() => {
        if (confirming === "remove") void run("remove", () => devicesApi.removeTools().then(setState));
        else if (confirming) {
          const kind = confirming;
          void run(kind, () => devicesApi.setConsent(kind, true).then(setState));
        }
      }}
      onCancelConfirm={() => {
        if (!pending) setConfirming(null);
      }}
      onPrune={() => void run("prune", () => devicesApi.pruneTools().then(setToolchain))}
      onRemove={() => setConfirming("remove")}
    />
  );
}
