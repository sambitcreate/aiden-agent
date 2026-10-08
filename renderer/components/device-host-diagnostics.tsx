/**
 * Adapted from t3code apps/web/src/components/device/DeviceToolVersions.tsx and
 * DeviceHostUpdates.tsx @ a6ec88f7 (MIT)
 *
 * Per-host helper versions, update progress, and Retry. Settings → Simulator,
 * the Simulator tab before its hub is ready, and the Device tools drawer all
 * use these, so an update in progress is visible wherever the user looks.
 * Nothing here polls: the container reads the service state once and then
 * follows its pushed changes.
 */
import * as React from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import { Button, Text } from "./ui";
import { devicesApi } from "../lib/ipc";
import type { DeviceHostInfo, DeviceServiceState } from "../shared/devices";
import { previousToolVersion, type DeviceToolVersion } from "../shared/device-ssh-hosts";

export const DEVICE_TOOL_LABELS = { hub: "Device hub", agent: "Agent tools" } as const;

/** One line for a helper: what runs, what is pinned, and whether an update is waiting. */
export function toolVersionSummary(tool: DeviceToolVersion | undefined): string {
  if (!tool) return "Not checked yet";
  const pinnedInstalled = tool.installedVersions.includes(tool.requiredVersion);
  if (tool.runningVersion) {
    return tool.runningVersion === tool.requiredVersion
      ? `${tool.runningVersion}, running`
      : `${tool.runningVersion} running, ${tool.requiredVersion} required`;
  }
  if (pinnedInstalled) return `${tool.requiredVersion}, installed`;
  const previous = previousToolVersion(tool);
  return previous ? `${previous} installed, ${tool.requiredVersion} required` : "Not installed";
}

const HOST_STATUS_TEXT: Record<DeviceHostInfo["status"], string> = {
  disabled: "Turned off for this build.",
  "needs-consent": "Not set up.",
  installing: "Installing helpers…",
  starting: "Starting helpers…",
  ready: "Ready.",
  stopped: "Not running.",
  unavailable: "Unavailable.",
  error: "Stopped with an error.",
};

export function hostStatusText(host: DeviceHostInfo): string {
  return host.detail ?? HOST_STATUS_TEXT[host.status];
}

/** Hosts with something to report: an install or update in progress, or a failure the user can retry. */
export function hostsNeedingAttention(hosts: readonly DeviceHostInfo[]): DeviceHostInfo[] {
  return hosts.filter((host) => host.status === "installing" || host.status === "starting" || host.status === "error");
}

export interface DeviceHostUpdatesProps {
  hosts: readonly DeviceHostInfo[];
  /** The host a Retry is running for. */
  pending: string | null;
  onRetry(hostId: string): void;
}

/** Install and update progress per host, with Retry on a failure. Renders nothing when all is quiet. */
export function DeviceHostUpdates({ hosts, pending, onRetry }: DeviceHostUpdatesProps) {
  const shown = hostsNeedingAttention(hosts);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Helper updates">
      {shown.map((host) => {
        const failed = host.status === "error";
        return (
          <li
            key={host.id}
            role={failed ? "alert" : "status"}
            className="flex items-start gap-3 rounded-control bg-control/50 px-3 py-2"
          >
            {failed ? null : (
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-secondary motion-reduce:animate-none" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <Text variant="small-strong" className="block truncate">
                {host.name}
              </Text>
              <Text variant="small" color={failed ? "status-red" : "secondary"} className="block break-words">
                {hostStatusText(host)}
              </Text>
              {failed ? (
                <Text variant="small" color="secondary" className="block">
                  Check the connection and network access, then retry. Your settings are kept.
                </Text>
              ) : null}
            </div>
            {failed ? (
              <Button
                size="small"
                variant="muted"
                disabled={pending !== null}
                aria-label={`Retry ${host.name}`}
                onClick={() => onRetry(host.id)}
              >
                {pending === host.id ? (
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <RotateCw aria-hidden />
                )}
                Retry
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface DeviceHostDiagnosticsViewProps extends DeviceHostUpdatesProps {
  /** `drawer` matches the Device tools drawer's section styling. */
  variant?: "drawer" | "panel";
}

/** A compact per-host summary: status, helper versions, and any update in progress. */
export function DeviceHostDiagnosticsView({ hosts, pending, onRetry, variant = "drawer" }: DeviceHostDiagnosticsViewProps) {
  const titleId = React.useId();
  if (hosts.length === 0) return null;
  return (
    <section
      aria-labelledby={titleId}
      className={variant === "drawer" ? "device-tools-section" : "flex w-full max-w-sm flex-col gap-2 text-left"}
    >
      <h3 id={titleId} className={variant === "drawer" ? "device-tools-section-title" : "text-small font-semibold text-secondary"}>
        Host diagnostics
      </h3>
      <DeviceHostUpdates hosts={hosts} pending={pending} onRetry={onRetry} />
      <dl className="flex flex-col gap-1.5">
        {hosts.map((host) => (
          <div key={host.id} className="flex flex-col gap-0.5">
            <dt>
              <Text variant="small-strong">{host.name}</Text>
            </dt>
            <dd className="m-0">
              <Text variant="small" color="secondary" className="block break-words">
                {hostStatusText(host)}
              </Text>
            </dd>
            {host.kind === "peer" ? null : (
              <>
                {(["hub", "agent"] as const).map((tool) => (
                  <dd key={tool} className="m-0 flex justify-between gap-3">
                    <Text variant="small" color="secondary">
                      {DEVICE_TOOL_LABELS[tool]}
                    </Text>
                    <Text variant="small" className="font-mono">
                      {toolVersionSummary(host.tools?.[tool])}
                    </Text>
                  </dd>
                ))}
                {host.toolInspectionError ? (
                  <dd className="m-0">
                    <Text variant="small" color="status-red" className="block break-words">
                      {host.toolInspectionError}
                    </Text>
                  </dd>
                ) : null}
              </>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Follows the device service state; Retry is the explicit Start for that host. */
export function useDeviceHostRetry(): { pending: string | null; error: string | null; retry(hostId: string): void } {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const retry = (hostId: string) => {
    if (pending) return;
    setPending(hostId);
    setError(null);
    devicesApi
      .startHost(hostId)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Retry did not work."))
      .finally(() => setPending(null));
  };
  return { pending, error, retry };
}

export function DeviceHostDiagnostics({ variant = "drawer" }: { variant?: "drawer" | "panel" }) {
  const [state, setState] = React.useState<DeviceServiceState | null>(null);
  const { pending, error, retry } = useDeviceHostRetry();
  React.useEffect(() => {
    let current = true;
    const unsubscribe = devicesApi.onState((next) => {
      if (current) setState(next);
    });
    devicesApi.getState().then(
      (next) => {
        if (current) setState(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  if (!state) return null;
  return (
    <>
      <DeviceHostDiagnosticsView hosts={state.hosts} pending={pending} onRetry={retry} variant={variant} />
      {error ? (
        <Text variant="small" color="status-red" role="alert" className="block">
          {error}
        </Text>
      ) : null}
    </>
  );
}
