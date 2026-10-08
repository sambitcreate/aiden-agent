import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceHostInfo, DeviceServiceState } from "../../shared/devices.js";
import type { DeviceToolVersions, SshDeviceHostConfig } from "../../shared/device-ssh-hosts.js";
import {
  SimulatorSshHostsView,
  SshHostEditorForm,
  sshInstallDescription,
  type SimulatorSshHostsViewProps,
} from "./simulator-ssh-hosts.js";
import { SimulatorSettingsView, type SimulatorSettingsViewProps } from "./simulator-settings.js";

const MINI: SshDeviceHostConfig = { id: "ssh-mini01", label: "Mac mini", target: "me@mini.local", port: 2222 };
const TOOLS: DeviceToolVersions = {
  hub: { requiredVersion: "0.12.0", installedVersions: ["0.12.0"], runningVersion: "0.12.0" },
  agent: { requiredVersion: "0.21.12", installedVersions: [], runningVersion: null },
};

function state(sshHost: Partial<DeviceHostInfo>, extra: Partial<DeviceServiceState> = {}): DeviceServiceState {
  return {
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    hosts: [
      { id: "local", kind: "local", name: "This Mac", status: "ready" },
      { id: MINI.id, kind: "ssh", name: MINI.label, status: "stopped", ...sshHost },
    ],
    consent: { streaming: true, agentAccess: false, peerSharing: false },
    devices: [],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
    sshHosts: [MINI],
    ...extra,
  };
}

const noop = () => undefined;
function view(props: Partial<SimulatorSshHostsViewProps>) {
  return renderToStaticMarkup(
    <SimulatorSshHostsView
      state={state({})}
      pending={null}
      checks={{}}
      error={null}
      onAdd={noop}
      onEdit={noop}
      onConnect={noop}
      onTest={noop}
      onInstall={noop}
      onRemove={noop}
      {...props}
    />,
  );
}

const button = (html: string, label: string) =>
  new RegExp(`<button[^>]*>(?:<svg[^>]*>.*?</svg>)?${label}</button>`, "u").exec(html)?.[0] ?? null;

test("each host shows its destination, status, versions, and the one action that fits", () => {
  const idle = view({});
  assert.match(idle, /SSH hosts/u);
  assert.match(idle, /me@mini\.local, port 2222/u);
  assert.match(idle, /Not connected/u);
  assert.ok(button(idle, "Connect"), "a disconnected host offers Connect");
  assert.match(idle, /More for Mac mini/u);

  const needsInstall = view({ state: state({ status: "needs-consent", detail: "Install the simulator helpers on Mac mini." }) });
  assert.match(needsInstall, /Needs install/u);
  assert.ok(button(needsInstall, "Install…"));

  const failed = view({ state: state({ status: "error", detail: "SSH to Mac mini was refused." }) });
  assert.match(failed, /SSH to Mac mini was refused\./u);
  assert.ok(button(failed, "Retry"));

  const ready = view({ state: state({ status: "ready", tools: TOOLS }, { consent: { streaming: true, agentAccess: true, peerSharing: false } }) });
  assert.match(ready, /Device hub: <span class="font-mono">0\.12\.0, running<\/span>/u);
  assert.match(ready, /Agent tools: <span class="font-mono">Not installed<\/span>/u);
  assert.ok(button(ready, "Install agent tools…"), "agent access on and agent tools missing offers their install");
});

test("without simulator streaming, hosts can be tested and edited but not connected", () => {
  const html = view({ state: state({}, { consent: { streaming: false, agentAccess: false, peerSharing: false } }) });
  assert.match(button(html, "Connect") ?? "", / disabled=""/u);
  assert.match(html, /Turn on simulator streaming to connect\./u);
  assert.match(html, /<button(?![^>]*disabled="")[^>]*>(?:(?!<\/button>).)*Add SSH host<\/button>/u, "hosts can still be added");
});

test("connection checks and version-check failures are announced on the host row", () => {
  const html = view({
    state: state({ toolInspectionError: "Could not check versions: Connection refused. Installed tools were not changed." }),
    checks: { [MINI.id]: { status: "failed", error: "Node.js 22 or newer is required on the host; found 20.1.0." } },
  });
  assert.match(html, /role="alert"[^>]*>Node\.js 22 or newer is required/u);
  assert.match(html, /Installed tools were not changed/u);
  const connected = view({
    checks: { [MINI.id]: { status: "connected", nodeVersion: "22.12.0", platforms: [{ platform: "ios", available: true }] } },
  });
  assert.match(connected, /Connected\. Node 22\.12\.0\. iOS Simulators available\./u);
});

test("the editor shows each problem beside its field and only tests a valid draft", () => {
  const draft = { id: "ssh-new001", label: "", target: "-oProxyCommand=x", identityFile: "id_rsa", port: "" };
  const html = renderToStaticMarkup(
    <SshHostEditorForm draft={draft} attempted={false} check={null} saving={false} error={null} onChange={noop} onTest={noop} />,
  );
  assert.match(html, /aria-invalid="true"[^>]*value="-oProxyCommand=x"|value="-oProxyCommand=x"[^>]*aria-invalid="true"/u);
  assert.match(html, /not starting with a dash/u);
  assert.match(html, /absolute path/u);
  assert.match(button(html, "Test connection") ?? "", / disabled=""/u);
  assert.doesNotMatch(html, /Enter an SSH alias/u, "untouched empty fields stay quiet until a save attempt");

  const attempted = renderToStaticMarkup(
    <SshHostEditorForm
      draft={{ ...draft, target: "", identityFile: "" }}
      attempted
      check={null}
      saving={false}
      error={null}
      onChange={noop}
      onTest={noop}
    />,
  );
  assert.match(attempted, /Enter an SSH alias or user@host\./u);

  const valid = renderToStaticMarkup(
    <SshHostEditorForm
      draft={{ ...draft, target: "me@mini.local", identityFile: "~/.ssh/id_ed25519" }}
      attempted={false}
      check={{ status: "local" }}
      saving={false}
      error="Another SSH host already uses this destination."
      onChange={noop}
      onTest={noop}
    />,
  );
  assert.doesNotMatch(button(valid, "Test connection") ?? "", / disabled=""/u);
  assert.match(valid, /is this Mac/u);
  assert.match(valid, /role="alert"[^>]*>Another SSH host already uses this destination\./u);
});

test("install confirmation names what runs on the host and what it needs", () => {
  assert.match(sshInstallDescription(MINI, "hub", true), /expo-device-hub and agent-device .*Node\.js 22 or newer and npm/u);
  assert.match(sshInstallDescription(MINI, "hub", false), /pinned expo-device-hub into ~\/\.aiden\/devices/u);
  assert.match(sshInstallDescription(MINI, "agent", true), /pinned agent-device into/u);
  assert.match(sshInstallDescription(MINI, "hub", false), /never in the background/u);
});

const settingsNoop = () => undefined;
function settings(props: Partial<SimulatorSettingsViewProps>) {
  return renderToStaticMarkup(
    <SimulatorSettingsView
      state={state({})}
      toolchain={{
        tools: [
          { id: "hub", name: "expo-device-hub", pinned: "0.12.0", installed: ["0.11.0"] },
          { id: "agent", name: "agent-device", pinned: "0.21.12", installed: ["0.21.12"] },
        ],
      }}
      pending={null}
      error={null}
      confirming={null}
      onConsent={settingsNoop}
      onConfirm={settingsNoop}
      onCancelConfirm={settingsNoop}
      onPrune={settingsNoop}
      onRemove={settingsNoop}
      onInspect={settingsNoop}
      onUpdate={settingsNoop}
      onRetry={settingsNoop}
      {...props}
    />,
  );
}

test("Settings shows an outdated helper's update with an Update button only under its permission", () => {
  const local: DeviceHostInfo = {
    id: "local",
    kind: "local",
    name: "This Mac",
    status: "stopped",
    tools: {
      hub: { requiredVersion: "0.12.0", installedVersions: ["0.11.0"], runningVersion: null },
      agent: { requiredVersion: "0.21.12", installedVersions: ["0.21.12"], runningVersion: "0.21.12" },
    },
  };
  const html = settings({ state: { ...state({}), hostStatus: "stopped", hosts: [local] } });
  assert.match(html, /Update available/u);
  assert.match(html, /0\.12\.0 replaces 0\.11\.0 the next time the helpers start, or update now\./u);
  assert.match(html, /aria-label="Update expo-device-hub to 0\.12\.0"/u);
  assert.match(html, /Running 0\.21\.12\./u);
  assert.ok(button(html, "Check versions"), "the read-only version check is offered");

  const withoutPermission = settings({
    state: { ...state({}), hostStatus: "stopped", hosts: [local], consent: { streaming: false, agentAccess: false, peerSharing: false } },
  });
  assert.doesNotMatch(withoutPermission, /aria-label="Update expo-device-hub/u);
});

test("Settings shows update progress and a per-host Retry after a failure", () => {
  const html = settings({
    state: {
      ...state({ status: "error", detail: "Could not connect to Mac mini over SSH." }),
      hosts: [
        { id: "local", kind: "local", name: "This Mac", status: "installing", detail: "Updating the device hub from 0.11.0 to 0.12.0…" },
        { id: MINI.id, kind: "ssh", name: "Mac mini", status: "error", detail: "Could not connect to Mac mini over SSH." },
      ],
    },
  });
  assert.match(html, /role="status"[^>]*>.*Updating the device hub from 0\.11\.0 to 0\.12\.0…/su);
  assert.match(html, /role="alert"[^>]*>.*Could not connect to Mac mini over SSH\./su);
  assert.match(html, /aria-label="Retry Mac mini"/u);
});
