import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceHostInfo, DeviceServiceState } from "../shared/devices.js";
import {
  DeviceHostDiagnosticsView,
  DeviceHostUpdates,
  toolVersionSummary,
} from "./device-host-diagnostics.js";
import { DevicesPanelView, type DevicesPanelViewProps } from "./devices-panel.js";

const noop = () => undefined;

test("version lines say what runs, what is installed, and what is required", () => {
  assert.equal(toolVersionSummary(undefined), "Not checked yet");
  assert.equal(toolVersionSummary({ requiredVersion: "0.12.0", installedVersions: ["0.12.0"], runningVersion: "0.12.0" }), "0.12.0, running");
  assert.equal(toolVersionSummary({ requiredVersion: "0.12.0", installedVersions: ["0.12.0"], runningVersion: null }), "0.12.0, installed");
  assert.equal(
    toolVersionSummary({ requiredVersion: "0.12.0", installedVersions: ["0.11.0"], runningVersion: null }),
    "0.11.0 installed, 0.12.0 required",
  );
  assert.equal(
    toolVersionSummary({ requiredVersion: "0.12.0", installedVersions: ["0.11.0", "0.12.0"], runningVersion: "0.11.0" }),
    "0.11.0 running, 0.12.0 required",
  );
  assert.equal(toolVersionSummary({ requiredVersion: "0.12.0", installedVersions: [], runningVersion: null }), "Not installed");
});

test("updates in progress are announced, a failure offers Retry, and quiet hosts render nothing", () => {
  const hosts: DeviceHostInfo[] = [
    { id: "local", kind: "local", name: "This Mac", status: "installing", detail: "Updating the device hub from 0.11.0 to 0.12.0…" },
    { id: "ssh-mini01", kind: "ssh", name: "Mac mini", status: "error", detail: "Could not connect to Mac mini over SSH." },
    { id: "ssh-studio", kind: "ssh", name: "Studio", status: "ready" },
  ];
  const html = renderToStaticMarkup(<DeviceHostUpdates hosts={hosts} pending={null} onRetry={noop} />);
  assert.match(html, /role="status"[^>]*>.*This Mac.*Updating the device hub/su);
  assert.match(html, /role="alert"[^>]*>.*Mac mini.*Could not connect/su);
  assert.match(html, /aria-label="Retry Mac mini"/u);
  assert.doesNotMatch(html, /Studio/u);
  assert.doesNotMatch(html, /Retry This Mac/u, "progress has no Retry");
  const busy = renderToStaticMarkup(<DeviceHostUpdates hosts={hosts} pending="ssh-mini01" onRetry={noop} />);
  assert.match(busy, /<button[^>]*disabled=""[^>]*aria-label="Retry Mac mini"|<button[^>]*aria-label="Retry Mac mini"[^>]*disabled=""/u);
  assert.equal(renderToStaticMarkup(<DeviceHostUpdates hosts={[hosts[2]!]} pending={null} onRetry={noop} />), "");
});

test("host diagnostics list versions per host and leave paired Macs' helpers to their owner", () => {
  const html = renderToStaticMarkup(
    <DeviceHostDiagnosticsView
      pending={null}
      onRetry={noop}
      hosts={[
        {
          id: "local",
          kind: "local",
          name: "This Mac",
          status: "unavailable",
          detail: "Xcode was not found.",
          tools: {
            hub: { requiredVersion: "0.12.0", installedVersions: ["0.12.0"], runningVersion: null },
            agent: { requiredVersion: "0.21.12", installedVersions: [], runningVersion: null },
          },
        },
        { id: "peer-1", kind: "peer", name: "Studio Mac", status: "ready" },
        { id: "ssh-mini01", kind: "ssh", name: "Mac mini", status: "stopped", toolInspectionError: "Could not check versions." },
      ]}
    />,
  );
  assert.match(html, /Host diagnostics/u);
  assert.match(html, /Xcode was not found\./u);
  assert.match(html, /Device hub.*0\.12\.0, installed/su);
  assert.equal(html.match(/Device hub/gu)?.length, 2, "This Mac and the SSH host, not the paired Mac");
  assert.match(html, /Could not check versions\./u);
});

function panel(state: DeviceServiceState, extra: Partial<DevicesPanelViewProps> = {}) {
  return renderToStaticMarkup(
    <DevicesPanelView
      state={state}
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
      onStartHost={noop}
      {...extra}
    />,
  );
}

test("the Simulator tab groups SSH hosts after this Mac and offers Connect even when this Mac is unavailable", () => {
  const html = panel({
    hostStatus: "unavailable",
    hostStatuses: { local: { status: "unavailable" } },
    hosts: [
      { id: "local", kind: "local", name: "This Mac", status: "unavailable", detail: "Xcode was not found." },
      { id: "ssh-mini01", kind: "ssh", name: "Mac mini", status: "stopped", detail: "Not connected. Aiden connects only when you ask." },
    ],
    consent: { streaming: true, agentAccess: false, peerSharing: false },
    devices: [],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
  });
  const local = html.indexOf(">This Mac<");
  const remote = html.indexOf(">Mac mini<");
  assert.ok(local >= 0 && remote > local, "This Mac comes first");
  assert.match(html, /aria-label="Connect Mac mini"/u);
  assert.match(html, /aria-label="Try again This Mac"/u);
  assert.match(html, /Not connected\. Aiden connects only when you ask\./u);
});
