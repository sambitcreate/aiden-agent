import assert from "node:assert/strict";
import test from "node:test";
import { DeviceToolsMissingError } from "./device-host.js";
import {
  SSH_RECONNECT_ATTEMPTS,
  createSshDeviceHost,
  nextSshReconnectDelay,
  sshFailureMessage,
  sshForwardArgs,
  type SshCommandResult,
  type SshDeviceHostDeps,
  type SshTunnelProcess,
} from "./ssh-device-host.js";

const CONFIG = { id: "ssh-abc123", label: "Mac mini", target: "me@mini.local", port: 2222, identityFile: "~/.ssh/id" };
const TOOLS = {
  hub: { requiredVersion: "0.12.0", installedVersions: ["0.12.0"], runningVersion: "0.12.0" },
  agent: { requiredVersion: "0.21.12", installedVersions: ["0.21.12"], runningVersion: null },
};

class FakeTunnel implements SshTunnelProcess {
  exitCode: number | null = null;
  private listeners: Array<() => void> = [];
  constructor(readonly args: readonly string[]) {}
  kill() {
    this.exit(143);
  }
  onExit(listener: () => void) {
    if (this.exitCode !== null) listener();
    else this.listeners.push(listener);
  }
  stderr() {
    return this.exitCode === 255 ? "bind [127.0.0.1]:40001: Address already in use" : "";
  }
  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const listener of this.listeners.splice(0)) listener();
  }
  get localPort(): number {
    const forward = this.args[this.args.indexOf("-L") + 1]!;
    return Number(forward.split(":")[1]);
  }
}

type Respond = (mode: string, allowInstall: boolean) => SshCommandResult;

const started = (extra: Record<string, unknown> = {}): SshCommandResult => ({
  code: 0,
  stderr: "",
  stdout: `${JSON.stringify({
    nodePath: "/opt/homebrew/bin/node",
    nodeVersion: "22.12.0",
    platforms: [{ platform: "ios", available: true }],
    tools: TOOLS,
    hubPort: 5100,
    helpers: { axSettings: null, serveSimCli: "/remote/serve-sim.js" },
    ...extra,
  })}\n`,
});

function harness(respond: Respond) {
  const scripts: Array<{ mode: string; allowInstall: boolean }> = [];
  const commands: string[][] = [];
  const tunnels: FakeTunnel[] = [];
  const delays: number[] = [];
  const health: string[] = [];
  /** Local ports whose forward answers; a tunnel answers once spawned unless refused. */
  const alive = new Set<number>();
  const refuse = new Set<number>();
  let clock = 0;
  let nextPort = 40_000;
  const deps: SshDeviceHostDeps = {
    owner: "owner-1",
    async runSsh(args, options) {
      if (options.stdin === undefined) {
        commands.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      }
      const mode = /const mode = "([a-z-]+)"/u.exec(options.stdin)?.[1] ?? "?";
      const allowInstall = /const allowInstall = true;/u.test(options.stdin);
      scripts.push({ mode, allowInstall });
      return respond(mode, allowInstall);
    },
    spawnTunnel(args) {
      const tunnel = new FakeTunnel(args);
      tunnels.push(tunnel);
      if (refuse.has(tunnel.localPort)) queueMicrotask(() => tunnel.exit(255));
      else alive.add(tunnel.localPort);
      return tunnel;
    },
    reservePort: async () => ++nextPort,
    async fetch(url) {
      const port = Number(new URL(url).port);
      const tunnel = tunnels.find((candidate) => candidate.localPort === port);
      const ok = alive.has(port) && tunnel?.exitCode === null;
      return { ok, status: ok ? 200 : 502 };
    },
    async sleep(ms) {
      delays.push(ms);
      clock += ms;
    },
    now: () => (clock += 1),
  };
  const host = createSshDeviceHost(CONFIG, deps);
  host.onHealth((value, detail) => health.push(detail ? `${value}: ${detail}` : value));
  return { host, scripts, commands, tunnels, delays, health, alive, refuse };
}

async function settle(until: () => boolean): Promise<void> {
  for (let index = 0; index < 500 && !until(); index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(until(), "the host never reached the expected state");
}

test("the tunnel forwards loopback only, with keepalives, batch mode, and the target after --", () => {
  assert.deepEqual(
    sshForwardArgs(CONFIG, [
      { localPort: 40001, remotePort: 5100 },
      { localPort: 40002, remotePort: 5200 },
    ]),
    [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-p", "2222",
      "-i", "~/.ssh/id",
      "-o", "IdentitiesOnly=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=10",
      "-o", "ServerAliveCountMax=3",
      "-N",
      "-L", "127.0.0.1:40001:127.0.0.1:5100",
      "-L", "127.0.0.1:40002:127.0.0.1:5200",
      "--",
      "me@mini.local",
    ],
  );
});

test("connecting starts the remote hub without install approval and exposes only a forwarded loopback origin", async () => {
  const h = harness((mode) => (mode === "start" ? started() : { code: 0, stdout: "{}", stderr: "" }));
  const ready = await h.host.ensureReady();
  assert.deepEqual(h.scripts, [{ mode: "start", allowInstall: false }]);
  assert.equal(h.tunnels.length, 1);
  assert.equal(ready.hub.origin, `http://127.0.0.1:${h.tunnels[0]!.localPort}`);
  assert.equal(ready.nodePath, "/opt/homebrew/bin/node");
  assert.equal(h.host.current(), ready);
  assert.deepEqual(h.host.tools(), TOOLS);
  // Host commands run over ssh with the same target and options.
  await ready.run("xcrun", ["simctl", "list", "devices", "--json"]);
  assert.deepEqual(h.commands[0]!.slice(-5, -2), ["--", "me@mini.local", "sh"]);
});

test("a missing helper stops before any tunnel opens, and only an approved start installs", async () => {
  const h = harness((mode, allowInstall) =>
    mode === "start" && !allowInstall
      ? { code: 3, stdout: "", stderr: "missing-tool:expo-device-hub\n" }
      : mode === "probe"
        ? { ...started(), stdout: JSON.stringify({ nodePath: "/n", nodeVersion: "22.12.0", platforms: [], tools: { ...TOOLS, hub: { ...TOOLS.hub, installedVersions: ["0.11.0"] } } }) }
        : started(),
  );
  await assert.rejects(h.host.ensureReady(), (error) => error instanceof DeviceToolsMissingError && error.tool === "expo-device-hub");
  assert.equal(h.tunnels.length, 0);
  const phases: string[] = [];
  await h.host.ensureReady((phase, detail) => phases.push(`${phase}: ${detail}`), { allowInstall: true });
  assert.deepEqual(h.scripts.map((script) => `${script.mode}:${script.allowInstall}`), ["start:false", "probe:false", "start:true"]);
  assert.deepEqual(phases, ["installing: Updating device hub from 0.11.0 to 0.12.0…"]);
});

test("a dropped tunnel reconnects with 1 s doubling backoff and never installs while reconnecting", async () => {
  let failures = 2;
  const h = harness((mode, allowInstall) => {
    assert.equal(allowInstall, false);
    if (mode === "start" && h.tunnels.length > 0 && failures > 0) {
      failures -= 1;
      return { code: 255, stdout: "", stderr: "ssh: connect to host mini.local port 2222: Connection refused" };
    }
    return started();
  });
  const first = await h.host.ensureReady();
  h.tunnels[0]!.exit(255);
  await settle(() => h.health.includes("ready"));
  assert.deepEqual(h.delays.filter((delay) => delay >= 1000), [1000, 2000, 4000]);
  assert.equal(h.health.filter((entry) => entry.startsWith("restarting")).length, 3);
  const second = h.host.current();
  assert.ok(second);
  assert.notEqual(second.hub.origin, first.hub.origin, "the stream reconnects through a fresh forwarded port");
});

test("reconnecting gives up after the bounded attempts and reports why", async () => {
  const h = harness((mode) =>
    mode === "start" && h.tunnels.length > 0
      ? { code: 255, stdout: "", stderr: "ssh: connect to host mini.local: Operation timed out" }
      : started(),
  );
  await h.host.ensureReady();
  h.tunnels[0]!.exit(255);
  await settle(() => h.health.some((entry) => entry.startsWith("failed")));
  assert.equal(h.scripts.filter((script) => script.mode === "start").length, 1 + SSH_RECONNECT_ATTEMPTS);
  assert.match(h.health[h.health.length - 1]!, /^failed: Could not connect to Mac mini over SSH: .*timed out/u);
  assert.equal(h.host.current(), null);
});

test("stopping during a reconnect wait ends it, closes tunnels, and stops the remote helpers once", async () => {
  const h = harness((mode) =>
    mode === "agent-start" ? started({ daemonPort: 5200, token: "t", entryPath: "/remote/agent-device.mjs" }) : started(),
  );
  await h.host.ensureReady();
  await h.host.ensureAgentReady(undefined, {});
  assert.equal(h.tunnels.filter((tunnel) => tunnel.exitCode === null).length, 2, "hub and daemon each have a tunnel");
  h.tunnels[0]!.exit(255);
  await h.host.stop();
  await settle(() => h.scripts.some((script) => script.mode === "stop"));
  assert.ok(h.tunnels.every((tunnel) => tunnel.exitCode !== null));
  assert.equal(h.scripts.filter((script) => script.mode === "start").length, 1, "no reconnect after stop");
  assert.equal(h.scripts.filter((script) => script.mode === "stop").length, 1);
});

test("a forward whose local port was taken retries on a fresh port", async () => {
  const h = harness(() => started());
  h.refuse.add(40_001);
  const ready = await h.host.ensureReady();
  assert.equal(h.tunnels.length, 2);
  assert.equal(ready.hub.origin, "http://127.0.0.1:40002");
});

test("agent tools get their own daemon tunnel and the remote token", async () => {
  const h = harness((mode) =>
    mode === "agent-start" ? started({ daemonPort: 5200, token: "remote-token", entryPath: "/remote/agent-device.mjs" }) : started(),
  );
  const ready = await h.host.ensureAgentReady(undefined, {});
  const daemonTunnel = h.tunnels[1]!;
  assert.ok(daemonTunnel.args.includes("127.0.0.1:40002:127.0.0.1:5200"));
  assert.deepEqual(ready.agentDevice, { baseUrl: "http://127.0.0.1:40002", token: "remote-token", entryPath: "/remote/agent-device.mjs" });
  // Stopping agent access keeps the viewer's hub tunnel.
  await h.host.stopAgent();
  assert.equal(daemonTunnel.exitCode, 143);
  assert.equal(h.tunnels[0]!.exitCode, null);
  assert.ok(h.scripts.some((script) => script.mode === "stop-agent"));
});

test("a user action reuses a live forward and restarts a dead remote hub", async () => {
  const h = harness(() => started());
  const ready = await h.host.ensureReady();
  assert.equal(await h.host.ensureReady(), ready);
  assert.equal(h.scripts.length, 1);
  h.alive.delete(h.tunnels[0]!.localPort);
  const next = await h.host.ensureReady();
  assert.notEqual(next, ready);
  assert.equal(h.scripts.length, 2);
  assert.equal(h.tunnels[0]!.exitCode, 143, "the stale tunnel is closed");
});

test("ssh failures read as actions the user can take", () => {
  assert.match(
    sshFailureMessage("Mini", { code: 255, stdout: "", stderr: "me@mini: Permission denied (publickey)." }),
    /ssh-agent .*never asks for passwords/u,
  );
  assert.match(
    sshFailureMessage("Mini", { code: 255, stdout: "", stderr: "Host key verification failed." }),
    /Connect once in Terminal/u,
  );
  assert.equal(
    sshFailureMessage("Mini", { code: 1, stdout: "", stderr: "Node.js 22 or newer is required on the host; found 20.1.0.\n" }),
    "Node.js 22 or newer is required on the host; found 20.1.0.",
  );
  assert.deepEqual([0, 1000, 16_000, 30_000].map(nextSshReconnectDelay), [1000, 2000, 30_000, 30_000]);
});
