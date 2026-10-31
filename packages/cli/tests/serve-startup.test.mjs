import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkg, "dist", "app", "cli.js");

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "aiden-serve-startup-"));
  const home = join(root, "home"), agentDir = join(root, "agent");
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { agentDir, env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, env });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

/** Start a long-running command and resolve once `ready` matches its combined output. */
async function startServing(t, command, args, env, ready) {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output.stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  });
  const deadline = Date.now() + 60_000;
  while (!ready.test(output.stdout + output.stderr)) {
    if (child.exitCode !== null) throw new Error(`serve exited early (${child.exitCode}):\n${output.stdout}\n${output.stderr}`);
    if (Date.now() > deadline) throw new Error(`serve did not become ready:\n${output.stdout}\n${output.stderr}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return { child, output };
}

function unauthenticatedRemoteRequest(agentDir, port) {
  const ca = readFileSync(join(agentDir, "remote-tls", "ca-certificate.pem"));
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port, ca, path: "/api/aiden/v1/workspaces", headers: { "aiden-protocol-version": "1" } }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest(response.statusCode));
    });
    request.setTimeout(15_000, () => request.destroy(new Error("Remote request timed out")));
    request.on("error", reject);
    request.end();
  });
}

test("aiden serve starts Remote by default, reports it, and opens no pairing window without a terminal", async (t) => {
  const { agentDir, env } = sandbox(t);
  const { output } = await startServing(t, process.execPath, [cli, "serve"], env, /Aiden Remote listening/);

  const status = json(runCli(["serve", "status"], env));
  assert.equal(status.running, true);
  assert.equal(status.remote.on, true);
  assert.ok(Number.isInteger(status.remote.lanPort), JSON.stringify(status.remote));
  assert.match(status.remote.lanEndpoint, new RegExp(`^https://[^/]+:${status.remote.lanPort}/api/aiden/v1$`));

  // The listener is real and admits nobody without a paired credential.
  assert.equal(await unauthenticatedRemoteRequest(agentDir, status.remote.lanPort), 401);

  // Piped output is a log, not a person: no code is shown and no single-use secret is minted.
  assert.doesNotMatch(output.stdout + output.stderr, /Manual code|Scan with Aiden/);
  assert.deepEqual(json(runCli(["remote", "pair-status"], env)), { state: "none" });
});

test("aiden serve --no-remote serves without Remote", async (t) => {
  const { env } = sandbox(t);
  await startServing(t, process.execPath, [cli, "serve", "--no-remote"], env, /Aiden Remote is off/);

  const status = json(runCli(["serve", "status"], env));
  assert.equal(status.running, true);
  assert.deepEqual(status.remote, { on: false });
  const remote = runCli(["remote", "status"], env);
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /Remote is off/);
});

test("aiden serve --daemon passes the Remote choice to the background server", async (t) => {
  for (const [args, on] of [[[], true], [["--no-remote"], false]]) {
    const { env } = sandbox(t);
    const started = json(runCli(["serve", "--daemon", ...args], env));
    t.after(() => { runCli(["serve", "stop"], env); });
    assert.equal(started.remote.on, on, JSON.stringify(started));
    assert.equal(json(runCli(["serve", "status"], env)).remote.on, on);
    assert.equal(json(runCli(["serve", "stop"], env)).stopped, true);
    assert.deepEqual(json(runCli(["serve", "status"], env)).remote, { on: false });
  }
});

test("aiden serve rejects contradictory pairing and Remote flags before starting", (t) => {
  const { env } = sandbox(t);
  for (const [args, message] of [
    [["--no-remote", "--pair", "lan"], /--pair needs Remote/],
    [["--daemon", "--pair", "tailscale"], /aiden remote pair/],
    [["--remote", "--no-remote"], /Choose one/],
    [["--pair", "wifi"], /--pair lan\|tailscale/],
    [["--tui"], /Usage: aiden serve/],
  ]) {
    const result = runCli(["serve", ...args], env);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
  }
  assert.equal(json(runCli(["serve", "status"], env)).running, false);
});

// util-linux `script` gives the CLI a real terminal; BSD/macOS `script` takes other arguments.
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;

test("aiden serve in a terminal shows a LAN pairing code that the server is waiting on", { skip: !hasScript && "needs util-linux script for a pseudo-terminal" }, async (t) => {
  const { env } = sandbox(t);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const { output } = await startServing(t, "script", ["-qfec", `${quote(process.execPath)} ${quote(cli)} serve`, "/dev/null"], env, /Manual code: \S+/);
  const text = output.stdout + output.stderr;
  assert.match(text, /Endpoint: https:\/\/[^/\s]+:\d+\/api\/aiden\/v1/);
  assert.match(text, /expires in [45]m/);
  const pairing = json(runCli(["remote", "pair-status"], env));
  assert.equal(pairing.state, "awaiting_scan");
  assert.match(pairing.sessionId, /^pairing_/);
});

/** A Remote service double that records the transport operations Tailscale pairing performs. */
function tailscalePairingDouble({ connectionMode = "lan", tailscaleConnected = false, node, connectError, deniedAfterConnect = false }) {
  const calls = [];
  let mode = connectionMode, connected = tailscaleConnected, denied = false;
  const service = {
    async status() { return { connectionMode: mode, tailscaleConnected: connected, ...(denied ? { tailscaleErrorCode: "permission_denied" } : {}) }; },
    async setConnectionMode(next) { calls.push(["mode", next]); mode = next; },
    async connectTailscale() {
      calls.push(["connect"]);
      if (connectError) throw new Error(connectError);
      if (deniedAfterConnect) { denied = true; return; }
      connected = true;
    },
    async beginPairing(transport) {
      calls.push(["pair", transport]);
      if (!connected) throw new Error("Connect the Aiden Tailscale Serve route before pairing.");
      return { sessionId: "pairing_test", transport };
    },
  };
  const tailscale = { async status() { calls.push(["node"]); return node ?? { installed: true, dnsName: "box.tail1234.ts.net", httpsAvailable: true }; } };
  return { service, tailscale, calls, mode: () => mode };
}

test("Tailscale pairing on a fresh LAN profile adds Tailscale and connects Serve before opening the window", async () => {
  const api = await import("../dist/parity-test-api.js");
  const fresh = tailscalePairingDouble({});
  assert.deepEqual(await api.beginTailscalePairing(fresh.service, fresh.tailscale), { sessionId: "pairing_test", transport: "tailscale" });
  assert.deepEqual(fresh.calls, [["node"], ["mode", "both"], ["connect"], ["pair", "tailscale"]]);
  assert.equal(fresh.mode(), "both", "LAN keeps working next to Tailscale");

  const ready = tailscalePairingDouble({ connectionMode: "tailscale", tailscaleConnected: true });
  await api.beginTailscalePairing(ready.service, ready.tailscale);
  assert.deepEqual(ready.calls, [["pair", "tailscale"]], "a connected route is used as is");
});

test("Tailscale pairing leaves foreign routes alone and names the setup step instead of a bare retry", async () => {
  const api = await import("../dist/parity-test-api.js");
  const conflict = tailscalePairingDouble({ connectError: "tailscale_route_conflict" });
  await assert.rejects(api.beginTailscalePairing(conflict.service, conflict.tailscale), /left it unchanged.*aiden remote mode both.*aiden remote tailscale-review.*aiden remote tailscale-takeover <token>/s);
  assert.deepEqual(conflict.calls, [["node"], ["mode", "both"], ["connect"], ["mode", "lan"]], "no pairing window, and the added mode is put back");

  const denied = tailscalePairingDouble({ deniedAfterConnect: true });
  await assert.rejects(api.beginTailscalePairing(denied.service, denied.tailscale), /sudo tailscale set --operator=\$USER.*aiden remote pair tailscale/s);
  assert.equal(denied.mode(), "lan");

  for (const [node, message] of [
    [{ installed: false, errorCode: "not_installed" }, /not installed.*sudo tailscale up.*aiden remote pair tailscale/s],
    [{ installed: true }, /sudo tailscale up.*aiden remote pair tailscale/s],
    [{ installed: true, dnsName: "box.tail1234.ts.net", httpsAvailable: false }, /HTTPS.*aiden remote pair tailscale/s],
  ]) {
    const blocked = tailscalePairingDouble({ node });
    await assert.rejects(api.beginTailscalePairing(blocked.service, blocked.tailscale), message);
    assert.deepEqual(blocked.calls, [["node"]], "nothing changes before the node is ready");
  }
});

// Never let a test touch a developer's real Tailscale Serve configuration.
const tailscaleInstalled = !!(await (await import("../dist/parity-test-api.js")).resolveTailscaleBinary());

test("aiden serve --pair tailscale without Tailscale says how to set it up and keeps LAN mode", { skip: (!hasScript && "needs util-linux script for a pseudo-terminal") || (tailscaleInstalled && "Tailscale is installed on this host") }, async (t) => {
  const { env } = sandbox(t);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const { output } = await startServing(t, "script", ["-qfec", `${quote(process.execPath)} ${quote(cli)} serve --pair tailscale`, "/dev/null"], env, /Could not open a Tailscale pairing window[^\n]*\n/);
  const text = output.stdout + output.stderr;
  assert.match(text, /Tailscale is not installed on this server\. Install it .*sudo tailscale up.*aiden remote pair tailscale/);
  assert.doesNotMatch(text, /Manual code/);
  const again = runCli(["remote", "pair", "tailscale"], env);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /Tailscale is not installed on this server/);
  const status = json(runCli(["remote", "status"], env));
  assert.equal(status.connectionMode, "lan");
  assert.deepEqual(json(runCli(["remote", "pair-status"], env)), { state: "none" });
});

test("serve status reports Remote as unknown instead of waiting on a daemon that never answers", async () => {
  const api = await import("../dist/parity-test-api.js");
  const { createServer } = await import("node:net");
  const dir = mkdtempSync(join(tmpdir(), "aiden-serve-wedged-"));
  const held = [];
  const server = createServer((socket) => { held.push(socket); });
  try {
    server.listen(join(dir, "serve.sock"));
    await once(server, "listening");
    const started = Date.now();
    const summary = await api.daemonRemoteSummary(dir, 200);
    assert.equal(summary.on, "unknown");
    assert.match(summary.error, /did not answer/);
    assert.ok(Date.now() - started < 5_000, "status returns on its own short deadline");
  } finally {
    for (const socket of held) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A control socket that answers like a running server and records what it was asked. */
async function fakeDaemon(answer) {
  const { createServer } = await import("node:net");
  const dir = mkdtempSync(join(tmpdir(), "aiden-serve-fake-"));
  const asked = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const { command, args } = JSON.parse(buffer);
      asked.push([command, ...args].join(" "));
      const result = answer(command, args);
      socket.end(JSON.stringify(result instanceof Error ? { error: result.message } : { result }) + "\n");
    });
  });
  server.listen(join(dir, "serve.sock"));
  await once(server, "listening");
  return { dir, asked, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function sink() {
  const stream = { text: "", write(chunk) { stream.text += chunk; return true; } };
  return stream;
}

test("startup pairing on a Tailscale-only server pairs over Tailscale and reports a failed window", async () => {
  const api = await import("../dist/parity-test-api.js");
  const pairing = { sessionId: "pairing_test", qrPayload: "aiden-pair:test", manualCode: "ABCD-1234", bootstrap: { expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  const daemon = await fakeDaemon((command, args) => {
    if (command === "serve") return { remote: { on: true, connectionMode: "tailscale" } };
    if (args[0] === "pair") return pairing;
    return { sessionId: "pairing_test", state: "failed" };
  });
  const out = sink(), err = sink();
  try {
    const started = Date.now();
    await api.showStartupPairing(daemon.dir, undefined, new AbortController().signal, out, err);
    assert.deepEqual(daemon.asked, ["serve status", "remote pair tailscale", "remote status", "remote pair-status"]);
    assert.match(out.text, /Manual code: ABCD-1234/);
    assert.match(err.text, /Pairing failed\. Run `aiden remote pair tailscale` to try again/);
    assert.doesNotMatch(out.text, /expired/);
    assert.ok(Date.now() - started < 10_000, "a failed window ends the wait instead of running out the clock");
  } finally {
    daemon.close();
  }
});

test("startup pairing names both pair commands when the server's network is unknown and LAN fails", async () => {
  const api = await import("../dist/parity-test-api.js");
  const daemon = await fakeDaemon((command, args) => {
    if (command === "serve") return new Error("status unavailable");
    if (args[0] === "pair") return new Error("Local-network access is not enabled.");
    return { state: "none" };
  });
  const out = sink(), err = sink();
  try {
    await api.showStartupPairing(daemon.dir, undefined, new AbortController().signal, out, err);
    assert.deepEqual(daemon.asked, ["serve status", "remote pair lan"]);
    assert.match(err.text, /Could not open a LAN pairing window\. Local-network access is not enabled\. Run `aiden remote pair lan` or `aiden remote pair tailscale` to try again\./);
  } finally {
    daemon.close();
  }
});
