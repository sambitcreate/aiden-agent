import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_DEVICE, DEVICE_HUB } from "./device-toolchain.js";
import {
  SSH_MISSING_TOOL_EXIT,
  quoteRemoteArg,
  remoteDeviceScript,
  type SshDeviceScriptMode,
} from "./ssh-device-script.js";
import { remoteExecScript } from "./ssh-device-host.js";

/**
 * Runs the bootstrap script the way a host would: piped to `node`, with HOME
 * pointing at a scratch home and PATH holding fake `npm` and `xcrun`.
 */
interface FakeHost {
  home: string;
  bin: string;
  run(mode: SshDeviceScriptMode, options?: { allowInstall?: boolean; owner?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

async function fakeHost(options: { npm?: boolean; xcrun?: boolean } = {}): Promise<FakeHost> {
  const home = await mkdtemp(path.join(tmpdir(), "aiden-ssh-host-"));
  const bin = path.join(home, "bin");
  await mkdir(bin, { recursive: true });
  if (options.xcrun !== false) await executable(path.join(bin, "xcrun"), "#!/bin/sh\nexit 0\n");
  if (options.npm !== false) {
    // A stand-in npm: `install --prefix <dir> name@version` lays out the package with a tiny hub that answers /readyz.
    await executable(
      path.join(bin, "npm"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("10.9.0"); process.exit(0); }
const prefix = args[args.indexOf("--prefix") + 1];
const spec = args[args.length - 1];
const name = spec.slice(0, spec.lastIndexOf("@"));
const entry = name === "expo-device-hub" ? ["dist", "server", "cli.mjs"] : ["bin", "agent-device.mjs"];
const file = path.join(prefix, "node_modules", name, ...entry);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, ${JSON.stringify(
        `import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => { res.statusCode = req.url === "/readyz" ? 200 : 404; res.end(); }).listen(port, "127.0.0.1");
`,
      )});
`,
    );
  }
  const run: FakeHost["run"] = (mode, runOptions = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [], {
        env: { HOME: home, PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(remoteDeviceScript(runOptions.owner ?? "owner-1", mode, { allowInstall: runOptions.allowInstall }));
    });
  return { home, bin, run };
}

async function executable(file: string, content: string): Promise<void> {
  await writeFile(file, content);
  await chmod(file, 0o755);
}

async function installed(home: string, name: string, version: string, entry: string[]): Promise<void> {
  const directory = path.join(home, ".aiden", "devices", "tools", `${name}@${version}`);
  await mkdir(path.join(directory, "node_modules", name, ...entry.slice(0, -1)), { recursive: true });
  await writeFile(path.join(directory, "node_modules", name, ...entry), "");
  await writeFile(path.join(directory, ".install-complete"), `${version}\n`);
}

const darwin = process.platform === "darwin";

test("the probe reports Node, iOS support, and installed versions without installing anything", async () => {
  const host = await fakeHost();
  await installed(host.home, DEVICE_HUB.name, "0.11.0", ["dist", "server", "cli.mjs"]);
  const result = await host.run("probe");
  assert.equal(result.code, 0, result.stderr);
  const probe = JSON.parse(result.stdout.trim()) as {
    nodeVersion: string;
    platforms: Array<{ platform: string; available: boolean }>;
    tools: { hub: { requiredVersion: string; installedVersions: string[] }; agent: { installedVersions: string[] } };
  };
  assert.equal(probe.nodeVersion, process.versions.node);
  assert.deepEqual(probe.platforms.map((platform) => [platform.platform, platform.available]), [["ios", darwin]]);
  assert.deepEqual(probe.tools.hub, { requiredVersion: DEVICE_HUB.version, installedVersions: ["0.11.0"], runningVersion: null });
  assert.deepEqual(probe.tools.agent.installedVersions, []);
  const tools = await readdir(path.join(host.home, ".aiden", "devices", "tools"));
  assert.deepEqual(tools, [`${DEVICE_HUB.name}@0.11.0`], "a probe writes nothing");
});

test("a missing npm is a clear, actionable probe failure", async () => {
  const host = await fakeHost({ npm: false });
  const result = await host.run("probe");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /npm was not found on the host's non-interactive SSH PATH/u);
});

test("a start without install approval stops at a missing helper and never runs npm", async (t) => {
  if (!darwin) return t.skip("iOS hosts are Macs");
  const host = await fakeHost();
  const result = await host.run("start");
  assert.equal(result.code, SSH_MISSING_TOOL_EXIT);
  assert.match(result.stderr, new RegExp(`missing-tool:${DEVICE_HUB.name}`, "u"));
  const tools = await readdir(path.join(host.home, ".aiden", "devices", "tools")).catch(() => []);
  assert.deepEqual(tools, []);
});

test("an approved start installs the pinned hub, reclaims old versions, and stop ends it", async (t) => {
  if (!darwin) return t.skip("iOS hosts are Macs");
  const host = await fakeHost();
  await installed(host.home, DEVICE_HUB.name, "0.10.0", ["dist", "server", "cli.mjs"]);
  await installed(host.home, DEVICE_HUB.name, "0.11.0", ["dist", "server", "cli.mjs"]);
  const started = await host.run("start", { allowInstall: true });
  assert.equal(started.code, 0, started.stderr);
  const value = JSON.parse(started.stdout.trim()) as {
    hubPort: number;
    tools: { hub: { installedVersions: string[]; runningVersion: string | null } };
  };
  t.after(() => void host.run("stop"));
  const ready = await fetch(`http://127.0.0.1:${value.hubPort}/readyz`);
  assert.equal(ready.status, 200, "the hub answers on the host's loopback");
  // The newest previous version stays as a fallback; older ones are reclaimed.
  assert.deepEqual(value.tools.hub.installedVersions, ["0.11.0", DEVICE_HUB.version]);
  assert.equal(value.tools.hub.runningVersion, DEVICE_HUB.version);

  const again = await host.run("start");
  assert.equal(JSON.parse(again.stdout.trim()).hubPort, value.hubPort, "a second start reuses the healthy hub");

  const stopped = await host.run("stop");
  assert.equal(stopped.code, 0, stopped.stderr);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(fetch(`http://127.0.0.1:${value.hubPort}/readyz`));
});

test("another owner's hub on the same host is left running", async (t) => {
  if (!darwin) return t.skip("iOS hosts are Macs");
  const host = await fakeHost();
  const mine = JSON.parse((await host.run("start", { allowInstall: true, owner: "mine" })).stdout.trim()) as { hubPort: number };
  const theirs = JSON.parse((await host.run("start", { owner: "theirs" })).stdout.trim()) as { hubPort: number };
  t.after(() => void host.run("stop", { owner: "theirs" }));
  assert.notEqual(mine.hubPort, theirs.hubPort);
  await host.run("stop", { owner: "mine" });
  assert.equal((await fetch(`http://127.0.0.1:${theirs.hubPort}/readyz`)).status, 200);
});

test("the agent-device version a host reports matches the pinned one", () => {
  assert.match(remoteDeviceScript("o", "probe"), new RegExp(`"${AGENT_DEVICE.version.replace(/\./gu, "\\.")}"`, "u"));
});

test("remote commands survive the remote shell exactly as passed", () => {
  const args = ["%s|", "it's", "$HOME", "a b", "`id`", "--"];
  const script = remoteExecScript("printf", args, { AIDEN_X: "y'z" });
  // ssh joins everything after the target with spaces for the login shell; `sh -c` then runs the quoted script.
  const remote = ["sh", "-c", quoteRemoteArg(script)].join(" ");
  const result = spawnSync("/bin/sh", ["-c", remote], { encoding: "utf8" });
  assert.equal(result.stdout, "it's|$HOME|a b|`id`|--|");
  const env = spawnSync("/bin/sh", ["-c", ["sh", "-c", quoteRemoteArg(remoteExecScript("printenv", ["AIDEN_X"], { AIDEN_X: "y'z" }))].join(" ")], {
    encoding: "utf8",
  });
  assert.equal(env.stdout.trim(), "y'z");
});
