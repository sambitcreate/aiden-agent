// Behavioral oracles for the `aiden serve` process (cli-native C03, C04): real
// daemon processes, their control socket and the artifacts they leave behind.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as api from "../dist/parity-test-api.js";

const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist", "app", "cli.js");
const posix = { skip: process.platform === "win32" };

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "aiden-serve-life-"));
  const home = join(root, "home"), agentDir = join(root, "agent");
  mkdirSync(home); mkdirSync(agentDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { agentDir, socket: api.daemonSocket(agentDir), lock: join(agentDir, "serve.lock"), env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
}

const run = (args, env) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, env });

/** A foreground server with Remote off, resolved once its control socket answers. */
async function foreground(t, box) {
  const child = spawn(process.execPath, [cli, "serve", "--no-remote"], { env: box.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
  const deadline = Date.now() + 30_000;
  while (!stderr.includes("listening at")) {
    if (child.exitCode !== null) throw new Error(`serve exited early:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`serve did not become ready:\n${stderr}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return { child, exited, stderr: () => stderr };
}

/** Sends raw bytes and returns everything the daemon answered before it closed. */
function exchange(socketPath, ...writes) {
  return new Promise((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => { for (const write of writes) socket.write(write); });
    socket.on("data", (part) => { reply += part; });
    socket.on("close", () => resolveReply(reply));
    socket.on("error", rejectReply);
  });
}

test("a stop that arrives during startup ends it there", posix, async (t) => {
  const box = sandbox(t);
  const previous = { agentDir: process.env.AIDEN_CODING_AGENT_DIR, home: process.env.HOME };
  process.env.AIDEN_CODING_AGENT_DIR = box.agentDir; process.env.HOME = box.env.HOME;
  const controller = new AbortController(), { listen } = Server.prototype;
  // The socket is being bound, so scheduler and Telegram startup are still ahead.
  Server.prototype.listen = function (...args) { controller.abort(); return listen.apply(this, args); };
  t.after(() => {
    Server.prototype.listen = listen;
    process.env.AIDEN_CODING_AGENT_DIR = previous.agentDir; process.env.HOME = previous.home;
  });
  let ready = false;
  await api.serve(box.agentDir, controller.signal, { remote: false, onReady: () => { ready = true; } });
  assert.equal(ready, false, "a cancelled startup never reports ready");
  assert.equal(existsSync(box.socket), false);
  assert.equal(existsSync(box.lock), false);
});

test("a stopped server leaves nothing behind and a new one takes over at once", posix, async (t) => {
  const box = sandbox(t);
  t.after(() => { run(["serve", "stop"], box.env); });
  assert.equal(run(["serve", "--daemon", "--no-remote"], box.env).status, 0);
  const first = JSON.parse(readFileSync(join(box.lock, "owner.json"), "utf8"));
  const stopped = run(["serve", "stop"], box.env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(existsSync(box.lock), false);
  assert.equal(existsSync(box.socket), false);
  const again = run(["serve", "--daemon", "--no-remote"], box.env);
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(readFileSync(join(box.lock, "owner.json"), "utf8"));
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.token, first.token);
});

test("a second server is refused while the first holds the lease, and the first is unharmed", posix, async (t) => {
  const box = sandbox(t);
  const server = await foreground(t, box);
  const second = run(["serve", "--no-remote"], box.env);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Another Aiden process owns/u);
  assert.equal(JSON.parse(await exchange(box.socket, `${JSON.stringify({ command: "serve", args: ["status"] })}\n`)).result.remote.on, false);
  server.child.kill("SIGTERM");
  assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
});

test("a failed startup releases its lease and the next start succeeds", posix, async (t) => {
  const box = sandbox(t);
  // A directory at the socket path cannot be cleared, so startup fails after the lease is taken.
  mkdirSync(join(box.socket, "occupied"), { recursive: true });
  const failed = run(["serve", "--no-remote"], box.env);
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(box.lock), false, "the lease went with the failed start");
  rmSync(box.socket, { recursive: true, force: true });
  const server = await foreground(t, box);
  server.child.kill("SIGTERM");
  assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
});

test("an idle or half-sent control client does not hold up shutdown", posix, async (t) => {
  const box = sandbox(t);
  const server = await foreground(t, box);
  const idle = createConnection(box.socket), partial = createConnection(box.socket);
  idle.on("error", () => {}); partial.on("error", () => {});
  await new Promise((resolveWait) => partial.once("connect", resolveWait));
  partial.write('{"command":"serve"');
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  server.child.kill("SIGTERM");
  assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
  assert.equal(existsSync(box.socket), false);
  assert.equal(existsSync(box.lock), false);
  idle.destroy(); partial.destroy();
});

test("the control socket answers one framed request per connection and refuses malformed ones", posix, async (t) => {
  const box = sandbox(t);
  await foreground(t, box);
  const status = `${JSON.stringify({ command: "serve", args: ["status"] })}\n`;
  // A request may arrive in pieces; only its newline frames it.
  assert.deepEqual(JSON.parse(await exchange(box.socket, status.slice(0, 5), status.slice(5))), { result: { remote: { on: false } } });
  // Anything after the first frame is ignored, not run as a second request.
  const pipelined = await exchange(box.socket, status + status);
  assert.equal(pipelined.trim().split("\n").length, 1);
  assert.match(await exchange(box.socket, "not json\n"), /"error"/u);
  assert.match(await exchange(box.socket, `${JSON.stringify({ command: "shell", args: [] })}\n`), /Invalid daemon command/u);
  assert.match(await exchange(box.socket, `${JSON.stringify({ command: "serve", args: [1] })}\n`), /Invalid daemon command/u);
  assert.match(await exchange(box.socket, `${JSON.stringify({ command: "remote", args: ["status"] })}\n`), /Remote is off/u);
  // A request with no newline inside the byte ceiling is cut off, with no reply.
  assert.equal(await exchange(box.socket, "x".repeat(70_000)), "");
  assert.deepEqual(JSON.parse(await exchange(box.socket, status)), { result: { remote: { on: false } } }, "the server is still healthy");
});

test("shutdown keeps the lease until a running control command has answered", posix, async (t) => {
  const box = sandbox(t), controller = new AbortController(), ready = Promise.withResolvers();
  const serving = api.serve(box.agentDir, controller.signal, { onReady: ready.resolve });
  void serving.catch(ready.reject);
  await ready.promise;
  const workspace = await api.remoteDaemonCommand(box.agentDir, "workspace", ["add", box.agentDir]);
  // Workspace changes look at the chat index first, which gives the test a place to hold one.
  const { stat } = fsPromises, reached = Promise.withResolvers(), held = Promise.withResolvers();
  fsPromises.stat = async (...args) => {
    if (String(args[0]).endsWith("index.json")) { reached.resolve(); await held.promise; }
    return stat(...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = stat; syncBuiltinESMExports(); });
  const answer = api.remoteDaemonCommand(box.agentDir, "workspace", ["access", workspace.id, "none"]);
  await reached.promise;
  controller.abort();
  let released = false;
  void serving.then(() => { released = true; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  assert.equal(released, false, "the command is still changing state");
  assert.equal(existsSync(box.lock), true);
  held.resolve();
  assert.equal((await answer).access, "none", "the client hears how its command ended");
  await serving;
  assert.equal(existsSync(box.lock), false);
  assert.equal(existsSync(box.socket), false);
});

test("serve phases only move forward and draining waits for every accepted command", async () => {
  const lifetime = new api.ServeLifetime();
  assert.equal(lifetime.acceptsCommands, true, "commands are answered while services start");
  lifetime.markServing();
  assert.equal(lifetime.phase, "serving");
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  lifetime.track(first.promise); lifetime.track(second.promise);
  lifetime.beginDrain();
  assert.equal(lifetime.acceptsCommands, false);
  lifetime.markServing();
  assert.equal(lifetime.phase, "draining", "a late ready report cannot reopen the socket");
  let settled = false;
  const settling = lifetime.settleCommands().then(() => { settled = true; });
  first.reject(new Error("answered already"));
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(settled, false);
  second.resolve();
  await settling;
  assert.equal(settled, true);
});

/** A fake daemon that answers every connection with the given bytes. */
async function fakeDaemon(t, answer) {
  const box = sandbox(t);
  const server = createServer((socket) => { socket.on("data", () => answer(socket)); socket.on("error", () => {}); });
  await new Promise((resolveListen) => server.listen(box.socket, resolveListen));
  t.after(() => new Promise((resolveClose) => { server.close(resolveClose); }));
  return box.agentDir;
}

test("the command client settles once for every way a daemon can answer", posix, async (t) => {
  assert.deepEqual(await api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end('{"result":{"ok":true}}\n')), "serve", ["status"]), { ok: true });
  await assert.rejects(api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end('{"error":"Refused."}\n')), "serve", ["status"]), /Refused\./u);
  await assert.rejects(api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end()), "serve", ["status"]), /closed without a response/u);
  await assert.rejects(api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end('{"partial"')), "serve", ["status"]), /closed without a response/u);
  await assert.rejects(api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end("not json\n")), "serve", ["status"]), SyntaxError);
  await assert.rejects(api.remoteDaemonCommand(await fakeDaemon(t, (socket) => { socket.write("x".repeat(9 * 1024 * 1024)); }), "serve", ["status"]), /too large/u);
  const missing = sandbox(t);
  await assert.rejects(api.remoteDaemonCommand(missing.agentDir, "serve", ["status"]), (error) => error.code === "ENOENT" && /not running/u.test(error.message));
});
