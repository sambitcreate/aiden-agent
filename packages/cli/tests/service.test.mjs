import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // A user manager cannot order against system units such as network-online.target, so the unit names none.
  assert.doesNotMatch(unit, /^(After|Wants|Requires)=/m);
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

test("an install that starts its server applies the chosen network and pairs over a network that reaches it", async (t) => {
  const entry = join(mkdtempSync(join(tmpdir(), "aiden-service-entry-")), "cli.js");
  writeFileSync(entry, "");
  t.after(() => rmSync(dirname(entry), { recursive: true, force: true }));
  const saved = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = entry;
  t.after(() => { if (saved === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = saved; });
  /** Installs on a fake Linux host whose server is ready at once, and records what reaches the server. */
  const install = async (flags, { failNetwork, status, tty = true, interrupt, saved } = {}) => {
    const { host, local } = fakeHost(t, "linux", { "loginctl show-user": { stdout: "yes\n" } });
    if (saved) {
      mkdirSync(local.agentDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(local.agentDir, "remote.json"), JSON.stringify({ version: 1, connectionMode: saved }));
    }
    const sent = [];
    const paired = [];
    const remote = async (args) => {
      sent.push(args.join(" "));
      if (args[0] === "network" && failNetwork) throw new Error("Tailscale is not signed in.");
      return args[0] === "status" ? status : {};
    };
    const pair = async (transport) => {
      paired.push(transport);
      if (!interrupt) return "session-1";
      // The person presses Ctrl+C, the SSH session drops, or the command is killed while the code is on screen.
      process.emit(interrupt, interrupt);
      return "session-1";
    };
    let output = "";
    const write = process.stdout.write;
    const writeErr = process.stderr.write;
    process.stdout.write = (chunk) => { output += chunk; return true; };
    process.stderr.write = (chunk) => { output += chunk; return true; };
    try {
      await api.serviceCommand(local.agentDir, ["install", ...flags], host, { ready: async () => true, remote, pair, tty });
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
    return { sent, paired, output };
  };

  for (const [network, transport, label] of [["local", "lan", "the local network only"], ["tailscale", "tailscale", "Tailscale only"], ["both", "tailscale", "the local network and Tailscale"]]) {
    const { sent, paired, output } = await install(["--network", network]);
    assert.deepEqual(sent, [`network ${network}`], network);
    assert.deepEqual(paired, [transport], `${network}: the code is for a network the server is on`);
    assert.match(output, new RegExp(`running as a service and reachable over ${label}\\.`), network);
  }

  // Tailscale could not be set up, but the server still serves the local network: say so and pair there.
  const fellBack = await install(["--network", "tailscale"], { failNetwork: true, status: { connectionMode: "lan" } });
  assert.deepEqual(fellBack.sent, ["network tailscale", "status"]);
  assert.deepEqual(fellBack.paired, ["lan"]);
  assert.match(fellBack.output, /Could not set up Tailscale only\. Tailscale is not signed in\./);
  assert.match(fellBack.output, /For now the server is reachable over the local network only\./);

  // Nothing reaches the server: no pairing code and no reachable claim.
  const unreachable = await install(["--network", "tailscale"], { failNetwork: true, status: { connectionMode: "tailscale", tailscaleConnected: false } });
  assert.deepEqual(unreachable.paired, []);
  assert.match(unreachable.output, /For now no phone can reach the server\./);
  assert.doesNotMatch(unreachable.output, /reachable over/);

  // Ctrl+C skips pairing but the service keeps running, so the code on screen is closed; a finished window is left alone.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const skipped = await install(["--network", "local"], { interrupt: signal });
    assert.deepEqual(skipped.sent, ["network local", "pair-cancel session-1"], signal);
    assert.match(skipped.output, /Closed the pairing code\./, signal);
  }
  assert.ok(!(await install(["--network", "local"])).sent.some((line) => line.startsWith("pair-cancel")), "no cancel without Ctrl+C");

  // An unfinished Tailscale route change leaves the server's reach unknown: no reachable claim, no code, and the fix.
  const unfinished = await install(["--network", "local"], { failNetwork: true, status: { connectionMode: "lan", tailscaleRouteState: "reconciliation_required" } });
  assert.deepEqual(unfinished.paired, []);
  assert.match(unfinished.output, /unfinished change.*aiden remote tailscale-reconcile/s);
  assert.doesNotMatch(unfinished.output, /reachable over|no phone can reach/);

  // A reinstall without --network keeps the Tailscale network saved in the profile, and pairs over it.
  const kept = await install([], { saved: "tailscale" });
  assert.deepEqual(kept.sent, ["network tailscale"]);
  assert.deepEqual(kept.paired, ["tailscale"]);
  assert.match(kept.output, /Keeping the server's network: Tailscale only\./);

  // --no-pair, or no terminal to show a code in, names the pair command instead.
  for (const [flags, tty] of [[["--network", "both", "--no-pair"], true], [["--network", "both"], false]]) {
    const { paired, output } = await install(flags, { tty });
    assert.deepEqual(paired, [], flags.join(" "));
    assert.match(output, /Pair a phone with `aiden remote pair tailscale`\./, flags.join(" "));
  }
});

test("the server is called reachable over Tailscale only while its route is connected", () => {
  assert.equal(api.reachableNetwork({ connectionMode: "lan" }), "local");
  assert.equal(api.reachableNetwork({ connectionMode: "both", tailscaleConnected: true }), "both");
  assert.equal(api.reachableNetwork({ connectionMode: "both", tailscaleConnected: false }), "local");
  assert.equal(api.reachableNetwork({ connectionMode: "tailscale", tailscaleConnected: true }), "tailscale");
  assert.equal(api.reachableNetwork({ connectionMode: "tailscale", tailscaleConnected: false }), undefined);
  assert.equal(api.reachableNetwork({ enabled: true, running: false, connectionMode: "both", tailscaleConnected: true }), undefined, "Remote that is not listening reaches no one");
  assert.equal(api.reachableNetwork({ enabled: false, running: false, connectionMode: "lan" }), undefined, "Remote that is off reaches no one");
  assert.equal(api.reachableNetwork({ enabled: true, running: true, connectionMode: "lan" }), "local");
  assert.equal(api.reachableNetwork(undefined), undefined, "a server that does not answer is not called reachable");
});

test("a reinstall keeps the Tailscale network the server already uses", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "aiden-service-saved-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  assert.equal(api.savedNetwork(agentDir), undefined, "a fresh profile has nothing to keep");
  for (const [mode, kept] of [["tailscale", "tailscale"], ["both", "both"], ["lan", undefined]]) {
    writeFileSync(join(agentDir, "remote.json"), JSON.stringify({ version: 1, connectionMode: mode }));
    assert.equal(api.savedNetwork(agentDir), kept, mode);
  }
  writeFileSync(join(agentDir, "remote.json"), "{ not json");
  assert.equal(api.savedNetwork(agentDir), undefined, "unreadable settings fall back to the usual choice");
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

function networkDouble({ connectionMode = "lan", tailscaleConnected = false, connectError, modeError } = {}) {
  const calls = [];
  let mode = connectionMode, connected = tailscaleConnected;
  const service = {
    async status() { return { connectionMode: mode, tailscaleConnected: connected }; },
    async setConnectionMode(next) { calls.push(["mode", next]); if (modeError) throw new Error(modeError); mode = next; if (next === "lan") connected = false; },
    async connectTailscale() { calls.push(["connect"]); if (connectError) throw new Error(connectError); connected = true; },
  };
  const tailscale = { async status() { calls.push(["node"]); return { installed: true, dnsName: "box.tail1234.ts.net", httpsAvailable: true }; } };
  return { service, tailscale, calls, mode: () => mode };
}

test("the install network is asked in a terminal and, without one, follows the suggestion only when Tailscale is ready", async () => {
  const host = { platform: "linux", uid: 1000, user: "sam" };
  const ready = { installed: true, signedIn: true, dnsName: "box.tail1234.ts.net", httpsCertificates: true, funnelOn443: false, operatorNeeded: false };
  const signedOut = { installed: true, signedIn: false, httpsCertificates: false, funnelOn443: false };
  const choose = (facts, cloud, interactive, ask) => api.chooseNetwork(host, interactive, { facts: async () => facts, cloud: async () => cloud, ask });
  assert.equal(await choose(ready, true, false), "tailscale", "a cloud server with Tailscale ready goes Tailscale-only");
  assert.equal(await choose(ready, false, false), "both", "a home server with Tailscale ready keeps the local network too");
  assert.equal(await choose(signedOut, true, false), "local", "an unattended install never picks a network that cannot work yet");
  assert.equal(await choose(signedOut, false, false), "local");
  const asked = [];
  assert.equal(await choose(signedOut, true, true, async (question) => { asked.push(question); return "both"; }), "both", "the person's answer wins");
  assert.equal(asked[0].recommended, "tailscale", "a cloud server is pointed at Tailscale even before it is set up");
  assert.match(asked[0].text, /sudo tailscale up/);
});

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

  const unfinished = networkDouble({ connectionMode: "both", tailscaleConnected: true, modeError: "tailscale_reconciliation_required" });
  await assert.rejects(api.setRemoteNetwork(unfinished.service, unfinished.tailscale, "local"), /aiden remote tailscale-reconcile/, "leaving Tailscale names the fix, not the bare code");

  const conflict = networkDouble({ connectError: "tailscale_route_conflict" });
  await assert.rejects(api.setRemoteNetwork(conflict.service, conflict.tailscale, "tailscale"), /already points somewhere else/);
  assert.equal(conflict.mode(), "lan", "a failed Tailscale setup leaves the server reachable on the local network");
});
