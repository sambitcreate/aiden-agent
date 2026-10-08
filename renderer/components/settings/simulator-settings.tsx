import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { AlertDialog, Badge, Button, Callout, Field, FieldSet, Switch, Text } from "../ui";
import { devicesApi } from "../../lib/ipc";
import { useAppCapabilities } from "../../lib/app-capabilities";
import {
  DEVICE_SETUP_NOTICE,
  LOCAL_DEVICE_HOST_ID,
  type DeviceConsentKind,
  type DeviceServiceState,
  type DeviceToolchainState,
} from "../../shared/devices";
import { previousToolVersion, toolNeedsUpdate } from "../../shared/device-ssh-hosts";
import { DeviceHostUpdates, useDeviceHostRetry } from "../device-host-diagnostics";
import { SimulatorSshHosts } from "./simulator-ssh-hosts";

type Pending = DeviceConsentKind | "prune" | "remove" | "inspect" | "update-hub" | "update-agent" | null;

export interface SimulatorSettingsViewProps {
  state: DeviceServiceState | null;
  toolchain: DeviceToolchainState | null;
  pending: Pending;
  error: string | null;
  /** Streaming or agent access being turned on, awaiting the npm download confirmation. */
  confirming: "streaming" | "agentAccess" | "remove" | null;
  onConsent(kind: DeviceConsentKind, granted: boolean): void;
  onConfirm(): void;
  /** The control that opened the confirmation, focused again when it closes. */
  returnFocus?: () => HTMLElement | null;
  onCancelConfirm(): void;
  onPrune(): void;
  onRemove(): void;
  /** Reads helper versions on this Mac and every SSH host. Installs nothing. */
  onInspect?(): void;
  /** Installs the pinned version over an older one, under the permission already granted. */
  onUpdate?(tool: "hub" | "agent"): void;
  /** The host a Retry is running for. */
  retrying?: string | null;
  onRetry?(hostId: string): void;
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
  {
    kind: "mobileSharing",
    label: "Share with Aiden On The Go",
    description:
      "Your paired iPhone and Android phones can watch, tap, and shut down this Mac’s simulators. They can’t change simulator settings. Turning this off disconnects them.",
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
  returnFocus,
  onCancelConfirm,
  onPrune,
  onRemove,
  onInspect,
  onUpdate,
  retrying = null,
  onRetry,
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
  const anyGranted =
    state.consent.streaming || state.consent.agentAccess || state.consent.peerSharing || state.consent.mobileSharing === true;
  const confirmCopy = confirming === "streaming" || confirming === "agentAccess" ? CONFIRM_COPY[confirming] : null;
  const localTools = state.hosts.find((host) => host.id === LOCAL_DEVICE_HOST_ID)?.tools;

  return (
    <>
      <FieldSet title="Permissions">
        {CONSENT_ROWS.map((row) => {
          const needsStreaming = row.kind !== "streaming" && !state.consent.streaming;
          const granted = state.consent[row.kind] === true;
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
                  checked={granted}
                  disabled={busy || state.hostStatus === "disabled" || (needsStreaming && !granted)}
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
        {onRetry && state.hosts.some((host) => ["installing", "starting", "error"].includes(host.status)) ? (
          <Field label="Updates" orientation="vertical">
            <DeviceHostUpdates hosts={state.hosts} pending={retrying} onRetry={onRetry} />
          </Field>
        ) : null}
      </FieldSet>

      <FieldSet title="Helper tools">
        {(toolchain?.tools ?? []).map((tool) => {
          const others = tool.installed.filter((version) => version !== tool.pinned);
          const current = tool.installed.includes(tool.pinned);
          const versions = localTools?.[tool.id];
          const running = versions?.runningVersion ?? null;
          // An older install with the matching permission granted updates here, or on the next Start.
          const update = versions && toolNeedsUpdate(versions) ? previousToolVersion(versions) : null;
          const permitted = tool.id === "hub" ? state.consent.streaming : state.consent.agentAccess;
          const notes = [
            running ? `Running ${running}.` : null,
            update
              ? `${tool.pinned} replaces ${update} the next time the helpers start${permitted ? ", or update now" : ""}.`
              : null,
            others.length > 0
              ? `Older versions on disk: ${others.join(", ")}`
              : current
                ? "Installed from npm into Aiden’s app data."
                : update
                  ? null
                  : "Downloaded from npm only after you allow it.",
          ].filter(Boolean);
          return (
            <Field key={tool.id} label={<span className="font-mono">{tool.name}</span>} description={notes.join(" ")}>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge className="whitespace-nowrap">Pinned {tool.pinned}</Badge>
                <Badge color={current ? "green" : update ? "warning" : undefined} className="whitespace-nowrap">
                  {current ? "Installed" : update ? "Update available" : "Not installed"}
                </Badge>
                {update && permitted && onUpdate ? (
                  <Button
                    size="small"
                    variant="filled"
                    disabled={busy}
                    aria-label={`Update ${tool.name} to ${tool.pinned}`}
                    onClick={() => onUpdate(tool.id)}
                  >
                    {pending === `update-${tool.id}` ? "Updating…" : "Update"}
                  </Button>
                ) : null}
              </div>
            </Field>
          );
        })}
        {onInspect ? (
          <Field
            label="Check device tool versions"
            description="Reads the versions installed and running on this Mac and on your SSH hosts. Nothing is installed or changed."
          >
            <Button size="small" variant="transparent" disabled={busy} onClick={onInspect}>
              {pending === "inspect" ? "Checking…" : "Check versions"}
            </Button>
          </Field>
        ) : null}
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
        keepOpenOnConfirm
        returnFocus={returnFocus}
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
        keepOpenOnConfirm
        returnFocus={returnFocus}
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
  const retry = useDeviceHostRetry();
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const confirm = (next: NonNullable<SimulatorSettingsViewProps["confirming"]>) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirming(next);
  };

  React.useEffect(() => {
    if (!capabilities.devices) return;
    let current = true;
    let lastStatus: DeviceServiceState["hostStatus"] | null = null;
    const unsubscribe = devicesApi.onState((next) => {
      if (!current) return;
      setState(next);
      // Installs and removals elsewhere (the Simulator tab, another window) change what is on disk.
      // Re-read on status changes only: a disk read, never a poll.
      if (lastStatus !== null && next.hostStatus !== lastStatus) {
        void devicesApi.toolchain().then((tools) => {
          if (current) setToolchain(tools);
        }, () => undefined);
      }
      lastStatus = next.hostStatus;
    });
    Promise.all([devicesApi.getState(), devicesApi.toolchain()])
      .then(([nextState, nextToolchain]) => {
        if (!current) return;
        setState(nextState);
        setToolchain(nextToolchain);
        lastStatus ??= nextState.hostStatus;
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
    <>
      <SimulatorSettingsView
        state={state}
        toolchain={toolchain}
        pending={pending}
        error={error ?? retry.error}
        confirming={confirming}
        onConsent={(kind, granted) => {
          // Turning on anything that downloads from npm asks first; sharing and every revoke do not.
          if (granted && (kind === "streaming" || kind === "agentAccess")) confirm(kind);
          else void run(kind, () => devicesApi.setConsent(kind, granted).then(setState));
        }}
        onConfirm={() => {
          if (confirming === "remove") void run("remove", () => devicesApi.removeTools().then(setState));
          else if (confirming) {
            const kind = confirming;
            void run(kind, () => devicesApi.setConsent(kind, true).then(setState));
          }
        }}
        returnFocus={() => returnFocusRef.current}
        onCancelConfirm={() => {
          if (!pending) setConfirming(null);
        }}
        onPrune={() => void run("prune", () => devicesApi.pruneTools().then(setToolchain))}
        onRemove={() => confirm("remove")}
        onInspect={() => void run("inspect", () => devicesApi.inspectTools().then(setState))}
        onUpdate={(tool) => void run(`update-${tool}`, () => devicesApi.updateTool({ hostId: LOCAL_DEVICE_HOST_ID, tool }).then(setState))}
        retrying={retry.pending}
        onRetry={retry.retry}
      />
      {state ? <SimulatorSshHosts state={state} /> : null}
    </>
  );
}
