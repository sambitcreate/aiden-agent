import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceHostStatus, DeviceServiceState, DeviceSummary } from "../shared/devices.js";
import { DeviceViewer, deviceStatusLabel } from "./device-viewer.js";
import { DevicesPanel, DevicesPanelView, type DevicesPanelViewProps } from "./devices-panel.js";

const IPHONE: DeviceSummary = {
  hostId: "local",
  id: "UDID-1",
  name: "iPhone 17 Pro",
  platform: "ios",
  version: "iOS 27.0",
  booted: true,
  kind: "iphone",
};
const IPAD: DeviceSummary = { ...IPHONE, id: "UDID-2", name: "iPad Air", booted: false, kind: "ipad" };

function state(hostStatus: DeviceHostStatus, extra: Partial<DeviceServiceState> = {}): DeviceServiceState {
  return {
    hostStatus,
    hostStatuses: { local: { status: hostStatus } },
    hosts: [{ id: "local", kind: "local", name: "This Mac", status: hostStatus }],
    consent: { streaming: hostStatus !== "needs-consent", agentAccess: false, peerSharing: false },
    devices: [],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
    ...extra,
  };
}

const noop = () => undefined;
function view(props: Partial<DevicesPanelViewProps>) {
  return renderToStaticMarkup(
    <DevicesPanelView
      state={null}
      chatId="chat-1"
      compact={false}
      pending={null}
      error={null}
      onSetup={noop}
      onStart={noop}
      onRefresh={noop}
      onRefreshPeers={noop}
      onOpen={noop}
      onAgentAccess={noop}
      onPeerSharing={noop}
      {...props}
    />,
  );
}

test("the stateful panel renders a checking state before any IPC answers", () => {
  const html = renderToStaticMarkup(<DevicesPanel workspaceId="w1" chatId="chat-1" active compact={false} />);
  assert.match(html, /Checking simulator setup/u);
  assert.match(html, /aria-labelledby="devices-empty-title"/u);
});

test("consent explains npm and the node-datachannel prebuilt download before setup", () => {
  const html = view({ state: state("needs-consent") });
  assert.match(html, /iOS Simulator/u);
  assert.match(html, /Xcode/u);
  assert.match(html, /from npm/u);
  assert.match(html, /node-datachannel download its prebuilt native binary/u);
  assert.match(html, /Set up simulator streaming/u);
  assert.match(html, /id="devices-empty-title"/u);
  assert.doesNotMatch(html, /border-(red|green|blue|accent)/u);
  assert.match(view({ state: state("disabled") }), /disabled=""[^>]*>Set up simulator streaming/u);
});

test("compact panels keep explanations for assistive technology", () => {
  const html = view({ state: state("needs-consent"), compact: true });
  assert.match(html, /class="sr-only"[^>]*>Watch and control Xcode simulators/u);
});

test("installing, starting, stopped, unavailable, and error each render their own state", () => {
  const installing = view({
    state: state("installing", { hostStatuses: { local: { status: "installing", detail: "expo-device-hub@0.12.0" } } }),
  });
  assert.match(installing, /Installing simulator helpers/u);
  assert.match(installing, /role="status"[^>]*>expo-device-hub@0\.12\.0/u);
  assert.match(view({ state: state("starting") }), /Starting simulator helpers/u);
  assert.match(view({ state: state("stopped") }), />Start<\/button>/u);
  const unavailable = view({ state: state("unavailable", { unavailableReason: "Install Xcode first." }) });
  assert.match(unavailable, /Simulators unavailable/u);
  assert.match(unavailable, /Install Xcode first\./u);
  assert.match(unavailable, /Try again/u);
  const failed = view({ state: state("error"), error: "The device hub exited." });
  assert.match(failed, /role="alert"[^>]*>The device hub exited\./u);
});

test("the ready list offers Open or Boot & open, and needs an active chat", () => {
  const html = view({ state: state("ready", { devices: [IPHONE, IPAD] }) });
  assert.match(html, /iPhone 17 Pro/u);
  assert.match(html, /iOS 27\.0 · Booted/u);
  assert.match(html, /aria-label="Open iPhone 17 Pro"/u);
  assert.match(html, /aria-label="Boot and open iPad Air"[^>]*>Boot &amp; open/u);
  assert.match(html, /aria-label="Refresh simulators"/u);

  const noChat = view({ state: state("ready", { devices: [IPHONE] }), chatId: undefined });
  assert.match(noChat, /Open a chat to attach a simulator/u);
  assert.match(noChat, /disabled=""[^>]*aria-label="Open iPhone 17 Pro"/u);
  assert.match(view({ state: state("ready") }), /No iOS simulators found/u);
});

test("agent access is an explicit, labelled switch that discloses the npm install", () => {
  const off = view({ state: state("ready", { devices: [IPHONE] }) });
  assert.match(off, /id="devices-agent-access-label"[^>]*>Let Aiden use simulators/u);
  assert.match(off, /role="switch" aria-checked="false"/u);
  assert.match(off, /aria-labelledby="devices-agent-access-label"/u);
  assert.match(off, /installs agent-device from npm/u);
  const on = view({
    state: state("ready", { devices: [IPHONE], consent: { streaming: true, agentAccess: true, peerSharing: false } }),
    pending: "agent",
  });
  assert.match(on, /role="switch" aria-checked="true"/u);
  assert.match(on, /disabled=""[^>]*aria-labelledby="devices-agent-access-label"|aria-labelledby="devices-agent-access-label"[^>]*disabled=""/u);
  assert.match(view({ state: state("ready"), compact: true }), /class="[^"]*\bsr-only"[^>]*>In chats, Aiden can open/u);
});

const PEER_PHONE: DeviceSummary = { ...IPHONE, hostId: "peer:studio", name: "iPhone 17" };

test("a lone Mac keeps the flat list while paired Macs group devices by host", () => {
  const flat = view({ state: state("ready", { devices: [IPHONE] }) });
  assert.doesNotMatch(flat, /devices-host-group/u);
  const grouped = view({
    state: state("ready", {
      devices: [IPHONE, PEER_PHONE],
      hosts: [
        { id: "local", kind: "local", name: "This Mac", status: "ready" },
        { id: "peer:studio", kind: "peer", name: "Studio", status: "ready" },
        { id: "peer:laptop", kind: "peer", name: "Laptop", status: "unavailable", detail: "Could not reach Laptop." },
      ],
    }),
  });
  assert.equal(grouped.match(/class="devices-host-group"/gu)?.length, 3);
  assert.ok(grouped.indexOf(">This Mac<") < grouped.indexOf(">Studio<"), "this Mac is listed first");
  assert.match(grouped, /aria-labelledby="devices-host-peer-studio"/u);
  assert.match(grouped, /Open iPhone 17/u);
  assert.match(grouped, /Could not reach Laptop\./u);
  assert.equal(grouped.match(/Try again/gu)?.length, 1, "only the unreachable Mac offers a retry");
  assert.doesNotMatch(grouped, /border-(red|green|blue|accent)/u);
});

test("sharing with paired Macs is a labelled switch shown only while this Mac is ready", () => {
  const html = view({ state: state("ready", { consent: { streaming: true, agentAccess: false, peerSharing: true } }) });
  assert.match(html, /id="devices-peer-sharing-label"[^>]*>Share with paired Macs/u);
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-labelledby="devices-peer-sharing-label"/u);
  assert.match(html, /Turning this off disconnects them/u);
  assert.doesNotMatch(view({ state: state("stopped") }), /Share with paired Macs/u);
});

test("a ready paired Mac keeps the list usable when this Mac's helpers are unavailable", () => {
  const hosts = [
    { id: "local", kind: "local" as const, name: "This Mac", status: "unavailable" as const, detail: "Xcode is not installed." },
    { id: "peer:studio", kind: "peer" as const, name: "Studio", status: "ready" as const },
  ];
  const html = view({ state: state("unavailable", { devices: [PEER_PHONE], hosts }) });
  assert.match(html, /Open iPhone 17/u);
  assert.match(html, /Xcode is not installed\./u);
  assert.doesNotMatch(html, /Share with paired Macs/u);
  // Without streaming consent nothing from a peer is shown.
  const off = view({
    state: state("unavailable", {
      devices: [PEER_PHONE],
      hosts,
      consent: { streaming: false, agentAccess: false, peerSharing: false },
    }),
  });
  assert.doesNotMatch(off, /Open iPhone 17/u);
});

test("the Environment panel brings the Simulator tab forward when an agent opens a device", () => {
  const source = readFileSync(new URL("./environment-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /devicesApi\.onReveal\(\(chatId\) => \{\s+if \(chatId === revealChatId\) showTools\("devices"\);/u);
});

test("an open session for this chat renders the viewer, other chats see the list", () => {
  const ready = state("ready", {
    devices: [IPHONE],
    sessions: [{ chatId: "chat-1", hostId: "local", deviceId: "UDID-1", openedBy: "user" }],
  });
  const viewer = () => <div>viewer-shell</div>;
  assert.match(view({ state: ready, viewer }), /viewer-shell/u);
  assert.doesNotMatch(view({ state: ready, viewer, chatId: "chat-2" }), /viewer-shell/u);
});

test("the viewer shell labels every control and exposes a focusable screen", () => {
  const html = renderToStaticMarkup(
    <DeviceViewer
      chatId="chat-1"
      session={{ chatId: "chat-1", hostId: "local", deviceId: "UDID-1", openedBy: "user" }}
      device={IPHONE}
      active={false}
      compact={false}
      onClose={noop}
    />,
  );
  for (const name of [
    "Home",
    "Lock",
    "Rotate",
    "Switch to dark appearance",
    "Text size",
    "Screenshot to chat",
    "Device tools",
    "Shut down simulator",
    "Close simulator",
  ]) {
    assert.match(html, new RegExp(`aria-label="${name}"`, "u"), name);
  }
  assert.match(html, /role="toolbar" aria-label="Simulator controls"/u);
  assert.match(html, /tabindex="0" role="application"/u);
  assert.match(html, /role="status" aria-live="polite"/u);
  assert.match(html, /aspect-ratio:0\.46/u);
});

test("an active viewer shows the flat screen until a frame proves the stream can be framed in 3D", () => {
  const html = renderToStaticMarkup(
    <DeviceViewer
      chatId="chat-1"
      session={{ chatId: "chat-1", hostId: "local", deviceId: "UDID-1", openedBy: "user" }}
      device={IPHONE}
      active
      compact={false}
      onClose={noop}
    />,
  );
  assert.match(html, /data-frame="flat"/u);
  assert.doesNotMatch(html, /device-viewer-3d/u);
});

test("viewer status labels", () => {
  assert.equal(deviceStatusLabel("idle", false), "Connecting…");
  assert.equal(deviceStatusLabel("streaming", true), "Live");
  assert.equal(deviceStatusLabel("streaming", false), "Live, input reconnecting…");
  assert.equal(deviceStatusLabel("error", false), "Disconnected");
});

test("Environment panel renders the Simulator tab and panel only with the devices capability", () => {
  const source = readFileSync(new URL("./environment-panel.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /availableEnvironmentPanelTabs\(panel\.subagentsEnabled, panel\.devicesEnabled\)/u,
  );
  assert.match(source, /tab === "devices"\s+\? Smartphone/u);
  assert.match(source, /tab === "devices"\s+\? "Simulator"/u);
  assert.match(source, /panel\.devicesEnabled \? \(\s*<div\s+id="environment-devices-panel"/u);
  assert.match(source, /hidden=\{panel\.tab !== "devices"\}/u);
  assert.match(source, /active=\{presented && panel\.tab === "devices"\}/u);
  assert.match(source, /chatId=\{panel\.activeChat\.chatId \?\? undefined\}/u);
});
