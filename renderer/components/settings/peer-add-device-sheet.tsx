import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Laptop, Link2, Loader2, Monitor, RotateCw, TriangleAlert } from "lucide-react";
import { Badge, Button, Callout, Dialog, Input, Text, Textarea } from "../ui";
import { peerHostsApi } from "../../lib/ipc";
import { hostQueryKeys } from "../../lib/hosts/host-query-keys";
import {
  mintPeerPairingAttemptId,
  peerDiscoveredRows,
  peerPairingOutcomeCopy,
  type PeerPairingOutcomeCopy,
} from "../../lib/peer-connections";
import { formatPairingMatchCode, pairingRequestSecondsLeft } from "../remote-pairing-request-sheet";
import type {
  PeerDiscoveryState,
  PeerHostView,
  PeerPairingProgress,
  PeerPairingResult,
} from "../../shared/peer-host";

interface PickedDevice {
  id: string;
  name: string;
}

/** Where the Add device sheet is. Endpoints and secrets never appear here. */
export type PeerAddDeviceStep =
  | { kind: "choose" }
  | { kind: "setup"; device?: PickedDevice }
  | { kind: "link" }
  | {
      kind: "waiting";
      attemptId: string;
      method: "request" | "code" | "link";
      name?: string;
      progress?: { matchCode: string; expiresAt: string };
    }
  | { kind: "paired"; host: PeerHostView }
  | { kind: "failed"; copy: PeerPairingOutcomeCopy; retry: Exclude<PeerAddDeviceStep, { kind: "waiting" | "paired" | "failed" }> };

export interface PeerAddDeviceActions {
  connect(device: PickedDevice): void;
  openSetup(device?: PickedDevice): void;
  openLink(): void;
  submitSetup(input: { code: string; address?: string }): void;
  submitLink(link: string): void;
  refresh(): void;
  back(): void;
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function DeviceIcon({ platform }: { platform?: "mac" | "linux" }) {
  const Icon = platform === "linux" ? Monitor : Laptop;
  return <Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />;
}

function DiscoveredList({
  discovery,
  replaceHostId,
  actions,
}: {
  discovery: PeerDiscoveryState;
  replaceHostId?: string;
  actions: PeerAddDeviceActions;
}) {
  const rows = peerDiscoveredRows(discovery.devices, replaceHostId);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Text variant="small-strong" color="secondary">
          {replaceHostId ? "Find it again" : "Computers running Aiden"}
        </Text>
        <span className="flex items-center gap-1.5">
          {discovery.scanning ? (
            <Text variant="small" color="secondary" role="status" className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Searching…
            </Text>
          ) : null}
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label="Search again"
            disabled={discovery.scanning}
            onClick={actions.refresh}
          >
            <RotateCw />
          </Button>
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-card bg-well px-4 py-5 text-center">
          <Text variant="small-strong" className="block">
            {discovery.scanning ? "Looking on your network and tailnet" : "No computers found"}
          </Text>
          <Text variant="small" color="secondary" className="mt-1 block">
            Open Aiden on the other computer. It must be on the same network or the same Tailscale
            tailnet. You can also pair with a setup code.
          </Text>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-card bg-well" aria-label="Discovered computers">
          {rows.map(({ device, connect, setupCode, note }) => (
            <li
              key={device.id}
              className="relative flex items-center gap-3 px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden max-[540px]:flex-wrap"
            >
              <DeviceIcon platform={device.platform} />
              <span className="min-w-0 flex-1">
                <Text variant="small-strong" truncate className="block">{device.name}</Text>
                <Text variant="small" color="secondary" className="block">{note}</Text>
              </span>
              {!connect && !setupCode ? <Badge>Paired</Badge> : null}
              {setupCode ? (
                <Button
                  size="small"
                  variant={connect ? "transparent" : "filled"}
                  aria-label={`Enter setup code for ${device.name}`}
                  onClick={() => actions.openSetup({ id: device.id, name: device.name })}
                >
                  Setup code
                </Button>
              ) : null}
              {connect ? (
                <Button
                  size="small"
                  variant="accent"
                  aria-label={`Connect to ${device.name}`}
                  onClick={() => actions.connect({ id: device.id, name: device.name })}
                >
                  Connect
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="small" variant="filled" onClick={() => actions.openSetup()}>
          <KeyRound /> Enter setup code
        </Button>
        <Button size="small" variant="transparent" onClick={actions.openLink}>
          <Link2 /> Paste pairing link
        </Button>
      </div>
    </div>
  );
}

function SetupCodeForm({
  device,
  actions,
}: {
  device?: PickedDevice;
  actions: PeerAddDeviceActions;
}) {
  const [address, setAddress] = React.useState("");
  const [code, setCode] = React.useState("");
  const addressId = React.useId();
  const codeId = React.useId();
  const ready = code.trim().length > 0 && (device !== undefined || address.trim().length > 0);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        actions.submitSetup({ code: code.trim(), ...(device ? {} : { address: address.trim() }) });
      }}
    >
      <Text as="p" variant="small" color="secondary">
        On {device ? device.name : "the other computer"}, open Settings → Connections → Control this
        device and choose Connect a device. Enter the {device ? "setup code" : "address and setup code"} it
        shows.
      </Text>
      {device ? null : (
        <label htmlFor={addressId} className="flex flex-col gap-1.5">
          <Text variant="small-strong">Desktop address</Text>
          <Input
            id={addressId}
            value={address}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="studio-mac.example.ts.net"
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
      )}
      <label htmlFor={codeId} className="flex flex-col gap-1.5">
        <Text variant="small-strong">Setup code</Text>
        <Input
          id={codeId}
          value={code}
          autoFocus={device !== undefined}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button type="button" variant="filled" onClick={actions.back}>Back</Button>
        <Button type="submit" variant="accent" disabled={!ready}>Pair</Button>
      </div>
    </form>
  );
}

function PairingLinkForm({ actions }: { actions: PeerAddDeviceActions }) {
  const [link, setLink] = React.useState("");
  const linkId = React.useId();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (link.trim()) actions.submitLink(link.trim());
      }}
    >
      <label htmlFor={linkId} className="flex flex-col gap-1.5">
        <Text variant="small-strong">Pairing link</Text>
        <Textarea
          id={linkId}
          value={link}
          autoFocus
          rows={4}
          spellCheck={false}
          className="font-mono text-small"
          onChange={(event) => setLink(event.target.value)}
        />
      </label>
      <Text as="p" variant="small" color="secondary">
        A one-time link copied from the other computer. It expires after a few minutes.
      </Text>
      <div className="flex gap-2">
        <Button type="button" variant="filled" onClick={actions.back}>Back</Button>
        <Button type="submit" variant="accent" disabled={!link.trim()}>Pair</Button>
      </div>
    </form>
  );
}

function Waiting({
  step,
  now,
}: {
  step: Extract<PeerAddDeviceStep, { kind: "waiting" }>;
  now: number;
}) {
  const name = step.name ?? "the other computer";
  if (step.progress) {
    const { matchCode, expiresAt } = step.progress;
    return (
      <div className="flex flex-col gap-3">
        <div
          className="flex flex-col items-center gap-1 rounded-control bg-well px-4 py-4 text-center"
          data-pairing-match-code={matchCode}
        >
          <Text variant="small" color="secondary" className="block">Match code</Text>
          <span
            role="img"
            aria-label={`Match code ${matchCode.split("").join(" ")}`}
            className="select-none font-mono text-heading1 font-semibold tracking-[0.18em] tabular-nums text-primary"
          >
            {formatPairingMatchCode(matchCode)}
          </span>
        </div>
        <Text as="p" variant="small" color="secondary" role="status">
          Check that {name} shows this code, then choose Allow there. Don’t allow a request whose code
          doesn’t match.
        </Text>
        <Text variant="small" color="secondary" role="timer" aria-live="off" className="tabular-nums">
          Expires in {formatCountdown(pairingRequestSecondsLeft(expiresAt, now))}
        </Text>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-card bg-well px-4 py-4" role="status">
      <Loader2 className="size-4 shrink-0 animate-spin text-secondary" aria-hidden="true" />
      <Text variant="small">
        {step.method === "request" ? `Asking ${name}…` : `Pairing with ${name}…`}
      </Text>
    </div>
  );
}

/** The sheet's content for one step; the container owns IPC and focus. */
export function PeerAddDeviceSheetBody({
  step,
  discovery,
  replaceHostId,
  now,
  actions,
}: {
  step: PeerAddDeviceStep;
  discovery: PeerDiscoveryState;
  replaceHostId?: string;
  now: number;
  actions: PeerAddDeviceActions;
}) {
  switch (step.kind) {
    case "choose":
      return <DiscoveredList discovery={discovery} replaceHostId={replaceHostId} actions={actions} />;
    case "setup":
      return <SetupCodeForm device={step.device} actions={actions} />;
    case "link":
      return <PairingLinkForm actions={actions} />;
    case "waiting":
      return <Waiting step={step} now={now} />;
    case "paired":
      return (
        <div className="flex items-start gap-3 rounded-card bg-status-green-surface px-4 py-4" role="status">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-green" aria-hidden="true" />
          <span className="min-w-0">
            <Text variant="small-strong" className="block break-words">
              {replaceHostId ? `${step.host.name} is paired again` : `${step.host.name} is paired`}
            </Text>
            <Text variant="small" color="secondary" className="block">
              Its chats and workspaces appear in the sidebar while it’s connected.
            </Text>
          </span>
        </div>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-3">
          <Callout role="alert">
            <span className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden="true" />
              <span className="min-w-0">
                <Text variant="small-strong" className="block">{step.copy.title}</Text>
                <Text variant="small" color="secondary" className="block break-words">{step.copy.message}</Text>
              </span>
            </span>
          </Callout>
          <div className="flex gap-2">
            <Button variant="filled" onClick={actions.back}>Back</Button>
          </div>
        </div>
      );
  }
}

/** Title for the sheet in each step. */
export function peerAddDeviceTitle(step: PeerAddDeviceStep, replaceName?: string): string {
  if (step.kind === "setup") return "Enter setup code";
  if (step.kind === "link") return "Paste pairing link";
  if (step.kind === "waiting") return step.progress ? "Compare codes" : "Pairing…";
  if (step.kind === "paired") return "Paired";
  return replaceName ? `Re-pair ${replaceName}` : "Add device";
}

const IDLE_DISCOVERY: PeerDiscoveryState = { scanning: true, devices: [] };

/**
 * Pair another computer running Aiden. Searching runs only while the sheet
 * is open. With `replaceHost`, a successful pairing replaces that host's
 * saved trust and keeps its local name.
 */
export function PeerAddDeviceSheet({
  open,
  onOpenChange,
  replaceHost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replaceHost?: { id: string; name: string };
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = React.useState<PeerAddDeviceStep>({ kind: "choose" });
  const [discovery, setDiscovery] = React.useState<PeerDiscoveryState>(IDLE_DISCOVERY);
  const [now, setNow] = React.useState(() => Date.now());
  const attemptRef = React.useRef<string | null>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const replaceHostId = replaceHost?.id;

  // Search only while the sheet is open.
  React.useEffect(() => {
    if (!open) return;
    setStep({ kind: "choose" });
    setDiscovery(IDLE_DISCOVERY);
    let live = true;
    const off = peerHostsApi.onDiscovery((state) => {
      if (live) setDiscovery(state);
    });
    void peerHostsApi.discoveryStart().then(
      (state) => live && setDiscovery(state),
      () => live && setDiscovery({ scanning: false, devices: [] }),
    );
    return () => {
      live = false;
      off();
      void peerHostsApi.discoveryStop().catch(() => undefined);
      const attempt = attemptRef.current;
      attemptRef.current = null;
      if (attempt) void peerHostsApi.pairCancel(attempt).catch(() => undefined);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    return peerHostsApi.onPairingProgress((progress: PeerPairingProgress) => {
      setStep((current) =>
        current.kind === "waiting" && current.attemptId === progress.attemptId
          ? { ...current, progress: { matchCode: progress.matchCode, expiresAt: progress.expiresAt } }
          : current,
      );
    });
  }, [open]);

  const counting = step.kind === "waiting" && step.progress !== undefined;
  React.useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [counting]);

  // Move focus into the new step so it never falls back to the page.
  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = contentRef.current;
      if (!root || root.contains(document.activeElement)) return;
      const target =
        root.querySelector<HTMLElement>("[autofocus], input, textarea") ??
        root.querySelector<HTMLElement>("button:not([disabled])");
      (target ?? root).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, step.kind]);

  const run = (
    method: "request" | "code" | "link",
    name: string | undefined,
    retry: Extract<PeerAddDeviceStep, { kind: "failed" }>["retry"],
    start: (attemptId: string) => Promise<PeerPairingResult>,
  ) => {
    const attemptId = mintPeerPairingAttemptId();
    attemptRef.current = attemptId;
    setStep({ kind: "waiting", attemptId, method, ...(name ? { name } : {}) });
    void start(attemptId)
      .catch((): PeerPairingResult => ({
        ok: false,
        outcome: { status: "failed", message: "The other device could not complete pairing." },
      }))
      .then((result) => {
        if (attemptRef.current !== attemptId) return;
        attemptRef.current = null;
        void queryClient.invalidateQueries({ queryKey: hostQueryKeys.list() });
        void queryClient.invalidateQueries({ queryKey: hostQueryKeys.statuses() });
        if (result.ok) {
          setStep({ kind: "paired", host: result.host });
          return;
        }
        const copy = peerPairingOutcomeCopy(result.outcome);
        setStep(copy ? { kind: "failed", copy, retry } : retry);
      });
  };

  const actions: PeerAddDeviceActions = {
    connect: (device) =>
      run("request", device.name, { kind: "choose" }, (attemptId) =>
        peerHostsApi.pairRequest(attemptId, device.id, replaceHostId),
      ),
    openSetup: (device) => setStep(device ? { kind: "setup", device } : { kind: "setup" }),
    openLink: () => setStep({ kind: "link" }),
    submitSetup: ({ code, address }) => {
      const device = step.kind === "setup" ? step.device : undefined;
      run("code", device?.name ?? replaceHost?.name, device ? { kind: "setup", device } : { kind: "setup" }, (attemptId) =>
        peerHostsApi.pairSetupCode(
          attemptId,
          device ? { deviceId: device.id, code } : { address: address ?? "", code },
          replaceHostId,
        ),
      );
    },
    submitLink: (link) =>
      run("link", replaceHost?.name, { kind: "link" }, (attemptId) =>
        peerHostsApi.pairLink(attemptId, link, replaceHostId),
      ),
    refresh: () => {
      void peerHostsApi.discoveryRefresh().then(setDiscovery, () => undefined);
    },
    back: () => setStep(step.kind === "failed" ? step.retry : { kind: "choose" }),
  };

  const waiting = step.kind === "waiting";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={peerAddDeviceTitle(step, replaceHost?.name)}
      description={
        step.kind === "choose"
          ? replaceHost
            ? `Pair with ${replaceHost.name} again to restore access. Its name on this device stays the same.`
            : "Control another computer running Aiden from this one. It approves the request, or shows you a setup code."
          : undefined
      }
      confirmHidden
      cancelLabel={waiting ? "Cancel" : step.kind === "paired" ? "Done" : "Close"}
    >
      <div ref={contentRef} tabIndex={-1} className="outline-none">
        <PeerAddDeviceSheetBody
          step={step}
          discovery={discovery}
          replaceHostId={replaceHostId}
          now={now}
          actions={actions}
        />
      </div>
    </Dialog>
  );
}
