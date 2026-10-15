import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONNECTIONS_SEGMENTS,
  ConnectionsSegments,
  connectionsSegmentForKey,
} from "./connections-settings.js";
import {
  PeerAddDeviceSheetBody,
  peerAddDeviceTitle,
  type PeerAddDeviceActions,
  type PeerAddDeviceStep,
} from "./peer-add-device-sheet.js";
import { PeerHostRow } from "./peer-hosts-settings.js";
import type {
  PeerDiscoveryState,
  PeerHostStatus,
  PeerHostView,
  PeerSupervisorState,
} from "../../shared/peer-host.js";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const noop = () => undefined;
const actions: PeerAddDeviceActions = {
  connect: noop,
  openSetup: noop,
  openLink: noop,
  submitSetup: noop,
  submitLink: noop,
  refresh: noop,
  back: noop,
};

const DISCOVERED: PeerDiscoveryState = {
  scanning: false,
  devices: [
    { id: "install_open", name: "Studio Mac", platform: "mac", route: "tailscale", pairingRequests: true, paired: false },
    { id: "install_closed", name: "Lab Linux", platform: "linux", route: "lan", pairingRequests: false, paired: false },
    { id: "install_saved", name: "Office Mac", platform: "mac", route: "lan", pairingRequests: true, paired: true },
  ],
};

function body(step: PeerAddDeviceStep, discovery: PeerDiscoveryState = DISCOVERED, replaceHostId?: string) {
  return renderToStaticMarkup(
    <PeerAddDeviceSheetBody
      step={step}
      discovery={discovery}
      replaceHostId={replaceHostId}
      now={NOW}
      actions={actions}
    />,
  );
}

/** Accessible names of the enabled buttons in rendered markup. */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)]
    .filter(([, attributes]) => !/\bdisabled=""/u.test(attributes!))
    .map(([, attributes, content]) =>
      /aria-label="([^"]*)"/u.exec(attributes!)?.[1] ??
      content!.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim(),
    );
}

test("the device list offers Connect only to devices taking requests and nothing for paired ones", () => {
  const names = buttons(body({ kind: "choose" }));
  assert.ok(names.includes("Connect to Studio Mac"));
  assert.ok(!names.includes("Connect to Lab Linux"));
  assert.ok(names.includes("Enter setup code for Lab Linux"));
  assert.ok(!names.some((name) => name.endsWith("Office Mac")), "a paired device cannot be paired twice");
  // The manual paths stay available whatever was found.
  assert.ok(names.includes("Enter setup code"));
  assert.ok(names.includes("Paste pairing link"));
});

test("while searching with nothing found yet, the sheet says so and cannot restart the scan", () => {
  const html = body({ kind: "choose" }, { scanning: true, devices: [] });
  assert.match(html, /role="status"[^>]*>[\s\S]*?Searching/u);
  assert.ok(!buttons(html).includes("Search again"));
  assert.ok(buttons(body({ kind: "choose" }, { scanning: false, devices: [] })).includes("Search again"));
});

test("re-pairing lists the replaced host and lets it be connected again", () => {
  const names = buttons(body({ kind: "choose" }, DISCOVERED, "install_saved"));
  assert.ok(names.includes("Connect to Office Mac"));
  assert.ok(!names.includes("Connect to Studio Mac"));
});

test("while waiting for the other device, the match code is shown grouped with its countdown", () => {
  const html = body({
    kind: "waiting",
    attemptId: "attempt_0001",
    method: "request",
    name: "Studio Mac",
    progress: { matchCode: "042917", expiresAt: new Date(NOW + 90_000).toISOString() },
  });
  assert.match(html, /aria-label="Match code 0 4 2 9 1 7"/u);
  assert.match(html, />042 917</u);
  assert.match(html, /role="timer"[^>]*>Expires in (<!-- -->)?1:30</u);
  assert.match(html, /Studio Mac shows this code/u);
});

test("before the code exists, waiting is announced without a code", () => {
  const html = body({ kind: "waiting", attemptId: "attempt_0001", method: "request", name: "Studio Mac" });
  assert.doesNotMatch(html, /Match code/u);
  assert.match(html, /role="status"[\s\S]*Asking Studio Mac/u);
  assert.equal(peerAddDeviceTitle({ kind: "waiting", attemptId: "attempt_0001", method: "request" }), "Pairing…");
});

test("a setup code for a discovered device needs no address; a typed one does", () => {
  assert.doesNotMatch(body({ kind: "setup", device: { id: "install_closed", name: "Lab Linux" } }), /Desktop address/u);
  assert.match(body({ kind: "setup" }), /Desktop address/u);
  // Pair stays off until the fields are filled.
  assert.ok(!buttons(body({ kind: "setup" })).includes("Pair"));
});

test("a failed attempt is announced with a way back", () => {
  const html = body({
    kind: "failed",
    copy: { title: "Request declined", message: "The other device declined this request." },
    retry: { kind: "choose" },
  });
  assert.match(html, /role="alert"[\s\S]*Request declined[\s\S]*declined this request/u);
  assert.ok(buttons(html).includes("Back"));
});

function host(overrides: Partial<PeerHostView> = {}): PeerHostView {
  return {
    id: "install_studio",
    name: "Studio Mac",
    enabled: true,
    state: "disconnected",
    features: [],
    capabilities: [],
    ...overrides,
  };
}

function row(view: PeerHostView, state?: PeerSupervisorState): string {
  const status: PeerHostStatus | undefined = state
    ? { hostId: view.id, generation: 1, state, feed: "off", stale: false }
    : undefined;
  return renderToStaticMarkup(
    <PeerHostRow
      host={view}
      status={status}
      now={NOW}
      busy={false}
      onEnabledChange={noop}
      onReconnect={noop}
      onRename={noop}
      onRepair={noop}
      onForget={noop}
    />,
  );
}

test("a paired host row offers the action its state calls for", () => {
  const revoked = buttons(row(host(), { kind: "blocked", reason: "auth" }));
  assert.ok(revoked.includes("Re-pair"));
  assert.ok(!revoked.includes("Reconnect"));

  const retrying = buttons(row(host(), { kind: "backoff", attempt: 2, retryAt: NOW + 5_000 }));
  assert.ok(retrying.includes("Reconnect"));
  assert.ok(!retrying.includes("Re-pair"));

  const connected = buttons(row(host(), { kind: "connected", since: NOW }));
  assert.ok(!connected.includes("Reconnect") && !connected.includes("Re-pair"));
  // The switch and the menu are always there.
  assert.ok(connected.includes("Control Studio Mac"));
  assert.ok(connected.includes("More for Studio Mac"));
});

test("a turned-off host shows its switch off and offers no reconnect", () => {
  const html = row(host({ enabled: false, state: "disabled" }));
  assert.match(html, /role="switch"[^>]*aria-checked="false"[^>]*aria-label="Control Studio Mac"|aria-label="Control Studio Mac"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Control Studio Mac"/u);
  assert.ok(!buttons(html).includes("Reconnect"));
  assert.match(html, />Off</u);
});

test("the Connections segments expose one selected tab and keyboard order wraps", () => {
  const html = renderToStaticMarkup(
    <ConnectionsSegments selected="others" onSelect={noop} idPrefix="connections" />,
  );
  assert.equal([...html.matchAll(/role="tab"/gu)].length, CONNECTIONS_SEGMENTS.length);
  assert.match(html, /aria-selected="true"[^>]*>Control other devices</u);
  assert.match(html, /aria-selected="false"[^>]*tabindex="-1"[^>]*>Control this device</u);

  assert.equal(connectionsSegmentForKey("ArrowRight", 1), 0);
  assert.equal(connectionsSegmentForKey("ArrowLeft", 0), 1);
  assert.equal(connectionsSegmentForKey("End", 0), 1);
  assert.equal(connectionsSegmentForKey("Home", 1), 0);
  assert.equal(connectionsSegmentForKey("Enter", 0), null);
});

test("transport connection stays syncing until the host feed is live", () => {
  const view = host({ routes: [{ id: "route_lan", kind: "lan", origin: "paired", active: true }], activeRouteKind: "lan" });
  const status: PeerHostStatus = { hostId: view.id, generation: 1, state: { kind: "connected", since: NOW }, feed: "syncing", stale: true };
  const render = (status: PeerHostStatus) => renderToStaticMarkup(<PeerHostRow host={view} status={status} now={NOW} busy={false} onEnabledChange={noop} onReconnect={noop} onRename={noop} onRepair={noop} onForget={noop} />);
  assert.match(render(status), /Syncing chats/);
  assert.match(render(status), /Local network/);
  assert.doesNotMatch(render(status), />Ready</);
  assert.match(render({ ...status, feed: "live", stale: false }), />Ready</);
  assert.match(render({ ...status, feed: "unsupported" }), /Access unavailable/);
});

test("a failed initial paired-computer read offers retry instead of a false empty state", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { PeerHostsSettings } = await import("./peer-hosts-settings");
  const { hostQueryKeys } = await import("../../lib/hosts/host-query-keys");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.fetchQuery({ queryKey: hostQueryKeys.list(), queryFn: async () => { throw new Error("Storage locked"); } }).catch(() => {});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PeerHostsSettings hostLabel="computer" /></QueryClientProvider>);
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn&#x27;t load paired computers/);
  assert.ok(buttons(html).includes("Try again"));
  assert.doesNotMatch(html, /No computers yet/);
  client.clear();
});
