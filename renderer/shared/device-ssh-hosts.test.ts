import assert from "node:assert/strict";
import test from "node:test";
import {
  describeDeviceHostCheck,
  deviceToolInstallMessage,
  parseDeviceHostCheck,
  parseSshDeviceHostConfigs,
  sshDeviceHostDraft,
  toolNeedsUpdate,
  updateSshDeviceHosts,
  validateSshDeviceHostDraft,
  type SshDeviceHostConfig,
} from "./device-ssh-hosts.js";
import { parseDeviceServiceState } from "./devices.js";

const draft = (overrides: Partial<Record<"id" | "label" | "target" | "identityFile" | "port", string>> = {}) => ({
  id: "ssh-abc123",
  label: "Mac mini",
  target: "me@mini.local",
  identityFile: "",
  port: "",
  ...overrides,
});

test("a valid draft trims fields, falls back to the target as its name, and drops empty options", () => {
  assert.deepEqual(validateSshDeviceHostDraft(draft({ label: "  ", target: " build-mac ", port: " 2222 " })), {
    config: { id: "ssh-abc123", label: "build-mac", target: "build-mac", port: 2222 },
  });
  assert.deepEqual(validateSshDeviceHostDraft(draft({ identityFile: " ~/.ssh/id_ed25519 " })).config, {
    id: "ssh-abc123",
    label: "Mac mini",
    target: "me@mini.local",
    identityFile: "~/.ssh/id_ed25519",
  });
});

test("each invalid field gets its own message, and a dash-led target can never become an ssh option", () => {
  const { errors } = validateSshDeviceHostDraft(
    draft({ target: "-oProxyCommand=touch /tmp/x", identityFile: "id_rsa", port: "70000" }),
  );
  assert.ok(errors);
  assert.match(errors.target ?? "", /not starting with a dash/u);
  assert.match(errors.identityFile ?? "", /absolute path/u);
  assert.match(errors.port ?? "", /1 to 65535/u);
  assert.match(validateSshDeviceHostDraft(draft({ target: "" })).errors?.target ?? "", /alias or user@host/u);
  assert.ok(validateSshDeviceHostDraft(draft({ target: "me@host name" })).errors?.target);
  assert.ok(validateSshDeviceHostDraft(draft({ label: "a\u0007b" })).errors?.label);
  assert.ok(validateSshDeviceHostDraft(draft({ port: "22a" })).errors?.port);
  // The id is Aiden's; the reserved local id or a free-form one is refused.
  assert.ok(validateSshDeviceHostDraft(draft({ id: "local" })).errors);
});

test("drafts round-trip through the editor shape", () => {
  const host: SshDeviceHostConfig = { id: "ssh-abc123", label: "Mini", target: "mini", port: 22, identityFile: "/k" };
  assert.deepEqual(validateSshDeviceHostDraft(sshDeviceHostDraft(host)).config, host);
});

test("stored host lists fail closed on duplicates, bad entries, and untrimmed labels", () => {
  const host = { id: "ssh-abc123", label: "Mini", target: "mini" };
  assert.deepEqual(parseSshDeviceHostConfigs([host]), [host]);
  assert.equal(parseSshDeviceHostConfigs([host, host]), null);
  assert.equal(parseSshDeviceHostConfigs([{ ...host, label: " Mini " }]), null);
  assert.equal(parseSshDeviceHostConfigs([{ ...host, port: "22" }]), null);
  assert.equal(parseSshDeviceHostConfigs("nope"), null);
});

test("adding, editing, and removing hosts keeps ids and refuses a second entry for one destination", () => {
  const a: SshDeviceHostConfig = { id: "ssh-aaaaaa", label: "A", target: "a" };
  const b: SshDeviceHostConfig = { id: "ssh-bbbbbb", label: "B", target: "b", port: 2200 };
  const added = updateSshDeviceHosts([a], b);
  assert.deepEqual(added, [a, b]);
  assert.deepEqual(updateSshDeviceHosts(added, { ...b, label: "Build" }), [a, { ...b, label: "Build" }]);
  assert.throws(() => updateSshDeviceHosts(added, { ...b, id: "ssh-cccccc" }), /already uses this destination/u);
  // The same name on a different port is a different destination.
  assert.equal(updateSshDeviceHosts(added, { ...b, id: "ssh-cccccc", port: 2201 }).length, 3);
  assert.deepEqual(updateSshDeviceHosts(added, a, true), [b]);
});

test("install progress is worded as an update only when an older version is on the host", () => {
  const tool = { requiredVersion: "0.12.0", installedVersions: ["0.9.0", "0.11.2"], runningVersion: null };
  assert.equal(deviceToolInstallMessage("the device hub", tool), "Updating the device hub from 0.11.2 to 0.12.0…");
  assert.equal(toolNeedsUpdate(tool), true);
  const fresh = { ...tool, installedVersions: [] };
  assert.equal(deviceToolInstallMessage("the device hub", fresh), "Installing the device hub 0.12.0…");
  assert.equal(toolNeedsUpdate(fresh), false, "a first install is not an update");
  const current = { ...tool, installedVersions: ["0.11.2", "0.12.0"] };
  assert.equal(toolNeedsUpdate(current), false);
  assert.equal(deviceToolInstallMessage("agent tools", undefined), "Installing agent tools…");
});

test("connection checks parse fail-closed and read as one line", () => {
  const connected = parseDeviceHostCheck({
    status: "connected",
    nodeVersion: "22.12.0",
    platforms: [{ platform: "ios", available: false, reason: "Xcode was not found on the host." }],
    tools: {
      hub: { requiredVersion: "0.12.0", installedVersions: [], runningVersion: null },
      agent: { requiredVersion: "0.21.12", installedVersions: [], runningVersion: null },
    },
  });
  assert.ok(connected);
  assert.equal(describeDeviceHostCheck(connected), "Connected. Node 22.12.0. Xcode was not found on the host.");
  assert.equal(parseDeviceHostCheck({ status: "connected", nodeVersion: "22", platforms: [{ platform: "android" }] }), null);
  assert.equal(parseDeviceHostCheck({ status: "failed", error: "" }), null);
  assert.deepEqual(parseDeviceHostCheck({ status: "local" }), { status: "local" });
  assert.match(describeDeviceHostCheck({ status: "local" }), /is this Mac/u);
});

test("service state carries SSH hosts and per-host tool versions, and rejects malformed ones", () => {
  const base = {
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    hosts: [
      {
        id: "local",
        kind: "local",
        name: "This Mac",
        status: "ready",
        tools: {
          hub: { requiredVersion: "0.12.0", installedVersions: ["0.12.0"], runningVersion: "0.12.0" },
          agent: { requiredVersion: "0.21.12", installedVersions: [], runningVersion: null },
        },
      },
      { id: "ssh-abc123", kind: "ssh", name: "Mini", status: "stopped", toolInspectionError: "Could not check." },
    ],
    consent: { streaming: true, agentAccess: false, peerSharing: false },
    devices: [],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
    sshHosts: [{ id: "ssh-abc123", label: "Mini", target: "mini" }],
  };
  const parsed = parseDeviceServiceState(base);
  assert.equal(parsed?.hosts[0]?.tools?.hub.runningVersion, "0.12.0");
  assert.equal(parsed?.hosts[1]?.toolInspectionError, "Could not check.");
  assert.deepEqual(parsed?.sshHosts, base.sshHosts);
  assert.equal(parseDeviceServiceState({ ...base, sshHosts: [{ id: "local", label: "x", target: "x" }] }), null);
  assert.equal(
    parseDeviceServiceState({ ...base, hosts: [{ ...base.hosts[0], tools: { hub: { requiredVersion: "../x" } } }] }),
    null,
  );
});
