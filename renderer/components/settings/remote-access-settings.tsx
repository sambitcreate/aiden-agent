import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import {
  CheckCircle2,
  ChevronDown,
  Folder,
  Info,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldSet,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import { CopyButton } from "../copy-button";
import { aidenRemoteApi } from "../../lib/ipc";
import { queryKeys, useAidenRemoteSettings } from "../../lib/queries";
import type {
  AidenRemoteConnectionMode,
  AidenRemoteDeviceView,
  AidenRemotePairingBootstrapView,
  AidenRemoteSettingsSnapshot,
  AidenRemoteTailscaleTakeoverReviewView,
} from "../../shared/aiden-remote";
import {
  groupRemoteDevices,
  remoteConnectionSummary,
  type RemoteDeviceGroups,
} from "../../lib/remote-connection-status";
import {
  effectiveRemotePairingLifecycle,
  evaluateRemotePairingLifecycle,
  remotePairingPresentation,
} from "../../lib/remote-pairing-lifecycle";

const FRIENDLY_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function friendlyDate(timestamp: number): string {
  return FRIENDLY_DATE_FORMATTER.format(new Date(timestamp));
}

function pairingVerificationCode(pairing: AidenRemotePairingBootstrapView): string {
  return pairing.serverSpkiSha256.slice(-9, -1).toUpperCase();
}

function connectionModeLabel(mode: AidenRemoteConnectionMode): string {
  switch (mode) {
    case "lan": return "Local Network";
    case "tailscale": return "Tailscale";
    case "both": return "Local Network + Tailscale";
  }
}

function tailscaleRouteCopy(status: AidenRemoteSettingsSnapshot["status"]): {
  badge: string;
  description: string;
} {
  switch (status.tailscaleRouteState) {
    case "owned": {
      if (status.tailscaleErrorCode === "not_connected") {
        return { badge: "Configured", description: "This profile owns the route, but Tailscale is signed out. Sign in to make it reachable." };
      }
      if (status.tailscaleErrorCode === "https_unavailable") {
        return { badge: "Configured", description: "This profile owns the route, but HTTPS is not available for this Tailscale name." };
      }
      return { badge: status.enabled ? "Connected" : "Configured", description: "This Aiden profile owns the mobile route." };
    }
    case "available":
      return { badge: "Available", description: "The Aiden mobile route is available on this Mac." };
    case "other_aiden_live":
      return { badge: "In use", description: "Another running Aiden profile owns this Mac’s mobile route. Stop or disconnect it before connecting here." };
    case "other_aiden_stale":
      return { badge: "Previous route found", description: "A previous Aiden profile left this route behind. Review it before taking over." };
    case "unrelated_conflict":
      return { badge: "Path unavailable", description: "The Aiden path has an unrecognized Serve configuration. Aiden will not replace it." };
    case "funnel_conflict":
      return { badge: "Funnel conflict", description: "Tailscale Funnel is enabled on this HTTPS listener. Disable Funnel yourself before connecting Aiden." };
    case "reconciliation_required":
      return { badge: "Verification needed", description: "Tailscale did not confirm the last route update. Verify its exact result before continuing." };
    case "unavailable":
      return {
        badge: status.tailscaleErrorCode === "not_installed" || !status.tailscaleInstalled
          ? "Tailscale not found"
          : status.tailscaleErrorCode === "not_connected"
            ? "Sign in required"
            : status.tailscaleErrorCode === "https_unavailable"
              ? "HTTPS unavailable"
              : "Unavailable",
        description: status.tailscaleErrorCode === "not_installed" || !status.tailscaleInstalled
          ? "Install Tailscale to use this connection method."
          : status.tailscaleErrorCode === "not_connected"
            ? "Open Tailscale and sign in before connecting Aiden’s mobile route."
            : status.tailscaleErrorCode === "https_unavailable"
              ? "Enable HTTPS for this Tailscale device name, then try again."
              : "Aiden couldn’t safely inspect the current Tailscale Serve configuration.",
      };
  }
}

function friendlyTailscaleError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("tailscale_route_live")) return "Another Aiden profile is active on this route. Nothing was changed.";
  if (message.includes("tailscale_takeover_changed") || message.includes("tailscale_takeover_expired")) return "The route changed or this review expired. Review it again before taking over.";
  if (message.includes("tailscale_funnel_conflict")) return "Tailscale Funnel is using this listener. Aiden did not change it.";
  if (message.includes("tailscale_route_conflict")) return "This Serve path is already in use. Aiden did not change it.";
  if (message.includes("tailscale_ownership_commit_failed")) return "Aiden restored the previous route because it couldn’t save ownership.";
  if (message.includes("tailscale_route_recovery_failed")) return "Aiden couldn’t verify route recovery. Check Tailscale Serve before trying again.";
  if (message.includes("tailscale_route_outcome_unknown")) return "Tailscale reported an uncertain route update. Aiden did not save ownership; inspect Serve before retrying.";
  if (message.includes("tailscale_reconciliation_conflict")) return "The route changed after the uncertain update. Aiden left it untouched; inspect Tailscale Serve.";
  if (message.includes("tailscale_reconciliation_unhealthy")) return "The route exists but this Aiden service did not answer its health check. Nothing was claimed.";
  if (message.includes("tailscale_reconciliation_required")) return "Verify the previous Tailscale update before starting another route change.";
  if (message.includes("tailscale_not_connected")) return "Open Tailscale and sign in before connecting Aiden.";
  if (message.includes("tailscale_https_unavailable")) return "Enable HTTPS for this Tailscale device name before connecting Aiden.";
  if (message.includes("tailscale_route_busy")) return "Another Aiden profile is updating this Mac’s mobile route. Wait a moment and try again.";
  return "Aiden couldn’t safely update the Tailscale route.";
}

function Disclosure({
  title,
  summary,
  children,
}: React.PropsWithChildren<{ title: string; summary: string }>) {
  return (
    <details className="group mb-7 overflow-hidden rounded-card bg-well">
      <summary className="flex min-h-14 cursor-default list-none items-center gap-3 px-4 py-3 outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-selection [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-large-strong text-primary">{title}</span>
          <span className="mt-0.5 block truncate text-small text-secondary">{summary}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-tertiary transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="border-t border-separator">{children}</div>
    </details>
  );
}

function RemoteAccessInfo() {
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button
          iconOnly
          size="small"
          variant="transparent"
          aria-label="About Remote Access security"
          className="size-7"
        >
          <Info />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <Text variant="small-strong">Aiden stays in control</Text>
        <Text as="p" variant="small" color="secondary" className="mt-1 leading-relaxed">
          Aiden On The Go can use only capabilities and folders approved on this Mac. Provider keys never leave Aiden, and the desktop app must be running. Tailscale is optional.
        </Text>
      </HoverCardContent>
    </HoverCard>
  );
}

function SettingsDeviceRow({
  device,
  state,
  onRevoke,
  highlighted = false,
}: {
  device: AidenRemoteDeviceView;
  state: keyof RemoteDeviceGroups;
  onRevoke?: () => void;
  highlighted?: boolean;
}) {
  const timestamp = state === "previous" ? (device.revokedAt ?? device.lastSeenAt) : device.lastSeenAt;
  return (
    <div
      data-remote-device-id={device.id}
      tabIndex={-1}
      className={`relative flex items-center gap-3 p-4 outline-none transition-colors after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden ${highlighted ? "bg-list-selection" : ""}`}
    >
      <Smartphone className="size-4 shrink-0 text-secondary" />
      <div className="min-w-0 flex-1">
        <Text variant="small-strong" truncate className="block">{device.name}</Text>
        <Text variant="small" color="secondary" className="block">
          {device.type === "ipad" ? "iPad" : "iPhone"} · {state === "pending"
            ? "Finishing connection"
            : `${state === "previous" ? "Removed" : "Last seen"} ${friendlyDate(timestamp)}`}
        </Text>
      </div>
      {state === "active" ? <Badge color="green">Active</Badge> : null}
      {state === "pending" ? <Badge color="blue">Finishing</Badge> : null}
      {state === "inactive" ? <Badge>Inactive</Badge> : null}
      {state === "previous" ? <Badge>Previous</Badge> : null}
      {onRevoke ? <Button size="small" variant="transparent" onClick={onRevoke}>Revoke</Button> : null}
    </div>
  );
}

export function RemoteAccessSettings() {
  const queryClient = useQueryClient();
  const settingsQuery = useAidenRemoteSettings();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pairing, setPairing] = React.useState<AidenRemotePairingBootstrapView | null>(null);
  const completedPairingDeviceId = React.useRef<string | null>(null);
  const pairingRef = React.useRef<AidenRemotePairingBootstrapView | null>(null);
  const mounted = React.useRef(false);
  const pairingRequestGeneration = React.useRef(0);
  const observedPairingSession = React.useRef<string | null>(null);
  const [highlightedDeviceId, setHighlightedDeviceId] = React.useState<string | null>(null);
  const [pairingQr, setPairingQr] = React.useState<string | null>(null);
  const [pairingSeconds, setPairingSeconds] = React.useState(0);
  const [revokeDevice, setRevokeDevice] = React.useState<AidenRemoteDeviceView | null>(null);
  const [removeRootId, setRemoveRootId] = React.useState<string | null>(null);
  const [takeoverReview, setTakeoverReview] = React.useState<AidenRemoteTailscaleTakeoverReviewView | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = React.useState("");

  React.useEffect(() => aidenRemoteApi.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
  }), [queryClient]);

  React.useEffect(() => {
    if (settingsQuery.data?.displayName) {
      setDisplayNameDraft(settingsQuery.data.displayName);
    }
  }, [settingsQuery.data?.displayName]);

  React.useEffect(() => {
    if (settingsQuery.data?.status.tailscaleRouteState !== "other_aiden_stale") {
      setTakeoverReview(null);
    }
  }, [settingsQuery.data?.status.tailscaleRouteState]);

  React.useEffect(() => {
    if (!pairing) {
      setPairingQr(null);
      setPairingSeconds(0);
      return;
    }
    let current = true;
    void QRCode.toDataURL(pairing.qrPayload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((url) => current && setPairingQr(url)).catch(() => {
      if (current) toast.error("Aiden couldn't draw the pairing code.");
    });
    const updateRemaining = () => {
      setPairingSeconds(Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1_000)));
    };
    updateRemaining();
    const interval = window.setInterval(updateRemaining, 1_000);
    return () => {
      current = false;
      window.clearInterval(interval);
    };
  }, [pairing]);

  React.useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pairingRequestGeneration.current += 1;
      const current = pairingRef.current;
      if (current) void aidenRemoteApi.closePairing(current.pairingSessionId).catch(() => undefined);
    };
  }, []);

  const pairingLifecycle = React.useMemo(() => pairing && settingsQuery.data
    ? evaluateRemotePairingLifecycle({
        pairingSessionId: pairing.pairingSessionId,
        status: settingsQuery.data.pairing,
        devices: settingsQuery.data.devices,
      })
    : { state: "unrelated" as const }, [
      pairing,
      settingsQuery.data,
    ]);

  React.useEffect(() => {
    if (!pairing || !settingsQuery.data) return;
    if (settingsQuery.data.pairing?.sessionId === pairing.pairingSessionId) {
      observedPairingSession.current = pairing.pairingSessionId;
    } else if (
      observedPairingSession.current === pairing.pairingSessionId &&
      settingsQuery.data.pairing?.sessionId !== pairing.pairingSessionId &&
      busy !== "closingPairing"
    ) {
      setPairing(null);
      toast.error(settingsQuery.data.pairing
        ? "This pairing code was replaced by a newer pairing window."
        : "This pairing window was closed on this Mac.");
      return;
    }
    if (pairingLifecycle.state === "cancelled") {
      setPairing(null);
      void aidenRemoteApi.closePairing(pairing.pairingSessionId).catch(() => undefined);
      toast.error("Pairing was cancelled because this device was revoked.");
      return;
    }
    if (pairingLifecycle.state !== "connected") return;
    const connected = pairingLifecycle.device;
    if (completedPairingDeviceId.current === connected.id) return;
    completedPairingDeviceId.current = connected.id;
    setBusy("closingPairing");
    void aidenRemoteApi.closePairing(pairing.pairingSessionId).then(() => {
      setPairing(null);
      setHighlightedDeviceId(connected.id);
      toast.success(`${connected.name} connected.`);
      window.requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-remote-device-id="${connected.id}"]`,
        );
        row?.scrollIntoView({ block: "nearest" });
        row?.focus({ preventScroll: true });
      });
      window.setTimeout(() => setHighlightedDeviceId(null), 3_000);
    }).catch(() => {
      toast.error("The device connected, but Aiden couldn't close the pairing window.");
    }).finally(() => setBusy(null));
  }, [busy, pairing, pairingLifecycle, settingsQuery.data]);

  const commit = React.useCallback((next: AidenRemoteSettingsSnapshot) => {
    queryClient.setQueryData(queryKeys.aidenRemote, next);
  }, [queryClient]);

  const mutate = async (
    operation: string,
    action: () => Promise<AidenRemoteSettingsSnapshot>,
    errorMessage?: (error: unknown) => string,
  ) => {
    if (busy) return;
    setBusy(operation);
    try {
      commit(await action());
    } catch (error) {
      toast.error(errorMessage
        ? errorMessage(error)
        : error instanceof Error ? error.message : "Remote Access couldn't be updated.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
    } finally {
      setBusy(null);
    }
  };

  const beginPairing = async (transport: "lan" | "tailscale") => {
    if (busy) return;
    setBusy("pairing");
    const requestGeneration = ++pairingRequestGeneration.current;
    try {
      completedPairingDeviceId.current = null;
      observedPairingSession.current = null;
      const nextPairing = await aidenRemoteApi.beginPairing(transport);
      if (!mounted.current || pairingRequestGeneration.current !== requestGeneration) {
        await aidenRemoteApi.closePairing(nextPairing.pairingSessionId).catch(() => undefined);
        return;
      }
      observedPairingSession.current = nextPairing.pairingSessionId;
      queryClient.setQueryData<AidenRemoteSettingsSnapshot>(
        queryKeys.aidenRemote,
        (current) => current
          ? {
              ...current,
              pairing: {
                sessionId: nextPairing.pairingSessionId,
                state: "awaiting_scan",
              },
            }
          : current,
      );
      setPairing(nextPairing);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
    } catch (error) {
      if (mounted.current && pairingRequestGeneration.current === requestGeneration) {
        toast.error(error instanceof Error ? error.message : "Aiden couldn't open pairing.");
      }
    } finally {
      if (mounted.current && pairingRequestGeneration.current === requestGeneration) {
        setBusy(null);
      }
    }
  };

  const reviewTailscaleTakeover = async () => {
    if (busy) return;
    setBusy("tailscaleReview");
    try {
      setTakeoverReview(await aidenRemoteApi.reviewTailscaleTakeover());
    } catch (error) {
      toast.error(friendlyTailscaleError(error));
      await queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
    } finally {
      setBusy(null);
    }
  };

  const confirmTailscaleTakeover = async () => {
    if (!takeoverReview || busy) return;
    setBusy("tailscaleTakeover");
    try {
      commit(await aidenRemoteApi.takeOverTailscale(takeoverReview.token));
      setTakeoverReview(null);
      toast.success("This Aiden profile now owns the mobile route.");
    } catch (error) {
      toast.error(friendlyTailscaleError(error));
      setTakeoverReview(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
    } finally {
      setBusy(null);
    }
  };

  const closePairing = async (open: boolean) => {
    if (open) return;
    const current = pairing;
    if (!current || busy) return;
    setBusy("closingPairing");
    try {
      await aidenRemoteApi.closePairing(current.pairingSessionId);
      setPairing(null);
    } catch {
      toast.error("Aiden couldn't close this pairing window.");
    } finally {
      setBusy(null);
    }
  };

  if (settingsQuery.isLoading) {
    return (
      <FieldSet title="Remote Access">
        <Field label="Status" description="Checking Aiden's local remote service.">
          <span className="flex items-center justify-end gap-2 text-small text-secondary">
            <Loader2 className="size-4 animate-spin" /> Checking…
          </span>
        </Field>
      </FieldSet>
    );
  }

  if (!settingsQuery.data) {
    return (
      <Callout color="red" role="alert">
        <Text variant="strong">Remote Access is unavailable</Text>
        <Text variant="small" color="secondary">
          {settingsQuery.error instanceof Error ? settingsQuery.error.message : "Aiden couldn't read its remote settings."}
        </Text>
      </Callout>
    );
  }

  const snapshot = settingsQuery.data;
  const { status } = snapshot;
  const transportAllowsLan = status.connectionMode === "lan" || status.connectionMode === "both";
  const transportAllowsTailscale = status.connectionMode === "tailscale" || status.connectionMode === "both";
  const groups = groupRemoteDevices(snapshot.devices, { serviceRunning: status.running });
  const tailscalePresentation = tailscaleRouteCopy(status);
  const effectivePairingLifecycle = effectiveRemotePairingLifecycle(pairingLifecycle, pairingSeconds);
  const pairingPresentation = remotePairingPresentation(effectivePairingLifecycle, pairingSeconds);
  const pairingTransport = pairing?.endpoint.includes(".ts.net/") ? "tailscale" : "lan";
  const canPairLan = transportAllowsLan && status.running;
  const canPairTailscale = status.enabled && transportAllowsTailscale && status.tailscaleConnected;
  const availablePairingTransports = [
    ...(canPairLan ? (["lan"] as const) : []),
    ...(canPairTailscale ? (["tailscale"] as const) : []),
  ];
  const summary = remoteConnectionSummary({
    enabled: status.enabled,
    running: status.running,
    error: status.error,
    activeDeviceCount: groups.active.length,
  });

  return (
    <>
      <FieldSet title="Remote Access">
        <Field
          label={(
            <span className="flex items-center gap-1.5">
              This Mac
              <RemoteAccessInfo />
            </span>
          )}
          description="Connect Aiden On The Go while Aiden is running."
        >
          <div className="flex items-center justify-end gap-2 max-[540px]:justify-start">
            {busy === "enabled" ? <Loader2 className="size-4 animate-spin text-secondary" /> : null}
            <Badge color={status.running ? "green" : status.error ? "red" : undefined}>{summary}</Badge>
            <Switch
              checked={status.enabled}
              onCheckedChange={(enabled) => void mutate("enabled", () => aidenRemoteApi.setEnabled(enabled))}
              disabled={busy !== null}
              aria-label="Enable Aiden Remote Access"
            />
          </div>
        </Field>
        <Field
          label="Mac name"
          description={`Shown on paired devices. Identity remains ${snapshot.instanceId.slice(-6)}.`}
        >
          <form
            className="flex w-full max-w-sm items-center justify-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate("displayName", () => aidenRemoteApi.setDisplayName(displayNameDraft));
            }}
          >
            <Input
              value={displayNameDraft}
              onChange={(event) => setDisplayNameDraft(event.target.value)}
              maxLength={80}
              aria-label="Mac display name"
              disabled={busy !== null}
            />
            <Button
              size="small"
              type="submit"
              disabled={
                busy !== null ||
                displayNameDraft.trim().length === 0 ||
                displayNameDraft.trim() === snapshot.displayName
              }
            >
              {busy === "displayName" ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </form>
        </Field>
        {status.error ? (
          <div className="flex items-start gap-2 px-4 py-3 text-small text-red" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{status.error}</span>
          </div>
        ) : null}
      </FieldSet>

      <FieldSet title="Mobile devices">
        <Field
          label="Add a device"
          description="Scan a one-time code in Aiden On The Go. Pairing expires after five minutes."
        >
          <div className="flex justify-end max-[540px]:justify-start">
            {availablePairingTransports.length <= 1 ? (
              <Button
                size="small"
                variant="accent"
                disabled={availablePairingTransports.length === 0 || busy !== null}
                onClick={() => {
                  const [transport] = availablePairingTransports;
                  if (transport) void beginPairing(transport);
                }}
              >
                {busy === "pairing" ? <Loader2 className="animate-spin" /> : <Plus />}
                Add device
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="small" variant="accent" disabled={busy !== null}>
                    {busy === "pairing" ? <Loader2 className="animate-spin" /> : <Plus />}
                    Add device <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void beginPairing("lan")}>
                    <Network /> Local Network
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void beginPairing("tailscale")}>
                    <Network /> Tailscale
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </Field>
        {groups.active.length === 0 && groups.pending.length === 0 && groups.inactive.length === 0 ? (
          <div className="p-4 text-small text-secondary">No devices are paired with this Mac.</div>
        ) : (
          <>
            {groups.active.map((device) => (
              <SettingsDeviceRow
                key={device.id}
                device={device}
                state="active"
                highlighted={highlightedDeviceId === device.id}
                onRevoke={() => setRevokeDevice(device)}
              />
            ))}
            {groups.pending.map((device) => (
              <SettingsDeviceRow
                key={device.id}
                device={device}
                state="pending"
                highlighted={highlightedDeviceId === device.id}
                onRevoke={() => setRevokeDevice(device)}
              />
            ))}
            {groups.inactive.map((device) => (
              <SettingsDeviceRow
                key={device.id}
                device={device}
                state="inactive"
                highlighted={highlightedDeviceId === device.id}
                onRevoke={() => setRevokeDevice(device)}
              />
            ))}
          </>
        )}
        {groups.previous.length > 0 ? (
          <details className="group border-t border-separator">
            <summary className="flex cursor-default list-none items-center justify-between px-4 py-3 text-small-strong text-secondary outline-none hover:bg-list-hover focus-visible:bg-list-selection [&::-webkit-details-marker]:hidden">
              <span>Previous connections</span>
              <span className="flex items-center gap-2 text-tertiary">
                {groups.previous.length}
                <ChevronDown className="size-4 transition-transform duration-150 group-open:rotate-180" />
              </span>
            </summary>
            {groups.previous.map((device) => (
              <SettingsDeviceRow key={device.id} device={device} state="previous" />
            ))}
          </details>
        ) : null}
      </FieldSet>

      <Disclosure
        title="Connection"
        summary={`${connectionModeLabel(status.connectionMode)} · ${status.running ? "Ready" : summary}`}
      >
        <Field
          label="Connection method"
          description="Choose local Wi-Fi, Tailscale, or both."
        >
          <Select
            value={status.connectionMode}
            onValueChange={(value) => void mutate("mode", () =>
              aidenRemoteApi.setConnectionMode(value as AidenRemoteConnectionMode))}
            disabled={busy !== null}
          >
            <SelectTrigger aria-label="Remote Access connection mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lan">Local Network</SelectItem>
              <SelectItem value="tailscale">Tailscale</SelectItem>
              <SelectItem value="both">Local Network + Tailscale</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Technical details" description={`Private API port ${status.lanPort}. Aiden keeps this port stable after a successful start.`} orientation="vertical">
          <Callout aria-live="polite" color={status.error ? "red" : undefined}>
            <div className="flex items-center gap-2">
              {status.running ? (
                <CheckCircle2 className="size-4 text-green" />
              ) : status.error ? (
                <TriangleAlert className="size-4 text-red" />
              ) : (
                <Network className="size-4 text-tertiary" />
              )}
              <Text variant="small-strong">{status.running ? "Ready" : summary}</Text>
            </div>
            {status.lanEndpoint ? (
              <Text as="p" variant="small" color="secondary" className="mt-1 break-all">
                Local: {status.lanEndpoint}
              </Text>
            ) : null}
            {status.tailscaleEndpoint ? (
              <Text as="p" variant="small" color="secondary" className="mt-1 break-all">
                Tailscale: {status.tailscaleEndpoint}
              </Text>
            ) : null}
            {status.errorCode === "remote_port_in_use" ? (
              <Text as="p" variant="small" color="secondary">
                Another local Aiden profile is using this saved endpoint. Stop that profile and try again; Aiden will not silently move a saved mobile connection to a new port.
              </Text>
            ) : status.error ? (
              <Text as="p" variant="small" color="secondary">{status.error}</Text>
            ) : null}
          </Callout>
        </Field>
        {transportAllowsTailscale ? (
          <Field
            label="Tailscale Serve"
            description="Aiden inspects the existing Serve configuration first, never enables Funnel, and never resets unrelated routes."
            orientation="vertical"
          >
            <Callout>
              <code className="block overflow-x-auto whitespace-pre-wrap break-all font-mono text-small text-secondary">
                {status.tailscaleRoutePreview ?? "Preparing the loopback route…"}
              </code>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <Badge color={status.tailscaleConnected ? "green" : undefined}>
                    {tailscalePresentation.badge}
                  </Badge>
                  <Text as="p" variant="small" color="secondary" className="mt-1">
                    {tailscalePresentation.description}
                  </Text>
                </div>
                {status.tailscaleRouteState === "owned" ? (
                  <Button
                    size="small"
                    variant="filled"
                    disabled={!status.enabled || busy !== null}
                    onClick={() => void mutate("tailscale", aidenRemoteApi.disconnectTailscale, friendlyTailscaleError)}
                  >
                    {busy === "tailscale" ? <Loader2 className="animate-spin" /> : <Network />}
                    Disconnect
                  </Button>
                ) : status.tailscaleRouteState === "available" ? (
                  <Button
                    size="small"
                    variant="accent"
                    disabled={!status.enabled || busy !== null || !status.tailscaleInstalled}
                    onClick={() => void mutate("tailscale", aidenRemoteApi.connectTailscale, friendlyTailscaleError)}
                  >
                    {busy === "tailscale" ? <Loader2 className="animate-spin" /> : <Network />}
                    Connect
                  </Button>
                ) : status.tailscaleRouteState === "other_aiden_stale" ? (
                  <Button
                    size="small"
                    variant="accent"
                    disabled={!status.enabled || busy !== null}
                    onClick={() => void reviewTailscaleTakeover()}
                  >
                    {busy === "tailscaleReview" ? <Loader2 className="animate-spin" /> : <TriangleAlert />}
                    Review takeover
                  </Button>
                ) : status.tailscaleRouteState === "reconciliation_required" ? (
                  <Button
                    size="small"
                    variant="accent"
                    disabled={!status.enabled || busy !== null}
                    onClick={() => void mutate("tailscale", aidenRemoteApi.reconcileTailscale, friendlyTailscaleError)}
                  >
                    {busy === "tailscale" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    Verify update
                  </Button>
                ) : null}
              </div>
            </Callout>
          </Field>
        ) : null}
      </Disclosure>

      <Disclosure
        title="Workspace access"
        summary={snapshot.approvedRoots.length === 0
          ? "No folders approved"
          : `${snapshot.approvedRoots.length} approved folder${snapshot.approvedRoots.length === 1 ? "" : "s"}`}
      >
        <Field
          label="Approved folders"
          description="Paired devices can explore only these roots. Hidden and system folders remain excluded. Roots cannot overlap."
        >
          <div className="flex justify-end max-[540px]:justify-start">
            <Button size="small" disabled={busy !== null} onClick={() => void mutate("addRoot", aidenRemoteApi.addApprovedRoot)}>
              {busy === "addRoot" ? <Loader2 className="animate-spin" /> : <Plus />} Add folder
            </Button>
          </div>
        </Field>
        {snapshot.approvedRoots.length === 0 ? (
          <div className="p-4 text-small text-secondary">No folders are approved for remote browsing.</div>
        ) : snapshot.approvedRoots.map((root) => (
          <div key={root.id} className="relative flex items-center gap-3 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden">
            <Folder className="size-4 shrink-0 text-secondary" />
            <div className="min-w-0 flex-1">
              <Text variant="small-strong" truncate className="block">{root.label}</Text>
              <Text variant="small" color="secondary" truncate className="block" title={root.folderPath}>{root.folderPath}</Text>
            </div>
            <Button iconOnly size="small" variant="transparent" aria-label={`Remove ${root.label}`} onClick={() => setRemoveRootId(root.id)}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </Disclosure>

      <Dialog
        open={pairing !== null}
        onOpenChange={(open) => void closePairing(open)}
        title="Pair Aiden On The Go"
        description={effectivePairingLifecycle.state === "finishing"
          ? "The code was accepted. Keep Aiden On The Go open while it finishes connecting."
          : effectivePairingLifecycle.state === "failed"
            ? "This one-time code was consumed, but Aiden couldn't create the connection. Close and try again."
            : effectivePairingLifecycle.state === "expired"
              ? "This one-time code expired. Create a new code to continue."
              : "Scan the QR or enter the one-time setup code in Aiden On The Go. Do not share either one."}
        confirmHidden
        busy={busy === "closingPairing"}
      >
        {pairing ? (
          <div className="flex flex-col items-center gap-3 text-center">
            {pairingQr ? (
              <div className="relative size-64 max-w-full">
                <img
                  src={pairingQr}
                  alt={pairingPresentation.qrDisabled ? "Consumed Aiden pairing QR code" : "One-time Aiden pairing QR code"}
                  className={`size-64 max-w-full rounded-card ${pairingPresentation.qrDisabled ? "opacity-30" : ""}`}
                />
                {effectivePairingLifecycle.state === "finishing" ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" role="status" aria-live="polite">
                    <Loader2 className="size-8 animate-spin text-accent" />
                    <Text variant="strong">Finishing connection</Text>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex size-64 items-center justify-center rounded-card bg-well"><Loader2 className="animate-spin" /></div>
            )}
            <Badge color={pairingPresentation.tone}>
              {pairingPresentation.badge}
            </Badge>
            <div className="w-full rounded-control bg-well px-4 py-3 text-left">
              <Text variant="small" color="secondary" className="block">
                {pairingTransport === "tailscale" ? "Private Tailscale address" : "Nearby Mac address"}
              </Text>
              <div className="mt-1 flex items-center justify-between gap-3">
                <code className="min-w-0 break-all font-mono text-small text-primary">{pairing.endpoint}</code>
                <CopyButton text={pairing.endpoint} label="Copy Mac address" />
              </div>
            </div>
            <div
              className={`w-full rounded-control bg-well px-4 py-3 text-left ${pairingPresentation.qrDisabled ? "opacity-50" : ""}`}
              aria-label="Manual pairing setup code"
              aria-disabled={pairingPresentation.qrDisabled}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Text variant="small" color="secondary" className="block">Enter this code instead</Text>
                  <code className={`mt-1 block break-all font-mono text-heading2 font-semibold tracking-wider text-primary ${pairingPresentation.qrDisabled ? "select-none" : "select-all"}`}>
                    {pairingPresentation.qrDisabled ? "Code unavailable" : pairing.manualCode}
                  </code>
                </div>
                {!pairingPresentation.qrDisabled ? (
                  <CopyButton text={pairing.manualCode} label="Copy setup code" />
                ) : null}
              </div>
              <Text variant="small" color="secondary" className="mt-2 block">
                {pairingTransport === "tailscale"
                  ? "Enter this private address and the setup code on your iPhone or iPad."
                  : "Select this discovered Mac, then enter the setup code on your iPhone or iPad."}
              </Text>
            </div>
            <Text variant="small" color="secondary" role="status" aria-live="polite">
              Certificate check {pairingVerificationCode(pairing)} · {pairingPresentation.qrDisabled
                ? pairingPresentation.badge
                : `Expires in ${pairingSeconds} seconds`}.
            </Text>
            {(effectivePairingLifecycle.state === "expired" || effectivePairingLifecycle.state === "failed") ? (
              <Button
                size="small"
                variant="accent"
                disabled={busy !== null}
                onClick={() => void beginPairing(pairingTransport)}
              >
                <RefreshCw /> Create new code
              </Button>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <AlertDialog
        open={takeoverReview !== null}
        onOpenChange={(open) => !open && setTakeoverReview(null)}
        title="Take over Aiden’s mobile route?"
        description="The previous Aiden target did not answer two bounded health checks. Aiden will replace only /api/aiden/v1, preserve every other Serve handler, and leave Funnel unchanged. Local Network access is unaffected."
        confirmLabel="Take Over"
        busy={busy === "tailscaleTakeover"}
        keepOpenOnConfirm
        onConfirm={confirmTailscaleTakeover}
      />

      <AlertDialog
        open={revokeDevice !== null}
        onOpenChange={(open) => !open && setRevokeDevice(null)}
        title="Revoke this device?"
        description={revokeDevice ? `“${revokeDevice.name}” will immediately lose Remote Access. Pair it again to restore access.` : undefined}
        confirmLabel="Revoke"
        confirmVariant="destructive"
        busy={busy === "revoke"}
        keepOpenOnConfirm
        onConfirm={async () => {
          if (!revokeDevice) return;
          await mutate("revoke", () => aidenRemoteApi.revokeDevice(revokeDevice.id));
          setRevokeDevice(null);
        }}
      />

      <AlertDialog
        open={removeRootId !== null}
        onOpenChange={(open) => !open && setRemoveRootId(null)}
        title="Remove this approved folder?"
        description="Paired devices will no longer be able to explore or add workspaces from this root. Existing Aiden workspaces are unchanged."
        confirmLabel="Remove"
        confirmVariant="destructive"
        busy={busy === "removeRoot"}
        keepOpenOnConfirm
        onConfirm={async () => {
          if (!removeRootId) return;
          await mutate("removeRoot", () => aidenRemoteApi.removeApprovedRoot(removeRootId));
          setRemoveRootId(null);
        }}
      />
    </>
  );
}
