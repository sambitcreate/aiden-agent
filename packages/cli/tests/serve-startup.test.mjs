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
