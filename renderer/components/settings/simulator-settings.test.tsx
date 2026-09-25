import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceServiceState, DeviceToolchainState } from "../../shared/devices.js";
import { SETTINGS_DESTINATIONS, SETTINGS_SECTIONS } from "../../shared/settings-section.js";
import {
  SimulatorSettings,
  SimulatorSettingsView,
  type SimulatorSettingsViewProps,
} from "./simulator-settings.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function state(extra: Partial<DeviceServiceState> = {}): DeviceServiceState {
  return {
    hostStatus: "needs-consent",
    hostStatuses: { local: { status: "needs-consent" } },
    hosts: [{ id: "local", kind: "local", name: "This Mac", status: "needs-consent" }],
    consent: { streaming: false, agentAccess: false, peerSharing: false },
    devices: [],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
    ...extra,
  };
}

const EMPTY_TOOLS: DeviceToolchainState = {
  tools: [
    { id: "hub", name: "expo-device-hub", pinned: "0.12.0", installed: [] },
    { id: "agent", name: "agent-device", pinned: "0.21.12", installed: [] },
  ],
};

const noop = () => undefined;
function view(props: Partial<SimulatorSettingsViewProps>) {
  return renderToStaticMarkup(
    <SimulatorSettingsView
      state={state()}
      toolchain={EMPTY_TOOLS}
      pending={null}
      error={null}
      confirming={null}
      onConsent={noop}
      onConfirm={noop}
      onCancelConfirm={noop}
      onPrune={noop}
      onRemove={noop}
      {...props}
    />,
  );
}

function switchFor(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${label}"[^>]*>`, "u").exec(html)
    ?? new RegExp(`<button[^>]*aria-label="${label}"[^>]*role="switch"[^>]*>`, "u").exec(html);
  assert.ok(match, `switch ${label}`);
  return match[0];
}

test("Simulator is an Agent settings destination hidden without the devices capability", () => {
  assert.ok((SETTINGS_SECTIONS as readonly string[]).includes("simulator"));
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "simulator");
  assert.equal(destination?.group, "Agent");
  assert.ok(destination?.keywords.includes("ios"));
  const settingsView = read("../../main/settings-view.tsx");
  assert.match(settingsView, /capabilities\.devices \? NAV : NAV\.filter\(\(item\) => item\.id !== "simulator"\)/u);
  assert.match(settingsView, /simulator: SimulatorSettings/u);
});

test("a build without the devices capability reads nothing and says so", () => {
  const html = renderToStaticMarkup(<SimulatorSettings />);
  assert.match(html, /not available in this build/u);
  assert.doesNotMatch(html, /role="switch"/u);
});

test("before setup only streaming can be turned on, and nothing can be pruned or removed", () => {
  const html = view({});
  assert.doesNotMatch(switchFor(html, "Simulator streaming"), / disabled=""/u);
  assert.match(switchFor(html, "Agent access"), / disabled=""/u);
  assert.match(switchFor(html, "Share with paired Macs"), / disabled=""/u);
  assert.match(html, /Requires simulator streaming/u);
  assert.match(html, /Pinned 0\.12\.0/u);
  assert.match(html, /Pinned 0\.21\.12/u);
  assert.match(html, /Not installed/u);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Prune<\/button>/u);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Remove…<\/button>/u);
});

test("installed helpers show their versions, and stale ones can be pruned", () => {
  const html = view({
    state: state({ hostStatus: "stopped", consent: { streaming: true, agentAccess: false, peerSharing: false } }),
    toolchain: {
      tools: [
        { id: "hub", name: "expo-device-hub", pinned: "0.12.0", installed: ["0.11.0", "0.12.0"] },
        { id: "agent", name: "agent-device", pinned: "0.21.12", installed: [] },
      ],
    },
  });
  assert.match(switchFor(html, "Simulator streaming"), /aria-checked="true"/u);
  assert.doesNotMatch(switchFor(html, "Agent access"), / disabled=""/u);
  assert.match(html, /Older versions on disk: 0\.11\.0/u);
  assert.match(html, /Installed/u);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Prune<\/button>/u);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Remove…<\/button>/u);
  assert.match(html, /Starts when you open the Simulator tab/u);
});

test("while one change is pending every control waits, and errors are announced", () => {
  const html = view({
    state: state({ hostStatus: "installing", consent: { streaming: true, agentAccess: false, peerSharing: false } }),
    pending: "agentAccess",
    error: "npm was not found.",
  });
  for (const label of ["Simulator streaming", "Agent access", "Share with paired Macs"]) {
    assert.match(switchFor(html, label), / disabled=""/u);
  }
  assert.match(html, /role="alert"[^>]*>npm was not found\./u);
  assert.match(html, /Installing helpers…/u);
});

test("an unavailable Mac explains why, and a missing state is a read in progress", () => {
  assert.match(view({ state: state({ hostStatus: "unavailable", unavailableReason: "Install Xcode to use simulators." }) }), /Install Xcode/u);
  assert.match(view({ state: null }), /Reading simulator settings…/u);
  assert.match(view({ state: null, error: "Could not read." }), /role="alert"[^>]*>Could not read\./u);
});

test("downloads and removal each ask before they run", () => {
  const source = read("./simulator-settings.tsx");
  assert.match(source, /if \(granted && \(kind === "streaming" \|\| kind === "agentAccess"\)\) setConfirming\(kind\)/u);
  assert.match(source, /confirmVariant="destructive"/u);
  assert.match(source, /onRemove=\{\(\) => setConfirming\("remove"\)\}/u);
  assert.doesNotMatch(source, /setInterval|setTimeout/u, "no background polling");
});
