import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import {
  CheckCircle2,
  Folder,
  Loader2,
  Network,
  Plus,
  ShieldCheck,
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
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import { aidenRemoteApi } from "../../lib/ipc";
import { queryKeys, useAidenRemoteSettings } from "../../lib/queries";
import type {
  AidenRemoteConnectionMode,
  AidenRemoteDeviceView,
  AidenRemotePairingBootstrapView,
  AidenRemoteSettingsSnapshot,
} from "../../shared/aiden-remote";

function friendlyDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function pairingVerificationCode(pairing: AidenRemotePairingBootstrapView): string {
  return pairing.serverSpkiSha256.slice(-9, -1).toUpperCase();
}

export function RemoteAccessSettings() {
  const queryClient = useQueryClient();
  const settingsQuery = useAidenRemoteSettings();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [pairing, setPairing] = React.useState<AidenRemotePairingBootstrapView | null>(null);
  const [pairingQr, setPairingQr] = React.useState<string | null>(null);
  const [pairingSeconds, setPairingSeconds] = React.useState(0);
  const [revokeDevice, setRevokeDevice] = React.useState<AidenRemoteDeviceView | null>(null);
  const [removeRootId, setRemoveRootId] = React.useState<string | null>(null);

  React.useEffect(() => aidenRemoteApi.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
  }), [queryClient]);

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

  const commit = React.useCallback((next: AidenRemoteSettingsSnapshot) => {
    queryClient.setQueryData(queryKeys.aidenRemote, next);
  }, [queryClient]);

  const mutate = async (
    operation: string,
    action: () => Promise<AidenRemoteSettingsSnapshot>,
  ) => {
    if (busy) return;
    setBusy(operation);
    try {
      commit(await action());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Remote Access couldn't be updated.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
    } finally {
      setBusy(null);
    }
  };

  const beginPairing = async (transport: "lan" | "tailscale") => {
    if (busy) return;
    setBusy("pairing");
    try {
      setPairing(await aidenRemoteApi.beginPairing(transport));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden couldn't open pairing.");
    } finally {
      setBusy(null);
    }
  };

  const closePairing = (open: boolean) => {
    if (open) return;
    setPairing(null);
    void aidenRemoteApi.closePairing().catch(() => undefined);
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
  const activeDevices = snapshot.devices.filter((device) => device.revokedAt === undefined);

  return (
    <>
      <Callout className="mb-7" role="note">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" />
          <div>
            <Text variant="strong">Aiden stays in control</Text>
            <Text as="p" variant="small" color="secondary" className="mt-1">
              Aiden On The Go can use only the capabilities and folders approved on this Mac. Provider keys never leave Aiden. The desktop app must be running; Tailscale is optional.
            </Text>
          </div>
        </div>
      </Callout>

      <FieldSet title="Remote Access">
        <Field
          label="Enable Remote Access"
          description="Starts the private API while Aiden is running, even when its window is closed. Off by default."
        >
          <div className="flex items-center justify-end gap-2">
            {busy === "enabled" ? <Loader2 className="size-4 animate-spin text-secondary" /> : null}
            <Switch
              checked={status.enabled}
              onCheckedChange={(enabled) => void mutate("enabled", () => aidenRemoteApi.setEnabled(enabled))}
              disabled={busy !== null}
              aria-label="Enable Aiden Remote Access"
            />
          </div>
        </Field>
        <Field
          label="Connection"
          description="Local Network uses pinned HTTPS and Bonjour. Tailscale uses one explicit non-Funnel Serve route."
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
        <Field label="Status" description={`Private API port ${status.lanPort}.`} orientation="vertical">
          <Callout aria-live="polite" color={status.error ? "red" : undefined}>
            <div className="flex items-center gap-2">
              {status.running ? (
                <CheckCircle2 className="size-4 text-green" />
              ) : status.error ? (
                <TriangleAlert className="size-4 text-red" />
              ) : (
                <Network className="size-4 text-tertiary" />
              )}
              <Text variant="small-strong">
                {status.running ? "Ready" : status.enabled ? "Needs attention" : "Off"}
              </Text>
              {status.running ? <Badge color="green">Running</Badge> : null}
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
            {status.error ? <Text as="p" variant="small" color="secondary">{status.error}</Text> : null}
          </Callout>
        </Field>
      </FieldSet>

      {transportAllowsTailscale ? (
        <FieldSet title="Tailscale Serve">
          <Field
            label="Aiden-owned route"
            description="Aiden inspects the existing Serve configuration first, never enables Funnel, and never resets unrelated routes."
            orientation="vertical"
          >
            <Callout>
              <code className="block overflow-x-auto whitespace-pre-wrap break-all font-mono text-small text-secondary">
                {status.tailscaleRoutePreview ?? "Preparing the loopback route…"}
              </code>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Badge color={status.tailscaleConnected ? "green" : undefined}>
                  {status.tailscaleConnected ? "Connected" : status.tailscaleInstalled ? "Not connected" : "Tailscale not found"}
                </Badge>
                <Button
                  size="small"
                  variant={status.tailscaleConnected ? "filled" : "accent"}
                  disabled={!status.enabled || busy !== null || !status.tailscaleInstalled}
                  onClick={() => void mutate("tailscale", () => status.tailscaleConnected
                    ? aidenRemoteApi.disconnectTailscale()
                    : aidenRemoteApi.connectTailscale())}
                >
                  {busy === "tailscale" ? <Loader2 className="animate-spin" /> : <Network />}
                  {status.tailscaleConnected ? "Disconnect" : "Connect"}
                </Button>
              </div>
            </Callout>
          </Field>
        </FieldSet>
      ) : null}

      <FieldSet title="Pair a device">
        <Field
          label="Aiden On The Go"
          description="A pairing QR is high-entropy, expires after five minutes, and works once. A new device receives its own revocable credential."
        >
          <div className="flex flex-wrap justify-end gap-2 max-[540px]:justify-start">
            {transportAllowsLan ? (
              <Button size="small" disabled={!status.running || busy !== null} onClick={() => void beginPairing("lan")}>
                <Smartphone /> Pair over Local Network
              </Button>
            ) : null}
            {transportAllowsTailscale ? (
              <Button size="small" disabled={!status.tailscaleConnected || busy !== null} onClick={() => void beginPairing("tailscale")}>
                <Smartphone /> Pair over Tailscale
              </Button>
            ) : null}
          </div>
        </Field>
      </FieldSet>

      <FieldSet title="Approved folders">
        <Field
          label="Workspace browser roots"
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
      </FieldSet>

      <FieldSet title="Paired devices">
        {activeDevices.length === 0 ? (
          <div className="p-4 text-small text-secondary">No active devices are paired.</div>
        ) : activeDevices.map((device) => (
          <div key={device.id} className="relative flex items-center gap-3 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden">
            <Smartphone className="size-4 shrink-0 text-secondary" />
            <div className="min-w-0 flex-1">
              <Text variant="small-strong" truncate className="block">{device.name}</Text>
              <Text variant="small" color="secondary" className="block">
                {device.type === "ipad" ? "iPad" : "iPhone"} · Last seen {friendlyDate(device.lastSeenAt)}
              </Text>
            </div>
            <Button size="small" variant="transparent" onClick={() => setRevokeDevice(device)}>Revoke</Button>
          </div>
        ))}
      </FieldSet>

      <Dialog
        open={pairing !== null}
        onOpenChange={closePairing}
        title="Pair Aiden On The Go"
        description="Scan this code from the iPhone or iPad app. Do not share it."
        confirmHidden
      >
        {pairing ? (
          <div className="flex flex-col items-center gap-3 text-center">
            {pairingQr ? (
              <img src={pairingQr} alt="One-time Aiden pairing QR code" className="size-64 max-w-full rounded-card" />
            ) : (
              <div className="flex size-64 items-center justify-center rounded-card bg-well"><Loader2 className="animate-spin" /></div>
            )}
            <Badge color={pairingSeconds > 0 ? "blue" : "red"}>
              {pairingSeconds > 0 ? `Expires in ${Math.floor(pairingSeconds / 60)}:${String(pairingSeconds % 60).padStart(2, "0")}` : "Expired"}
            </Badge>
            <Text variant="small" color="secondary">
              Verification {pairingVerificationCode(pairing)} · This is a visual check, not a manual pairing password.
            </Text>
          </div>
        ) : null}
      </Dialog>

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
