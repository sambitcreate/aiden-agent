import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const api = await import("../dist/parity-test-api.js");

const launch = {
  node: "/opt/node 22/bin/node",
  entry: "/home/sam/my \"aiden\"/packages/cli/dist/app/cli.js",
  agentDir: "/home/sam/.aiden/agent 100%",
  path: "/usr/local/bin:/usr/bin:/bin:/home/sam/$bin",
};

/** A machine whose service manager answers from `answers` and records each call. */
function fakeHost(t, platform, answers = {}) {
  const home = mkdtempSync(join(tmpdir(), "aiden-service-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1];
    return { status: 0, stdout: "", stderr: "", ...(typeof answer === "function" ? answer(calls) : answer) };
  };
  // A profile that does not exist yet, as on a first install.
  const local = { ...launch, agentDir: join(home, "fresh profile", "agent") };
  return { host: { platform, home, uid: 501, user: "sam", run }, calls, home, local };
}

test("the systemd unit runs serve --no-pair with every value quoted and escaped for systemd", () => {
  const unit = api.systemdUnit(launch);
  const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
  // systemd: "%" starts a specifier (written "%%"), "$" starts a variable in ExecStart (written "$$").
  assert.equal(execStart, 'ExecStart="/opt/node 22/bin/node" "/home/sam/my \\"aiden\\"/packages/cli/dist/app/cli.js" "serve" "--no-pair"');
  assert.ok(unit.includes('Environment="AIDEN_CODING_AGENT_DIR=/home/sam/.aiden/agent 100%%"'));
  assert.ok(unit.includes('Environment="PATH=/usr/local/bin:/usr/bin:/bin:/home/sam/$bin"'), "Environment= does not expand $");
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.throws(() => api.systemdUnit({ ...launch, entry: "/tmp/a\nExecStartPre=/bin/evil" }), /line breaks/);
});

test("the launchd job escapes XML and logs to serve.log in the agent directory", () => {
  const plist = api.launchdPlist({ ...launch, entry: "/Users/sam/R&D/<aiden>/cli.js" });
  assert.ok(plist.includes("<string>/Users/sam/R&amp;D/&lt;aiden&gt;/cli.js</string>"));
  assert.ok(plist.includes("<string>serve</string>\n    <string>--no-pair</string>"));
  assert.ok(plist.includes("<key>StandardOutPath</key><string>/home/sam/.aiden/agent 100%/serve.log</string>"));
  assert.ok(plist.includes("<key>Label</key><string>com.sambitcreate.aiden-agent.serve</string>"));
});

test("Linux install writes a user unit, enables and restarts it, and turns on lingering", (t) => {
  const { host, calls, home, local } = fakeHost(t, "linux", { "loginctl show-user": { stdout: "no\n" } });
  const result = api.installService(host, local);
  const file = join(home, ".config", "systemd", "user", "aiden.service");
  assert.equal(result.file, file);
  assert.equal(readFileSync(file, "utf8"), api.systemdUnit(local));
  assert.deepEqual(calls, [
    "systemctl --user daemon-reload",
    "systemctl --user enable aiden.service",
    "systemctl --user restart aiden.service",
    "loginctl show-user sam --property=Linger --value",
    "loginctl enable-linger sam",
  ]);
  assert.equal(result.warning, undefined);
});

test("Linux install says how to keep the server running after logout when lingering cannot be turned on", (t) => {
  const { host, local } = fakeHost(t, "linux", { "loginctl show-user": { stdout: "no\n" }, "loginctl enable-linger": { status: 1, stderr: "Access denied" } });
  assert.match(api.installService(host, local).warning, /sudo loginctl enable-linger \$USER/);
});

test("Linux install without a systemd user session names the fix instead of half-installing", (t) => {
  const { host, calls, local } = fakeHost(t, "linux", { "systemctl --user daemon-reload": { status: 1, stderr: "Failed to connect to bus: No medium found" } });
  assert.throws(() => api.installService(host, local), /not available in this session.*over SSH.*aiden serve --daemon.*No medium found/s);
  assert.deepEqual(calls.slice(0, 1), ["systemctl --user daemon-reload"], "nothing is enabled or started");
  assert.equal(api.serviceStatus(host).installed, false, "the unit written for the attempt is removed again");
});

test("a failed reinstall puts back the service that was already installed", (t) => {
  for (const [platform, failing] of [["linux", "systemctl --user restart"], ["darwin", "launchctl bootstrap"]]) {
    let fail = false;
    const { host, calls, local } = fakeHost(t, platform, { "loginctl show-user": { stdout: "yes\n" }, [failing]: () => fail ? { status: 1, stderr: "Job failed" } : {} });
    const { file } = api.installService(host, local);
    const working = readFileSync(file, "utf8");
    fail = true;
    calls.length = 0;
    assert.throws(() => api.installService(host, { ...local, path: "/opt/new/bin" }), /Job failed/);
    assert.equal(readFileSync(file, "utf8"), working, `${platform}: the earlier service file is back`);
    assert.ok(!calls.some((call) => call.includes("disable")), `${platform}: the earlier service is not disabled`);
    assert.equal(calls.at(-1), platform === "linux" ? "systemctl --user restart aiden.service" : `launchctl bootstrap gui/501 ${file}`, `${platform}: the earlier service is started again`);
  }
});

test("a reinstall whose new server never becomes ready puts back the service that was installed before", async (t) => {
  const entry = join(mkdtempSync(join(tmpdir(), "aiden-service-entry-")), "cli.js");
  writeFileSync(entry, "");
  t.after(() => rmSync(dirname(entry), { recursive: true, force: true }));
  const saved = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = entry;
  t.after(() => { if (saved === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = saved; });
  for (const platform of ["linux", "darwin"]) {
    const { host, calls, local } = fakeHost(t, platform, { "loginctl show-user": { stdout: "yes\n" } });
    const { file } = api.installService(host, { ...local, path: "/opt/working/bin" });
    const working = readFileSync(file, "utf8");
    calls.length = 0;
    // Every manager command succeeds, but no server ever answers on the control socket.
    await assert.rejects(api.serviceCommand(local.agentDir, ["install", "--network", "local", "--no-pair"], host, { readyTimeoutMs: 300 }), /did not start the server.*Put back the service that was installed before/s, platform);
    assert.equal(readFileSync(file, "utf8"), working, `${platform}: the earlier service file is back`);
    assert.equal(calls.at(-1), platform === "linux" ? "systemctl --user restart aiden.service" : `launchctl bootstrap gui/501 ${file}`, `${platform}: the earlier service is started again`);
    if (platform === "darwin") assert.equal(calls.at(-2), "launchctl bootout gui/501/com.sambitcreate.aiden-agent.serve", "the replacement is unloaded first");
  }
});

test("a first install whose server never becomes ready is removed instead of left restarting", async (t) => {
  const entry = join(mkdtempSync(join(tmpdir(), "aiden-service-entry-")), "cli.js");
  writeFileSync(entry, "");
  t.after(() => rmSync(dirname(entry), { recursive: true, force: true }));
  const saved = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = entry;
  t.after(() => { if (saved === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = saved; });
  for (const platform of ["linux", "darwin"]) {
    const { host, calls, local } = fakeHost(t, platform, { "loginctl show-user": { stdout: "yes\n" } });
    await assert.rejects(api.serviceCommand(local.agentDir, ["install", "--network", "local", "--no-pair"], host, { readyTimeoutMs: 300 }), (error) => {
      assert.match(error.message, /did not start the server.*Removed the service it installed/s, platform);
      assert.doesNotMatch(error.message, /aiden serve --daemon/, `${platform}: no server was stopped, so none is suggested`);
      return true;
    });
    assert.equal(calls.at(platform === "linux" ? -2 : -1), platform === "linux" ? "systemctl --user disable --now aiden.service" : "launchctl bootout gui/501/com.sambitcreate.aiden-agent.serve", `${platform}: the service is stopped`);
    assert.equal(api.serviceStatus(host).installed, false, `${platform}: nothing is left installed`);
  }
});

test("the server is called reachable over Tailscale only while its route is connected", () => {
  assert.equal(api.reachableNetwork({ connectionMode: "lan" }), "local");
  assert.equal(api.reachableNetwork({ connectionMode: "both", tailscaleConnected: true }), "both");
  assert.equal(api.reachableNetwork({ connectionMode: "both", tailscaleConnected: false }), "local");
  assert.equal(api.reachableNetwork({ connectionMode: "tailscale", tailscaleConnected: true }), "tailscale");
  assert.equal(api.reachableNetwork({ connectionMode: "tailscale", tailscaleConnected: false }), undefined);
  assert.equal(api.reachableNetwork(undefined), undefined, "a server that does not answer is not called reachable");
});

test("Linux uninstall stops the service and removes the unit; a second uninstall reports nothing to remove", (t) => {
  const { host, calls, local } = fakeHost(t, "linux", { "loginctl show-user": { stdout: "yes\n" } });
  const { file } = api.installService(host, local);
  calls.length = 0;
  assert.equal(api.uninstallService(host), true);
  assert.equal(existsSync(file), false);
  assert.deepEqual(calls, ["systemctl --user disable --now aiden.service", "systemctl --user daemon-reload"]);
  assert.equal(api.uninstallService(host), false);
});

test("macOS install replaces any loaded job with a LaunchAgent in the person's login session", (t) => {
  const { host, calls, home, local } = fakeHost(t, "darwin", { "launchctl print": { stdout: "state = running\n" } });
  const result = api.installService(host, local);
  const file = join(home, "Library", "LaunchAgents", "com.sambitcreate.aiden-agent.serve.plist");
  assert.equal(result.file, file);
  assert.equal(readFileSync(file, "utf8"), api.launchdPlist(local));
  assert.ok(existsSync(local.agentDir), "launchd opens serve.log there before Node can create the directory");
  assert.deepEqual(calls, [
    "launchctl bootout gui/501/com.sambitcreate.aiden-agent.serve",
    "launchctl enable gui/501/com.sambitcreate.aiden-agent.serve",
    `launchctl bootstrap gui/501 ${file}`,
  ]);
  assert.match(result.warning, /automatic login/);
  assert.deepEqual({ ...api.serviceStatus(host), logs: undefined }, { installed: true, manager: "launchd", file, active: true, logs: undefined });
});

test("macOS reinstall loads a label the person disabled earlier", (t) => {
  // launchd keeps a disabled label disabled across boots and refuses to load it until enabled.
  const { host, local } = fakeHost(t, "darwin", {
    "launchctl bootstrap": (calls) => calls.includes("launchctl enable gui/501/com.sambitcreate.aiden-agent.serve") ? {} : { status: 5, stderr: "Bootstrap failed: 5: Input/output error" },
  });
  assert.doesNotThrow(() => api.installService(host, local));
  assert.equal(api.serviceStatus(host).installed, true);
});

test("uninstall keeps the service file and says so when the manager cannot stop a loaded service", (t) => {
  for (const [platform, stop, failure] of [
    ["linux", "systemctl --user disable", "Failed to connect to bus: No medium found"],
    ["darwin", "launchctl bootout", "Boot-out failed: 5: Input/output error"],
  ]) {
    let failing = false;
    const { host, local } = fakeHost(t, platform, { "loginctl show-user": { stdout: "yes\n" }, [stop]: () => failing ? { status: 5, stderr: failure } : {} });
    const { file } = api.installService(host, local);
    failing = true;
    assert.throws(() => api.uninstallService(host), new RegExp(`Could not stop the Aiden service.*${failure.split(":")[0]}.*still installed`, "s"), platform);
    assert.equal(existsSync(file), true, `${platform}: the file stays so uninstall can be retried`);
  }
  const { host, local } = fakeHost(t, "darwin", { "launchctl bootout": { status: 113, stderr: "Boot-out failed: 113: Could not find specified service" } });
  const { file } = api.installService(host, local);
  assert.equal(api.uninstallService(host), true, "a job that is not loaded counts as stopped");
  assert.equal(existsSync(file), false);
});

test("other systems are told to use serve --daemon", (t) => {
  const { host } = fakeHost(t, "win32");
  assert.throws(() => api.installService(host, launch), /Linux \(systemd\) and macOS \(launchd\).*aiden serve --daemon/);
});

test("install flags take a network choice and --no-pair, and reject anything else", () => {
  assert.deepEqual(api.parseInstallFlags([]), { pair: true });
  assert.deepEqual(api.parseInstallFlags(["--network", "tailscale", "--no-pair"]), { network: "tailscale", pair: false });
  assert.deepEqual(api.parseInstallFlags(["--network=both"]), { network: "both", pair: true });
  assert.throws(() => api.parseInstallFlags(["--network", "lan"]), /local\|tailscale\|both/);
  assert.throws(() => api.parseInstallFlags(["--daemon"]), /Usage: aiden service install/);
});

function networkDouble({ connectionMode = "lan", tailscaleConnected = false, connectError } = {}) {
  const calls = [];
  let mode = connectionMode, connected = tailscaleConnected;
  const service = {
    async status() { return { connectionMode: mode, tailscaleConnected: connected }; },
    async setConnectionMode(next) { calls.push(["mode", next]); mode = next; if (next === "lan") connected = false; },
    async connectTailscale() { calls.push(["connect"]); if (connectError) throw new Error(connectError); connected = true; },
  };
  const tailscale = { async status() { calls.push(["node"]); return { installed: true, dnsName: "box.tail1234.ts.net", httpsAvailable: true }; } };
  return { service, tailscale, calls, mode: () => mode };
}

test("choosing a network sets the mode and connects Tailscale only when the choice needs it", async () => {
  const tailscaleOnly = networkDouble();
  assert.equal((await api.setRemoteNetwork(tailscaleOnly.service, tailscaleOnly.tailscale, "tailscale")).connectionMode, "tailscale");
  assert.deepEqual(tailscaleOnly.calls, [["node"], ["mode", "tailscale"], ["connect"]]);

  const widen = networkDouble({ connectionMode: "tailscale", tailscaleConnected: true });
  await api.setRemoteNetwork(widen.service, widen.tailscale, "both");
  assert.deepEqual(widen.calls, [["mode", "both"]], "a connected route is kept");

  const local = networkDouble({ connectionMode: "both", tailscaleConnected: true });
  await api.setRemoteNetwork(local.service, local.tailscale, "local");
  assert.deepEqual(local.calls, [["mode", "lan"]]);

  const conflict = networkDouble({ connectError: "tailscale_route_conflict" });
  await assert.rejects(api.setRemoteNetwork(conflict.service, conflict.tailscale, "tailscale"), /already points somewhere else/);
  assert.equal(conflict.mode(), "lan", "a failed Tailscale setup leaves the server reachable on the local network");
});
